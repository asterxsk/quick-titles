# Plan deviations

Recorded during implementation of `docs/plans/2026-09-14-quick-titles.md`.
The plan prescribes this file for changes a task must make outside its declared ownership,
and it is also where defects found in the plan itself are recorded rather than silently patched.

---

## D1 — Task 3 cannot run before Tasks 4 and 5

**Found:** 2026-09-14, before Phase 2 started.

**Problem.** Task 3's `tools/eval/run-eval.mjs` imports `dist/core/prompt.js` and
`dist/core/parse.js` (plan lines 465–466) and its Step 3 runs `npm run build` first. Those two
modules are produced by Task 4 and Task 5, which the plan places in Phase 3 — *after* the
Phase 2 gate. The gate as written cannot execute.

**Resolution.** Task 4 and Task 5 are promoted ahead of Task 3. They are pure functions with no
dependency on the model or the GGUF, so they cost nothing to move. Revised phase order:

| Phase | Tasks | Parallel |
|---|---|---|
| 1 | 1, 2 | 2 |
| 2 | 4, 5 | 2 |
| 3 | 3 **(hard gate)** | 1 |
| 4 | 6, 7, 8 | 3 |
| 5 | 9, 10 | 1 (sequential — 9 feeds 10) |
| 6 | 11, 12, 13, 14 | 4 |
| 7 | 15, 16, 17 | 3 |
| 8 | 18 | 1 |

Task 3 remains a hard gate at the same point in the dependency graph; it simply has its
prerequisites ahead of it now instead of behind it.

---

## D2 — Task 4's instruction is in the SDK source, not the SDK docs, and the plan's `buildPrompt` omits `PASSAGE:`

**Found:** 2026-09-14, while preparing Phase 2.

**Problem.** Task 4 Step 1 says to retrieve `Titles.prompt` from
`desert-ant-core/docs/models/title.md`. That page does not contain the string — it only says the
prompt lives in `Titles.prompt`. The real definition is `Sources/Title/Title.swift:82`.

More seriously, the plan's `buildPrompt` (plan lines 632–636) renders
`` `${INSTRUCTION}\n\n${bounded.trim()}\n` `` — it omits the `PASSAGE:` label that the trained
prompt contains. Sending a prompt that differs from the training prompt is precisely the failure
the model card warns about ("a paraphrase is a different task"), and `Title.swift`'s own
docstring records that an earlier release shipped exactly this bug.

**Ground truth** (`Sources/Title/Title.swift:82-89`, byte-for-byte after Swift's
line-continuation backslashes are resolved — note the sentences are joined with **no space**,
which is how the source actually reads):

```
Write a factual title (3-8 words) and a 1-2 sentence description for this passage.Be specific enough to identify this passage. No emoji, no hashtags, no hype.Write in the same language as the passage.

PASSAGE:
{clip}
```

That is: `<three sentences with no separator><LF><LF>PASSAGE:<LF><clip><LF>`

**Resolution.** `assets/instruction.txt` holds the three-sentence block verbatim (including the
missing spaces between sentences — that is the trained string, not a transcription error), and
`buildPrompt` renders:

```ts
return `${INSTRUCTION}\n\nPASSAGE:\n${bounded.trim()}\n`;
```

---

## D3 — Task 5's parser should also accept `DESCRIPTION:`

**Found:** 2026-09-14, while preparing Phase 2.

The upstream reference parser, `Sources/Title/Title.swift:233-250`, accepts `TITLE:`,
`DESCRIPTION:` **and** `DESC:`, and falls back to the first unlabelled line. The plan's parser
handles only `TITLE:` and `DESC:`. Since the spec asks for tolerant parsing and the ground-truth
implementation is more forgiving, `src/core/parse.ts` accepts all three labels. The fallback and
capitalisation behaviour stay as the plan wrote them.

---

## D4 — Parallel-phase agents do not commit

The plan's per-task protocol ends each task with `git add` / `git commit`. Tasks in a parallel
phase share one working tree and one git index, so concurrent commits race on `.git/index.lock`.
Agents in parallel phases therefore leave their files staged on disk and the orchestrator commits
each task's files once the phase's verification is in. Sequential phases commit per task as the
plan states.

---

## D5 — Model weights are converted locally instead of in macOS CI

**Found:** 2026-09-14, during Phase 1.

**Problem.** Task 2 builds a GitHub Actions job that converts the MLX weights to GGUF on a macOS
runner. Running it requires a GitHub remote. There is none: this repository was `git init`ed
locally and never pushed. Without that job there is no `title-q8_0.gguf`, so Task 3 — the hard
gate — cannot run at all.

**Resolution.** The weights are dequantized locally instead. `model.safetensors` is MLX 6-bit
affine (`group_size: 64, bits: 6, mode: affine`); the packing is unpacked in numpy, the result is
validated by per-tensor cosine similarity against the unquantized base model
`ibm-granite/granite-4.0-350m` — a fine-tune must correlate strongly with its base, so a wrong
unpacking shows up immediately as near-zero similarity — and only then converted with
`convert_hf_to_gguf.py --outtype q8_0`.

Task 2's workflow is still written and committed: it is the reproducible, correct answer for the
shipped product, and it is what a contributor without a local conversion will use. What changes is
only how this machine obtains the artifact today.

**Not done, deliberately:** no GitHub repository is created under the user's account to run the
workflow. That is an outward-facing action on someone else's credentials and was not authorised
for this session.

---

## D6 — Task 6 must apply the chat template, not pass the raw prompt

**Found:** 2026-09-14, while preparing Phase 2.

`chat_template.jinja` is the stock Granite 4.0 template: it wraps a user turn in
`<|start_of_role|>user<|end_of_role|>…<|end_of_text|>` and prefixes a default system message.
`buildPrompt` returns only the instruction and passage, with no role markers. Task 6 as written
calls `sequence.prompt(buildPrompt(clip), …)` (plan line 929) — the raw string straight into
completion, with no role markers at all. The model would be served a shape it never saw in
training. The model card is explicit that the template is part of the task, and `Title.swift`'s
docstring records that shipping the wrong prompt already happened once.

**Resolution.** `TitleEngine.generate` drives a `LlamaChatSession` bound to the sequence rather
than calling `sequence.prompt` directly:

```ts
const session = new LlamaChatSession({ contextSequence: sequence });
const raw = await session.prompt(buildPrompt(clip), { maxTokens: 64, temperature: 0 });
```

`LlamaChatSession` applies the model's chat wrapper, which node-llama-cpp resolves from the
`tokenizer.chat_template` metadata that `convert_hf_to_gguf.py` embeds — the same vendored
`chat_template.jinja`, since Task 4 vendors it and Task 2's converter reads it out of the source
directory. Task 6's agent must confirm this empirically: render one prompt and assert the output
contains `<|start_of_role|>user<|end_of_role|>` and ends with
`<|start_of_role|>assistant<|end_of_role|>`. If the GGUF turns out to carry no chat template, pass
`new JinjaTemplateChatWrapper({ template })` from the vendored file explicitly instead.

---

## D7 — The plan never creates the `build` script it then depends on

Task 1's Step 1 runs `npm init -y` and installs dependencies but never sets any `scripts` entry,
so `package.json` keeps npm's placeholder `test` script. Task 3 Step 3, Task 5's eval runner and
every adapter that imports the compiled `dist/client.js` all invoke `npm run build`, which did not
exist. `tsconfig.json` already declares `rootDir: src` / `outDir: dist`, so the script is `tsc`.

**Resolution.** `package.json` gains:

```json
"scripts": {
  "build": "tsc",
  "typecheck": "tsc --noEmit",
  "test": "vitest run"
}
```

## D8 — `tsc` fails on a clean checkout: tsconfig needs `types: ["node"]`

Task 1's `tsconfig.json` is copied verbatim from the plan and omits a `types` field. Under the
installed TypeScript 7.0.2, `npx tsc --noEmit` fails with four `TS2591` errors in `src/paths.ts`
(`Cannot find name 'process'`, `Cannot find name 'node:os'`) — `@types/node` is installed but not
being pulled in. Adding `"types": ["node"]` clears them and `npm run build` then emits `dist/`.
Every later task compiles through this config.

## D9 — `tests/paths.test.ts` fails on Windows

Task 1's test injects a POSIX override (`QUICK_TITLES_DATA_DIR=/tmp/qt-test`) and then asserts
`storeFile().startsWith(dataDir())`. `storeFile()` is `join(dataDir(), "titles.jsonl")`, and
`path.join` normalises separators for the host platform, so on win32 the store path comes back as
`\tmp\qt-test\titles.jsonl` and the prefix check fails against `/tmp/qt-test`.

The production code is correct — a real Windows data dir would be `C:\Users\…\AppData\Local\quick-titles`
and the prefix check would hold. The defect is in the assertion. Replaced with an exact comparison
that is platform-independent:

```ts
expect(storeFile()).toBe(join(dataDir(), "titles.jsonl"));
```

## D10 — The plan's "hash-pinned" prompt pins nothing

Task 4 computes `TEMPLATE_SHA256` and `INSTRUCTION_SHA256` from the asset files at module load,
and the test then hashes those same files and compares. The assertion restates what the module
already computed from the same bytes, so it cannot fail — editing either asset keeps the suite
green. The Global Constraints call these files immutable and hash-pinned; the plan does not
actually implement that.

**Resolution.** The two hashes are literal constants in `src/core/prompt.ts`, and the module
verifies the files against them at load, throwing on mismatch. The test then asserts a real
invariant. Values:

- `assets/chat_template.jinja` → `9524df67b77a7b25a2dfee898f75b316a157eb9d855b51e32aeac79d7c8a83ce`
- `assets/instruction.txt` → `8928323d4f8f74d6b2eb06bbf28028d84ebc8d3e153386718976396b384c294c`

## D11 — Task 5's tests and its implementation disagree; the tests are right

Two of the nine assertions in the plan's own test file fail against the plan's own implementation.

1. `parseTitleOutput("!!!").title` is asserted to be `null`, but the fallback path takes the first
   non-empty line and `tidyTitle` accepts any non-empty string, so it returns `"!!!"`. Fixed by
   requiring at least one letter (`/\p{L}/u`) in a title.

2. `"DESC: This text is about a refactor of the auth middleware."` is asserted to yield
   `"Refactor of the auth middleware."`, but the stock-phrase patterns match only the phrase and
   leave its article, producing `"A refactor of the auth middleware."`. Fixed by making each
   pattern consume an optional leading article.

In both cases the implementation is corrected to satisfy the test. Weakening an assertion to match
the code would have discarded the intended behaviour and hidden a real bug in the shipped parser.

---

## D12 — The Pi reader reads a shape Pi does not write

**Found:** 2026-09-14, by reading a real session file before Phase 4.

Task 7's `pi.ts` reads `parsed.role` and `parsed.content` at the top level of each line. Real Pi
sessions nest both inside a `message` object:

```json
{"type":"message","id":"3eefe713","parentId":"8b7b297c","timestamp":"2026-09-05T07:20:56.801Z",
 "message":{"role":"user","content":[{"type":"text","text":"@Downloads/…"}],"timestamp":1788592856793}}
```

Against real data the plan's reader produces `""` for every Pi session — it would silently fail
to title anything while every test passed, because the fixture was written to match the code
rather than the format. Real Pi files also carry `session`, `model_change`,
`thinking_level_change` and `custom_message` line types, of which only `message` is a
conversation turn.

**Resolution.** `pi.ts` reads `parsed.message.role` and runs `parsed.message.content` through the
same `textOf` helper the other readers use, since content is an array of `{type,text}` parts. The
fixture is written to the real shape.

## D13 — The Codex reader feeds permission boilerplate to the model

Real Codex rollouts open with `response_item` entries whose `payload.role` is `developer` and
whose text is a `<permissions instructions>` block — session scaffolding, not conversation. Task
7's reader includes every `response_item` regardless of role, so on real data the clip leads with
a large block of tool-permission prose and the model is asked to title *that*.

**Resolution.** `codex.ts` skips `developer` and `system` roles, keeping `user` and `assistant`.

## D14 — opencode2's transcript is a SQLite row, not a JSON file; the adapter must materialise it

**Found:** 2026-09-14, inspecting `~/.local/share/opencode/opencode.db`.

The plan's Task 7 reader parses a JSON file shaped `{"session_v2":{…},"messages":[…]}` and Task 12
passes `ctx.paths.data('session/${sessionID}.json')` as the transcript path. No such file exists.
opencode2 (which is installed here — `session_v2` holds 173 rows) keeps messages in SQLite:

| Table | Role |
|---|---|
| `session_v2` | sessions; `id`, `title`, `slug`, `directory`, `tokens_input`, `time_updated` |
| `session_message` | the v2 message log — FK to `session_v2`, keyed by `seq`, with `type` and a `data` JSON blob |
| `message`, `part` | the older v1 tables, FK to `session`; not what opencode2 writes |

`session_message.type` is one of `user`, `assistant`, `system`, `synthetic`, `compaction`,
`agent-switched`, `model-switched`. A `user` row's `data` is
`{"time":{…},"text":"…","files":[],"agents":[]}`.

**Resolution.** The reader keeps the plan's JSON interchange shape, and the *adapter* becomes
responsible for producing that file: the opencode2 plugin reads the session through its own
plugin API and writes `{session_v2, messages}` into the quick-titles cache directory, then passes
that path to `generate`. This keeps `readClip` storage-agnostic, requires no SQLite dependency in
the daemon (the Global Constraints forbid native dependencies), and honours the rule against
writing a host agent's storage — we read through opencode2's API and write only our own files.

Task 3's eval corpus reads the database directly instead, because it is a one-off tool script
rather than shipped code, and joins `session_message` to `session_v2` ordered by `seq`.

---

## D15 — `socketPath()` ignores the data-dir override on Windows, and the client test spies on an ESM export

Two related problems that both make tests pass while testing nothing.

`paths.ts` returns a fixed `\.\pipe\quick-titles` on win32, ignoring `QUICK_TITLES_DATA_DIR`
entirely. So on Windows every caller — every hook script, the client, the daemon — resolves to the
same pipe no matter what data directory is configured, and a test cannot isolate itself.

Task 10's test then works around that by calling `vi.spyOn(paths, "socketPath")`. Spying on a
live ESM namespace export is not reliable — the namespace object is frozen and the property is a
getter — and Vitest's own guidance is to use `vi.mock` for module-level substitution. And Task 11's
test sets `QUICK_TITLES_SOCKET` in the child's environment, expecting an override that `paths.ts`
never reads, so the child resolves the real pipe while the test believes it pointed somewhere inert.

**Resolution.** `socketPath()` gains an explicit override, checked first:

```ts
export function socketPath(): string {
  if (process.env.QUICK_TITLES_SOCKET) return process.env.QUICK_TITLES_SOCKET;
  if (platform() === "win32") return `\\.\pipe\${APP}`;
  return join(dataDir(), "daemon.sock");
}
```

Task 10's test then sets the environment instead of spying, and Task 11's `QUICK_TITLES_SOCKET`
becomes real rather than decorative.

## D16 — Task 11's test helper never feeds the script its stdin

