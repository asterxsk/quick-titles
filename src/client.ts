import { createConnection } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { socketPath, dataDir, pidFile, modelsDir, MODEL_FILE, envPathOverride } from "./paths.js";
import type { Request, Response } from "./daemon/protocol.js";
import type { GenerateRequest, GenerateResult } from "./core/types.js";

const DEFAULT_TIMEOUT_MS = 15_000;

/** Total budget for a cold ensureDaemon() call. Model load is 4.8-5.6s, so 6s
 *  covers a healthy start with margin. Callers can bound it via opts.timeoutMs. */
const ENSURE_TIMEOUT_MS = 6_000;
const PING_TIMEOUT_MS = 500;
const POLL_INTERVAL_MS = 250;
/** A lock older than this was left by a process that died mid-spawn. */
const LOCK_STALE_MS = 30_000;
/** How long a lock file that is empty or malformed counts as "a holder is still
 *  writing it" rather than "a holder died". See `lockIsStale`. */
const LOCK_WRITE_GRACE_MS = 2_000;

/** `Omit` distributes over a union only through a naked type parameter.
 *  `Omit<Request, "id">` written directly collapses the discriminated union to
 *  its common keys and drops `params`, so generate/list call sites cannot
 *  typecheck. Distribute so every member keeps its own fields. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Returns null on any failure. Callers treat null as "no title", never as an error. */
export async function request<T>(
  req: DistributiveOmit<Request, "id">,
  opts: { timeoutMs?: number } = {}
): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    let settled = false;
    const done = (value: T | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };

    const socket = createConnection(socketPath());
    socket.setTimeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    socket.on("timeout", () => done(null));
    socket.on("error", () => done(null));

    let buffer = "";
    socket.on("connect", () =>
      socket.write(JSON.stringify({ ...req, id: Math.random().toString(36).slice(2) }) + "\n")
    );
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const nl = buffer.indexOf("\n");
      if (nl === -1) return;
      try {
        const response = JSON.parse(buffer.slice(0, nl)) as Response;
        done(response.ok ? (response.result as T) : null);
      } catch {
        done(null);
      }
    });
  });
}

/** True if `pid` names a live process. EPERM means alive but not ours; only
 *  ESRCH means the process is gone. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** The pid the daemon recorded, or null if there is no readable pidFile. */
