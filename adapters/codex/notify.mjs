#!/usr/bin/env node
// Codex calls this with one JSON argument after a turn completes:
//   {type:"agent-turn-complete", thread-id, turn-id, cwd, input-messages,
//    last-assistant-message}
// We generate locally, then push the title back through Codex's own app-server
// RPC (`thread/name/set`). Codex hooks cannot set a name, and the state DB is
// documented as unsafe to write while Codex runs, so the app-server is the only
// supported writer (D30).
//
// Two measured corrections to the plan's version (D27, D28):
//   * `codex` may not be on PATH (a ChatGPT-desktop install ships the CLI at
//     %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe), so we resolve it.
//   * the app-server refuses any method before `initialize`, so a bare
//     `thread/name/set` is answered `-32600 "Not initialized"`. We handshake.
//
// Two more corrections this file carries (D40):
//   * the daemon is started here, via ensureDaemon(), exactly as every other
//     adapter does. The old run() called generate() alone, and generate() is a
//     one-shot socket call that returns null when nothing is listening — so on a
//     machine with no already-running daemon this adapter produced no title,
//     ever, with no retry.
//   * a thread name the user set by hand is never overwritten. That needs the
//     thread's CURRENT name, which is read from the same app-server session that
//     writes it (a second spawn of the 295 MB binary per turn is waste).
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { homedir, platform } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP_SERVER_ARGS = ["app-server", "--listen", "stdio://"];
const CLIENT_INFO = { name: "quick-titles", version: "0.1.0" };

function executable(path) {
  try {
    // isFile, not merely F_OK: a PATH entry can contain a *directory* named
    // `codex`, and spawning that would fail with EINVAL.
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The newest `<hash>/codex.exe` directly under `root`, or null. Filters to
 *  directories that actually contain the binary: on a real desktop install the
 *  newest hash directory can be empty or hold only a helper exe (this machine
 *  has exactly that), and picking it would resolve to nothing. */
function newestIn(root, names) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  let best = null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    for (const name of names) {
      const candidate = join(root, entry.name, name);
      if (!executable(candidate)) continue;
      try {
        const { mtimeMs } = statSync(candidate);
        if (!best || mtimeMs > best.mtimeMs) best = { path: candidate, mtimeMs };
      } catch {
        /* raced away */
      }
      break;
    }
  }
  return best?.path ?? null;
}

/** CODEX_BIN override -> PATH -> the ChatGPT-desktop app's content-hashed bin
 *  directory (Windows `%LOCALAPPDATA%`, macOS/Linux equivalents). Returns null
 *  when Codex cannot be found. Never hard-codes a hash (D27). */
export function resolveCodexBin(env = process.env) {
  if (env.CODEX_BIN) return env.CODEX_BIN;

  const exts = platform() === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, `codex${ext}`);
      if (executable(candidate)) return candidate;
    }
  }

  const local = env.LOCALAPPDATA ?? (platform() === "win32" ? join(homedir(), "AppData", "Local") : null);
  const roots = [];
  if (local) roots.push(join(local, "OpenAI", "Codex", "bin"));
  if (platform() === "darwin")
    roots.push(join(homedir(), "Library", "Application Support", "OpenAI", "Codex", "bin"));
  roots.push(join(homedir(), ".codex", "bin"));

  for (const root of roots) {
    const found = newestIn(root, ["codex.exe", "codex"]);
    if (found) return found;
  }
  return null;
}

/** Run `fn(call)` against one freshly spawned app-server speaking newline
 *  JSON-RPC on stdio, and resolve whatever `fn` resolves. Resolves null on any
 *  transport failure (spawn error, refused handshake, timeout, child exit), so
 *  callers never see an exception out of the host process. The child is killed
 *  and the wait bounded either way. */
function withAppServer({ bin, args = APP_SERVER_ARGS, timeoutMs, env }, fn) {
  return new Promise((done) => {
    const useShell = platform() === "win32" && /\.(cmd|bat)$/i.test(bin);
    let child;
    try {
      child = spawn(bin, args, {
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
        shell: useShell,
        env: { ...process.env, ...env },
      });
    } catch {
      done(null);
      return;
    }

    let buf = "";
    let nextId = 1;
    const pending = new Map();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      done(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);

    child.on("error", () => finish(null));
    child.on("exit", () => finish(null));
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const waiter = pending.get(msg.id);
        if (waiter) {
          pending.delete(msg.id);
          waiter(msg);
        }
      }
    });

    const call = (method, params) =>
      new Promise((res) => {
        const id = nextId++;
        pending.set(id, res);
        child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      });

    Promise.resolve(fn(call))
      .then((value) => finish(value))
      .catch(() => finish(null));
  });
}

/** Send `initialize` then `thread/name/set` to a freshly spawned app-server.
 *  Resolves true only when the write is acknowledged with no error. Never
 *  throws: a failed title is not worth breaking the host process over. */
export function setThreadName({ bin, args = APP_SERVER_ARGS, threadId, name, timeoutMs = 10_000, env }) {
  if (!bin || !threadId || !name) return Promise.resolve(false);
  return withAppServer({ bin, args, timeoutMs, env }, async (call) => {
    const init = await call("initialize", { clientInfo: CLIENT_INFO });
    if (init?.error) return false;
    const set = await call("thread/name/set", { threadId, name });
    return !set?.error;
  }).then((value) => value === true);
}