The plan's `invoke` helper calls `promisify(execFile)(process.execPath, [script], { …, input })`.
`input` is a `spawnSync`/`execFileSync` option; async `execFile` does not accept it and silently
ignores it. The child process therefore starts with an empty stdin, `readStdin()` gets `""`,
`JSON.parse` throws, the script returns `null` and exits 0 — and every assertion passes against a
script that was never given a payload. The adapter would have shipped with five green tests that
exercise nothing.

**Resolution.** The helper spawns the script and writes the payload to its stdin explicitly, then
resolves on close.

---

## D17 — The plan's stated reason for the 25-second hook timeout is false

Task 11's `hooks.json` declares `"timeout": 25` with the comment: *"UserPromptSubmit carries a hard
30 s ceiling. The hook declares 25 s so our own timeout fires first and we exit cleanly rather than
being killed mid-write."*

Verified against Claude Code v2.1.270's shipped hook schema: `timeout` is in **seconds**, the
schema declares it as a positive number with **no maximum**, and 30 s is the *default applied when
the field is omitted* — not a ceiling. The docs use the word "default". So declaring 25 s does not
buy headroom under a cap; it voluntarily gives up 5 s.

**Resolution.** The value stays at 25 s, because a bounded stall is genuinely what we want and
25 s sits above the client's own 15 s timeout (`src/client.ts`), so the client's clean failure
still wins the race. Only the comment changes, to state the real reason instead of a ceiling that
does not exist.

## D18 — The plan's open questions about `/clear` and `/compact` are answered: no hook fires

The plan lists "title behaviour on `/clear` and `/compact`" as unresolved. It is resolved by the
`SessionStart` matcher, whose valid values are exactly the `source` enum — `startup`, `resume`,
`clear`, `compact`, `fork`. Task 11 declares `startup|resume|fork`, which deliberately excludes
`clear` and `compact`, so no `SessionStart` hook fires after either. A session keeps the title it
already has across compaction, and `/clear` does not re-trigger a title.

That is the correct behaviour for this design — re-titling on every compaction is exactly what the
spec's "title once, refine once" rule rules out — but it is a consequence of a matcher that looked
arbitrary, so it is recorded here rather than left as an accident.

Also worth recording, since it was the plan's single largest unverified assumption and it is now
confirmed: **`sessionTitle` is real and it does suppress the built-in titler.** The shipped schema
for both `SessionStart` and `UserPromptSubmit` declares `sessionTitle` as an optional string; the
runtime short-circuits its haiku title pass when a hook supplies one; and the value lands as
`{"type":"custom-title","customTitle":…}` in the transcript plus a `custom-title.json` sidecar.
It is implemented and typed, though it does not appear in the public hooks documentation — a real
extension point that could change without a docs-visible deprecation.

---

## D19 — The converted GGUF's architecture is `granite`, not `granitehybrid`

Task 2's `tools/verify-gguf.mjs` asserts `general.architecture === "granitehybrid"` and exits
non-zero otherwise; the plan's own "known ordering risk" paragraph worries that
`convert_hf_to_gguf.py` might reject the zero-expert `granitemoehybrid` config.

It does not reject it, and the arch it emits is `granite`. llama.cpp's converter has an explicit
branch for this exact shape, in `conversion/granite.py` inside `GraniteHybridModel.__init__`:

> There are some models in this family that are non-hybrid, but keep the same parent class by
> setting all layers to "attention." If this is the case, the model architecture needs to be
> updated to a standard "granite" or "granitemoe" model

```python
if not self._ssm_layers:
    has_experts = self.find_hparam(["num_experts_per_tok", "num_experts_per_token"], optional=True)
    new_arch = gguf.MODEL_ARCH.GRANITE_MOE if has_experts else gguf.MODEL_ARCH.GRANITE
```

`desert-ant-labs/title`'s `config.json` has all 28 `layer_types` set to `"attention"` and
`num_local_experts: 0`, so the branch fires and lands on `GRANITE`. That is the correct output for
this model, not a degraded fallback — the plan's expected string was simply wrong.

`verify-gguf.mjs` now expects `granite`, and reads `model.architecture` rather than
`fileInfo.metadata["general.architecture"]`: node-llama-cpp nests that metadata by key prefix
(`metadata.general`, `metadata.tokenizer`), so the dotted lookup always returned `undefined` and
the old script could not have distinguished a good conversion from a bad one.

## D20 — The weights were converted locally; the conversion is validated, not assumed

The local conversion described in D5 succeeded, first attempt, with no macOS and no CI.

**The packing.** MLX 6-bit affine is a *dense little-endian bitstream of 4 values per 3 bytes*,
contiguous across the whole row — not the `32/bits`-values-per-word layout MLX uses for 2/4/8-bit.
Derived from `mlx/backend/cpu/quantized.cpp` (`extract_bits<T,bits>`, the `bits == 6` case) and
`mlx/backend/common/quantized.h` (`get_pack_factor` / `get_bytes_per_pack`), and cross-checked
against the byte-identical Metal implementation. Dequant is `w = scales * q + biases` per group of
64, with `scales`/`biases` repeating 64 times across the row.

**The validation.** A fine-tune stays close to its base, so per-tensor cosine similarity against
the unquantized `ibm-granite/granite-4.0-350m` is a decisive test of the unpacking:

| Tensor | Cosine |
|---|---|
| `model.embed_tokens.weight` | 0.9998 |
| `layers.0.self_attn.{q,k,v,o}_proj.weight` | 0.9987 – 0.9995 |
| `layers.0.mlp.{gate,up,down}_proj.weight` | 0.9997 – 0.9998 |
| `layers.14.*` | 0.9987 – 0.9997 |
| `layers.{0,14}.input_layernorm.weight` (never quantized) | 1.0000 |
| **negative control: reversed pack order** | **−0.0368** |

The negative control collapsing to noise is what makes the high numbers meaningful — the metric
discriminates sharply rather than being satisfiable by any output. Rebuilt tensor data is
704,759,808 bytes, byte-identical in size to the base checkpoint.

**The artifact.** `.probe/title-q8_0.gguf`, 378,137,504 bytes, 254 tensors, Q8_0, arch `granite`.
`tools/verify-gguf.mjs` reports OK: context 32768, 28 blocks, embedding 1024, and an embedded chat
template whose SHA-256 is `9524df67…` — byte-identical to the vendored `assets/chat_template.jinja`.
That last check is the one that matters for D6: the GGUF carries the exact template the model was
trained against, so `LlamaChatSession` will prompt it correctly without us supplying anything.

**Two corrections to Task 2's planned pipeline**, both found while doing this:

1. The base model's MLP is stored fused as `shared_mlp.input_linear` / `shared_mlp.output_linear`,
   not as separate `gate_proj`/`up_proj`. Fusion order was confirmed by correlation: `gate` is rows
   `[0:2048]` and `up` is rows `[2048:4096]`; the swap scores −0.0000.
2. `lm_head` does not exist — `tie_word_embeddings: true` on both sides.
3. PyPI's `gguf` 0.19.0 is too old for current llama.cpp and lacks `MODEL_ARCH.GRANITE_SWA`; the
   converter needs `gguf-py` from the same commit.

---

## D21 — First evidence that the model actually works

`.probe/`'s smoke run, which prompts the Q8_0 GGUF through node-llama-cpp with greedy decoding,
produces coherent on-task output — for example, prompted to shorten a title, it returns
`"Windows MLX checkpoint dequantization guide"`.

This is not the quality gate and does not substitute for it: those smoke prompts were ad-hoc rather
than the trained instruction, and one of them echoed its own input, which is the known failure mode
for this model when it is not given the prompt it expects. It is recorded here only as evidence that
the weights dequantized correctly and the model is capable of the task — the gate is still Task 3,
and it still decides whether the project continues.

---

## D22 — The chat prompt was still not the one the model was trained on

D6 caught that the plan sent a raw prompt with no role markers. Fixing that with a plain
`LlamaChatSession` got the role markers right but left two smaller fidelity gaps, both found by
rendering the actual prompt rather than trusting the wrapper:

1. **`add_generation_prompt` is not passed by default.** The template's final block emits
   `<|start_of_role|>assistant<|end_of_role|>` only when that flag is set; node-llama-cpp's
   `JinjaTemplateChatWrapper` renders without it, so the prompt ended at `<|end_of_text|>\n` with
   no assistant opener at all. Measured directly: the tail was
   `…base image has no arm64 variant\n<|end_of_text|>\n` instead of
   `…<|end_of_text|>\n<|start_of_role|>assistant<|end_of_role|>`.

2. **node-llama-cpp injects its own system message.** Its default is
   `"You are a helpful, respectful and honest assistant…"`, whereas the Granite template's own
   default — and therefore what the fine-tune saw in training — is
   `"You are a helpful assistant. Please ensure responses are professional, accurate, and safe."`

**Resolution.** The engine binds the template explicitly and passes the flag:

```ts
new JinjaTemplateChatWrapper({
  template: CHAT_TEMPLATE,
  additionalRenderParameters: { add_generation_prompt: true },
})
```

with `systemPrompt: ""` on the session. Verified by rendering: the prompt is now exactly
`<|start_of_role|>system<|end_of_role|>{g4 default}<|end_of_text|>` + a user turn containing
instruction, blank line, `PASSAGE:`, clip + `<|end_of_text|>` + `<|start_of_role|>assistant<|end_of_role|>`.

`CHAT_TEMPLATE` is exported from `src/core/prompt.ts` so the engine prompts with the same
hash-pinned bytes the GGUF embeds (D20 confirms they are identical) rather than relying on
auto-detection. Note the wrapper belongs on `LlamaChatSession`, not `loadModel` —
`LlamaModelOptions` has no `chatWrapper` field.

## D23 — `backend` reported the string `"false"` on CPU fallback

The plan writes `String(llama.gpu ?? "cpu")`. node-llama-cpp sets `llama.gpu` to the boolean
`false` — not `undefined` — when no GPU backend loads, and `??` only catches null and undefined.
So the CPU path produced the literal string `"false"` as the backend name, which would then appear
in `doctor`'s output and in every `TitleRecord`. Fixed to `llama.gpu || "cpu"`.

## D24 — GPU acceleration works, and Vulkan is the right backend on this machine

The user asked for GPU by default. Verified on this machine:

| Requested | Result |
|---|---|
| `gpu: "auto"` | **`vulkan`** — 29 of 29 layers offloaded |
| `gpu: "vulkan"` | works |
| `gpu: "cuda"` | `NoBinaryFoundError`: *"The prebuilt binary for platform "win" "x64" with CUDA support is not compatible with the current system"* |

So `gpu: "auto"` already does the right thing here and needs no override. CUDA is not reachable
through node-llama-cpp's prebuilt binaries on this machine; Vulkan drives the GPU instead.

One trap worth recording, because it cost real time: node-llama-cpp verifies its native binding by
`child_process.fork`-ing a test process, and `fork` propagates the parent's `execArgv`. Running a
probe as `node -e "…" --input-type=module` therefore breaks the child, the binding check fails, and
`getLlama` silently reports `gpu: false` — indistinguishable from a machine with no GPU. The same
API tested from a real `.mjs` file returns `vulkan`. Diagnose GPU problems from a file, never from
`node -e`.

## D25 — First real end-to-end evidence

The engine, built and run against `.probe/title-q8_0.gguf` with the template bound as above,
produces:

| Clip | Title | Description |
|---|---|---|
| token expiry comparison in auth middleware | `Change token expiry check to <=` | `The current comparison is set to < instead of <= to fix the auth middleware.` |
| docker build failing on arm64 | `Docker build fails on arm64` | `The base image lacks an arm64 variant, causing the build to fail.` |

Both are factual, specific, correctly registered, in the right word range, and neither echoes its
input. All 35 tests pass against the real model, including the three that load and run it.

This is encouraging but it is two clips, not a gate. Task 3's 40-transcript eval is still the
thing that decides whether the project continues.

## D26 — `Omit<Request, "id">` does not typecheck, because `Omit` is not distributive

Found by the Task 10 agent while implementing `src/client.ts`.

`Request` is a discriminated union. `Omit<T, K>` is defined as `Pick<T, Exclude<keyof T, K>>`, and
`keyof` over a union yields only the keys common to every member. So `Omit<Request, "id">` collapses
to `{ id: never; method: never }` — every member-specific field, `params` included, is gone. The
plan's own next line then fails:

```
src/client.ts(69,56): error TS2353: Object literal may only specify known properties, and
'params' does not exist in type 'Omit<Request, "id">'.
```

Later tasks hit the same wall: plan lines 2814 and 3104 call
`request({ method: "list", params: { limit: 20 } })`.

Fixed in `src/client.ts` with a distributive helper, which keeps the plan's stated contract
("a `Request` without `id`") while letting each union member keep its own shape:

```ts
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export async function request<T>(req: DistributiveOmit<Request, "id">, …)
```

This is the only change to the plan's code block.

## D27 — `codex` is not on PATH, but the Codex Desktop app ships a CLI that is

I had earlier concluded that Codex was not installed on this machine. That was wrong, and the way it
was wrong matters for the adapter.

**Correction, added after independent verification.** The first version of this entry claimed
`where codex` finds nothing on this machine. That is false, and it was false when written: an
npm-installed shim exists at `C:\Users\asterxsk\AppData\Roaming\npm\codex.cmd`, and `where codex`
resolves it. The adapter's PATH-first resolution returns that shim, so the shipped behaviour is
correct — but the justification I wrote for it was not. The claim that matters is the narrower one:
`codex` is not reliably on PATH, and on a ChatGPT-desktop install it may not be there at all, so
resolution cannot be a bare `spawnSync("codex", …)`. The evidence below stands on its own.

`~/.codex/config.toml` records, inside an unrelated MCP server's env block:

```toml
CODEX_CLI_PATH = "C:\\Users\\asterxsk\\AppData\\Local\\OpenAI\\Codex\\bin\\7ac07f4ce733f89a\\codex.exe"
```

That file exists (295 MB) and runs: `codex-cli 0.153.4`. So the CLI is present at a
content-hashed path under `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`, and `~/.codex`
is marked `.desktop-created` with `"originator": "Codex Desktop"` in every `session_meta`.

This is not a quirk of this machine. It is the normal shape of a ChatGPT-desktop install — and the
desktop app is one of the two Codex targets the user named ("codex + chatgpt app"). The plan's
`notify.mjs` calls `spawnSync("codex", ["app-server", …])`, which on such a machine fails with
`ENOENT`, `spawnSync` swallows it, and the adapter silently never titles anything.

The adapter must resolve the CLI explicitly: `CODEX_BIN` override → `PATH` → the newest
`%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe` (or the `macOS`/`Linux` equivalents). I read the
desktop app's stable-looking hash directory rather than hard-coding it.

## D28 — The Codex app-server requires an `initialize` handshake; the plan's RPC is rejected

The plan's `notify.mjs` sends exactly one message to a freshly spawned app-server:

```js
spawnSync("codex", ["app-server", "--listen", "stdio://"], { input: rpc + "\n", … });
```

Measured against the real 0.153.4 binary, that message is refused:

```
$ node .probe/codex/probe.mjs
initialize -> {"id":1,"result":{"userAgent":"quick-titles-probe/0.153.4 …"}}
thread/name/set(bogus) -> {"error":{"code":-32600,"message":"no rollout found for thread id 00000000-…"},"id":2}
thread/list -> 5 rows
bare thread/name/set, no initialize -> {"error":{"code":-32600,"message":"Not initialized"},"id":1}
```

