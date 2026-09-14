import {
  getLlama,
  JinjaTemplateChatWrapper,
  LlamaChatSession,
  type ChatWrapper,
  type Llama,
  type LlamaModel,
  type LlamaContext,
} from "node-llama-cpp";
import { buildPrompt, CHAT_TEMPLATE, INSTRUCTION } from "./prompt.js";
import {
  copiesClipOpening,
  echoesRun,
  isDegenerateRepetition,
  parseTitleOutput,
  type ParsedTitle,
} from "./parse.js";

export interface TitleEngineOptions {
  modelPath: string;
  /** Concurrent generations. The probe hit "No sequences left" with the
   *  default of 1. */
  contextSequences?: number;
  timeoutMs?: number;
  /** Observability seam, never a behaviour switch.
   *
   *  When both attempts are unusable the retry policy returns no title and the
   *  raw text is gone, which makes a refusal indistinguishable from a guard
   *  that fired on a good title — the exact blind spot that made the first
   *  quality-gate verdict wrong. The eval harness records what the model
   *  actually said through this callback. */
  onRaw?: (raw: string, attempt: { penalised: boolean }) => void;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** Budget for a title plus a 1-2 sentence description.
 *
 *  The quality gate ran at 64 and 20 of the 35 descriptions came back cut off
 *  mid-sentence, because the title eats a dozen tokens before the description
 *  starts. The model stops on its own well before this; the cap exists to bound
 *  a loop, not to shape the output. */
const MAX_TOKENS = 128;

/** Applied only to the second attempt, after the first produced something we
 *  would not show a user.
 *
 *  The first attempt stays at plain greedy decoding on purpose: the gate showed
 *  that 35 of 40 transcripts title correctly without any penalty, and changing
 *  the sampler for those would be changing behaviour that already works. */
const RETRY_REPEAT_PENALTY = {
  penalty: 1.3,
  frequencyPenalty: 0.2,
  presencePenalty: 0.2,
  lastTokens: 64,
};
const RETRY_DRY = { strength: 0.8 };

/** Characters that never belong in a title, only in the scaffolding a
 *  transcript carries around it.
 *
 *  A backtick is deliberately NOT in this set. It was, and the gate rejected
 *  `Running \`npx fallow\` and inspecting results` twice in a row on one of the
 *  forty real transcripts — a genuinely good title, thrown away because the
 *  model marked up a command name. The original justification ("no title of
 *  ours contains a backtick, so refusing them costs nothing real") was an
 *  assumption that the corpus then falsified, and dropping it flips exactly that
 *  one row: every title the other four characters catch is still caught. */
const MARKUP = /[<>*|]/;

/** Whether a parse is something we are willing to put in front of a user in
 *  place of the host's own title. Everything the quality gate caught as
 *  unusable is rejected here rather than passed through. */
export function isAcceptableTitle(parsed: ParsedTitle, clip: string): boolean {
  const title = parsed.title;
  if (!title) return false;
  if (title.split(/\s+/).length < 2) return false;
  if (isDegenerateRepetition(title)) return false;
  if (echoesRun(title, INSTRUCTION)) return false;
  if (copiesClipOpening(title, clip)) return false;
  // Markup means the model picked up a fragment of the transcript's own
  // scaffolding rather than describing the session. The gate shipped
  // `Reviewer:*No visual feedback yet.*` past every other guard: it is five
  // words, it repeats nothing, and it opens no line of the passage. No title of
  // ours contains `<`, `>`, `*`, a backtick or a pipe, so refusing them costs
  // nothing real.
  if (MARKUP.test(title)) return false;
  return true;
}

/** Runs up to two attempts and returns the first acceptable parse.
 *
 *  Extracted from `TitleEngine` so the retry policy can be tested against the
 *  real implementation without loading a model. `run(penalise)` performs one
 *  generation; `penalise` is false for the first attempt, which is left at plain
 *  greedy decoding because that is what titles 35 of 40 real transcripts
 *  correctly, and true for the corrective retry. */
export async function titleWithRetry(
  run: (penalise: boolean) => Promise<ParsedTitle>,
  clip: string
): Promise<ParsedTitle> {
  const first = await run(false);
  if (isAcceptableTitle(first, clip)) return first;

  const second = await run(true);
  if (isAcceptableTitle(second, clip)) return second;

  // Both attempts produced something we would not put in front of a user — a
  // token loop, the instruction echoed back, or a line lifted from the
  // transcript. Returning no title leaves the host's own title in place, which
  // is strictly better than replacing it with `MCP MCP MCP`.
  return { title: null, description: null };
}

export class TitleEngine {
  readonly backend: string;
  #llama: Llama;
  #model: LlamaModel;
  #context: LlamaContext;
  #chatWrapper: ChatWrapper;
  #timeoutMs: number;
  #onRaw: TitleEngineOptions["onRaw"];

