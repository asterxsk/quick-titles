// adapters/opencode2/plugin.ts
//
// opencode2 (beta) keeps its sessions in its own storage and exposes them to
// plugins through the plugin API. The daemon's opencode2 reader expects a JSON
// interchange file shaped `{ session_v2, messages }` — not a file opencode2
// writes — so this adapter reads the conversation through
// `ctx.session.context()` and materialises that file into quick-titles' own
// cache directory. The host's storage is read-only to us; we never write it.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// install.mjs substitutes this token with an absolute path. A relative import
// would break the moment the plugin is copied to ~/.config/opencode/plugins/
// rather than symlinked out of this repo.
const DIST = "__QUICK_TITLES_DIST__";

/** opencode2 writes this when its own titler has not run yet. Mirrors the
 *  placeholder the daemon's opencode2 reader recognises. */
const PLACEHOLDER = /^(New session|Child session) - \d{4}-\d{2}-\d{2}T[\d:.]+Z$/;

/** One decoded opencode2 message: the row's stored data plus `id` and `type`,
 *  which opencode2's session store adds when it decodes a message. */
export interface Opencode2Message {
  type?: string;
  /** user/system/synthetic rows carry a plain string here. */
  text?: unknown;
  /** assistant rows carry an array of parts. */
  content?: unknown;
}

/** The JSON interchange the daemon's opencode2 reader parses. */
export interface Interchange {
  session_v2: { title: string | null };
  messages: { role: string; content: string }[];
}

interface Part {
  text?: unknown;
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Assistant rows store content as parts; keep the visible text and drop the
 *  reasoning/tool parts, whose `text` is empty. */
function partsText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => textOf((part as Part | null)?.text))
    .filter(Boolean)
    .join("\n");
}

/** Pure: maps opencode2's decoded messages onto the reader's interchange
 *  shape. Only conversation turns are kept — `system`, `synthetic`,
 *  `compaction` and the switch markers are host scaffolding, not dialogue. */
export function materialise(
  session: { title?: string | null } | null | undefined,
  messages: readonly Opencode2Message[]
): Interchange {
  const turns: Interchange["messages"] = [];
  for (const message of messages) {
    const role =
      message.type === "user" ? "user" : message.type === "assistant" ? "assistant" : null;
    if (!role) continue;
    const content = role === "user" ? textOf(message.text) : partsText(message.content);
    if (content) turns.push({ role, content });
  }
  return { session_v2: { title: session?.title ?? null }, messages: turns };
}

/** The slice of opencode2's beta plugin context this adapter uses. Typed
 *  locally rather than imported: the published @opencode-ai/plugin package's
 *  v2 context has no `session`/`event` domains, whereas the beta binary's
 *  context does expose them. */
interface PluginContext {
  event: {
    subscribe(
      handler: (event: {
        type?: string;
        properties?: { sessionID?: string };
      }) => void | Promise<void>
    ): { dispose?: () => void } | void;
  };
  session: {
    get(args: { sessionID: string }): Promise<{ title?: string | null } | undefined>;
    context(args: { sessionID: string }): Promise<readonly Opencode2Message[]>;
    rename(args: { sessionID: string; title: string }): Promise<unknown>;
  };
}

export default {
  id: "quick-titles",
  async setup(ctx: PluginContext) {
    // pathToFileURL matters: a Windows absolute path is not a valid import specifier.
    const { generate, ensureDaemon } = (await import(pathToFileURL(join(DIST, "client.js")).href)) as {
      generate: typeof import("../../dist/client.js").generate;
      ensureDaemon: typeof import("../../dist/client.js").ensureDaemon;
    };
    const { cacheDir } = (await import(pathToFileURL(join(DIST, "paths.js")).href)) as {
      cacheDir: () => string;
    };

    // opencode2 is a long-lived host process handling many events, so the daemon
    // is warmed once rather than per event. The in-flight promise is cached; if
    // it resolves false the cache is cleared so a later event may try once more,
    // instead of the plugin no-opping forever (D34) or retry-storming.
    let daemonReady: Promise<boolean> | null = null;
    const warmDaemon = (): Promise<boolean> => {
      if (!daemonReady) {
        daemonReady = ensureDaemon({ timeoutMs: 6000 }).then(
          (ready) => {
            if (!ready) daemonReady = null;
            return ready;
          },
          () => {
            // A rejected ensureDaemon must not wedge the cache permanently.
            daemonReady = null;
            return false;
          }
        );
      }
      return daemonReady;
    };

    const unsub = ctx.event.subscribe(async (event) => {
      // Never let a failure escape into the host: opencode2 treats a rejected
      // event callback as a plugin fault. Every await below is best-effort.
      try {
        if (event?.type !== "session.idle" && event?.type !== "message.updated") return;

        // opencode2 delivers the id under `properties` (EventSessionIdle /
        // EventMessageUpdated in @opencode-ai/sdk), not under `data`.
        const sessionID = event.properties?.sessionID;
        if (!sessionID) return;

        // Only title sessions still showing a placeholder.
        const session = await ctx.session.get({ sessionID }).catch(() => null);
        const current = session?.title ?? "";
        if (current !== "" && !PLACEHOLDER.test(current)) return;

        // The transcript opencode2 produces is not a file; materialise the
        // conversation into our own cache directory so `generate` can read it.
        const messages = await ctx.session.context({ sessionID }).catch(() => []);
        const transcriptPath = join(cacheDir(), `${sessionID}.json`);
        mkdirSync(dirname(transcriptPath), { recursive: true });
        writeFileSync(transcriptPath, JSON.stringify(materialise(session, messages)), "utf8");

        // Cold start: the daemon may be spawned-but-not-yet-listening, so wait
        // for it once before the first generate. warmDaemon() must not reject.
        await warmDaemon();

        const result = await generate(
          {
            agent: "opencode2",
            sessionId: sessionID,
            transcriptPath,
          },
          { timeoutMs: 8000 }
        ).catch(() => null);

        if (result?.title) {
          await ctx.session.rename({ sessionID, title: result.title }).catch(() => null);
        }
      } catch {
        // swallow: a thrown handler would reject the host's event dispatch.
      }
    });

    return () => unsub?.dispose?.();
  },
};