`-32600 "Not initialized"`. The app-server needs `initialize` with a required `clientInfo`
(`{ name, version }`, per `InitializeParams` in the generated schema) before it will serve any
other method. So the adapter's single write never lands — and because the plan's contract tests only
grep the source text for `"thread/name/set"` and `payload["thread-id"]`, all four of them still pass
while the adapter does nothing.

Two things this validates in the plan's favour, worth recording so they are not "simplified" later:

- `--listen stdio://` **is** a real flag on 0.153.4 (there is also a `--stdio` shorthand), so the
  transport choice was right.
- `notify`'s payload shape and delivery are exactly as assumed. From `codex-rs/hooks/src/
  user_notification.rs`, the payload is `#[serde(tag = "type", rename_all = "kebab-case")]` with
  `thread_id`/`turn_id`/`cwd`/`input_messages`/`last_assistant_message` serialised kebab-case, so
  `payload["thread-id"]` and `payload.type === "agent-turn-complete"` are both correct. The JSON is
  appended as the final argv element (`command.arg(notify_payload)`) with `Stdio::null()` on stdin,
  so reading argv rather than stdin is also correct.

## D29 — The Codex write path is validated end to end, against the real binary

With the handshake added, `thread/name/set` works, synchronously, and lands where the user sees it.
Measured by renaming one existing thread and restoring it (`.probe/codex/resolve-name.mjs`):

```
target thread: 01a093e6-3409-7023-b5e0-b3c99b9fff4a
original name: "Add metadata, diagnose subagents"
set -> ok
  poll 0 (~0ms)  thread/list.name = "quick-titles probe (safe to ignore)"  db.name = "quick-titles probe (safe to ignore)"
  …
restore -> ok
restored name: "Add metadata, diagnose subagents" (exact)
```

So the rename is visible in `thread/list` **and** in `state_5.sqlite`'s `threads.name` immediately,
with no flush delay. `threads.name` is the sidebar label; `threads.title` is a different column
holding the full first user message, and is not what we write.

One boundary case, from the same probe: naming a **just-created, turn-less** thread
(`thread/start` then immediately `thread/name/set`) returns `ok` but `thread/list` still reports
`name: null` for it. `thread/name/set` needs a persisted rollout — a `thread/start` with no turns has
none. This does not affect the adapter, because `notify` fires after a completed turn, when the
rollout exists. It does mean the plan's Step 5 verification is sound and its expected result is real.

Ground truth for all of the above was generated from the installed binary rather than read from a
README: `codex app-server generate-json-schema --out .probe/codex/schema --experimental` (416 files,
4.9 MB). It confirms `thread/name/set` with required `{ threadId, name }`, an empty-object response,
and a `thread/name/updated` notification carrying `{ threadId, threadName }`.

## D30 — `notify` is a single-valued key, so install cannot merge with an existing notifier

`notify` is one argv array at user level (`Option<Vec<String>>` in `codex-rs/core/src/config.rs`),
and project-local `.codex/config.toml` is explicitly ignored for it. There is no array to append to,
so a machine that already has a notifier cannot gain a second one without one of them wrapping the
other.

This machine is exactly that case: `~/.codex/config.toml` already points `notify` at
`codex-computer-use.exe … "turn-ended"`. The plan's `install.mjs` correctly refuses rather than
clobbering it, and prints the line to add by hand. I am keeping that behaviour — silently rewriting
someone's existing notifier is worse than asking — but it means Codex support is a documented manual
step for anyone who already has notifications configured, which is most desktop users.

Rejected alternative, for the record: driving Codex from `~/.codex/hooks.json` instead. Hooks are
append-friendly (an array per event) and hand the hook `session_id` directly on stdin, but Codex
gates them behind a `trusted_hash` recorded in `config.toml` (`[hooks.state."…:user_prompt_submit:0:0"]`),
so a hook installed unattended does not run until the user approves it, and no hook return field can
set a thread name — `UserPromptSubmitHookSpecificOutputWire` is `deny_unknown_fields` with only
`eventName` and `additionalContext`. The plan's reasoning for choosing `notify` holds.

---

*Entries D31 onward were written after Phase 6 (the four host adapters) and after the quality gate
had been run, re-run and rewritten several times. They are recorded in the order the work happened.*

## D31 — The quality gate's first harness measured a path that does not ship

Task 3's eval harness hand-rolled its own `LlamaChatSession` over a single long-lived context
sequence and re-used it for all 40 transcripts. It reported that 28 of 40 rows produced the
**byte-identical** output `Audit of Claude Code workflow`, with per-row times climbing from ~1.5 s to
18.6 s. Read cold, that looks like a model failure, and it is exactly the kind of result that kills a
project.

It was a harness bug. Running the same clips through the shipping `TitleEngine` produced distinct,
correct titles in about a second each:

| Clip | Harness said | Shipping engine said |
|---|---|---|
| cc-15 | `Audit of Claude Code workflow` | `Running npx fallow and inspecting results` |
| codex-01 | `Audit of Claude Code workflow` | `Using the Codex agent browser CLI` |
| oc-03 | `Audit of Claude Code workflow` | `Fixing zoomed out UI elements in Udyog-Saarthi` |
| pi-01 | `Audit of Claude Code workflow` | `Finding malware and security skills` |

**Resolution — a rule, not just a fix.** The gate now drives `TitleEngine` from
`src/core/inference.ts` rather than re-implementing it. A gate that measures a path nobody ships is
worse than no gate: it produces confident numbers about the wrong thing. Whatever else changes, the
quality gate must call the code the user calls.

## D32 — The gate's failure modes were in our decoding and validation, not the weights

With the harness corrected, the gate's own verdict was: **FAILED on reliability.** 35 of 40 titles
were good, 5 were not, and 3 of those were visibly broken:

| Raw output | Failure |
|---|---|
| `Blender MCP MCP MCP MCP MCP MCP MCP` | repetition loop under greedy decoding |
| `Write a factual title (3-8 words) and 1-2` | the *trained instruction* echoed back |
| `User: I have hunyuan installed (3d ai generated` | the transcript's first line echoed back |
| `Statements about the design and implementation split are` | truncated sentence fragment |
| `Reviewer:*No visual feedback yet.*` | a fragment of the transcript's own scaffolding |

Plus: 20 of 35 descriptions were cut off mid-sentence at the 64-token cap.

Four of those five are ours to fix, not the model's:

| Fix | Where |
|---|---|
| `maxTokens` 64 to 128 | `src/core/inference.ts` |
| One corrective retry with repetition penalties (first attempt untouched) | `src/core/inference.ts` |
| Reject token loops, instruction echoes, transcript-opening echoes, scaffolding fragments | `src/core/parse.ts`, `isAcceptableTitle` |
| Return **no** title when both attempts are unusable, leaving the host's own title in place | `titleWithRetry` |

The retry leaves the first attempt unchanged on purpose: the gate showed 35 of 40 transcripts title
correctly under plain greedy decoding, and changing the sampler for those would be changing
behaviour that already works. It runs only on the rows that already failed.

Re-measured over the same 40 transcripts, through the shipping engine:

| Counter | Before | After |
|---|---|---|
| titled | 40/40 (5 of them defective) | 37/40, 3 refused |
| catastrophic outputs | 4 | **0** |
| descriptions complete | 20/35 | 36/36 |
| median ms | 1158 | **777** |
| max ms | 18567 | 3406 |

`cc-18`, which produced the `MCP MCP MCP` loop, now reads `Blender MCP scaling and color plan` — the
retry rescued it. The three refusals are `codex-08` and `oc-01` (raw output was a dumped `FILES:`
list, parsed as the single word `FILES`) and `oc-02`.

**Two guards were tried and one was wrong.** An earlier version of the echo check rejected any title
whose words mostly appeared in the transcript. It refused `Custom plugin for OpenCode 2` — a good
title, for a session whose user had literally asked for "a custom plugin for opencode 2" — and it
refused `Claude Code status line schema and agent view` for the same reason. A title drawn from the
passage's vocabulary is not an echo; that is the job. The check is now narrow: a run of words from
the *instruction*, or a title that is the *opening* of the transcript. Both regression cases live in
`tests/core/gate.test.ts`, named as regressions.

## D33 — `.probe/` was deleted mid-run by a concurrent agent, taking the model with it

`.probe/title-q8_0.gguf` (378,137,504 bytes) and the whole conversion workspace were removed while
the quality gate was still running, so the numbers above could not be reproduced from the tree
afterwards. It is not recoverable: gitignored, not in the recycle bin, and not in the HF cache.

**The cause was mine.** `.gitignore` described `.probe/` as *"local model probe + conversion
workspace (throwaway, holds weights and GGUFs)"*. An agent read "throwaway", cleaned up, and was
right to. The comment is corrected to say what is actually true: the contents are regenerable in
principle and expensive in practice, and the GGUF is a build artifact under test.

Rebuilding it is a full MLX 6-bit dequant plus a llama.cpp conversion (see D20), running as the
`quick-titles-rebuild-model` workflow.

Two lessons worth keeping. A deictic comment in a file an agent reads — "throwaway", "temp", "safe to
delete" — is an instruction, and it will be followed. And an artifact that exists on one disk,
gitignored, with no fast way to rebuild it, is one concurrent cleanup away from destroying an
afternoon of measured work.

## D34 — Independent verification found a silent no-op in three of the four adapters

Every adapter was built by one agent and then attacked by a second whose brief was to refute it.
That pass earned its cost: three of the four shipped broken in a way their own tests could not see,
because in each case the failing path looks exactly like the succeeding one.

| Adapter | Verdict | Defect |
|---|---|---|
| Claude Code | flawed | Nothing ever starts the daemon |
| opencode2 | **broken** | Reads the session id from the wrong field |
| Codex | flawed | `notify` written into the wrong TOML table |
| Pi | solid | Ignores `PI_CODING_AGENT_DIR` |

**Claude Code.** `session-start.mjs` called `client.ensureDaemon().catch(() => {})` without awaiting
it, then reached `process.exit(0)` in the same synchronous continuation, so `ensureDaemon` died at
its first `await` and never reached its `spawn`. Nothing else in the adapter called it at all. On a
machine with no already-running daemon the plugin emitted no title, exited 0, and would have done so
forever. The verifier proved it by copying `dist/client.js` and injecting markers either side of the
spawn line: the unawaited call printed the entry marker and never the spawn marker; an awaited
control printed both.

**opencode2.** The plugin read `event.data?.sessionID`. opencode2 sends `event.properties.sessionID`
— confirmed in the installed SDK types (`EventSessionIdle = { id, type, properties: { sessionID } }`)
and in the working plugin already at `~/.config/opencode/plugins/herdr-agent-state.js`, then
empirically by driving the real `setup()`: the `properties` shape produced a rename, the `data` shape
produced nothing. The adapter would have no-opped on every event, on every machine.

**Codex.** `install.mjs` appended `notify = [...]` at end of file. TOML attaches a bare key to the
table it follows, and the user's own `config.toml` ends with `[hooks.state."…"]` — so the notifier
registered inside `hooks.state` and never took effect. The verifier proved it with `tomllib`. The
write path itself was separately proven against the real 0.153.4 binary, including a live
`thread/name/set` round trip that renamed a scratch thread and restored an existing one exactly.

**Pi.** Installed to a hardcoded `homedir()/.pi/agent/extensions`, ignoring `PI_CODING_AGENT_DIR`,
which sets the directory Pi's own loader scans. The same silent-no-op shape as the other two.

The pattern is worth naming, because it is the whole reason for this phase: all four defects are
invisible from a green test run, and three of the four are "the host never calls us". The verifiers
found them by running each adapter against an absent host and asking what happened, which is the one
question the implementers' tests were not asking.

## D35 — `ensureDaemon` could spawn a second daemon, could not be bounded, and spawned on a machine with no model

**Found:** 2026-09-14, by the independent verifier that also wrote D34, as four separate
reproductions against `src/client.ts`.

Every one is the same architectural fact: a daemon that is *spawned but still loading its model*
has not bound its socket yet, so "ping failed" does not mean "no daemon is coming".
`src/daemon/main.ts` calls `TitleEngine.create()` (4.8–5.6 s) before `startServer()`, and only
writes `pidFile()` after `startServer()`, so during that whole window the daemon is invisible to
both a ping and the pid file.

1. **Duplicate spawn.** `ensureDaemon` had no single-flight guard, so a `UserPromptSubmit` landing
   during `SessionStart`'s load window missed the ping and spawned a *second* full daemon.
   Reproduced with a daemon that takes 3 s to bind: the spawn log read `boot 11656` then
   `boot 19076`, and the second then logged `listen-fail 19076 EADDRINUSE`. On unix it is worse:
   `startServer` unlinks `opts.socketPath` before listening (`src/daemon/server.ts`), so the
   duplicate unlinked the first daemon's socket, stole the path, and orphaned daemon #1 forever.

2. **Live-but-wedged daemon duplicated.** A live pid in `pidFile()` means "busy", not "absent"; the
   old code ignored the pid file entirely and spawned anyway.

3. **Model-not-installed stall.** With no model provisioned the spawned daemon dies on load, but
   every prompt still paid the full 12 × 500 ms poll — a user-visible stall on every untitled
   session on a machine that can never answer.

4. **No budget.** The cost was a fixed 12 × 500 ms; callers could not bound it.

**Resolution.** The four fixes compose, in this order:

*ping(500 ms) → live-pid guard → model short-circuit → single-flight lock → spawn → poll every
250 ms within a total budget.*

The lock is `join(dataDir(), "daemon.lock")`, created with `openSync(path, "wx")` (atomic
create-exclusive) and written with our pid. On `EEXIST` the lock is reclaimed at most once if its
pid is dead (`process.kill(pid, 0)` throws `ESRCH`; `EPERM` is alive) or its mtime is older than
30 s; otherwise another process is spawning and we only poll. It is released in a `finally`, and
only when we created it. `opts.timeoutMs` (default 6000, unchanged in effect) is now a **total**
budget for the whole call, and `generate(req, opts)` forwards its `timeoutMs` to `request`
(default 15 s).

**One deliberate addition to the prescribed order:** immediately after acquiring the lock we ping
once more before spawning. Without it, a caller that lost the lock race can still acquire it a
moment later — after the winner has answered, released the lock and returned — and spawn a
duplicate of a daemon that is now up and healthy. The re-ping closes that window; the invariant is
"at most one spawn", and the literal lock→spawn→poll order does not by itself preserve it.

**Evidence.** `tests/client.test.ts` drives two concurrent child processes (the race is
cross-process; an in-process `Promise.all` would not exercise the on-disk lock) against the
`QUICK_TITLES_DAEMON_ENTRY`/`QUICK_TITLES_SOCKET` seams from `tests/adapters/claude-code.test.ts`.
Against the pre-fix client the duplicate test failed with
`expected [ '18884', '22924' ] to have a length of 1 but got 2`, and the model test failed with
`expected true to be false` — the pre-fix code spawned the stub and pinged it successfully through
the empty temp data dir. After the fix: exactly one boot line; the model short-circuit returns
false in under 500 ms having spawned nothing; a live pid in `pidFile()` suppresses the spawn; a
daemon that never binds is spawned once and gives up inside the budget. Worst-path wall clock at
the default budget is the 6000 ms deadline (the loop exits when `Date.now()` passes it, and each
poll ping is itself clamped to the remaining budget).