  private constructor(
    llama: Llama,
    model: LlamaModel,
    context: LlamaContext,
    chatWrapper: ChatWrapper,
    backend: string,
    timeoutMs: number,
    onRaw: TitleEngineOptions["onRaw"]
  ) {
    this.#llama = llama;
    this.#model = model;
    this.#context = context;
    this.#chatWrapper = chatWrapper;
    this.backend = backend;
    this.#timeoutMs = timeoutMs;
    this.#onRaw = onRaw;
  }

  static async create(opts: TitleEngineOptions): Promise<TitleEngine> {
    // Prebuilt binaries only. build:"never" plus skipDownload:true means
    // node-llama-cpp can never decide to compile llama.cpp from source, which
    // on a user's machine would take up to an hour.
    const llama = await getLlama({ gpu: "auto", build: "never", skipDownload: true });
    const model = await llama.loadModel({ modelPath: opts.modelPath });
    const context = await model.createContext({
      sequences: opts.contextSequences ?? 1,
    });
    return new TitleEngine(
      llama,
      model,
      context,
      // Bind the vendored template explicitly rather than relying on
      // auto-detection, and ask it for the generation prompt. The template's
      // own `add_generation_prompt` block emits the trailing
      // `<|start_of_role|>assistant<|end_of_role|>` the model was trained to
      // continue from; node-llama-cpp does not pass that flag by default.
      new JinjaTemplateChatWrapper({
        template: CHAT_TEMPLATE,
        additionalRenderParameters: { add_generation_prompt: true },
      }),
      // `llama.gpu` is `false`, not `undefined`, when no GPU backend loaded —
      // `??` would stringify that to "false" instead of reporting "cpu".
      llama.gpu || "cpu",
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      opts.onRaw
    );
  }

  async #attempt(clip: string, penalise: boolean): Promise<ParsedTitle> {
    const sequence = await this.#context.getSequence();
    try {
      // The model was fine-tuned inside the Granite chat template, so the
      // prompt goes through a chat session rather than the completion API.
      // `systemPrompt: ""` suppresses node-llama-cpp's own default system
      // message ("You are a helpful, respectful and honest assistant…") and
      // lets the Granite template emit its own default, which is what the
      // fine-tune was trained against.
      const session = new LlamaChatSession({
        contextSequence: sequence,
        chatWrapper: this.#chatWrapper,
        systemPrompt: "",
      });
      // Promise.race does not cancel the loser, so the timeout handle has to be
      // cleared by hand. Left dangling, every successful generation would keep
      // a live timer — enough to hold the process open for the full timeout
      // after the last title, and to accumulate in a long-lived daemon.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const response = await Promise.race([
        session.promptWithMeta(buildPrompt(clip), {
          maxTokens: MAX_TOKENS,
          temperature: 0,
          ...(penalise
            ? { repeatPenalty: RETRY_REPEAT_PENALTY, dryRepeatPenalty: RETRY_DRY }
            : {}),
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("inference timeout")), this.#timeoutMs);
        }),
      ]).finally(() => clearTimeout(timer));
      this.#onRaw?.(response.responseText, { penalised: penalise });
      return parseTitleOutput(response.responseText);
    } finally {
      sequence.dispose();
    }
  }

  async generate(clip: string): Promise<{ result: ParsedTitle; backend: string }> {
    return {
      result: await titleWithRetry((penalise) => this.#attempt(clip, penalise), clip),
      backend: this.backend,
    };
  }

  async dispose(): Promise<void> {
    await this.#context.dispose();
    await this.#model.dispose();
    await this.#llama.dispose();
  }
}
