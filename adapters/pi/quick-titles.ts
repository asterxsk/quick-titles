import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// install.mjs substitutes this token with an absolute path, because the
// extension is copied into ~/.pi/agent/extensions/ and cannot resolve a
// relative import back out to this repo.
const DIST = "__QUICK_TITLES_DIST__";

// The real client signatures (src/client.ts). Both `opts` are optional there,
// which is the trap this file used to fall into: omit them and a cold or wedged
// daemon is bounded by whatever the client's own default is (15s for a
// request), not by anything this adapter chose.
type Generate = (
  request: { agent: "pi"; sessionId: string; transcriptPath: string },
  opts?: { timeoutMs?: number }
) => Promise<{ title: string; description: string | null } | null>;

type EnsureDaemon = (opts?: { timeoutMs?: number }) => Promise<boolean>;

// The model load is measured at 4.8-5.6s, so 8s covers a healthy cold start
// with margin (src/daemon/main.ts calls TitleEngine.create() before it binds
// its socket, so until then "no ping" does not mean "no daemon coming").
const ENSURE_MS = 8000;
// Warm inference is ~0.8s median and 3.4s worst in the quality gate, so 5s is
// generous for the request itself.
const GENERATE_MS = 5000;

export default function quickTitles(pi: ExtensionAPI) {
  let turnCount = 0;
  let generate: Generate | null = null;
  let ensureDaemon: EnsureDaemon | null = null;

  pi.on("session_start", async () => {
    turnCount = 0;
    // pathToFileURL matters: a Windows absolute path is not a valid import specifier.
    ({ generate, ensureDaemon } = (await import(pathToFileURL(join(DIST, "client.js")).href)) as {
      generate: Generate;
      ensureDaemon: EnsureDaemon;
    });
    // Head start: begin the cold model load now instead of at the end of turn 1.
    // Fire-and-forget and bounded — the turn itself does the awaiting below, so
    // session_start never blocks on the daemon.
    ensureDaemon({ timeoutMs: ENSURE_MS }).catch(() => {});
  });

  pi.on("turn_end", async (_event, ctx) => {
    turnCount += 1;
    // Title on the first turn; retry on the third if the daemon was still cold,
    // then stop. Once a name exists, later turns leave it alone.
    if (turnCount !== 1 && turnCount !== 3) return;
    if (!generate || !ensureDaemon) return;
    if (await pi.getSessionName()) return;

    // Session identity lives on the read-only sessionManager; ExtensionContext
    // has no sessionId/sessionFile fields of its own.
    const transcriptPath = ctx.sessionManager.getSessionFile();
    if (!transcriptPath) return;

    // Wait for a cold daemon before asking it to generate, on a budget that
    // comfortably exceeds the model load. Turn 1 used to race this: it generated
    // against a socket that was not bound yet, so it either stalled on the
    // client's 15s default or returned null and silently titled nothing.
    await ensureDaemon({ timeoutMs: ENSURE_MS }).catch(() => {});

    const result = await generate(
      {
        agent: "pi",
        sessionId: ctx.sessionManager.getSessionId(),
        transcriptPath,
      },
      { timeoutMs: GENERATE_MS }
    ).catch(() => null);

    if (result?.title) await pi.setSessionName(result.title);
  });
}