`tests/adapters/claude-code.test.ts`'s two cold-start tests now set `QT_MODEL`, because they assert
the *spawn* path and the new short-circuit correctly refuses to spawn when no model is installed;
that is the test simulating a provisioned machine, not a change to what ships.

## D36 — The Claude Code hook's retry ordering put its worst path past the host's 25 s timeout

**Found:** 2026-09-14, while bounding the hook adapters against the client API D35 landed.

**Problem.** `user-prompt.mjs` ran `generate()` first, then on a miss `ensureDaemon()`, then
`generate()` again — with no `timeoutMs` on either call, so each inherits the client's 15 s default.
Against a daemon that has bound its socket but never answers, the path is: 15 s for the first
generate, 500 ms for ensureDaemon's missed ping, up to 6 s of poll while it spawns a duplicate, then
another 15 s for the retry. `hooks/hooks.json` gives UserPromptSubmit `"timeout": 25`, so the host
kills the hook mid-flight and the adapter emits nothing — the silent no-op this whole workflow
exists to remove. The pre-fix hook did one generate (15 s), so the "safety" retry had *lengthened*
the pathological path from survivable to fatal. The same shape catches a merely slow daemon: any
start past the first 15 s timeout adds a second up-to-15 s generate and blows 25 s.

**Evidence.** `tests/adapters/claude-code.test.ts`'s wedged-daemon test binds a socket that accepts
connections and never writes a byte, sets `QT_MODEL` so `ensureDaemon` cannot take its fast
no-model short-circuit, and runs the real hook. Against the pre-fix source it measured **36116 ms**
(`expected 36116 to be less than 20000`) — well past the 25 s the host allows, so the hook would
have been killed and emitted nothing. Against the fix it is **13130 ms**.

**Fix.** One `ensureDaemon`, then one `generate`:

```js
await client.ensureDaemon({ timeoutMs: 5000 }).catch(() => {});
const title = (await client.generate(req, { timeoutMs: 8000 }))?.title;
```

Worst path 500 ms ping + 5000 ms poll + 8000 ms generate = 13.5 s, inside 25 s with 11.5 s of
margin; warm path unchanged. `session-start.mjs` takes the same shape with `ensureDaemon(8000)`
and, on the `QT_TITLE_ON_RESUME` path, `generate(…, { timeoutMs: 8000 })` — worst path 16.5 s inside
its 30 s. The prompt-counter logic, the `dataDir` guard, the `readStdin` guard and the comment
explaining why `ensureDaemon` must be awaited (D34: fired and forgotten it never reaches its
`spawn()` before `process.exit`) are all unchanged.

**Two test consequences of moving the ping ahead of the generate.** The fake daemon now counts
*generates*, not all requests — otherwise every assertion that "exactly one generate happened"
would have read 2, since the hook pings first. And the cold-start stub appends a boot line per
spawn instead of overwriting its pid marker, so `spawns at most one daemon on a cold
UserPromptSubmit` can actually count them.

## D37 — Whitespace-only overrides still leaked relative state paths, and the Claude Code hook kept a second data-dir rule

**Found:** 2026-09-14, by independent verification of the previous round's empty-string fix.

**Problem (GAP 1).** The empty-string guard tested truthiness (`process.env.X || fallback`),
and `" "` is truthy, so an all-whitespace value was accepted as a path. Measured against the
pre-fix `src/paths.ts`:

| Override set to `" "` | Resolved value |
|---|---|
| `QUICK_TITLES_DATA_DIR` | `" "` — not absolute |
| `XDG_DATA_HOME` (linux) | `" \quick-titles"` — relative |
| `LOCALAPPDATA` (win32) | `" \quick-titles"` — relative |
| `QUICK_TITLES_SOCKET` | `" "` |

A relative data dir means the cache and title store are written under whatever cwd the host
happens to have — for the opencode2 adapter, the user's project directory.

**Resolution.** A single `envPathOverride(name)` helper returns `undefined` for an unset, empty,
or all-whitespace value and the raw value otherwise; all four reads go through it. Only the
all-whitespace case falls through: a value with any non-whitespace content is returned
**verbatim**, because leading and trailing spaces are legal in unix paths and trimming a real
value would corrupt it. The test `uses a path with legitimate surrounding spaces verbatim rather
than trimming it` pins that decision.

**Problem (GAP 2).** `adapters/claude-code/scripts/user-prompt.mjs:9` read
`CLAUDE_PLUGIN_DATA || QUICK_TITLES_DATA_DIR || ""` and never called `paths.dataDir()`. With both
unset the hook exited 0 and never titled; with only `CLAUDE_PLUGIN_DATA` set its `prompts-<id>`
counter lived somewhere different from the data dir `src/paths.ts` computes, so the title store
and the counter disagreed about where state lives.

**Resolution.** `dataDir()` in `src/paths.ts` now resolves `CLAUDE_PLUGIN_DATA` first, then
`QUICK_TITLES_DATA_DIR`, then the platform default — one rule, in one place. The hook loads the
compiled module (the new `loadPaths()` in `lib.mjs`) and calls `dataDir()`; its direct read is
gone. Every other consumer (client, daemon, opencode2's `cacheDir`) already went through
`paths.ts` and inherits the change.

**Evidence.** Against the pre-fix tree, seven new tests fail: the four whitespace variables
above (`expected ' ' to be '\home\u\.local\share\quick-titles'`; `expected ' \quick-titles' to
be 'C:\Users\u\AppData\Local\quick-titles'`), `CLAUDE_PLUGIN_DATA` being invisible to
`paths.dataDir()` (`expected '\home\u\.local\share\quick-titles' to be '/plugin/data'`), and both
hook tests — `titles from the platform data dir when no override is set` (the old hook emitted
nothing, `SyntaxError: Unexpected end of JSON input`) and `writes its prompt counter where
paths.dataDir() resolves` (`ENOENT`, the counter was in the other directory). After the fix all
33 tests in the two files pass; the full suite is 153 passed, 5 skipped.

**Other adapters audited.** opencode2 (`plugin.ts` uses `cacheDir()`) and Pi both resolve through
`dist/paths.js`, so they inherit the fix. `adapters/codex/notify.mjs` reads `LOCALAPPDATA`, but
only to locate the Codex CLI binary — a different question, not a second copy of the data-dir
rule. No other adapter or script re-reads the variables.

---

## D38 — The Codex installer's notify guard was a regex over TOML, wrong in both directions

**Found:** 2026-09-14, by the independent verifier that also wrote D34, attacking
`adapters/codex/install.mjs`.

**Problem.** The clobber-check was `/^\s*notify\s*=/m`. A regex over TOML cannot tell a key from
a string, and this one was wrong in both directions:

- **False refusal.** A config containing a triple-quoted or literal string with a line
  `notify = 5` matches the pattern, so the installer exits 1 and refuses to install even though
  no root `notify` key exists anywhere.
- **Missed duplicate.** A quoted root key — `"notify" = [...]` or `'notify' = [...]` — does not
  match, so the installer prepends a *second* `notify`. TOML forbids duplicate keys: the user's
  config becomes invalid and Codex fails to start. That is strictly worse than refusing.

This is the same mistake as the insertion defect in D34 (inserting before a line that merely
began with `[`, which also matched *inside* a triple-quoted string): treating TOML as text.

**Resolution — parse, don't pattern-match.**

1. Parse the file with a real parser and test the parsed document:
   `Object.prototype.hasOwnProperty.call(parsed, "notify")`. A quoted root key parses to the same
   `notify` property as a bare one; a `notify =` line inside a string is just string content and
   never becomes a key.
2. If the file does not parse at all, refuse, change nothing, and say so — do not "fix" a config
   we cannot read.
3. Prepend the key as before. A bare key with nothing above it is a root key by definition; that
   logic was proven correct in D34 and is unchanged.
4. **Re-parse the result** and require both that `parsed.notify` deep-equals the exact array we
   wrote and that every other key, table and value is unchanged (`isDeepStrictEqual`). On any
   failure, restore the original file byte-for-byte from the in-memory copy and exit non-zero.
   The write into a user-owned file is never trusted on faith.

**Dependency choice and cost.** No TOML parser was in the tree, so one was added: `smol-toml`
(`^1.8.0`) — **zero dependencies**, ESM-native, TOML 1.1.0, `parse`/`stringify` only. `npm
install smol-toml` reported `added 1 package`. It is a runtime `dependencies` entry, not a
devDependency, because `install.mjs` ships and runs on the user's machine. The cost is one small,
actively-maintained, dependency-free package, against hand-rolling a TOML parser to gate a write
into someone else's config.

**Evidence.** Five tests in `tests/adapters/codex.test.ts` fail against the pre-fix installer and
pass after: a triple-quoted basic string containing `notify = 5` (pre-fix printed `a notify entry
already exists` instead of installing), a single-quoted literal string with the same (pre-fix
exited 1), a `"notify"` root key (pre-fix exited 0 and wrote a duplicate), a `'notify'` root key
(same), and an unparseable file (pre-fix printed the clobber message instead of a parse
diagnostic). Pre-fix summary: `Tests 5 failed | 25 passed | 1 skipped`; post-fix:
`Tests 30 passed | 1 skipped`. The existing shapes — empty, comments-only, table-first, no
trailing newline — still round-trip, and the BOM case is now explicit: `smol-toml` rejects a
leading BOM, so the parse path strips one and the write path re-attaches it, with a test
asserting `charCodeAt(0) === 0xfeff` survives.

## D39 — The Pi installer's dynamic-import fallback re-implemented half of the SDK's path rule

**Found:** 2026-09-14, by an independent verifier that refuted the fallback and named two inputs
where it diverged from the SDK.

**Problem.** `adapters/pi/install.mjs` resolved Pi's agent directory with `getAgentDir()` and, when
the SDK was not importable, fell back to a hand-written copy of the rule. The copy implemented only
the truthiness check, the `~`/`~/` expansion and the `<home>/.pi/agent` default. It omitted the two
other branches of the SDK's `normalizePath()`:

- **`normalizeWindowsShellPath()` (win32).** `/c/agent`, `/mnt/c/agent` and `/cygdrive/c/agent`
  resolve to `C:\agent` in the SDK; the fallback returned them unchanged, so `join(value,
  "extensions")` produced a drive-relative `\c\agent\extensions` and the extension was installed
  where Pi never scans.
- **`fileURLToPath()` for `file://` values.** `PI_CODING_AGENT_DIR=file:///D:/agentdir` resolves to
  `D:\agentdir` in the SDK; the fallback passed the literal through, `mkdirSync` threw an uncaught
  `ENOENT`, and the installer exited 1 — the exact "no extension and no explanation" failure the
  fallback's own comment claimed to have removed.

**Why the fallback existed.** The SDK is a devDependency; an earlier top-level `import` exited 1 with
`ERR_MODULE_NOT_FOUND` under `npm install --omit=dev`.

**Resolution — option (b): stop duplicating the rule.** The copied fallback is deleted. The installer
calls `getAgentDir()` and, if the SDK cannot be imported, exits non-zero with an actionable message
(`… It is a devDependency; \`npm install --omit=dev\` leaves it out. Install it and re-run: npm
install`) instead of guessing at a directory. Why this over a faithful re-implementation:

1. **A partial copy of someone else's path normaliser is a defect factory.** The verifier found two
   omissions in a nine-line function; every branch the SDK adds later — the caret range `^0.85.1`
   permits point releases — is another. Delegation cannot disagree with the authority by
   construction, for any input, tested or not.
2. **The absent-SDK case is nearly unreachable in practice.** The installer already refuses unless
   `dist/client.js` exists, and that file is produced by `npm run build` → `tsc`, itself a
   devDependency. If the SDK is gone, the build is gone too, so the installer normally exits earlier
   at the dist check. Reproducing the rule for a state the same devDependency omission makes
   unreachable was cost without payoff.
3. **Failure is actionable, not silent.** The one case the fallback protected (`--omit=dev` with a
   prebuilt `dist/`) now prints exactly what to run. A wrong-directory install is silent; an
   explained refusal is not — which is the D34 distinction this adapter exists to honour.

The installer's other resolution failures are caught through the same non-zero, stack-trace-free
path: the SDK resolving but `getAgentDir()` throwing (a malformed `file://`), and an unwritable
target directory.

**Tests.** `tests/adapters/pi.test.ts` gains two data-driven blocks. *SDK resolvable:* for an
absolute path, a relative path, `""`, unset, `"~"`, `"~/sub"`, `"   "` and (win32) `"~\sub"`, the
installer must land in exactly the directory a fresh process using the real SDK computes — the
expected value is read from the SDK, never derived from our own reading of the variable. *SDK
absent:* the installer runs from a copy outside the repository with `NODE_PATH` cleared, for
`/c/agent`, `/mnt/c/agent`, `/cygdrive/c/agent`, `file:///D:/agentdir`, `""`, `"   "`, `"~"`,
`"~/sub"`, `"~\sub"`, a normal absolute path and a relative path — each must exit 1, say what to do,
print no stack trace, and install nothing.

**Evidence.** Against the pre-fix installer, 11 mode-B tests fail and 20 pass
(`Tests  11 failed | 20 passed (31)`). Ten report `AssertionError: expected +0 to be 1` — the
fallback installed silently. The `file://` case reports
`AssertionError: expected 'node:fs:1651\r\n  const result = bind…' not to match /^\s+at\s/m`, the
uncaught

```
Error: ENOENT: no such file or directory, mkdir 'C:\Users\asterxsk\AppData\Local\Temp\qt-pi-ECgj8g\file:\D:\agentdir\extensions'
    at mkdirSync (node:fs:1651:26)
```

— the verbatim defect. After the fix: `Tests  31 passed (31)`.

## D40 — The Pi adapter raced its own daemon warm-up and let the client's 15 s default pick the bound

**Found:** 2026-09-14, while bounding the four adapters against the client API D35 landed
(the same pass that produced D36).

**Problem.** `adapters/pi/quick-titles.ts` started the daemon in the background and never
awaited it — `session_start` fired `ensureDaemon().catch(() => {})` — then on turn 1 called
`generate(req)` with no `opts` at all. Both calls therefore took the client's defaults:
`ensureDaemon` 6 s, `generate` 15 s. Pi is a long-lived process, so unlike the Claude Code hook
(D34) the spawn does eventually happen; but turn 1 still raced a cold daemon, whose model load is
4.8–5.6 s. Against a socket that is not bound yet the connection is refused at once and `generate`
returns null, so turn 1 titled nothing; against one that is bound but still loading it stalls for
most of 15 s. The old comment — "the third turn retries" — documented the race instead of removing
it.

**Evidence.** `tests/adapters/pi.test.ts` drives the real shipped extension against a fake Pi and a
stub client in `__QUICK_TITLES_DIST__`. Two new tests fail against the pre-fix source:

- A daemon that needs ~3 s to become reachable: `AssertionError: expected [] to deeply equal
  [ Array(1) ]`, the turn finishing in **9 ms** — it generated against the cold socket and set no
  name.
- A wedged daemon that accepts connections and never answers:
  `AssertionError: expected 'undefined' to be 'number'` on the recorded `timeoutMs` (no bound was
  passed), and the 16 s race guard fired because the turn never returned — the request was running
  to the client's 15 s default while `ensureDaemon` waited on nothing.

**Fix.** One awaited `ensureDaemon` before the generate on `turn_end`, plus an explicit `timeoutMs`
on both calls:

```ts
await ensureDaemon({ timeoutMs: ENSURE_MS }).catch(() => {});
const result = await generate({ … }, { timeoutMs: GENERATE_MS }).catch(() => null);
```

with `ENSURE_MS = 8000` (the 4.8–5.6 s model load plus margin) and `GENERATE_MS = 5000` (warm
inference is ~0.8 s median and 3.4 s worst in the quality gate). **Worst path 8000 + 5000 =
13000 ms** — the sum of two bounds this adapter chose, instead of 15 s plus an unbounded wait.
`src/client.ts` treats `ensureDaemon`'s `timeoutMs` as a *total* budget for the whole call (D35), so
the two are sequential and additive and neither can outrun its own number.

The healthy path is unchanged in cost: `session_start` still starts the load early — now itself
bounded by the same `ENSURE_MS` — and turn 1 waits out the same load it always had to, so the first
title still lands at roughly 6 s. The local `Generate` and `ensureDaemon` type declarations are
corrected to the real `src/client.ts` signatures (`opts?: { timeoutMs?: number }`), which is what
lets the options typecheck. Everything else is preserved: turn 1 titles, turn 3 retries, an existing
Pi name is never overwritten (`if (await pi.getSessionName()) return;`), the transcript path comes
from `ctx.sessionManager.getSessionFile()`, and the `DIST` token and `pathToFileURL` import are
untouched.

**Why the await is on `turn_end`, not `session_start`.** Awaiting the warm-up in `session_start`
would block session start on a 5 s model load. Awaiting it at the point of use — immediately before
the generate that needs the daemon — bounds only the turns that need a title (turns 1 and 3), not
every session.

## D41 — The Codex adapter never started the daemon and overwrote a user's thread name

**Found:** 2026-09-14, adapting `adapters/codex/notify.mjs`.

Both defects are the silent-no-op class D34 named: the failing path is indistinguishable from the
succeeding one, and each ships behind green tests.

**Defect 1.** `run()` called `generate()` and nothing else. `generate()` is a one-shot socket call
that returns `null` when nothing is listening, so on a machine with no already-running daemon the
Codex adapter produced no title on any turn, ever, exiting 0 each time. Every other adapter calls
`ensureDaemon()`; this one did not.

**Defect 2.** `run()` called `setThreadName()` unconditionally on every turn. Codex's sidebar name is
user-visible and user-editable, so a manual rename was clobbered by the next turn. The Claude Code
and Pi adapters both refuse to replace a name they did not write.

**Policy.** Write on turn 1 (early pass) and turn 3 (refine), and only when the thread's current name
is empty or is exactly the title we last wrote. That is the Pi adapter's cadence (turn 1 and turn 3,
behind a name guard), with one addition: Pi refuses whenever any name exists, but Codex has a second
pass by design, so the one name it may replace is the name it wrote itself. A user rename is neither
empty nor our previous title and is left alone — and because the decision is made from the current
name *before* generating, a rename costs neither a model run nor a daemon start.

