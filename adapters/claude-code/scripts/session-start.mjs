#!/usr/bin/env node
// SessionStart fires on startup|resume|fork and receives no prompt text, but it
// does receive transcript_path - so on resume we can title a session that was
// never titled, and backfill history.
import { readStdin, loadClient, emitTitle } from "./lib.mjs";

const input = await readStdin();
if (!input?.session_id || !input?.transcript_path) process.exit(0);

// Warm the daemon, but never block session start on a machine where it cannot
// run: ensureDaemon spawns it detached (so it outlives this hook) and gives up
// after its 8s total budget, well inside the hook's 30s budget. It must be
// awaited — fired and forgotten it never reaches its spawn() before this
// script's process.exit.
const client = await loadClient();
await client.ensureDaemon({ timeoutMs: 8000 }).catch(() => {});

const title = process.env.QT_TITLE_ON_RESUME === "1"
  ? (await client.generate({
      agent: "claude-code",
      sessionId: input.session_id,
      transcriptPath: input.transcript_path,
    }, { timeoutMs: 8000 }))?.title
  : null;

emitTitle("SessionStart", title);
process.exit(0);