function daemonPid(): number | null {
  try {
    const pid = Number(readFileSync(pidFile(), "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** A daemon process exists, whether or not it is answering yet. This is the only
 *  evidence available for a daemon that is still loading its model: it has not
 *  bound its socket, so a failed ping says nothing about it. Sampled twice in
 *  `ensureDaemon` — before the lock attempt and again after acquiring it —
 *  because a single sample goes stale across the wait. */
function isDaemonAlive(): boolean {
  const pid = daemonPid();
  return pid !== null && processAlive(pid);
}

/** A lock is stale if its pid is dead or the file has not been touched in
 *  LOCK_STALE_MS. An unreadable or vanished lock is reclaimable. */
function lockIsStale(path: string): boolean {
  try {
    const raw = readFileSync(path, "utf8").trim();
    const age = Date.now() - statSync(path).mtimeMs;
    const pid = Number(raw);
    if (!Number.isInteger(pid) || pid <= 0) {
      // The lock exists but holds nothing readable. That has two causes, and
      // they are indistinguishable by content: a holder that has created the
      // file but not yet written its pid, and a holder that died between those
      // two steps.
      //
      // Only the first matters, and it is not rare. `acquireSpawnLock` creates
      // the file with `openSync(path, "wx")` and writes the pid afterwards, so
      // the file is briefly empty — and two callers racing a cold start reach
      // that `openSync` at the same instant, which is exactly when the loser is
      // sitting in this function reading the winner's lock. Judging an empty
      // file stale on sight meant the loser unlinked the winner's lock, created
      // its own, and spawned a second daemon: CI observed it as
      // `expected [ '2927', '2926' ] to have a length of 1 but got 2`, and only
      // ever on a loaded runner, because the two processes have to arrive
      // together for the window to be hit.
      //
      // Age is therefore the only available discriminator. The cost of choosing
      // wrong in this direction is one grace period of delay after a genuine
      // crash; choosing wrong in the other direction is a duplicate daemon
      // loading the same model twice, which is worse.
      //
      // (`writeSync` of a few bytes is a single write syscall, so a reader sees
      // either nothing or the whole pid — a torn pid is not a case to handle.)
      return age > LOCK_WRITE_GRACE_MS;
    }
    return !processAlive(pid) || age > LOCK_STALE_MS;
  } catch {
    return true;
  }
}

/** Single-flight spawn lock, created atomically (O_EXCL) at dataDir()/daemon.lock.
 *  Returns the open fd when this process created the lock, or null when another
 *  process already holds a fresh one (in which case the caller must NOT spawn). */
function acquireSpawnLock(): number | null {
  const path = join(dataDir(), "daemon.lock");
  mkdirSync(dataDir(), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, String(process.pid));
      return fd;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null;
      if (!lockIsStale(path)) return null;
      // A dead holder left it behind: reclaim and retry the create once.
      try {
        unlinkSync(path);
      } catch {
        // Raced with another reclaim; the retry below will re-check.
      }
    }
  }
  return null;
}

/** Drop the lock, but only when this process is the one that created it. */
function releaseSpawnLock(fd: number | null): void {
  if (fd === null) return;
  try {
    closeSync(fd);
  } catch {
    // already closed
  }
  try {
    unlinkSync(join(dataDir(), "daemon.lock"));
  } catch {
    // already gone
  }
}

/** Best-effort daemon start. Returns whether the daemon answered afterwards.
 *
 *  `opts.timeoutMs` is a TOTAL budget for the whole call (default 6s). A cold
 *  start pays no more than that, whether the daemon comes up, is already
 *  loading, or never provisioned. */
export async function ensureDaemon(opts: { timeoutMs?: number } = {}): Promise<boolean> {
  const deadline = Date.now() + (opts.timeoutMs ?? ENSURE_TIMEOUT_MS);

  const ping = async (timeoutMs: number = PING_TIMEOUT_MS): Promise<boolean> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    return (await request({ method: "ping" }, { timeoutMs: Math.min(timeoutMs, remaining) })) !== null;
  };

  // 1. A daemon that is already answering needs nothing from us.
  if (await ping()) return true;

  // 2. A live pid means a daemon exists but is still loading its model. Its
  //    failed ping is "busy", not "absent" — never spawn a second one.
  const daemonAlive = isDaemonAlive();

  // 3. Nothing was ever provisioned, so nothing will load: bail before spending
  //    the poll budget on every prompt of an untitled session.
  //
  //    An explicit QT_MODEL is taken on trust rather than stat'd. The override
  //    exists so a caller can say "the model is here" — a sideloaded file, a
  //    converted model outside the data directory — and the pre-check's job is
  //    only to notice that the *default* location is empty. Requiring the
  //    overridden path to exist makes the override useless for anything the
  //    process cannot already see, and turns a user's typo into "no daemon ever
  //    starts" with no diagnostic. `modelPath()` is deliberately not used here:
  //    it resolves the override, which is exactly what must not happen before
  //    the daemon gets a chance to report why it could not load.
  if (!daemonAlive && !envPathOverride("QT_MODEL") && !existsSync(join(modelsDir(), MODEL_FILE))) {
    return false;
  }

  // 4. Single-flight: only the lock holder may spawn. The lock lives on disk so
  //    it holds across processes, not just across calls.
  const lock = daemonAlive ? null : acquireSpawnLock();
  try {
    // Holding the lock is permission to spawn, not an obligation: re-read
    // liveness before using it. `daemonAlive` above was sampled *before* the lock
    // attempt, so a daemon that wrote its pid file in between would otherwise be
    // missed. The re-ping below catches a daemon that is *up*; it cannot catch
    // one that is still loading its model, and that is the window the pid file
    // exists to cover (D35, D53). Skipping the spawn here falls through to the
    // poll, which is the same path a caller that saw the live pid at step 2
    // would have taken.
    if (!daemonAlive && lock !== null && !isDaemonAlive()) {
      // The daemon may have started while we waited for the lock; if it now
      // answers, the other spawner already did the work.
      if (await ping()) return true;

      const here = dirname(fileURLToPath(import.meta.url));
      // The daemon entry is overridable for the same reason socketPath() is (D15):
      // a test that means "start the daemon" must be able to point the spawn at a
      // stand-in instead of the real 300 MB model loader.
      const entry = process.env.QUICK_TITLES_DAEMON_ENTRY ?? join(here, "daemon", "main.js");
      const child = spawn(process.execPath, [entry], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    }

    // 5. Poll every 250ms until the daemon answers or the budget is spent.
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, Math.min(POLL_INTERVAL_MS, deadline - Date.now())));
      if (await ping()) return true;
    }
    return false;
  } finally {
    releaseSpawnLock(lock);
  }
}

export async function generate(
  req: GenerateRequest,
  opts: { timeoutMs?: number } = {}
): Promise<GenerateResult | null> {
  return request<GenerateResult>({ method: "generate", params: req }, opts);
}