**Turn state, on disk.** Codex passes a turn *id*, not a turn number, and `notify` is a fresh process
every turn, so the count cannot live in memory. Each thread gets one JSON file,
`dataDir()/codex-name-<threadId>.json`, holding `{turns, lastTitle}`. The turn is incremented before
any early return — turns 2 and 4+ must still advance it, or the cadence stalls on the next
invocation — and `lastTitle` is recorded only when the write is acknowledged, so a title that never
landed is not mistaken for ours on turn 3. The directory comes from the compiled `paths.dataDir()`
rather than a re-read of the environment, so the adapter keeps the one data-dir rule (D37).

**Read and write share one app-server session.** The read is `thread/list` — the method measured in
D29, whose rows carry `id` and `name`. `setThreadName` is refactored onto a shared `withAppServer`
helper and stays write-only, so its existing contract and tests are unchanged; the new sibling
`renameThread({ bin, threadId, resolveName })` handshakes (`initialize`, D28), reads the current name,
then calls `resolveName(current)` and writes its result, all against the single child.
`resolveName` is where `run()` applies the policy and runs `ensureDaemon()` + `generate()` between
the read and the write, so codex.exe (295 MB) is spawned once per turn, not once per step, and a name
the user set never starts a daemon at all. Every await stays bounded (ensureDaemon 5 s, generate 8 s,
app-server session 30 s), so a hung daemon cannot leak the process even though Codex gives notify no
timeout and does not wait for it.

**Tests.** `tests/adapters/codex.test.ts` updates one entry-point test and adds three. (a) With
nothing listening and `QUICK_TITLES_DAEMON_ENTRY` pointed at a stub that appends one pid per boot,
the adapter boots exactly one daemon and the title still lands. (b) A thread whose current name came
from the user is not overwritten: the stub log is exactly `["initialize","thread/list"]`, no
`thread/name/set` is sent, and the daemon is not even pinged. (c) Four sequential notify runs from
one data dir read, write, read, nothing: `thread/list` and `thread/name/set` presence are each
`[true,false,true,false]`, turn 4 writes no app-server log at all, and the state file reads
`{turns:4, lastTitle:"Generated Codex Title"}`. (d) The real-binary round trip stays behind the
existing `QUICK_TITLES_CODEX_E2E` gate. The pre-existing `setThreadName` ordering assertions are
untouched because that function remains write-only; the entry-point assertion was updated
deliberately to `["initialize","thread/list","thread/name/set"]`.

**Evidence (failing-first).** Against the pre-fix `notify.mjs` copied aside, the four tests fail:

```
 ❯ tests/adapters/codex.test.ts (34 tests | 4 failed | 1 skipped) 4995ms
   × carries a generated title from a turn-complete payload to thread/name/set
     AssertionError: expected [ 'initialize', 'thread/name/set' ] to deeply equal [ 'initialize', 'thread/list', …(1) ]
   × starts a daemon from a cold start and still lands the title
     Error: ENOENT: no such file or directory, open 'C:\Users\…\Temp\qt-codex-Dhuy6Q\boots.log'
   × never overwrites a thread name the user set by hand
     AssertionError: expected [ 'initialize', 'thread/name/set' ] to deeply equal [ 'initialize', 'thread/list' ]
   × writes on turn 1, refines on turn 3, and does nothing on turn 4
     AssertionError: expected [ false, false, false, false ] to deeply equal [ true, false, true, false ]
 Tests  4 failed | 29 passed | 1 skipped (34)
```

The cold-start test fails on the boot log rather than an assertion: the pre-fix adapter never spawned
anything, so the stub's log was never created. After the fix: `Tests 33 passed | 1 skipped (34)`; the
full suite is `175 passed | 5 skipped (180)`.

---

## D42 — The plugin manifest declared the hooks file Claude Code already loads

**Found:** 2026-09-14, confirming the Claude Code hook schema against the installed 2.1.270 bundle.

`.claude-plugin/plugin.json` carried `"hooks": "./hooks/hooks.json"`. The loader builds its list of
hook files as `[join(dir, CG), join(dir, Int), join(dir, "hooks", "hooks.json"), ...manifest.hooks]`
— the standard path is **always** in that list, before the manifest's own entries are appended. The
declaration therefore made the same file appear twice, and the duplicate check raised:

> Duplicate hooks file detected: … resolves to already-loaded file …. The standard hooks/hooks.json
> is loaded automatically, so manifest.hooks should only reference additional hook files.

at `level: "error"`, `type: "hook-load-failed"`. The key is for *additional* hook files only; a
plugin whose hooks live in the standard location must not declare them. Removed.

**Why it was not caught:** nothing in the repository validated the manifest, and the local validator
does not check hooks at all — see D43. The defect was found by reading the loader out of the
installed binary after a review of the hook schema raised the question, not by any test.

## D43 — `claude plugin validate` reports success on a broken `hooks.json`

**Found:** 2026-09-14, while looking for a way to check D42 mechanically.

The documented local validator was tested against a deliberately corrupt hooks file — an unknown
event name plus a bogus top-level key — in a throwaway copy of the plugin directory:

```
--- A: valid hooks.json ---
success: true | manifest errors: 0 | contents: 0
--- B: broken hooks.json (unknown top-level key + bad event) ---
success: true | manifest errors: [] | contents: 1
```

Both report `success: true` with zero errors. `contents` rises from 0 to 1, so the validator *sees*
the hooks component and declines to validate it. `--strict` behaves the same; it only promotes the
manifest warnings (it does correctly flag a missing `author`).

This is a negative result worth recording rather than a bug we can fix: it means **we have no local
check on hooks.json**, and the file that decides whether the entire Claude Code adapter runs is
validated by nothing but a live session. D42 is exactly the class of defect that would hide there.

## D44 — Two test suites leaked a temp directory per test into the OS temp directory

**Found:** 2026-09-14, after the user reported C: drive clutter.

`tests/core/store.test.ts` and `tests/daemon/server.test.ts` each called `mkdtemp(join(tmpdir(), …))`
in `beforeEach` and never removed the result — not a cleanup race, simply no cleanup. On this machine
`os.tmpdir()` is `C:\Users\<user>\AppData\Local\Temp`, and the accumulated evidence was:

```
qt-* dirs: 539
prefixes: 282 qt-store-, 234 qt-daemon-, 7 qt-harness-, 4 qt-client-, 2 qt-pi-, 1 qt-test-
```

516 of the 539 came from those two files.

**Fix.** `tests/helpers/tmp.ts` roots temp directories at `<repo>/.tmp` (gitignored) and exposes
`cleanupTempDirs()`, called from `afterEach`. The repository rule is that scratch space belongs under
the project directory; `os.tmpdir()` resolved to `C:` and so violated it even though the OS would
have cleaned up eventually. Verified: both suites pass and `.tmp` is empty afterwards.

**Note for future rounds.** Workflow agents copy the nearest pattern in a file, so one suite using
`tmpdir()` propagates it to every file an agent subsequently touches. Anything a prompt can specify
should be specified, rather than left to be inferred from surrounding code.

## D45 — `fallow`'s dead-code verdict was mostly an artifact of the repo being a host plugin

**Found:** 2026-09-14, on the first `fallow audit` run against the assembled tree.

The audit exited 1 with 18 dead-code issues, the largest bucket being `unused_files: 8` — every file
under `adapters/` plus `tools/eval/run-eval.mjs`. Each came with an `auto_fixable: false` action whose
description was **"Delete this file."** Acting on the report as presented would have deleted the product.

The cause is structural, and worth stating plainly because it will recur in any plugin repository:
quick-titles' adapters are **executables reached from outside the dependency graph**. Claude Code loads
`adapters/claude-code/scripts/*.mjs` by absolute path from `hooks.json`; Codex runs `notify.mjs` from an
argv array in `config.toml`; the opencode2 loader imports `plugin.ts`; Pi imports `quick-titles.ts`;
`run-eval.mjs` is run by hand. Nothing in the repository imports any of them, so from fallow's side of
the graph they are unreferenced — and fallow's `entry_points` came back as
`{"total": 15, "sources": {"plugin": 15}}`, i.e. it had only the plugin manifests to work from.

**Fix.** `.fallowrc.json` declares an explicit `entry` list. The list is load-bearing documentation, not
configuration noise: it is the only place that records "these files are reached from outside". It also
carries `ignorePatterns: ["spike/**"]`, because `spike/` (gitignored) otherwise contributed an
unused-dependency finding about a throwaway helper package. Result: **18 issues → 6.**

**What survived, and what it was worth.** Three were real or half-real:

- `readMarkerFile` in `adapters/claude-code/scripts/lib.mjs` — genuinely dead. Nothing writes
  `titled-<sessionId>` any more; the hook's later-turn logic now uses a turn-counter file. Its doc comment
  still describes a mechanism that no longer exists, which is the more misleading half.
- `tempDirSync` in `tests/helpers/tmp.ts` — unused at the time, and it turned out to be exactly what the
  four suites still calling `mkdtempSync` needed. Kept, not deleted.
- The build guard duplicated between the opencode2 and Pi installers — extracted to
  `adapters/shared/install-common.mjs`, so the message telling a developer to `npm run build` cannot drift
  between installers.

**One false positive survives and should not be acted on.** `unused_class_members: TitleEngine.dispose`.
That method has **11 call sites**, including `src/daemon/main.ts:20` and `tools/eval/run-eval.mjs:56` —
both declared entry points — and `tests/core/inference.test.ts` calls it eight times. `create()` is typed
`Promise<TitleEngine>`, so the receiver is unambiguously typed. fallow simply does not credit it.
`dispose` is load-bearing: it is what releases the llama.cpp context, model, and backend. Anyone reading
a bare `fallow audit` should be told this before they "clean up" a class member the engine needs.

**Remaining complexity findings are concentrated, not spread.** Seven of ten are in
`adapters/codex/notify.mjs`, the worst being `resolveCodexBin` (cyclomatic 14, cognitive 18). That file
carries the whole Codex write path — binary resolution across .cmd/.exe/shim layouts, an app-server
handshake, a read-modify-write on a thread name, and per-thread turn state — so the concentration is a
signal about scope, not a scattering of sloppy functions. It is left as-is deliberately: it is verified by
process-level tests and has already survived one adversarial round, and restructuring a working,
hard-to-test module to lower a number would be the wrong trade. The fifteen `large_functions` are almost
all single long `it()` bodies in the adapter suites, which is a test-style question rather than a
production one.

**Follow-up, after the last feature landed.** The audit now exits 1 with **one** dead-code issue, one
duplication clone group, and one complexity finding — and all three name the same file,
`" /extensions/quick-titles.ts"`, the artifact of an agent writing to a path with a leading space. That
one stray directory was producing three findings of three different kinds, including a 69-line clone group
(it is a near-copy of `adapters/pi/quick-titles.ts`) and a `crap: 90` complexity finding on code no one
maintains. It cannot be fixed without a deletion, which is on hold; it is item 1 of `to-delete.md`, and
removing it takes the audit to zero. Nothing else in the repository registers.

Entry points went from 15 to 31 once `.fallowrc.json` declared them (13 manual, 17 from the manifests,
1 from `package.json`), which is the measurement of how much of this repo fallow could not see before.

One new finding was silenced in config rather than in code, and the distinction matters:
`dev_dependencies_in_production: @earendil-works/pi-coding-agent`. The Pi installer imports that package
from production code, which reads as "move it to dependencies". It must stay a devDependency. Pi is the
host — its SDK lives in Pi's own prefix at the version Pi actually runs, and shipping our own copy would
give every quick-titles user the Pi SDK whether or not they use Pi, and let the installed extension answer
to a different version than the loader reading it. The import is deliberately optional, with a
hand-written equivalent of the SDK's `getAgentDir()` as the fallback branch; `npx` does not install
devDependencies, so for every published-package user that fallback is the only branch that runs. The
finding was right about the import and wrong about the fix, so it is recorded in `ignoreDependencies` with
the reasoning beside it.

---

## D46 — The `/sessions` listing must not go through the daemon, and the attribution was missing from two of the four places the spec requires it

