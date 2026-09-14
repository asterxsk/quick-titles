// These tests drive the adapter the way Claude Code drives it: a JSON payload
// on the hook's stdin, JSON (or nothing) on stdout, and always exit 0.
//
// D16: async `execFile` silently ignores its `input` option, so a helper built
// on it starts the child with empty stdin and every assertion passes against a
// script that never saw a payload. The helper below spawns the script and writes
// the payload to stdin explicitly, and the tests prove the payload arrived.
import { describe, expect, it, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDirSync } from "../helpers/tmp.js";

const ROOT = process.cwd();
const USER_PROMPT = join(ROOT, "adapters/claude-code/scripts/user-prompt.mjs");
const SESSIONS = join(ROOT, "adapters/claude-code/scripts/sessions.mjs");
const SESSION_START = join(ROOT, "adapters/claude-code/scripts/session-start.mjs");

// The client spawns `node <daemon entry>` detached. Tests that mean "no daemon"
// point that spawn at a file that does not exist, so they never launch the real
// 300 MB daemon as a side effect of asserting the hook is quiet.
const NO_DAEMON_ENTRY = join(ROOT, "adapters/claude-code/scripts/__no-daemon-entry__.mjs");

// A socket path nobody is listening on, so the client's connect fails fast.
function inertSocket(): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\qt-absent-${Math.random().toString(36).slice(2)}`
    : join(tempDirSync("qt-test-"), "absent.sock");
}
afterEach(() => {
  cleanupTempDirs();
});

interface Run {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Spawn the hook and write `payload` to its stdin, exactly as the host does. */
function invoke(script: string, payload: string, env: NodeJS.ProcessEnv = {}): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, QUICK_TITLES_DAEMON_ENTRY: NO_DAEMON_ENTRY, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.stdin.on("error", () => {}); // child may exit before we finish writing
    child.on("close", (code) => resolve({ stdout, stderr, code }));
    child.stdin.write(payload);
    child.stdin.end();
  });
}

interface FakeDaemon {
  socket: string;
  /** Only `generate` requests are counted: the hook pings first (ensureDaemon),
   *  and the number of *generates* is what proves it never retried. */
  generates: () => number;
  close: () => Promise<void>;
}

/** A stand-in for the real daemon: answers every `generate` with `title`. */
function startFakeDaemon(title: string): Promise<FakeDaemon> {
  return new Promise((resolve, reject) => {
    let generates = 0;
    const socket =
      process.platform === "win32"
        ? `\\\\.\\pipe\\qt-test-${Math.random().toString(36).slice(2)}`
        : join(tempDirSync("qt-test-"), "daemon.sock");
    const server = createServer((conn) => {
      let buf = "";
      conn.on("data", (chunk) => {
        buf += chunk.toString();
        const nl = buf.indexOf("\n");
        if (nl === -1) return;
        const req = JSON.parse(buf.slice(0, nl));
        if (req.method === "generate") generates += 1;
        conn.write(
          JSON.stringify({ id: req.id, ok: true, result: { title, description: null } }) + "\n"
        );
      });
    });
    server.on("error", reject);
    server.listen(socket, () =>
      resolve({
        socket,
        generates: () => generates,
        close: () => new Promise((r) => server.close(() => r())),
      })
    );
  });
}

/** A daemon that has bound its socket and accepts connections but never writes
 *  a byte, so every request — the 500ms ping and the 8s generate alike — runs to
 *  its full timeout. This is the "wedged" worst case: at connect time it is
 *  indistinguishable from a healthy daemon. */
function startWedgedDaemon(): Promise<FakeDaemon> {
  return new Promise((resolve, reject) => {
    const conns: import("node:net").Socket[] = [];
    const socket =
      process.platform === "win32"
        ? `\\\\.\\pipe\\qt-wedged-${Math.random().toString(36).slice(2)}`
        : join(tempDirSync("qt-test-"), "wedged.sock");
    const server = createServer((conn) => {
      conns.push(conn);
      conn.on("data", () => {}); // read and discard; never respond
      conn.on("error", () => {});
    });
    server.on("error", reject);
    server.listen(socket, () =>
      resolve({
        socket,
        generates: () => 0,
        close: () =>
          new Promise((r) => {
            for (const c of conns) c.destroy();
            server.close(() => r());
          }),
      })
    );
  });
}

/** A daemon *entry* the client spawns on a cold start. Unlike startFakeDaemon,
 *  nothing is listening until this process is launched, so the test proves the
 *  hook actually started a daemon. It *appends* its pid to a boot log the moment
 *  it boots — one line per spawn, so the log proves how many daemons the hook
 *  started — then serves ping/generate on QUICK_TITLES_SOCKET and exits. */
function writeStubDaemon(bootLog: string, title: string): string {
  const file = join(tempDirSync("qt-test-"), "stub-daemon.mjs");
  writeFileSync(
    file,
    `import { createServer } from "node:net";
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(bootLog)}, String(process.pid) + "\\n");
const server = createServer((conn) => {
  let buf = "";
  conn.on("data", (chunk) => {
    buf += chunk.toString();
    const nl = buf.indexOf("\\n");
    if (nl === -1) return;
    const req = JSON.parse(buf.slice(0, nl));
    if (req.method === "generate") {
      conn.write(JSON.stringify({ id: req.id, ok: true, result: { title: ${JSON.stringify(
        title
      )}, description: null } }) + "\\n");
      setTimeout(() => process.exit(0), 150);
    } else {
      conn.write(JSON.stringify({ id: req.id, ok: true, result: "pong" }) + "\\n");
    }
  });
  conn.on("error", () => {});
});
server.on("error", () => process.exit(1));
server.listen(process.env.QUICK_TITLES_SOCKET);
setTimeout(() => process.exit(0), 15000);
`,
    "utf8"
  );
  return file;
}

describe("claude-code adapter", () => {
  it("exits silently, code 0, when the daemon is absent", async () => {
    const { stdout, stderr, code } = await invoke(
      USER_PROMPT,
      JSON.stringify({ session_id: "s1", transcript_path: "nowhere.jsonl" }),
      { QUICK_TITLES_DATA_DIR: tempDirSync("qt-test-"), QUICK_TITLES_SOCKET: inertSocket() }
    );
    expect(stdout.trim()).toBe("");
    expect(stderr.trim()).toBe("");
    expect(code).toBe(0);
  });

  it("spawns a daemon from a cold start, without a prior SessionStart", async () => {
    // The gap this closes: every behavioural test above injects an already-
    // listening fake daemon, so none of them could see that the hook never
    // starts one. Here nothing listens; the daemon entry is the thing the hook
    // must spawn, and its boot line is the proof that it did.
    const data = tempDirSync("qt-test-");
    const marker = join(tempDirSync("qt-test-"), "spawned.pid");
    const entry = writeStubDaemon(marker, "Cold Start Title");
    const { stdout, stderr, code } = await invoke(
      USER_PROMPT,
      JSON.stringify({ session_id: "cold", transcript_path: "t.jsonl" }),
      {
        QUICK_TITLES_DATA_DIR: data,
        QUICK_TITLES_SOCKET: inertSocket(),
        QUICK_TITLES_DAEMON_ENTRY: entry,
        // This test asserts the spawn path, which ensureDaemon() skips when no
        // model is provisioned; pretend the stub's model is installed.
        QT_MODEL: join(data, "provisioned.gguf"),
      }
    );
    expect(code).toBe(0);
    expect(stderr.trim()).toBe("");
    expect(existsSync(marker)).toBe(true);
    expect(JSON.parse(stdout.trim()).hookSpecificOutput.sessionTitle).toBe("Cold Start Title");
  });

  it("SessionStart starts the daemon instead of dropping it at process.exit", async () => {
    const marker = join(tempDirSync("qt-test-"), "spawned-session.pid");
    const data = tempDirSync("qt-test-");
    const entry = writeStubDaemon(marker, "Resumed Session Title");
    const { stdout, code } = await invoke(
      SESSION_START,
      JSON.stringify({ session_id: "warm", transcript_path: "t.jsonl" }),
      {
        QUICK_TITLES_DATA_DIR: data,
        QUICK_TITLES_SOCKET: inertSocket(),
        QUICK_TITLES_DAEMON_ENTRY: entry,
        // See the cold-start test: ensureDaemon() skips the spawn when no model
        // is installed, so this test simulates a provisioned machine.
        QT_MODEL: join(data, "provisioned.gguf"),
        QT_TITLE_ON_RESUME: "1",
      }
    );
    expect(code).toBe(0);
    expect(existsSync(marker)).toBe(true);
    expect(JSON.parse(stdout.trim()).hookSpecificOutput.sessionTitle).toBe("Resumed Session Title");
  });

  it("exits silently, code 0, with no input", async () => {
    const { stdout, code } = await invoke(USER_PROMPT, "{}");
    expect(stdout.trim()).toBe("");
    expect(code).toBe(0);
  });

  it("exits silently, code 0, on malformed stdin", async () => {
    const data = tempDirSync("qt-test-");
    const { stdout, code } = await invoke(USER_PROMPT, "this is not json", {
      QUICK_TITLES_DATA_DIR: data,
      QUICK_TITLES_SOCKET: inertSocket(),
    });
    expect(stdout.trim()).toBe("");
    expect(code).toBe(0);
    // Garbage must not have been half-parsed into a session id.
    expect(existsSync(join(data, "prompts-s1"))).toBe(false);
  });

  it("exits silently, code 0, for a payload with no transcript path", async () => {
    const { stdout, stderr, code } = await invoke(
      USER_PROMPT,
      JSON.stringify({ session_id: "no-transcript" }),
      { QUICK_TITLES_DATA_DIR: tempDirSync("qt-test-"), QUICK_TITLES_SOCKET: inertSocket() }
    );
    expect(stdout.trim()).toBe("");
    expect(stderr.trim()).toBe("");
    expect(code).toBe(0);
  });

  it("SessionStart exits silently, code 0, for a payload with no transcript path", async () => {
    const { stdout, stderr, code } = await invoke(
      SESSION_START,
      JSON.stringify({ session_id: "s" })
    );
    expect(stdout.trim()).toBe("");
    expect(stderr.trim()).toBe("");
    expect(code).toBe(0);
  });

  it("emits the generated title as hook JSON on stdout", async () => {
    const daemon = await startFakeDaemon("Refactor auth middleware");
    try {
      const { stdout, stderr, code } = await invoke(
        USER_PROMPT,
        JSON.stringify({ session_id: "e2e", transcript_path: "t.jsonl" }),
        { QUICK_TITLES_DATA_DIR: tempDirSync("qt-test-"), QUICK_TITLES_SOCKET: daemon.socket }
      );
      expect(code).toBe(0);
      expect(stderr.trim()).toBe("");
      expect(stdout.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(stdout.trim())).toEqual({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          sessionTitle: "Refactor auth middleware",
        },
      });
      expect(daemon.generates()).toBe(1);
    } finally {
      await daemon.close();
    }
  });

  it("titles on prompt 1 and prompt 3 only", async () => {
    const data = tempDirSync("qt-test-");
    const daemon = await startFakeDaemon("Counted Title");
    const payload = JSON.stringify({ session_id: "counted", transcript_path: "t.jsonl" });
    try {
      const runs: Run[] = [];
      for (let i = 0; i < 4; i++) {
        runs.push(
          await invoke(USER_PROMPT, payload, {
            QUICK_TITLES_DATA_DIR: data,
            QUICK_TITLES_SOCKET: daemon.socket,
          })
        );
      }
      expect(runs.map((r) => r.stdout.trim() !== "")).toEqual([true, false, true, false]);
      expect(daemon.generates()).toBe(2);
      expect(readFileSync(join(data, "prompts-counted"), "utf8")).toBe("4");
    } finally {
      await daemon.close();
    }
  });

  it("completes a wedged-daemon worst case inside the host's 25s timeout", async () => {
    // A bound socket that accepts connections but never answers makes both the
    // ping and the generate run to their full timeouts. QT_MODEL is set so
    // ensureDaemon() does not take its fast no-model short-circuit and instead
    // spends its whole 5s poll budget — the exact path that used to blow 25s.
    // The host kills the hook at 25s; the adapter must finish far sooner and
    // still exit 0 rather than being killed mid-write (the silent no-op).
    const data = tempDirSync("qt-test-");
    const daemon = await startWedgedDaemon();
    try {
      const started = Date.now();
      const { stdout, stderr, code } = await invoke(
        USER_PROMPT,
        JSON.stringify({ session_id: "wedged", transcript_path: "t.jsonl" }),
        {
          QUICK_TITLES_DATA_DIR: data,
          QUICK_TITLES_SOCKET: daemon.socket,
          QT_MODEL: join(data, "provisioned.gguf"),
        }
      );
      const elapsed = Date.now() - started;
      // Tight enough to fail the old 42.8s ordering, loose enough to absorb
      // process startup on a loaded CI box.
      expect(elapsed).toBeLessThan(20000);
      expect(code).toBe(0);
      expect(stderr.trim()).toBe("");
      expect(stdout.trim()).toBe("");
    } finally {
      await daemon.close();
    }
  }, 45000);

  it("spawns at most one daemon on a cold UserPromptSubmit", async () => {
    // The old hook generated, then on a miss ensured the daemon and generated
    // again; against a slow start that could race a second spawn. The boot log
    // appends one line per spawn, so it can prove the hook spawned exactly one.
    const data = tempDirSync("qt-test-");
    const boot = join(tempDirSync("qt-test-"), "boots.log");
    const entry = writeStubDaemon(boot, "Single Spawn Title");
    const { stdout, code } = await invoke(
      USER_PROMPT,
      JSON.stringify({ session_id: "single", transcript_path: "t.jsonl" }),
      {
        QUICK_TITLES_DATA_DIR: data,
        QUICK_TITLES_SOCKET: inertSocket(),
        QUICK_TITLES_DAEMON_ENTRY: entry,
        QT_MODEL: join(data, "provisioned.gguf"),
      }
    );
    expect(code).toBe(0);
    expect(readFileSync(boot, "utf8").trim().split("\n").filter(Boolean)).toHaveLength(1);
    expect(JSON.parse(stdout.trim()).hookSpecificOutput.sessionTitle).toBe("Single Spawn Title");
  });

  it("feeds the payload to the hook's stdin", async () => {
    // readStdin() can only know the session id if the payload arrived on stdin;
    // the counter file it leaves behind is therefore proof the payload was read
    // and parsed (the failure mode D16 describes).
    const data = tempDirSync("qt-test-");
    const { code } = await invoke(
      USER_PROMPT,
      JSON.stringify({ session_id: "stdin-proof", transcript_path: "t.jsonl" }),
      { QUICK_TITLES_DATA_DIR: data, QUICK_TITLES_SOCKET: inertSocket() }
    );
    expect(code).toBe(0);
    expect(readFileSync(join(data, "prompts-stdin-proof"), "utf8")).toBe("1");
  });

  it("titles from the platform data dir when no override is set, instead of exiting untitled", async () => {
    // The old hook read CLAUDE_PLUGIN_DATA || QUICK_TITLES_DATA_DIR || "" and
    // exited 0 when both were unset, so on a host that supplies neither it
    // silently never titled anything. paths.dataDir() always resolves a real
    // directory, so the hook now titles instead of no-opping.
    const base = tempDirSync("qt-test-");
    const daemon = await startFakeDaemon("Fallback Title");
    try {
      const env: NodeJS.ProcessEnv = {
        CLAUDE_PLUGIN_DATA: "",
        QUICK_TITLES_DATA_DIR: "",
        QUICK_TITLES_SOCKET: daemon.socket,
        // Isolate the platform default so this test never writes to the real
        // user data dir: LOCALAPPDATA on win32, XDG_DATA_HOME elsewhere, HOME
        // for the macOS branch.
        LOCALAPPDATA: base,
        XDG_DATA_HOME: base,
        HOME: base,
        USERPROFILE: base,
      };
      const { stdout, code } = await invoke(
        USER_PROMPT,
        JSON.stringify({ session_id: "fallback", transcript_path: "t.jsonl" }),
        env
      );
      const expectedDataDir = join(
        base,
        process.platform === "darwin" ? join("Library", "Application Support") : "",
        "quick-titles"
      );
      expect(code).toBe(0);
      expect(JSON.parse(stdout.trim()).hookSpecificOutput.sessionTitle).toBe("Fallback Title");
      expect(readFileSync(join(expectedDataDir, "prompts-fallback"), "utf8")).toBe("1");
    } finally {
      await daemon.close();
    }
  });

  it("writes its prompt counter where paths.dataDir() resolves, not a second rule", async () => {
    // CLAUDE_PLUGIN_DATA and QUICK_TITLES_DATA_DIR deliberately differ here.
    // paths.dataDir() resolves them with one precedence (CLAUDE_PLUGIN_DATA
    // first); the hook used to re-read the pair itself, so its counter could
    // land somewhere the daemon's state never goes.
    const pluginData = tempDirSync("qt-test-");
    const qtData = tempDirSync("qt-test-");
    const daemon = await startFakeDaemon("One Rule Title");
    const prevPlugin = process.env.CLAUDE_PLUGIN_DATA;
    const prevQt = process.env.QUICK_TITLES_DATA_DIR;
    process.env.CLAUDE_PLUGIN_DATA = pluginData;
    process.env.QUICK_TITLES_DATA_DIR = qtData;
    try {
      const { dataDir } = (await import("../../src/paths.js")) as { dataDir: () => string };
      const resolved = dataDir();
      const { stdout, code } = await invoke(
        USER_PROMPT,
        JSON.stringify({ session_id: "one-rule", transcript_path: "t.jsonl" }),
        {
          CLAUDE_PLUGIN_DATA: pluginData,
          QUICK_TITLES_DATA_DIR: qtData,
          QUICK_TITLES_SOCKET: daemon.socket,
        }
      );
      expect(code).toBe(0);
      expect(JSON.parse(stdout.trim()).hookSpecificOutput.sessionTitle).toBe("One Rule Title");
      expect(readFileSync(join(resolved, "prompts-one-rule"), "utf8")).toBe("1");
    } finally {
      if (prevPlugin === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = prevPlugin;
      if (prevQt === undefined) delete process.env.QUICK_TITLES_DATA_DIR;
      else process.env.QUICK_TITLES_DATA_DIR = prevQt;
      await daemon.close();
    }
  });

  it("bounds the hook timeout above the client's own timeout", () => {
    const hooks = JSON.parse(
      readFileSync(join(ROOT, "adapters/claude-code/hooks/hooks.json"), "utf8")
    );
    const timeout = hooks.hooks.UserPromptSubmit[0].hooks[0].timeout;
    // `timeout` is seconds and the schema sets no maximum; 30 is only the
    // default applied when the field is omitted (D17). The hook's worst path is
    // ensureDaemon(5s) + generate(8s) = 13.5s, so 25s leaves the adapter 11.5s
    // of margin before the host would kill it and drop its output.
    expect(timeout).toBeGreaterThan(15);
    expect(timeout).toBeLessThan(30);
  });
});

// The `/sessions` listing is the only place a description is ever seen: no host
// agent has a field to put one in. It is also the only entry point in this
// adapter that a user invokes directly, and that is why it reads the store as a
// file rather than asking the daemon over its socket — what follows is what
// holds that decision in place.
describe("the /sessions listing", () => {
  const record = (
    agent: string,
    sessionId: string,
    title: string,
    description: string | null,
    createdAt: string
  ) =>
    JSON.stringify({
      agent,
      sessionId,
      title,
      description,
      backend: "vulkan",
      modelVersion: "title_q8_0@v0.1.0",
      createdAt,
    });

  it("lists every host's titles straight from the store, with no daemon running", async () => {
    const dataDir = tempDirSync("qt-sessions-");
    writeFileSync(
      join(dataDir, "titles.jsonl"),
      [
        record(
          "claude-code",
          "ses_1",
          "Auth middleware refactor",
          "Reworked token expiry checks.",
          "2026-09-14T10:00:00.000Z"
        ),
        record("pi", "ses_2", "Wiring the Pi extension", null, "2026-09-14T11:00:00.000Z"),
      ].join("\n") + "\n",
      "utf8"
    );

    // `invoke` already points QUICK_TITLES_DAEMON_ENTRY at a file that does not
    // exist, so a passing run is evidence the listing needs no daemon rather
    // than a claim about it. CLAUDE_PLUGIN_DATA is cleared explicitly because
    // dataDir() prefers it: an inherited value would aim the read at the real
    // store and the fixture would never be consulted.
    const out = await invoke(SESSIONS, "", {
      CLAUDE_PLUGIN_DATA: "",
      QUICK_TITLES_DATA_DIR: dataDir,
    });

    expect(out.code).toBe(0);
    expect(out.stdout).toContain("Auth middleware refactor");
    expect(out.stdout).toContain("Reworked token expiry checks.");
    expect(out.stdout).toContain("Wiring the Pi extension");
    expect(out.stdout).toContain("[pi]");
    expect(out.stdout).toContain("Powered by Desert Ant Labs");
  });

  it("says there are no titles yet rather than printing nothing", async () => {
    const dataDir = tempDirSync("qt-sessions-empty-");
    const out = await invoke(SESSIONS, "", {
      CLAUDE_PLUGIN_DATA: "",
      QUICK_TITLES_DATA_DIR: dataDir,
    });
    expect(out.code).toBe(0);
    expect(out.stdout).toMatch(/no titles yet/i);
  });
});