/** Read the thread's current name and, only when `resolveName` approves it,
 *  write a new one — in ONE app-server session, so codex.exe is spawned once
 *  per turn rather than once per step (D40).
 *
 *  The read is `thread/list`, the method measured in D29: rows carry `id` and
 *  `name`, and an untitled/absent thread reports no name (treated as empty).
 *
 *  `resolveName(current)` returns the name to write, or a falsy value to leave
 *  the thread alone; it is where the caller decides whether a name is ours to
 *  replace and produces the title. Resolves `{ written, name }`; `written` is
 *  false on every skip and every transport failure, which the caller uses to
 *  avoid recording a title that never landed. */
export function renameThread({ bin, args = APP_SERVER_ARGS, threadId, resolveName, timeoutMs = 30_000, env }) {
  if (!bin || !threadId) return Promise.resolve({ written: false, name: null });
  return withAppServer({ bin, args, timeoutMs, env }, async (call) => {
    const init = await call("initialize", { clientInfo: CLIENT_INFO });
    if (init?.error) return { written: false, name: null };

    const list = await call("thread/list", { limit: 100 });
    if (list?.error) return { written: false, name: null };
    const rows = list?.result?.data;
    const current = Array.isArray(rows)
      ? (rows.find((row) => row && row.id === threadId)?.name ?? null)
      : null;

    const name = await resolveName(current);
    if (!name) return { written: false, name: null };
    const set = await call("thread/name/set", { threadId, name });
    return { written: !set?.error, name: set?.error ? null : name };
  }).then((value) => value ?? { written: false, name: null });
}

/** Rollouts live at $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl.
 *  Walked in Node rather than shelled out: the tree is small. A fork/continuation
 *  rollout is `…-<parentId>_<childId>.jsonl` and contains BOTH ids, so a plain
 *  substring search can pick the wrong file; match the exact trailing id instead
 *  and return the most recent (D27). */
export async function findRollout(threadId, env = process.env) {
  const home = env.CODEX_HOME || join(env.USERPROFILE || homedir(), ".codex");
  const root = join(home, "sessions");
  const suffix = `${threadId}.jsonl`;
  const matches = [];

  async function walk(dir, depth) {
    if (depth > 4) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        const stem = entry.name.slice(0, -suffix.length);
        // Accept only `-<id>.jsonl` / `_<id>.jsonl`, not `<id>` glued to more id.
        const sep = stem.slice(-1);
        if (sep === "-" || sep === "_") {
          try {
            matches.push({ path, mtimeMs: (await stat(path)).mtimeMs });
          } catch {
            /* raced away */
          }
        }
      }
    }
  }

  await walk(root, 0);
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matches[0].path;
}

/** Per-thread turn state. notify is a fresh process every turn and Codex does
 *  not pass a turn number — only a turn id — so the turn count and the title we
 *  last wrote have to live on disk. One small JSON file per thread, in the
 *  directory paths.dataDir() resolves (D37), alongside the daemon's TitleStore. */
export function readTurnState(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return {
      turns: Number(parsed?.turns) || 0,
      lastTitle: typeof parsed?.lastTitle === "string" ? parsed.lastTitle : null,
    };
  } catch {
    return { turns: 0, lastTitle: null };
  }
}

export function writeTurnState(file, state) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(state), "utf8");
  } catch {
    // State is best-effort: a failure only means we may title twice.
  }
}

async function run() {
  const raw = process.argv[process.argv.length - 1];
  let payload;
  try {
    payload = JSON.parse(raw ?? "{}");
  } catch {
    return;
  }
  if (payload.type !== "agent-turn-complete") return;
  const threadId = payload["thread-id"];
  if (!threadId) return;

  const here = dirname(fileURLToPath(import.meta.url));
  const client = await import(pathToFileURL(join(here, "..", "..", "dist", "client.js")).href);
  const { dataDir } = await import(pathToFileURL(join(here, "..", "..", "dist", "paths.js")).href);

  // Count the turn before any early return: turns 2 and 4+ must still advance
  // the counter, or the cadence breaks on the next invocation.
  const stateFile = join(dataDir(), `codex-name-${threadId}.json`);
  const state = readTurnState(stateFile);
  state.turns += 1;
  writeTurnState(stateFile, state);

  // One early pass (turn 1), one refine (turn 3), nothing after — the same
  // cadence as the Claude Code and Pi adapters.
  if (state.turns !== 1 && state.turns !== 3) return;

  const rollout = await findRollout(threadId);
  if (!rollout) return;

  const bin = resolveCodexBin();
  if (!bin) return;

  const previous = state.lastTitle;
  // Read the current name and write the new one in one app-server session. The
  // daemon is only started once the name is ours to change (ensureDaemon lives
  // inside resolveName), so a name the user set never starts a daemon either.
  const { written, name } = await renameThread({
    bin,
    threadId,
    resolveName: async (current) => {
      // Never overwrite a name the user chose: only an empty name, or the exact
      // title we last wrote, may be replaced.
      if (current && current !== previous) return null;
      // A session can start before the daemon is listening, so this must not
      // depend on a warm-up having run. ensureDaemon is bounded (5s) and never
      // throws; the single generate is bounded to 8s. Codex does not wait for
      // notify and gives it no timeout, but every await is still bounded so a
      // hung daemon cannot leak this process forever.
      await client.ensureDaemon({ timeoutMs: 5000 }).catch(() => {});
      const result = await client.generate(
        { agent: "codex", sessionId: threadId, transcriptPath: rollout },
        { timeoutMs: 8000 }
      );
      return result?.title ?? null;
    },
  });

  // Record only a title that actually landed, so a later turn can recognise its
  // own name and refine it without ever touching a user's.
  if (written) {
    state.lastTitle = name;
    writeTurnState(stateFile, state);
  }
}

async function main() {
  try {
    await run();
  } catch {
    // notify is fire-and-forget: never surface a failure to Codex.
  }
  process.exit(0);
}

// Only drive the flow when executed as the notify callback, not when imported.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