Task 15's plan routes the listing through the daemon: the adapter imports `request` from
`dist/client.js` and calls `request({ method: "list", params: { limit: 20 } })`. That is
wrong, and the plan's own code proves it.

`request()` is transport-only — it connects to `socketPath()` and returns `null` when the
connect fails. It does not spawn (that is `ensureDaemon`, a separate export). The daemon is
started lazily by a session's **first prompt**, so the moment a user types `/sessions` it is
frequently not running yet. Following the plan would therefore print

```
No titles yet. Titles appear as you use your agents.
```

over a store with forty titles in it.

**Fix.** The listing reads the title store as a file. The store is append-only JSONL, so a read
is a plain file read with no lock and no socket. Nothing is spawned, nothing can time out, and
there is no state in which the answer is silently wrong.

**Evidence, and it is a mutation rather than an argument.** `tests/adapters/claude-code.test.ts`
runs the real `sessions.mjs` against a fixture store with `QUICK_TITLES_DAEMON_ENTRY` pointed at
a file that does not exist. Swapping the direct read back for the plan's `request({ method:
"list" })` call turns the test red with exactly the predicted output:

```
AssertionError: expected 'No titles yet. Titles appear as you u…' to contain 'Auth middleware refactor'
+ No titles yet. Titles appear as you use your agents.
```

Restoring the file returns it to green. The test asserts the decision, not a side effect of it.

**Two entry points, one renderer.** The plan specifies the Claude Code `/sessions` command;
`README.md` documents `quick-titles sessions` as the CLI subcommand. Both were built, sharing
`renderSessionList` in `src/cli/sessions.ts`, so the two cannot format differently. The CLI
subcommand is the one that works for all four hosts; the slash command is the one the spec
named.

**A licence gap this surfaced.** The spec's Attribution section requires the verbatim string
`Powered by Desert Ant Labs` in four places: the README, `quick-titles --version`, the
`/sessions` output, and the daemon's startup log. Two of the four were missing. `src/daemon/main.ts`
had it and the new renderer has it, but `--version` printed a bare version and the README
contained no such line — while the README simultaneously **claimed** the line appeared "here, in
`quick-titles sessions`, in `quick-titles doctor`, and in the daemon startup log", which was
false on two of those four counts. A licence obligation asserted in prose and absent from the
code is the worst version of this failure, because the claim is what a reader checks against.

All four now emit it, `doctor` added as a fifth surface, and the README says where it appears
because that is now true. `bin/quick-titles.mjs` keeps its own copy of the constant so
`--version` works from an unbuilt checkout; a test imports the exported one from
`src/cli/sessions.ts` and asserts the two are equal, so the duplication cannot drift silently.

`--version` prints the version on line 1 and the attribution on line 2, so
`$(quick-titles --version | head -1)` still parses. That is a deliberate cost: the alternative,
a single line, gives up the machine-readable contract.

**Two smaller calls.** Timestamps are stored as ISO8601 UTC; the listing renders them as
`2026-09-14 10:00 UTC` rather than a bare `2026-09-14 10:00`, which reads as local time and
would be wrong by the reader's UTC offset. And the slash command's body tells Claude to show the
block verbatim rather than summarise it, because the description and the attribution are the
content — a summary of a listing is not a listing.

---

## D47 — `files` in `package.json` shipped a package that could not load

**Found:** 2026-09-14, while adding the CI and release workflows (post-plan work).

Task 18 introduces packaging and release, but the plan never states what the published tarball
contains. Nothing in the repository did either: `package.json` had no `files` field, and its
`main` pointed at `index.js`, a file that has never existed.

**The defect.** Adding a `files` field and then actually inspecting the tarball with
`npm pack --dry-run --json` showed `src/core/prompt.ts` reads two files at import:

```ts
const assets = join(here, "..", "..", "assets");
const templateBytes = readFileSync(join(assets, "chat_template.jinja"));
const instructionBytes = readFileSync(join(assets, "instruction.txt"));
if (sha(templateBytes) !== TEMPLATE_SHA256) throw new Error("… does not match the pinned hash…");
```

`assets/` was not in `files`, so the published package would have shipped `dist/core/prompt.js`
without the two files it reads, and **every import of the prompt module in the published package
would have thrown at load time** — the daemon, the engine, and the whole product. From a checkout
everything passed, because a checkout has `assets/`.

This is the same shape as D45: the artifact is not the working tree, and every test in the suite
tested the working tree.

**Fix.** `assets/` is in `files`, and `main` is gone (there is no `main`; this is a CLI). Verified
by content, not by intent: 58 files, 45 KB, and every path the runtime reads is present, with no
`tests/`, `tools/`, `src/`, `docs/` or `spike/`.

**Pinned by `tests/packaging.test.ts`,** which packs the real tarball, unpacks it into a temp
directory outside the repository, and runs the shipped code there — `dist/core/prompt.js` (which
fails on a missing asset or a hash mismatch), `bin/quick-titles.mjs doctor` (which exercises the
paths, provisioning, and client modules without needing a model or a byte of `node_modules`), and
a `readdirSync` check that no checkout-only directory is published.

**Mutation-checked.** Removing `"assets/"` from `files` turns it red with the real failure, not a
proxy assertion:

```
AssertionError: expected [ …(58) ] to include 'assets/chat_template.jinja'
Error: the shipped prompt module failed to load: node:fs:697
```

Restoring it returns the suite to green.

**One environment note, recorded because it cost time.** Git Bash's GNU tar treats the `D:` in an
absolute Windows path as a remote-host spec, and Node passes backslash paths to it unescaped, so
`tar -xzf D:\… -C D:\…` fails with a bare "Command failed". The test runs tar with a `cwd` and two
relative arguments instead, which is portable to the macOS and Linux runners and sidesteps both
problems.

---

## D48 — CI's first run found a test that could only pass on Windows

**Found:** 2026-09-14, by the CI workflow added in the same session, on `macos-latest` (both Node 20
and 22).

```
FAIL tests/paths.test.ts > paths: whitespace-only environment variables > treats a whitespace-only LOCALAPPDATA as unset
 ❯ tests/paths.test.ts:186:35
AssertionError: expected false to be true
```

One test failed, on both macOS jobs, and nothing else did. The rest of the suite passed on macOS
unaided — including every adapter suite, which spawn child processes, bind sockets, and write to a
sibling directory outside the repository.

**The defect.** The test mocks `platform()` to `win32` and asserts the resolved data directory is
absolute:

```ts
osMock.platform = "win32";
osMock.home = "C:\Users\u";
process.env.LOCALAPPDATA = " ";
expect(dataDir()).toBe(join("C:\Users\u", "AppData", "Local", "quick-titles"));
expect(isAbsolute(dataDir())).toBe(true);   // line 186
```

`isAbsolute` is the **host's** implementation, and so is the `join` that builds the value.
`dataDir()` resolves the *branch* from the mocked platform but the *string* from the host's `join`.
On Windows that produces `C:\Users\u\AppData\Local\quick-titles`, which `win32.isAbsolute` accepts.
On macOS the same call returns a mixed-separator path that `posix.isAbsolute` rejects, so the
assertion asked a posix rule to bless a win32 path and got `false`. The test was written on
Windows, passed there, and could never have passed on the two platforms this project also ships to.

The file's own comment claimed a mutable holder "lets this file exercise every branch on any host."
True of branch selection. Not true of the resulting string shape, which is the thing line 186 was
asserting about — and that gap is exactly where this hid.

**Fix.** The assertion is gated on the mocked platform being the host's, with a comment saying why,
and it stays live on Windows where it means something. The host-independent `toBe` above it still
pins the branch on every platform. Every other `isAbsolute` call in the file mocks `linux` and is
unaffected.

**First attempt, reverted.** Rewriting all six assertions to use `posix.isAbsolute` or
`win32.isAbsolute` according to the mocked platform turned 8 of 18 tests red **on Windows**: the
values under test are built by the host's `join`, so a linux-shaped expectation arrives with
backslashes on Windows and fails a posix check. The lesson is the one above — the path's shape
follows the host, only the branch follows the mock — and the only honest assertion is one that
respects that. Restored and re-done.

**What this says about the matrix.** The obvious CI configuration, a single Linux job, would have
passed this and shipped it. The matrix is over operating systems first for exactly this reason:
this code has a `process.platform` branch in the paths module, the socket, the store location, and
the Pi installer's path normaliser.

---

## D49 — Nothing pinned the prompt assets to LF, so a Windows checkout could not load them

**Found:** 2026-09-14, by the same CI run, on `windows-latest` (both Node 20 and 22). Green on
ubuntu and macos at the same commit.

```
FAIL tests/packaging.test.ts > the published package > runs the pinned-hash check out of the unpacked package
Error: the shipped prompt module failed to load: .../dist/core/prompt.js:14
    throw new Error("assets/chat_template.jinja does not match the pinned hash; the vendored template was modified");
```

Every test file that statically imports `src/core/prompt.ts` also failed to load on those two jobs,
which vitest reports separately from failed tests — hence one named failure and a long list of
files. The real blast radius was the whole prompt path, on every Windows job, on a commit that was
green everywhere else.

**The defect.** `src/core/prompt.ts` compares the SHA-256 of `assets/chat_template.jinja` and
`assets/instruction.txt` against constants compiled into it, and throws at import when they differ.
That pin exists because the fine-tune was trained on a specific instruction and chat template, so
the bytes are the specification, not a formality.

The repository had no `.gitattributes`. On a Windows machine with `core.autocrlf=true` — the
default on GitHub's windows runners and on most Windows installs — `git clone` rewrites every LF in
those files to CRLF. The blob in the index was LF; the file on disk was not; the hash changed and
the module threw. The pin was doing its job: it caught a real byte-level difference. What was
missing was anything telling git those bytes are not git's to rewrite.

**Why this is worse than a broken CI job.** The tarball is built from the working tree. `npm pack`
on a CRLF checkout produces a package whose `dist/core/prompt.js` throws the moment it is imported,
so the failure mode is a published package that cannot start at all — the same class as D47, and
found the same way, by actually unpacking what would ship instead of trusting `files`.

**Fix.** A `.gitattributes` pinning both files to `-text`, with the reasoning written into it.
`-text` rather than `text eol=lf` on purpose: the pin is over exact bytes, so the invariant needed
is that the working tree holds byte-for-byte what was committed, which is what `-text` guarantees
unconditionally. `eol=lf` would also yield LF here, but by normalising toward a line ending git
picked rather than by leaving the file alone, and it would silently rewrite the file at checkout if
a CRLF version were ever committed instead of letting the check fail loudly.

No renormalisation was needed — the index and the Windows working tree were both already LF — so
the change adds a file and touches no existing one.

**Why it was missed when CI was written.** `.gitattributes` was considered and deliberately
skipped, on the reasoning that the repository contains no `.sh` files, which is where line-ending
conversion usually bites. That reasoning covered the file *type* people usually mean and missed the
file *property* that matters here: being hash-pinned. A file whose bytes are asserted is a
line-ending-sensitive file no matter what it is called.

---

## D50 — The Pi SDK does not run on Node 20, and the suite assumed it did

**Found:** 2026-09-14, by the same CI run, on all three `node 20` jobs. 35 failed tests on
ubuntu-latest / node 20.

```
Error: file:///.../node_modules/@earendil-works/pi-coding-agent/dist/core/package-manager.js:2
import { chmodSync, existsSync, globSync, ... } from "node:fs";
                                 ^^^^^^^^
