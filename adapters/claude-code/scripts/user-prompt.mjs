#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readStdin, loadClient, loadPaths, emitTitle } from "./lib.mjs";

const input = await readStdin();
if (!input?.session_id) process.exit(0);

// One rule for where quick-titles keeps state: paths.dataDir(), which resolves
// CLAUDE_PLUGIN_DATA (the Claude Code plugin host's directory) and
// QUICK_TITLES_DATA_DIR itself. Reading the pair here directly left the prompt
// counter in a different directory from the daemon's title store whenever only
// one of the two was set, and it exited untitled when neither was.
const { dataDir } = await loadPaths();
const dir = dataDir();

const counterFile = join(dir, `prompts-${input.session_id}`);
let count = 0;
try {
  count = Number(readFileSync(counterFile, "utf8").trim()) || 0;
} catch {
  count = 0;
}
count += 1;
try {
  mkdirSync(dir, { recursive: true });
  writeFileSync(counterFile, String(count));
} catch {
  // Counting is best-effort; a failure just means we may title twice.
}

// Pass 1 on the first prompt, refine once on the third. Nothing after that.
if (count !== 1 && count !== 3) process.exit(0);

const client = await loadClient();
const req = {
  agent: "claude-code",
  sessionId: input.session_id,
  transcriptPath: input.transcript_path,
};

// A session can resume without a fresh SessionStart, and a first prompt can
// land before the daemon is listening, so this must not depend on the warm-up
// hook having run. ensureDaemon runs first (a total 5s budget, never throws),
// then a single generate (bounded to 8s). Worst path: 500ms missed ping +
// 5000ms poll + 8000ms generate = 13.5s, inside the host's 25s timeout with
// 11.5s of margin. Warm path is unchanged: ping ~10ms, generate ~800ms.
await client.ensureDaemon({ timeoutMs: 5000 }).catch(() => {});
const title = (await client.generate(req, { timeoutMs: 8000 }))?.title;

emitTitle("UserPromptSubmit", title);
process.exit(0);
