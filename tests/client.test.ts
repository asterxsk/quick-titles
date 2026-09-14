import { describe, expect, it, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { request, ensureDaemon } from "../src/client.js";
import { cleanupTempDirs, tempDirSync } from "./helpers/tmp.js";

const ROOT = process.cwd();
const DIST_CLIENT = join(ROOT, "dist", "client.js");

/** A socket path nobody is listening on, so a ping fails without delay. */
function inertSocket(): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\qt-client-${Math.random().toString(36).slice(2)}`
    : join(tempDirSync("qt-client-"), "absent.sock");
}

/** A child that calls the built ensureDaemon() and prints `{ok,ms}`. The race
 *  under test is cross-process, so it must be driven from real processes against
 *  the on-disk lock — an in-process Promise.all would not exercise it. */
function writeRunner(): string {
  const file = join(tempDirSync("qt-client-"), "ensure-runner.mjs");
  writeFileSync(
    file,
    `const { ensureDaemon } = await import(${JSON.stringify(pathToFileURL(DIST_CLIENT).href)});
const t0 = Date.now();
const ok = await ensureDaemon({ timeoutMs: Number(process.env.QT_TEST_BUDGET ?? 6000) });
process.stdout.write(JSON.stringify({ ok, ms: Date.now() - t0 }) + "\\n");
`,
    "utf8"
  );
  return file;
}

/** A daemon *entry* the client spawns: it appends one line to `bootLog` per boot,
 *  then either binds and answers pings, or stays alive without ever listening. */
function writeStubEntry(bootLog: string, listen: boolean): string {
  const file = join(tempDirSync("qt-client-"), "stub-entry.mjs");
  const serve = listen
    ? `const server = createServer((conn) => {
  let buf = "";
  conn.on("data", (chunk) => {
    buf += chunk.toString();
    const nl = buf.indexOf("\\n");
    if (nl === -1) return;
    const req = JSON.parse(buf.slice(0, nl));
    conn.write(JSON.stringify({ id: req.id, ok: true, result: "pong" }) + "\\n");
  });
  conn.on("error", () => {});
});
server.on("error", () => process.exit(1));
server.listen(process.env.QUICK_TITLES_SOCKET);
setTimeout(() => process.exit(0), 5000);`
    : `setTimeout(() => process.exit(0), 5000);`;
  // The stub registers itself exactly as `src/daemon/main.ts` does — pid file
  // first, then the work — because that registration is what the caller has to
  // go on. A stub that never writes one models a daemon the product cannot see,
  // which makes the "at most one spawn" assertion unsatisfiable by any
  // implementation rather than wrong in this one (D53).
  writeFileSync(
    file,
    `import { appendFileSync, writeFileSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
const pidFile = join(process.env.QUICK_TITLES_DATA_DIR, "daemon.pid");
writeFileSync(pidFile, String(process.pid), "utf8");
process.on("exit", () => { try { unlinkSync(pidFile); } catch {} });
appendFileSync(${JSON.stringify(bootLog)}, String(process.pid) + "\\n");
${serve}
`,
    "utf8"
  );
  return file;
}

interface EnsureRun {
  ok: boolean;
  ms: number;
}

function runEnsure(runner: string, env: NodeJS.ProcessEnv): Promise<EnsureRun> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [runner], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c.toString()));
    child.on("close", () => {
      try {
        const parsed = JSON.parse(out.trim().split("\n").pop() ?? "{}");
        resolve({ ok: !!parsed.ok, ms: Number(parsed.ms) || 0 });
      } catch {
        resolve({ ok: false, ms: 0 });
      }
    });
  });
}

function bootLines(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
}

function snapshotEnv(keys: string[]): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const key of keys) snap[key] = process.env[key];
  return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snap)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("client", () => {
  const original = process.env.QUICK_TITLES_SOCKET;

  afterEach(() => {
    // QUICK_TITLES_SOCKET is the supported override (D15); assigning undefined
    // would store the string "undefined", so delete instead.
    if (original === undefined) delete process.env.QUICK_TITLES_SOCKET;
    else process.env.QUICK_TITLES_SOCKET = original;
  });

  it("returns null when no daemon is listening", async () => {
    process.env.QUICK_TITLES_SOCKET =
      process.platform === "win32" ? "\\\\.\\pipe\\qt-does-not-exist" : "/tmp/qt-does-not-exist.sock";
    expect(await request({ method: "ping" }, { timeoutMs: 300 })).toBeNull();
  });

  it("resolves null rather than rejecting", async () => {
    process.env.QUICK_TITLES_SOCKET =
      process.platform === "win32" ? "\\\\.\\pipe\\qt-does-not-exist" : "/tmp/qt-does-not-exist.sock";
    await expect(request({ method: "ping" }, { timeoutMs: 300 })).resolves.toBeNull();
  });
});

describe("client daemon lifecycle", () => {
  afterEach(() => {
    cleanupTempDirs();
  });

  it("spawns exactly one daemon when two callers race a cold start", async () => {
    const data = tempDirSync("qt-client-");
    const boot = join(tempDirSync("qt-client-"), "boots.log");
    const entry = writeStubEntry(boot, true);
    const runner = writeRunner();
    const env = {
      QUICK_TITLES_DATA_DIR: data,
      QUICK_TITLES_SOCKET: inertSocket(),
      QUICK_TITLES_DAEMON_ENTRY: entry,
      QT_MODEL: join(tempDirSync("qt-client-"), "ignored-by-stub.gguf"),
      QT_TEST_BUDGET: "4000",
    };

    const [a, b] = await Promise.all([runEnsure(runner, env), runEnsure(runner, env)]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(bootLines(boot)).toHaveLength(1);
  });

  it("takes an explicit QT_MODEL on trust even when the file it names is absent", async () => {
    // This is a contract, not an accident of the fixtures above. The pre-spawn
    // guard exists to notice that the DEFAULT model location is empty; an
    // explicit override is the caller asserting where the model is, and stat-ing
    // it makes the override useless for anything the process cannot already see.
    //
    // Pinned explicitly because a rewrite of the guard to `existsSync(modelPath())`
    // looks like a harmless simplification, reads as stricter-and-therefore-safer,
    // and silently broke three suites — the failure is "no daemon ever starts",
    // which surfaces as a missing title rather than as an error.
    const data = tempDirSync("qt-client-");
    const boot = join(tempDirSync("qt-client-"), "boots.log");
    const entry = writeStubEntry(boot, true);
    const runner = writeRunner();
    const absent = join(data, "not-actually-here.gguf");
    expect(existsSync(absent)).toBe(false);

    const result = await runEnsure(runner, {
      QUICK_TITLES_DATA_DIR: data,
      QUICK_TITLES_SOCKET: inertSocket(),
      QUICK_TITLES_DAEMON_ENTRY: entry,
      QT_MODEL: absent,
      QT_TEST_BUDGET: "4000",
    });

    expect(result.ok).toBe(true);
    expect(bootLines(boot)).toHaveLength(1);
  });

  it("has the daemon register its pid before it loads the model", () => {
    // An ordering, not a value, and the ordering is the whole reason the pid
    // file works as a liveness signal. `client.ts` step 2 exists to treat "a
    // live pid" as "a daemon is coming, do not spawn another", but that reasoning
    // only holds if the pid appears before the 5-second model load. Write it
    // afterwards and the entire load is a state where the daemon is running and
    // invisible to both a ping and the pid file (D35, D52).
    //
    // No behavioural test can reach this without loading a real model, so the
    // assertion is on the order of the two statements. Both substrings are the
    // full statement, not the bare call name, so a comment that merely mentions
    // `TitleEngine.create()` cannot satisfy the search.
    const source = readFileSync(join(ROOT, "src/daemon/main.ts"), "utf8");
    const registers = source.indexOf("await writeFile(pidFile()");
    const loads = source.indexOf("const engine = await TitleEngine.create(");
    expect(registers).toBeGreaterThan(-1);
    expect(loads).toBeGreaterThan(-1);
    expect(registers).toBeLessThan(loads);
  });

  it("does not duplicate a live daemon that never binds", async () => {
    const data = tempDirSync("qt-client-");
    const boot = join(tempDirSync("qt-client-"), "boots.log");
    const entry = writeStubEntry(boot, false);
    const runner = writeRunner();
    const env = {
      QUICK_TITLES_DATA_DIR: data,
      QUICK_TITLES_SOCKET: inertSocket(),
      QUICK_TITLES_DAEMON_ENTRY: entry,
      QT_MODEL: join(tempDirSync("qt-client-"), "ignored-by-stub.gguf"),
      QT_TEST_BUDGET: "1500",
    };

    const [a, b] = await Promise.all([runEnsure(runner, env), runEnsure(runner, env)]);

    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    expect(a.ms).toBeLessThan(2500);
    expect(b.ms).toBeLessThan(2500);
    expect(bootLines(boot)).toHaveLength(1);
  });

  // The two halves of the lock's age rule, pinned separately because getting
  // either wrong is invisible without them. The window between `openSync` and
  // `writeSync` in `acquireSpawnLock` is microseconds wide, so no test can drive
  // a real process into it on demand — but the state it produces is trivially
  // reproducible: a lock file that exists and is empty, with a fresh mtime.
  it("treats an empty lock as held while its writer is still mid-write", async () => {
    const data = tempDirSync("qt-client-");
    const boot = join(tempDirSync("qt-client-"), "boots.log");
    const entry = writeStubEntry(boot, true);
    const runner = writeRunner();
    writeFileSync(join(data, "daemon.lock"), "", "utf8");

    const { ok } = await runEnsure(runner, {
      QUICK_TITLES_DATA_DIR: data,
      QUICK_TITLES_SOCKET: inertSocket(),
      QUICK_TITLES_DAEMON_ENTRY: entry,
      QT_MODEL: join(tempDirSync("qt-client-"), "ignored-by-stub.gguf"),
      QT_TEST_BUDGET: "800",
    });

    // Reclaiming this lock is what spawned a second daemon in CI: the loser
    // unlinked the winner's lock, created its own, and spawned.
    expect(bootLines(boot)).toHaveLength(0);
    expect(ok).toBe(false);
  });

  it("reclaims an empty lock once it is older than the write grace", async () => {
    // The other half of the rule. Without this the fix above would be "never
    // reclaim an empty lock", which deadlocks after a crash mid-write.
    const data = tempDirSync("qt-client-");
    const boot = join(tempDirSync("qt-client-"), "boots.log");
    const entry = writeStubEntry(boot, true);
    const runner = writeRunner();
    const lock = join(data, "daemon.lock");
    writeFileSync(lock, "", "utf8");
    const past = new Date(Date.now() - 60_000);
    utimesSync(lock, past, past);

    const { ok } = await runEnsure(runner, {
      QUICK_TITLES_DATA_DIR: data,
      QUICK_TITLES_SOCKET: inertSocket(),
      QUICK_TITLES_DAEMON_ENTRY: entry,
      QT_MODEL: join(tempDirSync("qt-client-"), "ignored-by-stub.gguf"),
      QT_TEST_BUDGET: "4000",
    });

    expect(ok).toBe(true);
    expect(bootLines(boot)).toHaveLength(1);
  });

  it("short-circuits when no model is installed", async () => {
    const data = tempDirSync("qt-client-");
    const boot = join(tempDirSync("qt-client-"), "boots.log");
    const entry = writeStubEntry(boot, true);
    const keys = [
      "QUICK_TITLES_DATA_DIR",
      "QUICK_TITLES_SOCKET",
      "QUICK_TITLES_DAEMON_ENTRY",
      "QT_MODEL",
    ];
    const saved = snapshotEnv(keys);
    try {
      process.env.QUICK_TITLES_DATA_DIR = data;
      process.env.QUICK_TITLES_SOCKET = inertSocket();
      process.env.QUICK_TITLES_DAEMON_ENTRY = entry;
      delete process.env.QT_MODEL;

      const started = Date.now();
      const ok = await ensureDaemon();

      expect(ok).toBe(false);
      expect(Date.now() - started).toBeLessThan(500);
      expect(bootLines(boot)).toHaveLength(0);
    } finally {
      restoreEnv(saved);
    }
  });

  it("suppresses the spawn when pidFile holds a live pid", async () => {
    const data = tempDirSync("qt-client-");
    const boot = join(tempDirSync("qt-client-"), "boots.log");
    const entry = writeStubEntry(boot, true);
    writeFileSync(join(data, "daemon.pid"), String(process.pid), "utf8");
    const keys = [
      "QUICK_TITLES_DATA_DIR",
      "QUICK_TITLES_SOCKET",
      "QUICK_TITLES_DAEMON_ENTRY",
      "QT_MODEL",
    ];
    const saved = snapshotEnv(keys);
    try {
      process.env.QUICK_TITLES_DATA_DIR = data;
      process.env.QUICK_TITLES_SOCKET = inertSocket();
      process.env.QUICK_TITLES_DAEMON_ENTRY = entry;
      process.env.QT_MODEL = join(tempDirSync("qt-client-"), "never.gguf");

      const ok = await ensureDaemon({ timeoutMs: 400 });

      expect(ok).toBe(false);
      expect(bootLines(boot)).toHaveLength(0);
    } finally {
      restoreEnv(saved);
    }
  });
});