SyntaxError: The requested module 'node:fs' does not provide an export named 'globSync'
Node.js v20.20.2
```

**The defect, and what is not one.** The Pi SDK declares `engines.node >= 22.19.0` and imports
`globSync` from `node:fs`, which Node 20 does not export. On Node 20 the package is installed but
cannot be instantiated, so `tests/adapters/pi.test.ts` failed on its own probe rather than on
anything it was testing.

The production path is unaffected, and this is worth being precise about: `resolveAgentDir()` in
`adapters/pi/install.mjs` already wraps the import in a `try`/`catch` and falls back to the
hand-written `getAgentDir()` copy, so a user on Node 20 gets the fallback and a correct install.
The failure was confined to tests that compare the installer's answer against the live SDK's. They
read the SDK in a child process and assert equality; with the SDK uninstantiable there is nothing
to compare against, and every row failed on the probe.

That distinction is the reason this is a test fix and not a `package.json` change. Bumping
`engines.node` to 22.19 would be wrong: Claude Code, Codex and opencode2 adapters do not use this
SDK and are the actual Node 20 audience, and they work.

**Fix.** `describe.skipIf(!SDK_RUNS_HERE)` around the `pi install` suite, where `SDK_RUNS_HERE` is
one out-of-process import of the SDK at collection time. Out of process deliberately — the file
`vi.mock`s the SDK to force the fallback branch, so an in-process probe would be answered by the
mock instead of by the runtime. The other three suites in that file (the extension's behaviour, its
transcript reader, the source assertions) do not touch the SDK and still run on every Node.

Gated rather than deleted because that comparison is the only thing keeping the hand-written
fallback from drifting away from the SDK's real rule, which D39 records as the precise way the
previous copy went wrong. On any runtime Pi actually supports — Pi's own floor is Node 22.19 — the
comparison still runs in full.

Mutation-checked: with the probe's specifier pointed at a package that cannot resolve, the suite
reports 12 passed | 40 skipped instead of 52 passed, and restoring it returns 52 passed.

**Documented consequence.** The README's "Node 20 or newer" now carries the exception, because a
Pi user on Node 20 would otherwise be reading a requirement that does not describe their setup.

---

## D51 — `tests/adapters/codex.test.ts` imported `node:sqlite`, so it could not load on Node 20

**Found:** 2026-09-14, in the same CI run as D50, and fixed in the same pass. The second of the two
test files that failed on the `node 20` jobs.

The `pi install` gate in D50 only took `ubuntu-latest / node 20` from 35 failures down to the ones
in this file, which is how it surfaced: the run after that fix still failed every Node 20 job, and
the remaining failure was a *file load*, not a test.

```
import { DatabaseSync } from "node:sqlite";
```

`node:sqlite` is Node 22.5+, so on Node 20 the static import at the top of the file fails and all
33 tests in the file are lost — including the RPC-ordering, binary-discovery, rollout-lookup and
TOML-preservation suites that have nothing to do with SQLite.

The only use is one line inside `dbName()`, which is called from the live round-trip suite gated
behind `QUICK_TITLES_CODEX_E2E=1` and never runs in CI.

**Fix.** The static import becomes `createRequire(import.meta.url)("node:sqlite")` inside
`dbName()`, so the module is only resolved on the path that needs it.

Mutation-checked, because "this line never executes" is the kind of claim that is worth proving
rather than asserting: pointing the specifier at a package that cannot resolve leaves the suite at
33 passed | 1 skipped. The require is genuinely unreachable unless the E2E suite is switched on.

**The pattern worth naming.** Both this and D50 are the same mistake in different clothes — a test
file reaching for a runtime API without checking that the runtime this project claims to support
has it. `engines.node: ">=20"` is a promise about the product, and nothing was holding the suite to
it. That is precisely the gap the Node 20 matrix row exists to close, and it closed it on its first
run.

---

## D52 — Two callers could both spawn a daemon, because an empty lock file looked abandoned

**Found:** 2026-09-14, by CI, on the `node 20` jobs of two consecutive runs.

```
FAIL tests/client.test.ts > client daemon lifecycle > does not duplicate a live daemon that never binds
AssertionError: expected [ '2953', '2952' ] to have a length of 1 but got 2
```

and in the next run, on the sibling test:

```
FAIL tests/client.test.ts > client daemon lifecycle > spawns exactly one daemon when two callers race a cold start
AssertionError: expected [ '2927', '2926' ] to have a length of 1 but got 2
```

Two daemon pids in the boot log where the invariant is one. The same shape had also appeared on the
dependabot branch the day before, as `expected [ '4191', '4190' ] to have a length of 1 but got 2`.
Three sightings, three different tests, one race — and it never reproduced on a quiet developer
machine, which is why it took three passes to see.

**The first diagnosis was wrong, and its fix did not help.** The obvious suspect was D35, which had
already found `ensureDaemon` spawning a second daemon. Its guard is
`ping → live-pid → model short-circuit → single-flight lock`, plus a re-ping after the lock is
acquired. D35 also documented, without following it through, that `src/daemon/main.ts` calls
`TitleEngine.create()` (4.8–5.6 s) *before* `startServer()` and wrote `pidFile()` only *after* it, so
the whole model load is a state where a daemon exists and is invisible to both a ping and the pid
file. That is a real defect — the client's own step 2 comment, "a live pid means a daemon exists but
is still loading its model", describes a signal that did not exist yet — and it was fixed: the pid
file is now written before the engine loads, `client.ts` re-reads liveness after acquiring the lock
through a shared `isDaemonAlive()`, and the ordering in `main.ts` is pinned by a test that goes red
if it is moved back (mutation-checked). The test fixture was also made faithful: `writeStubEntry`
now registers its pid on boot, as the daemon does, because a stub that never writes one models a
daemon the product cannot see at all.

**None of that fixed the failure.** The next CI run failed the same way, on the same job. That is
what forced the actual analysis, and the actual mechanism is in the lock, not the pid file.

**The actual mechanism.** `acquireSpawnLock()` is called **exactly once** per `ensureDaemon` call and
is never retried. A caller either creates the lock — and spawns — or gets `null` and goes straight to
polling. So "B acquired the lock after A released it" cannot happen: B does not wait, and there is no
second attempt. A second spawn therefore means B **created** the lock, and the only way to create it
while A holds it is to reclaim it first, which means `lockIsStale()` returned true for A's live lock:

```ts
const raw = readFileSync(path, "utf8").trim();
const pid = Number(raw);
const age = Date.now() - statSync(path).mtimeMs;
return !Number.isInteger(pid) || pid <= 0 || !processAlive(pid) || age > LOCK_STALE_MS;
```

`processAlive` is true for A, and the mtime is fresh. The failing term is `pid <= 0`, and it is
reached when the lock file is **empty** — because `acquireSpawnLock` creates the file with
`openSync(path, "wx")` and writes the pid as a separate `writeSync`. Between those two syscalls the
lock exists and holds nothing, `Number("")` is `0`, and `lockIsStale` says "abandoned".

That window is microseconds wide, which is why it looked unreproducible — but it is not a random
window in this test. Two callers racing a cold start call `openSync` at the same instant, so the
loser is sitting in `lockIsStale` at exactly the moment the winner is between its two syscalls. The
race needs the two processes to arrive together, and a loaded CI runner is what makes them arrive
together; a warm developer machine starts the second process after the first has finished writing.

**Fix.** The empty-or-malformed branch is now gated on age rather than judged on sight:

```ts
if (!Number.isInteger(pid) || pid <= 0) {
  return age > LOCK_WRITE_GRACE_MS;   // 2 s
}
return !processAlive(pid) || age > LOCK_STALE_MS;
```

Content cannot distinguish "a holder is mid-write" from "a holder died mid-write"; age can. The cost
of choosing wrong in this direction is one grace period of delay after a genuine crash mid-write;
choosing wrong in the other direction is a duplicate daemon loading the same 360 MB model
concurrently and, on unix, stealing the first one's socket path. A torn read is not a case to
handle: `writeSync` of a few bytes is a single write syscall, so a reader sees either nothing or the
whole pid.

**Evidence, and this one is deterministic.** The window cannot be driven into on demand, but the
state it produces can: a lock file that exists, is empty, and has a fresh mtime. Two new tests pin
both halves of the rule — an empty fresh lock suppresses the spawn, an empty lock older than the
grace is still reclaimed (without which the fix would be "never reclaim an empty lock", which
deadlocks after a crash mid-write). Mutation-checked: setting `LOCK_WRITE_GRACE_MS` to `0` turns the
first red with `expected [ '20976' ] to have a length of +0 but got 1` — the CI failure, reproduced
locally on the first try.

**What this says about the earlier passes.** Two of the three changes above were correct fixes to
real defects found while chasing the wrong one, and they are kept on their own merits (D53 records
the pid-file ordering). The third, the fixture, was needed regardless: a test asserting "at most one
spawn" against a daemon that never announces itself is not testing the product. But the CI signal
was only trusted once the same failure survived a plausible fix, and the run that survived it is the
one that produced the answer.

---

## D53 — The daemon was invisible for the whole model load, exactly the window the pid file is for

**Found:** 2026-09-14, while chasing D52. A real defect, but not the cause of the failure that led
to it — recorded separately so the two do not get conflated.

D35 documented it and stopped one step short. Its words:

> `src/daemon/main.ts` calls `TitleEngine.create()` (4.8–5.6 s) before `startServer()`, and only
> writes `pidFile()` after `startServer()`, so during that whole window the daemon is invisible to
> both a ping and the pid file.

And `src/client.ts` step 2, written as part of D35's guard:

> A live pid means a daemon exists but is still loading its model. Its failed ping is "busy", not
> "absent" — never spawn a second one.

Those two sentences are about the same five seconds, and they contradict each other. Step 2 handles
"a daemon that is still loading its model" through the pid file, and for the whole of that state the
pid file did not exist yet. The branch was unreachable for the case it names. A second caller
arriving mid-load had no way to know a daemon was coming, other than by winning the lock — and if it
lost the lock to a caller that then gave up, nothing stopped it from spawning.

The cost is not hypothetical: on a slow disk the load can exceed a caller's 6 s budget, and the next
prompt then spawns a second daemon that loads the same 360 MB model alongside the first. On unix it
is worse, because `startServer` unlinks the socket path before listening, so the duplicate takes the
path and orphans daemon #1 — the failure D35 itself describes.

**Fix, two parts.**

*`src/daemon/main.ts`* writes the pid file before `TitleEngine.create()`, so the daemon is visible
for its whole life rather than only its serving life. A pid left behind by a daemon that dies during
the load is harmless: nothing trusts the file on its own, and `processAlive()` is what decides.

*`src/client.ts`* re-reads liveness after acquiring the lock, through a new `isDaemonAlive()` used
for both samples. The re-ping that D35 added answers "is it up"; this answers "is it coming". The
window it closes is narrow — a daemon that writes its pid between this caller's step-2 read and its
lock acquisition — and unlike D52's it is not what CI hit.

**Pinned by a test, because it is an ordering rather than a value.** No behavioural test can reach
it without loading a real model, so `tests/client.test.ts` asserts on the order of the two
statements in the source. Mutation-checked: moving the `writeFile(pidFile(), …)` back below
`TitleEngine.create()` turns it red on `expect(registers).toBeLessThan(loads)`.

**Fixture.** `writeStubEntry` in the same file now registers its pid on boot, first thing, as the
daemon does. Not a convenience: a stub that never writes a pid models a daemon the product has no
way to see, which makes "at most one spawn" unsatisfiable by *any* implementation rather than false
in this one. The fixture was not honouring the contract D35 wrote.

---

## D54 — The model-conversion workflow had failed every time it ran, for two unrelated reasons one step apart

**Found:** 2026-09-14, by an adversarial audit of all four CI/CD surfaces.

`convert-model.yml` had run exactly twice — both times on a Dependabot branch, never on `main` — and
died at the same step both times:

```
ValueError: Tokenizer class TokenizersBackend does not exist or is not currently imported.
```

**First cause, and the fix that was not enough.** `Install toolchain` ran

```
pip install mlx-lm huggingface_hub
git clone --depth 1 https://github.com/ggml-org/llama.cpp.git
pip install -r llama.cpp/requirements.txt
```

`mlx-lm 0.31.3` requires `transformers>=5.0.0` and got 5.17.0. `llama.cpp/requirements.txt` then
downgraded it to `transformers==4.57.6`, and also dropped `tokenizers` 0.23.2 → 0.22.2. pip said so
explicitly — `mlx-lm 0.31.3 requires transformers>=5.0.0, but you have transformers 4.57.6 which is
incompatible` — and the dequantise step then failed inside `mlx_lm.convert`'s tokenizer load.

The pin is not avoidable by choosing a narrower requirements file:
`requirements-convert_hf_to_gguf.txt` opens with `-r ./requirements-convert_legacy_llama.txt`, and
that file carries the pin. So the two toolchains cannot share one environment at one time, and the
install was split: `mlx-lm` alone, the dequantise against transformers 5.x, then llama.cpp's
requirements and the 4.57.6 that `convert_hf_to_gguf.py` is tested against.

**That fix alone was insufficient, and the reason is the interesting half.** Moving the install
merely relocates the failure: `convert_hf_to_gguf.py` also loads the tokenizer through
`AutoTokenizer.from_pretrained` — `conversion/base.py`, in `get_vocab_base`, reached from
`_set_vocab_gpt2` via `GraniteHybridModel.set_vocab` → `Mamba2Model.set_vocab` — so the 4.57.6 that
the converter pins cannot read this model either. The job would have failed one step later with the
same error, which is exactly the kind of half-fix that looks like progress in a run list.

**Why this model is unreadable by 4.x.** Upstream ships a transformers-5 tokenizer:
`tokenizer_config.json` contains `"backend": "tokenizers"` and `"tokenizer_class": "TokenizersBackend"`,
a class that exists in 5.x and not in 4.x. There is no `vocab.json` and no `merges.txt` in the
repository at all — only a self-contained `tokenizer.json` (6.8 MB). So there is nothing to fall back
to; the class name is the only thing standing between 4.x and the tokenizer data.

**Fix.** A step between the two installs rewrites `tokenizer_class` to `GPT2TokenizerFast` in the
*intermediate* `title-bf16/` directory — not in the model — and then loads it, while transformers is
still 4.x, so the assertion is meaningful. That last detail is why the step sits below the converter
install rather than above it.

**The equivalence is measured, not argued.** Both classes wrap the same `tokenizers` BPE built from
the same `tokenizer.json`, so the resulting tokenizer is compared directly on the real files:

| | vocab (id→token) | added tokens | 19 probe encodings |
|---|---|---|---|
| 4.57.6 + `GPT2TokenizerFast` | 100352, sha256 `0264e8b6…` | 96, sha256 `a31d8e6b…` | sha256 `373e3b07…` |
| 5.17.0 + `TokenizersBackend` | 100352, sha256 `0264e8b6…` | 96, sha256 `a31d8e6b…` | sha256 `373e3b07…` |

All three fingerprints identical. Under 5.17.0 the patched file still loads as `TokenizersBackend`
— 5.x ignores `tokenizer_class` when `backend: "tokenizers"` — so the rewrite is a no-op there and the
fix on 4.x. The GGUF's token list and its `tokenizer.ggml.pre` hash therefore cannot differ; only the
name of the Python class holding the file does. `get_vocab_base_pre` identifies the pre-tokenizer by
encoding probe strings, which is what the third row of that table covers.

**Verified green, for the first time.** Run **34845285881** (push to `main`, commit `6a3dbca`) is
the first run of this workflow to succeed. All sixteen steps pass, including the two that had never
been reached — "Convert to GGUF f16" and "Quantise to Q8_0" — and the verifier, which loaded the
artifact through `node-llama-cpp` and asserted `granite`, plus the chat template hash and the
`tokenizer.ggml.pre` value. It uploaded `title-q8_0` at 357 MB.

That green run is the end-to-end proof of the tokenizer step in the real environment: the converter
ran under transformers 4.57.6, produced a GGUF, and an independent loader accepted it. The equivalent
local check was the fingerprint table above; the run is what confirms the table's conclusion holds
through the actual `llama.cpp` pipeline.

One thing it does not prove, stated so nobody assumes it: the artifact the CI job builds is *not*
byte-identical to the one this project converted locally during D5. The local run used
`--outtype q8_0` directly (378 MB); the workflow goes f16 → `llama-quantize` (357 MB). Both are
valid Q8_0 and both verify, but only the workflow's is reproducible by anyone else, which is the
reason the workflow is the shipped answer and the local artifact was a stopgap.

**Four more defects in the same file, each independently fatal.**

- `runs-on: macos-14` is retired 2026-11-02, after which the job fails to start. Now `macos-15`,
  which is still the arm64 image — the Intel label is the separate `macos-15-intel`.
- The push filter named `tools/convert/**`, a directory that has never existed in this repository,
  and omitted `tools/verify-gguf.mjs`, the one tool the job actually runs. Editing the verifier
  therefore did not trigger the workflow that verifies.
- The same filter fired on Dependabot action bumps, because each bump edits this file, so every
  action bump launched a full macOS conversion job that then failed. Scoped to `main`.
- The verify step ran `node tools/verify-gguf.mjs` with no `setup-node` and no install, so it would
  have failed on `ERR_MODULE_NOT_FOUND` for `node-llama-cpp` even after everything above was fixed.
  Now set up and installed with `--omit=dev`, which is sufficient (`node-llama-cpp` is a runtime
  dependency) and skips the Pi SDK's transitive blob on a minute-billed runner.

**The step name was wrong in a way that mattered.** It read "Check the GGUF is loadable and is
granitehybrid". The check asserts `granite`, and correctly: the converter rewrites a hybrid model
with no SSM layers to `GRANITE_MOE` or `GRANITE` depending on whether experts are present, and this
checkpoint has none. Verified against the artifact this project already converted — `verify-gguf.mjs`
on the local `title-q8_0.gguf` prints `architecture: granite` and exits 0. A reader seeing the name
and a green `granite` result would reasonably conclude the check had failed.

---

## D55 — CI cancelled the verification of the commit it had just superseded

**Found:** 2026-09-14, same audit.

`ci.yml` had `cancel-in-progress: true` on `group: ci-${{ github.ref }}`. Every push to
`refs/heads/main` shares that group, so a second push cancelled the in-flight six-job matrix for the
first — and that commit never received a complete run. It happened once in this repository: run
34839694663 (commit `af1423af`) had four of its six jobs cancelled when the next main push
(34839840635) started about nine seconds earlier.

The impact is bounded — the cancelled run was already failing on both macOS legs, and the superseding
commit is a descendant of the same tree — so what was lost is a green record for one superseded SHA,
not verification of code that later shipped. It is still the wrong default for a main branch, where
superseding saves nothing and discards evidence. Now `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`:
a PR's own older runs are worth cancelling, main's are not.

---

## D56 — The leftover-scratch check reported leftovers on every clean run

**Found:** 2026-09-14, same audit.

The step tested `[ -d .tmp ]`. `tests/helpers/tmp.ts` creates `<repo>/.tmp` on every `tempDir` call,
and `cleanupTempDirs` removes the child directories it created but never the root — nothing removes
the root, and there is no vitest `globalSetup`. So the test was always true after any run that
reached the test step, and all six jobs of run 34842981621 printed

```
leftovers under .tmp:
```

followed by an empty list. The `else` branch, which prints "cleanup was complete", was reachable only
when `Test` was skipped.

The cost is not the wasted step. It is that the diagnostic that exists to catch the 539-leftover
directory leak the project already suffered printed an alarming header on every green run, which is
how a real signal gets trained out of its readers. A second gap: it only ever looked at `.tmp`, so a
leak into `tests/adapters/.tmp-*` (which `pi.test.ts` does create) or `__QUICK_TITLES_DIST__/` was
reported as clean.

Now it tests *emptiness* of every gitignored scratch root and prints nothing when they are all empty.

---

## D57 — The matrix tested a Node the toolchain does not support, and never tested the current LTS

**Found:** 2026-09-14, same audit.

The matrix was `["20", "22"]`. `vitest@5` declares `engines.node: ^22.12.0 || ^24.0.0 || >=26.0.0`
and `@earendil-works/pi-coding-agent@0.85.1` declares `>=22.19.0`, so Node 20 is below both of their
floors. The runs were green anyway, and that is the defect rather than a mitigation: npm emits only
`EBADENGINE` warnings (no `engine-strict` is set), so run 34842981621 logged
`required: { node: '>=22.19.0' }, current: { node: 'v20.20.2' }` on all three Node 20 legs and
recorded success on a runtime the test toolchain does not support.

Node 24, meanwhile, was tested nowhere, despite being the current LTS and the runner default. Both
halves are now fixed by testing `["22", "24"]`; the first run of that matrix passed Node 24 on macOS
and Ubuntu.

`engines.node: ">=20"` in `package.json` is **not** changed, deliberately, and the audit's suggestion
to align it with the devDependency floors is wrong: `engines.node` governs the consumer runtime, and
the runtime dependencies (`node-llama-cpp` `>=20.0.0`, `smol-toml` `>=18`) do support Node 20. The
devDependency floors constrain CI, not users.

---

## D58 — The documented manual release path could not succeed, and publishing could not have succeeded either

**Found:** 2026-09-14, same audit. Both are blocking, both latent because the workflow has never run.

**The tag input was dead.** `release.yml` resolved the tag as
`tag="${GITHUB_REF_NAME:-${{ inputs.tag }}}"`, in two places. `GITHUB_REF_NAME` is always populated —
with the *branch* on a `workflow_dispatch` — so the `:-` default could never fire. Dispatching with
`tag=v0.1.0` from `main` set `tag=main`, and the next step compared it against `v0.1.0` from
`package.json` and exited 1. The manual path, which exists precisely for when a tag push was missed,
could only ever fail. Now `github.event.inputs.tag || github.ref_name`, which is the tag on a push
(`inputs.tag` is empty there) and the input on a dispatch.

**A related injection claim that verification refuted, worth recording** because the code does look
alarming: `${{ inputs.tag }}` interpolated into a `run:` block. It does not fire. A quote inside the
`${VAR:-word}` construct does not terminate the outer double-quoted string, so a `"` breakout,
`$(...)`, backticks and a newline payload all stay literal — reproduced with a positive control in
which the naive `title="${{ }}` form *did* execute, proving the harness detects injection. It is also
moot once the expression is correct, since the alternate is never evaluated. The value is passed
through `env:` anyway, which is the hardening the form should have had.

**Publishing could never have succeeded.** `npm publish --provenance` ran with only `contents: write`
granted workflow-wide and no job-level override, so `id-token` was `none`. npm refuses: *Provenance
generation in GitHub Actions requires "write" access to the "id-token" permission*, exit `EUSAGE`,
nothing published. This would have surfaced the first time the maintainer set `NPM_PUBLISH=true` — a
one-way, outward-facing action on their own npm account, which is the worst moment to discover it. The
publish job now grants `contents: read` and `id-token: write`, which is also narrower than what it
inherited.

**And all three checkouts were ref-less.** On a dispatch they took the branch, not the tag being
released, so the tree fed to the tag/`package.json` check — and to the published tarball — was not the
tag. Latent while the tag bug masked it, live the moment that bug was fixed. All three now take
`github.event.inputs.tag || github.ref_name`.

---

## D59 — The weight fetch used a CLI huggingface_hub had already deleted

**Found:** 2026-09-14, by the first dispatch of D54's fix. A defect the fix exposed rather than caused.

`hf`/`huggingface-cli` — the step ran `huggingface-cli download desert-ant-labs/title --local-dir mlx-model`,
and on `huggingface_hub` 1.x that exits 1:

```
Warning: `huggingface-cli` is deprecated and no longer works. Use `hf` instead.
```

It had been passing, but not on its own merits. The original `Install toolchain` step installed
llama.cpp's requirements *before* this one, which downgraded `huggingface-hub` to 0.36.2 — a version
that still shipped a working `huggingface-cli`. Ordering the installs correctly removed the downgrade
and the step failed immediately on a command that had already been removed upstream.

So the fix is the command (`hf download`), not the pin. Reverting to `huggingface-cli`, or pinning
`huggingface-hub` back to 0.x to revive it, would re-establish a dependency on a deleted entry point
and reintroduce a downgrade nothing else in the job wants. This is recorded because the tempting
"fix" for the failing step is the wrong one, and the log now names it.

---

## D60 — Ten findings the audit raised and verification refuted

Recorded because knowing what is *not* broken is worth as much as the list of what is, and because
several of these will be proposed again.

- **`actions/checkout@v4` and `actions/setup-node@v4` declare `using: node20`, removed 2026-09-23.**
  GitHub's migration forces node20 actions onto Node 24 (`requireNode24`) rather than failing them,
  and the green run proves they execute that way. Only log noise. Dependabot already tracks the
  bumps. Not a defect.
- **The action versions are behind current majors** (checkout v7, setup-node v7, setup-python v7,
  upload-artifact v7). Version lag, not a defect; two Dependabot PRs are open for it. Note one
  factual correction: upload-artifact's node24 threshold is v6, not v5.
- **`main` has no branch protection or rulesets.** True, and a guardrail gap rather than a defect:
  the repository is private with exactly one collaborator, who is the admin — admins bypass
  protection unless explicitly included — and the workflow is used as post-push feedback by choice,
  which is legitimate for a solo private repository.
- **`npm publish --dry-run` enforces nothing.** It is a display step, named as one. The enforcement
  the finding asked for already exists: `tests/packaging.test.ts` packs, extracts, asserts the
  manifest and runs the shipped code, and `verify` gates `publish` via `needs:`.
- **The `Release` workflow has never run and the publish job cannot fire** because `NPM_PUBLISH` and
  `NPM_TOKEN` do not exist. That is the documented, deliberate design of an unreleased project, and
  the gate is a one-command opt-in rather than a dead end.
- **`delete_branch_on_merge` is false, leaving merged branches behind.** The two present
  `dependabot/*` branches are the heads of two *open* PRs; the repository has never merged a PR.
  The cited evidence refuted the claim.
- **Community profile health is 85% with `issue_template` missing.** Reproduced and confirmed
  non-defect: YAML issue *forms* are invisible to the API that computes this, and it is documented
  in-repo in `.github/ISSUE_TEMPLATE/config.yml`.
- **`.github/dependabot.yml` header comments.** Not refuted — fixed, but as documentation: the file
  claimed to be npm-only while configuring the `github-actions` ecosystem, and claimed "no GitHub
  Actions pinned by SHA to update automatically" when tag pins are exactly what the `github-actions`
  updater bumps. The header now says so.

**The `dependabot.yml` finding that did hold.** `ignore:` on `node-llama-cpp`
`version-update:semver-major` sat directly under a comment reading "Majors land as their own PR,
never folded into a group", and it suppressed every future major of the one dependency where a major
most plausibly changes prebuilt-binary coverage or the bundled llama.cpp ABI — the bump the
"prebuilt binaries only, never compile from source" constraint most needs a human to see. The
comment was also false in a second way: no group declared `update-types`, so majors would have been
folded into a group if they had been opened. Groups are now capped at `["minor", "patch"]` and the
`ignore` is gone.

**Also confirmed and acted on outside the workflows:** Dependabot alerts were disabled on the
repository despite `dependabot.yml` existing, so an advisory against `node-llama-cpp` or a
transitive dependency would have produced no alert and no security-fix PR. Enabled. Secret scanning
is *not* enabled and cannot be for free — on a private repository it requires the paid GitHub Secret
Protection add-on, so that one is a cost decision rather than a misconfiguration.

---

## D61 — Uninstall did not exist, and the reason it was not trivial

**Found:** 2026-09-14, asked directly: *"have you added the feature to uninstall it via npx?"* It had
not been, and `uninstall` appeared nowhere in the repository.

The plan treated installation as the whole story. Four adapters each wrote into a directory the user
also owns — `~/.config/opencode/plugins/`, `<agent dir>/extensions/`, `~/.codex/config.toml` — and
nothing could take it back out. The manual instructions in `docs/install.md` covered installing only,
so the honest answer to "how do I remove this" was "delete these files yourself", which is a poor
answer for a tool that goes to some trouble to be reversible elsewhere.

**The obstacle, and the shape of the fix.** Every installed file is named `quick-titles.ts` inside a
directory a user can also write to. An `rm -f` on a computed guess is unrecoverable if the guess is
wrong, and the wrong guess is plausible — an extension someone wrote themselves under the name they
would naturally pick. So the installers now write a marker line first:

```
// quick-titles — installed by `npx quick-titles install`, removed by `npx quick-titles uninstall`
```

`uninstall` removes a file only if that line is in it. A file without it is reported and kept, and the
run exits non-zero. Refusing is merely inconvenient; deleting someone's file is not recoverable. The
line doubles as the answer to "what is this file, and how do I get rid of it" for anyone opening it
in an editor.

**Codex is the exception, and matching it correctly needed a decision.** There is no file of ours to
mark — the registration is one `notify` line inside the user's own `config.toml`. Identity therefore
comes from the *script path* in the pair. The obvious alternative, `process.execPath`, is wrong: that
is whatever node `npx` happened to resolve on the day of the install, and it changes on every node
upgrade and on every `nvm use`, so matching on it would leave the notifier registered forever after
one version bump. A `notify` entry pointing anywhere else is refused rather than removed, the same
rule the installer already applied in the other direction.

**Candidate lists rather than one computed path.** Where an installer chooses its directory from the
environment — opencode2 from the cwd, Pi from `PI_CODING_AGENT_DIR` — the uninstaller checks both
branches, because an install and an uninstall can compute different answers. The limit is stated
rather than papered over: for opencode2 a project-local install is only found when uninstall runs from
that same directory, and for Pi an install into a custom agent directory is not found at all once the
variable is unset, because nothing recorded that path. In both cases the locations checked are printed
in the "not installed" message, so the answer is checkable instead of a bare "done".

**Claude Code is asked, not told.** `claude plugin uninstall` exits non-zero when the plugin is not
installed, which would make "there was nothing to remove" a failure and break the property the rest
of the command keeps. The marketplace and plugin lists are read as JSON first; only then are the two
removals run, plugin before marketplace, because removing the marketplace first would leave the plugin
entry pointing at a source that no longer exists. When the CLI cannot be asked, the removals are
attempted anyway — unknown must not be read as absent.

**One asymmetry with `install`, deliberate.** `install` with no argument is an error ("which agent?"),
because it cannot guess. `uninstall` with no argument removes all four: "remove everything" is a single
unambiguous answer, and it is what someone typing the bare command is asking for. Every agent is
attempted even after one fails, since stopping at the first refusal would leave the rest installed and
make the user run it again to discover that.

Absence is success throughout: the end state wanted is "not installed", and a file that is already
gone *is* that state. A second run reports "not installed" and exits zero.

**Left alone on purpose:** the model (357 MB, nothing else reads it, and keeping it means a reinstall
does not re-download) and the title store (an append-only file the user owns). Both are named in
`docs/install.md` so "uninstall did not clean up" is not a surprise.

35 tests across the four adapters and the CLI, including round-trip identity for Codex — install then
uninstall must reproduce the original config byte for byte across eight shapes (BOM, CRLF, trailing
table, triple-quoted string, empty, no trailing newline) — and the refusals: a foreign file, a foreign
`notify`, a quoted root key, an unparseable config, and a node path from a different install.

---

## D62 — The adversarial review of the CI commits, and the one cost that was not a defect

A review pass over the four CI commits (`b9216b8`, `1e5d2cc`, `6a3dbca`, `e1d3ff9`) checked each
change against the repository and against GitHub's actual behaviour rather than against the commit
messages. It confirmed the substantive changes — the leftover-scratch loop under the exact flags
GitHub uses for `shell: bash`, the tag resolution in all five places in `release.yml`, the
`cancel-in-progress` expression, `dependabot.yml` against the published schema, and the conversion
workflow against its own green run — and turned up four smaller things, three of them fixed here:

- **`to-delete.md` §5b told the reader to keep and delete the same files.** The prose said the two
  `tok` directories mattered "until the conversion workflow is green" while the command beside it
  deleted them, and that workflow has been green since run 34845285881. The command also omitted three
  captured logs and listed `.tmp/pip-cache` twice. The rule is now stated once.
- **`convert-model.yml` said `macos-14` "was retired on 2026-11-02"** — a date seven weeks in the
  future at the time of writing. Now "retires".
- **`ci.yml` claimed the leftover loop covers "every gitignored scratch root".** It covers the roots
  the suite creates; `.fallow/`, `graft/` and `.probe/` are gitignored and unscanned, because no test
  writes them. The comment now says which roots it means and why the others are out of scope.
- **The README lost its only H1.** Replacing `# quick-titles` with the header image left the document
  with no top-level heading and no `#quick-titles` anchor. Not fixed here: the image is the header by
  request, and a heading duplicating the wordmark immediately beneath it is a visual change to the
  block that was specified. Recorded as a known, deliberate trade-off rather than silently reverted.

**The finding that is a real cost, and why re-adding the legs would not fix it.** D57 removed the
Node 20 matrix legs on the grounds that they were green only because npm downgrades an engine mismatch
to an `EBADENGINE` warning — `vitest@5` declares `^22.12.0 || ^24.0.0 || >=26.0.0` and the Pi SDK
declares `>=22.19.0`, so on Node 20 the suite was running on a toolchain that does not support it.
That reasoning stands and the legs stay removed. But the consequence is worth stating plainly:
`package.json` still declares `engines.node: ">=20"` and `README.md` still says the other three
adapters work on Node 20, and **nothing now verifies that promise in CI** — a Node 22+ API in a
shipped adapter would merge green and only surface for a Node 20 user. Re-adding the legs does not fix
it, because the leg was never able to test anything: the problem is the mismatch between the promise
and what the *test toolchain* can run, not a missing row. The claim rests on the runtime
dependencies' own floors (`node-llama-cpp` `>=20.0.0`, `smol-toml` `>=18`) and on the adapters not
using a Node 22+ API, which is a human judgement rather than a checked one. Either backing it with a
real check or narrowing `engines` to `>=22` is a decision to take deliberately, not by accident of a
matrix edit.
