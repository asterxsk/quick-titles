// Codex adapter tests.
//
// The suite never depends on the 295 MB Codex binary and never renames a real
// thread. The RPC client is exercised against a tiny stub that speaks the same
// newline-delimited JSON-RPC over stdio and records the method order, so the
// one property that matters — `initialize` is sent before `thread/name/set` —
// is asserted on behaviour rather than grepped from source (D28). Discovery is
// exercised against a synthetic install tree (D27).
//
// A real-binary round trip lives in the last block and is gated behind
// QUICK_TITLES_CODEX_E2E so the default run stays independent of the binary.
import { describe, expect, it, afterEach } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import {
  writeFileSync,
  readFileSync,
  mkdirSync,
  utimesSync,
  existsSync,
} from "node:fs";
import { platform, homedir } from "node:os";
import { join, resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { tempDirSync, cleanupTempDirs } from "../helpers/tmp.js";

const ROOT = process.cwd();
const NOTIFY = join(ROOT, "adapters/codex/notify.mjs");
const INSTALL = join(ROOT, "adapters/codex/install.mjs");
const UNINSTALL = join(ROOT, "adapters/codex/uninstall.mjs");

const notify: {
  resolveCodexBin(env?: NodeJS.ProcessEnv): string | null;
  findRollout(threadId: string, env?: NodeJS.ProcessEnv): Promise<string | null>;
  setThreadName(opts: {
    bin: string;
    args?: string[];
    threadId: string;
    name: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
  }): Promise<boolean>;
} = await import(pathToFileURL(NOTIFY).href);

afterEach(() => {
  cleanupTempDirs();
});

interface Run {
  stdout: string;
  stderr: string;
  code: number | null;
}
function runNode(args: string[], env: NodeJS.ProcessEnv = {}): Promise<Run> {
  return new Promise((res) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("close", (code) => res({ stdout, stderr, code }));
    child.stdin.end();
  });
}

/** Parse a config file with the reference TOML implementation (Python's
 *  tomllib) rather than substring-matching the text. A table-nesting bug leaves
 *  `notify = [...]` in the file either way; only a real parser shows it landed
 *  inside the wrong table. */
function parseToml(file: string): Record<string, any> {
  // tomllib rejects a leading UTF-8 BOM even though TOML permits one, so hand
  // it a BOM-stripped copy when the file has one. That keeps this an
  // independent reference parser while still letting a BOM-preserving write be
  // asserted.
  const raw = readFileSync(file, "utf8");
  const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  let target = file;
  if (stripped !== raw) {
    target = join(tempDirSync("qt-codex-"), "reference.toml");
    writeFileSync(target, stripped, "utf8");
  }
  const code =
    "import json,sys,tomllib; print(json.dumps(tomllib.load(open(sys.argv[1],'rb'))))";
  const r = spawnSync("python", ["-c", code, target], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`tomllib failed on ${file}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

/** A minimal app-server stand-in: newline JSON-RPC on stdio. It appends every
 *  method it is asked to serve to STUB_LOG so ordering can be asserted, and can
 *  be told (via env) to fail either step. */
function writeStub(): string {
  const dir = tempDirSync("qt-codex-");
  const file = join(dir, "stub.mjs");
  writeFileSync(
    file,
    `import { appendFileSync } from "node:fs";
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (process.env.STUB_LOG) appendFileSync(process.env.STUB_LOG, msg.method + "\\n");
    if (process.env.STUB_NAME_LOG && msg.method === "thread/name/set")
      appendFileSync(process.env.STUB_NAME_LOG, msg.params.name + "\\n");
    let out;
    if (msg.method === "initialize") {
      out = process.env.STUB_FAIL_INIT
        ? { id: msg.id, error: { code: -32600, message: "Not initialized" } }
        : { id: msg.id, result: { userAgent: "stub/0" } };
    } else if (msg.method === "thread/list") {
      // The guarded write path reads the thread's current name here. STUB_THREAD_NAME
      // empty or unset models an untitled thread (name: null).
      out = process.env.STUB_FAIL_LIST
        ? { id: msg.id, error: { code: -32602, message: "list unavailable" } }
        : {
            id: msg.id,
            result: {
              data: [
                {
                  id: process.env.STUB_THREAD_ID ?? msg.params?.threadId ?? "t",
                  name: process.env.STUB_THREAD_NAME || null,
                },
              ],
            },
          };
    } else if (msg.method === "thread/name/set") {
      out = process.env.STUB_FAIL_SET
        ? { id: msg.id, error: { code: -32602, message: "no rollout found" } }
        : { id: msg.id, result: {} };
    } else {
      out = { id: msg.id, error: { code: -32601, message: "method not found" } };
    }
    process.stdout.write(JSON.stringify(out) + "\\n");
  }
});
`,
    "utf8"
  );
  return file;
}

function logPath(): string {
  return join(tempDirSync("qt-codex-"), "rpc.log");
}

/** An executable shim that runs the stub as if it were `codex app-server …`,
 *  so the shipped code path — spawn(bin, ["app-server", …]) — is exercised. */
function writeBinShim(stub: string): string {
  const dir = tempDirSync("qt-codex-");
  if (platform() === "win32") {
    const shim = join(dir, "codex-stub.cmd");
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${stub}" %*\r\n`, "utf8");
    return shim;
  }
  const shim = join(dir, "codex-stub");
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${stub}" "$@"\n`, { mode: 0o755 });
  return shim;
}

/** A daemon *entry* the client spawns on a cold start. Nothing listens until
 *  this process boots, so the adapter's ensureDaemon() is what must start it.
 *  It appends one pid line per spawn (so the boot log counts spawns), then
 *  serves ping/generate on QUICK_TITLES_SOCKET and exits. */
function writeStubDaemon(bootLog: string, title: string): string {
  const file = join(tempDirSync("qt-codex-"), "stub-daemon.mjs");
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

/** Write a rollout file for `id` under a fresh CODEX_HOME. notify only needs it
 *  to exist; the fake daemon, not the reader, answers `generate`. */
function codexHomeWithRollout(id: string): string {
  const home = tempDirSync("qt-codex-");
  const day = join(home, "sessions", "2026", "09", "14");
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, `rollout-2026-09-14T10-00-00-${id}.jsonl`), "", "utf8");
  return home;
}

/** A socket path nobody listens on, so the client's connect fails fast. */
function inertSocket(): string {
  return platform() === "win32"
    ? `\\\\.\\pipe\\qt-codex-absent-${Math.random().toString(36).slice(2)}`
    : join(tempDirSync("qt-codex-"), "absent.sock");
}

/** A stand-in for the daemon: answers every `generate` with `title`. */
function startFakeDaemon(title: string): Promise<{
  socket: string;
  requests: () => number;
  generates: () => number;
  close: () => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    let requests = 0;
    let generates = 0;
    const socket =
      platform() === "win32"
        ? `\\\\.\\pipe\\qt-codex-${Math.random().toString(36).slice(2)}`
        : join(tempDirSync("qt-codex-"), "daemon.sock");
    const server = createServer((conn) => {
      let buf = "";
      conn.on("data", (chunk) => {
        buf += chunk.toString();
        const nl = buf.indexOf("\n");
        if (nl === -1) return;
        const req = JSON.parse(buf.slice(0, nl));
        requests += 1;
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
        requests: () => requests,
        generates: () => generates,
        close: () => new Promise((r) => server.close(() => r())),
      })
    );
  });
}

describe("codex RPC client", () => {
  it("sends initialize before thread/name/set and reports success", async () => {
    const stub = writeStub();
    const log = logPath();
    const ok = await notify.setThreadName({
      bin: process.execPath,
      args: [stub, "app-server", "--listen", "stdio://"],
      threadId: "01a093e6-3409-7023-b5e0-b3c99b9fff4a",
      name: "Generated title",
      env: { STUB_LOG: log },
    });
    expect(ok).toBe(true);
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
      "initialize",
      "thread/name/set",
    ]);
  });

  it("fails without sending the write when initialize is refused", async () => {
    const stub = writeStub();
    const log = logPath();
    const ok = await notify.setThreadName({
      bin: process.execPath,
      args: [stub, "app-server", "--listen", "stdio://"],
      threadId: "t",
      name: "n",
      env: { STUB_LOG: log, STUB_FAIL_INIT: "1" },
    });
    expect(ok).toBe(false);
    // The handshake is a precondition: nothing else must reach the server.
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["initialize"]);
  });

  it("reports failure when thread/name/set is refused", async () => {
    const stub = writeStub();
    const log = logPath();
    const ok = await notify.setThreadName({
      bin: process.execPath,
      args: [stub, "app-server", "--listen", "stdio://"],
      threadId: "t",
      name: "n",
      env: { STUB_LOG: log, STUB_FAIL_SET: "1" },
    });
    expect(ok).toBe(false);
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
      "initialize",
      "thread/name/set",
    ]);
  });
});

describe("codex binary discovery", () => {
  it("prefers an explicit CODEX_BIN override", () => {
    const override = join(tempDirSync("qt-codex-"), "codex.exe");
    expect(notify.resolveCodexBin({ CODEX_BIN: override })).toBe(override);
  });

  it("finds codex on PATH", () => {
    const dir = tempDirSync("qt-codex-");
    writeFileSync(join(dir, "codex"), "");
    writeFileSync(join(dir, "codex.exe"), "");
    const found = notify.resolveCodexBin({ PATH: dir });
    expect(found).not.toBeNull();
    expect(resolve(found!)).toBe(resolve(join(dir, basename(found!))));
    expect(basename(found!)).toMatch(/^codex(\.exe)?$/);
  });

  it("falls back to the newest desktop-app bin that actually holds codex.exe", () => {
    if (platform() !== "win32") return; // %LOCALAPPDATA% shape is Windows-specific
    const local = tempDirSync("qt-codex-");
    const bin = join(local, "OpenAI", "Codex", "bin");
    const withExe = (hash: string, mtimeMs: number) => {
      const d = join(bin, hash);
      mkdirSync(d, { recursive: true });
      const exe = join(d, "codex.exe");
      writeFileSync(exe, "");
      utimesSync(exe, new Date(mtimeMs), new Date(mtimeMs));
    };
    withExe("aaaaaaaaaaaaaaaa", 1_000_000);
    withExe("bbbbbbbbbbbbbbbb", 2_000_000);
    // Newest directory, but it holds only unrelated executables — the real
    // machine has exactly this shape, and picking it would resolve to nothing.
    const empty = join(bin, "cccccccccccccccc");
    mkdirSync(empty, { recursive: true });
    const decoy = join(empty, "rg.exe");
    writeFileSync(decoy, "");
    utimesSync(decoy, new Date(9_000_000), new Date(9_000_000));

    const found = notify.resolveCodexBin({ LOCALAPPDATA: local, PATH: tempDirSync("qt-codex-") });
    expect(found).toBe(join(bin, "bbbbbbbbbbbbbbbb", "codex.exe"));
  });

  it("never hard-codes a bin hash", () => {
    expect(readFileSync(NOTIFY, "utf8")).not.toContain("7ac07f4ce733f89a");
  });
});

describe("codex rollout lookup", () => {
  it("matches the exact thread suffix and prefers the most recent by mtime", async () => {
    const home = tempDirSync("qt-codex-");
    const id = "01a093e6-3409-7023-b5e0-b3c99b9fff4a";
    const day = join(home, "sessions", "2026", "09", "14");
    mkdirSync(day, { recursive: true });
    // Older-looking filename, newer mtime — proves ordering uses mtime.
    const newerName = join(day, `rollout-2026-09-14T09-00-00-${id}.jsonl`);
    const olderName = join(day, `rollout-2026-09-14T11-00-00-${id}.jsonl`);
    writeFileSync(newerName, "");
    writeFileSync(olderName, "");
    utimesSync(newerName, new Date(2_000_000), new Date(2_000_000));
    utimesSync(olderName, new Date(1_000_000), new Date(1_000_000));

    expect(await notify.findRollout(id, { CODEX_HOME: home })).toBe(newerName);
  });

  it("does not confuse a fork rollout, which contains two thread ids", async () => {
    const home = tempDirSync("qt-codex-");
    const parent = "aaaaaaaa-1111-2222-3333-444444444444";
    const child = "bbbbbbbb-1111-2222-3333-444444444444";
    const day = join(home, "sessions", "2026", "09", "14");
    mkdirSync(day, { recursive: true });
    const parentOwn = join(day, `rollout-2026-09-14T09-00-00-${parent}.jsonl`);
    const fork = join(day, `rollout-2026-09-14T11-00-00-${parent}_${child}.jsonl`);
    writeFileSync(parentOwn, "");
    writeFileSync(fork, "");

    // The parent's own rollout must win for the parent, even though the newer
    // fork file also contains the parent id as a substring.
    expect(await notify.findRollout(parent, { CODEX_HOME: home })).toBe(parentOwn);
    expect(await notify.findRollout(child, { CODEX_HOME: home })).toBe(fork);
  });

  it("returns null when nothing matches", async () => {
    expect(await notify.findRollout("missing", { CODEX_HOME: tempDirSync("qt-codex-") })).toBeNull();
  });
});

describe("codex install", () => {
  const EXPECTED = [process.execPath, resolve(join(ROOT, "adapters/codex/notify.mjs"))];

  it("refuses to clobber an existing notify entry and leaves the file untouched", async () => {
    const home = tempDirSync("qt-codex-");
    const configPath = join(home, "config.toml");
    // The real config ends with a table; refusal must not depend on shape.
    const original =
      `model = "gpt-5"\nnotify = ["other.exe", "turn-ended"]\n\n` +
      `[hooks.state."a:b:0:0"]\ntrusted_hash = "deadbeef"\n`;
    writeFileSync(configPath, original, "utf8");

    const { stderr, code } = await runNode([INSTALL], { CODEX_HOME: home });
    expect(code).toBe(1);
    expect(stderr).toContain("a notify entry already exists");
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(parseToml(configPath).notify).toEqual(["other.exe", "turn-ended"]);
  });

  it("writes a TOML-valid notify array when no entry exists", async () => {
    const home = tempDirSync("qt-codex-");
    const { stdout, code } = await runNode([INSTALL], { CODEX_HOME: home });
    expect(code).toBe(0);
    expect(stdout).toContain("wrote notify entry");

    const config = readFileSync(join(home, "config.toml"), "utf8");
    const line = config.match(/^notify\s*=\s*(.+)$/m)?.[1];
    expect(line).toBeTruthy();
    // Parses as JSON only if backslashes were escaped, which is exactly the
    // defect the plan's raw-template write had on a Windows node path.
    expect(JSON.parse(line!)).toEqual(EXPECTED);
    // The no-table case: notify is a root key, not nested anywhere.
    expect(parseToml(join(home, "config.toml")).notify).toEqual(EXPECTED);
  });

  it("keeps notify at the root when config.toml ends with a table", async () => {
    // A bare key written after a table header belongs to that table (TOML is
    // not order-free). Appending at EOF therefore nested notify inside the
    // final table — the reported defect — so this asserts through a real parser.
    const home = tempDirSync("qt-codex-");
    const configPath = join(home, "config.toml");
    writeFileSync(
      configPath,
      `[mcp_servers.foo]\ncommand = "x"\n\n[hooks.state."a:b:0:0"]\ntrusted_hash = "deadbeef"\n`,
      "utf8"
    );

    const { code } = await runNode([INSTALL], { CODEX_HOME: home });
    expect(code).toBe(0);

    const parsed = parseToml(configPath);
    expect(parsed.notify).toEqual(EXPECTED);
    expect(parsed.mcp_servers.foo).toEqual({ command: "x" });
    expect(parsed.hooks.state["a:b:0:0"]).toEqual({ trusted_hash: "deadbeef" });
    expect(parsed.hooks.state["a:b:0:0"]).not.toHaveProperty("notify");
  });

  it("stays a root key when a non-table line begins with a bracket", async () => {
    // The first version of this fix inserted before /^[ \t]*\[/m — the first
    // line that merely *begins* with `[`. Inside a multi-line string or a
    // nested array that is not a table header, and `notify` then lands inside a
    // value: it does not register, which is the same silent no-op the fix was
    // meant to remove.
    const home = tempDirSync("qt-codex-");
    const configPath = join(home, "config.toml");
    writeFileSync(
      configPath,
      `description = """\n[not a table]\n"""\nmatrix = [\n  [1, 2],\n]\n\n` +
        `[model_providers.local]\nname = "local"\n`,
      "utf8"
    );

    const { code } = await runNode([INSTALL], { CODEX_HOME: home });
    expect(code).toBe(0);

    const parsed = parseToml(configPath);
    expect(parsed.notify).toEqual(EXPECTED);
    expect(parsed.description).toBe("[not a table]\n");
    expect(parsed.matrix).toEqual([[1, 2]]);
    expect(parsed.model_providers.local).toEqual({ name: "local" });
  });

  it("preserves comments and formatting rather than re-emitting the file", async () => {
    const home = tempDirSync("qt-codex-");
    const configPath = join(home, "config.toml");
    const body = `# my codex config\nmodel = "gpt-5"   # trailing\n`;
    writeFileSync(configPath, body, "utf8");

    const { code } = await runNode([INSTALL], { CODEX_HOME: home });
    expect(code).toBe(0);

    const after = readFileSync(configPath, "utf8");
    expect(after.endsWith(body)).toBe(true);
    expect(parseToml(configPath).model).toBe("gpt-5");
  });

  it("keeps notify at the root when a table sits after top-level keys", async () => {
    const home = tempDirSync("qt-codex-");
    const configPath = join(home, "config.toml");
    writeFileSync(
      configPath,
      `model = "gpt-5"\n\n[server]\nport = 1\n\n[hooks.state."x"]\ntrusted_hash = "abc"\n`,
      "utf8"
    );

    const { code } = await runNode([INSTALL], { CODEX_HOME: home });
    expect(code).toBe(0);

    const parsed = parseToml(configPath);
    expect(parsed.notify).toEqual(EXPECTED);
    expect(parsed.model).toBe("gpt-5");
    expect(parsed.server).toEqual({ port: 1 });
    expect(parsed.hooks.state.x).toEqual({ trusted_hash: "abc" });
  });

  // --- guard correctness: the old /^\s*notify\s*=/m regex was wrong both ways.
  // It matched `notify =` as *content* of a string (false refusal) and missed a
  // quoted root key (a duplicate notify, which makes the config invalid).

  it("installs when a triple-quoted basic string contains a notify = line", async () => {
    const home = tempDirSync("qt-codex-");
    const configPath = join(home, "config.toml");
    writeFileSync(
      configPath,
      `description = """\nnotify = 5\n"""\nmodel = "gpt-5"\n`,
      "utf8"
    );

    const { code, stderr } = await runNode([INSTALL], { CODEX_HOME: home });
    expect(stderr).not.toContain("already exists");
    expect(code).toBe(0);

    const parsed = parseToml(configPath);
    expect(parsed.notify).toEqual(EXPECTED);
    expect(parsed.description).toBe("notify = 5\n");
    expect(parsed.model).toBe("gpt-5");
  });

  it("installs when a single-quoted literal string contains a notify = line", async () => {
    const home = tempDirSync("qt-codex-");
    const configPath = join(home, "config.toml");
    writeFileSync(
      configPath,
      `description = '''\nnotify = 5\n'''\nmodel = "gpt-5"\n`,
      "utf8"
    );

    const { code } = await runNode([INSTALL], { CODEX_HOME: home });
    expect(code).toBe(0);

    const parsed = parseToml(configPath);
    expect(parsed.notify).toEqual(EXPECTED);
    expect(parsed.description).toBe("notify = 5\n");
    expect(parsed.model).toBe("gpt-5");
  });

  it("refuses a double-quoted existing key rather than write a duplicate", async () => {
    // TOML forbids duplicate keys; prepending a second notify would make the
    // config invalid and Codex would not start — worse than refusing.
    const home = tempDirSync("qt-codex-");
    const configPath = join(home, "config.toml");
    const original = `"notify" = ["other.exe", "turn-ended"]\nmodel = "gpt-5"\n`;
    writeFileSync(configPath, original, "utf8");

    const { code, stderr } = await runNode([INSTALL], { CODEX_HOME: home });
    expect(code).toBe(1);
    expect(stderr).toContain("a notify entry already exists");
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  it("refuses a single-quoted existing key rather than write a duplicate", async () => {
    const home = tempDirSync("qt-codex-");
    const configPath = join(home, "config.toml");
    const original = `'notify' = ["other.exe"]\n`;
    writeFileSync(configPath, original, "utf8");

    const { code, stderr } = await runNode([INSTALL], { CODEX_HOME: home });
    expect(code).toBe(1);
    expect(stderr).toContain("a notify entry already exists");
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  it("refuses a config that does not parse and changes nothing", async () => {
    const home = tempDirSync("qt-codex-");
    const configPath = join(home, "config.toml");
    const original = `notify = [\nthis is not toml\n`;
    writeFileSync(configPath, original, "utf8");

    const { code, stderr } = await runNode([INSTALL], { CODEX_HOME: home });
    expect(code).toBe(1);
    expect(stderr).toContain("not valid TOML");
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  // --- the shapes the file can already be in.

  it("installs into an empty config file", async () => {
    const home = tempDirSync("qt-codex-");
    const configPath = join(home, "config.toml");
    writeFileSync(configPath, "", "utf8");

    const { code } = await runNode([INSTALL], { CODEX_HOME: home });
    expect(code).toBe(0);
    expect(parseToml(configPath).notify).toEqual(EXPECTED);
  });

  it("installs into a comments-only config", async () => {
    const home = tempDirSync("qt-codex-");
    const configPath = join(home, "config.toml");
    const body = `# nothing but a comment\n`;
    writeFileSync(configPath, body, "utf8");

    const { code } = await runNode([INSTALL], { CODEX_HOME: home });
    expect(code).toBe(0);
    expect(readFileSync(configPath, "utf8").endsWith(body)).toBe(true);
    expect(parseToml(configPath).notify).toEqual(EXPECTED);
  });

  it("preserves a leading BOM", async () => {
    const home = tempDirSync("qt-codex-");
    const configPath = join(home, "config.toml");
    writeFileSync(configPath, String.fromCharCode(0xfeff) + `model = "gpt-5"\n`, "utf8");

    const { code } = await runNode([INSTALL], { CODEX_HOME: home });
    expect(code).toBe(0);
    expect(readFileSync(configPath, "utf8").charCodeAt(0)).toBe(0xfeff);
    const parsed = parseToml(configPath);
    expect(parsed.notify).toEqual(EXPECTED);
    expect(parsed.model).toBe("gpt-5");
  });

  it("round-trips a CRLF config", async () => {
    const home = tempDirSync("qt-codex-");
    const configPath = join(home, "config.toml");
    writeFileSync(configPath, `model = "gpt-5"\r\n`, "utf8");

    const { code } = await runNode([INSTALL], { CODEX_HOME: home });
    expect(code).toBe(0);
    const parsed = parseToml(configPath);
    expect(parsed.notify).toEqual(EXPECTED);
    expect(parsed.model).toBe("gpt-5");
    // The original line, CRLF and all, survives verbatim after our entry.
    expect(readFileSync(configPath, "utf8").endsWith(`model = "gpt-5"\r\n`)).toBe(true);
  });

  it("installs into a config with no trailing newline", async () => {
    const home = tempDirSync("qt-codex-");
    const configPath = join(home, "config.toml");
    writeFileSync(configPath, `model = "gpt-5"`, "utf8");

    const { code } = await runNode([INSTALL], { CODEX_HOME: home });
    expect(code).toBe(0);
    const parsed = parseToml(configPath);
    expect(parsed.notify).toEqual(EXPECTED);
    expect(parsed.model).toBe("gpt-5");
  });
});

describe("codex uninstall", () => {
  /** The file body a config had before install, so a round trip can be asserted
   *  as byte-for-byte identity rather than as "the notify key is gone". */
  const SHAPES: Array<{ name: string; body: string; env?: NodeJS.ProcessEnv }> = [
    { name: "a plain config", body: `model = "gpt-5"\n` },
    { name: "a trailing comment", body: `# my codex config\nmodel = "gpt-5"   # trailing\n` },
    { name: "a trailing table", body: `model = "gpt-5"\n\n[hooks.state."a:b:0:0"]\ntrusted_hash = "deadbeef"\n` },
    { name: "a multi-line string holding a bracket line", body: `description = """\n[not a table]\n"""\n` },
    { name: "an empty config", body: `` },
    { name: "no trailing newline", body: `model = "gpt-5"` },
    { name: "a leading BOM", body: String.fromCharCode(0xfeff) + `model = "gpt-5"\n` },
    { name: "CRLF endings", body: `model = "gpt-5"\r\n[server]\r\nport = 1\r\n` },
  ];

  for (const { name, body } of SHAPES) {
    it(`restores the config byte-for-byte after install for ${name}`, async () => {
      const home = tempDirSync("qt-codex-");
      const configPath = join(home, "config.toml");
      writeFileSync(configPath, body, "utf8");

      expect((await runNode([INSTALL], { CODEX_HOME: home })).code).toBe(0);
      // Precondition: the install really did change the file, so an uninstall
      // that does nothing cannot pass this by accident.
      expect(readFileSync(configPath, "utf8")).not.toBe(body);

      const { code, stdout } = await runNode([UNINSTALL], { CODEX_HOME: home });
      expect(code).toBe(0);
      expect(stdout).toContain("removed the notify entry");
      expect(readFileSync(configPath, "utf8")).toBe(body);
    });
  }

  it("removes an entry whose node path is from a different install", async () => {
    // The pair's first element is whatever node `npx` happened to resolve on the
    // day of the install, and it changes on every node upgrade. Matching on it
    // would leave the notifier registered forever after one `nvm use`.
    const home = tempDirSync("qt-codex-");
    const configPath = join(home, "config.toml");
    const foreignNode = platform() === "win32" ? "C:\\node20\\node.exe" : "/usr/bin/node20";
    writeFileSync(
      configPath,
      `notify = ${JSON.stringify([foreignNode, resolve(join(ROOT, "adapters/codex/notify.mjs"))])}\n` +
        `model = "gpt-5"\n`,
      "utf8"
    );

    const { code } = await runNode([UNINSTALL], { CODEX_HOME: home });
    expect(code).toBe(0);
    expect(readFileSync(configPath, "utf8")).toBe(`model = "gpt-5"\n`);
  });

  it("refuses a notify entry that belongs to someone else", async () => {
    const home = tempDirSync("qt-codex-");
    const configPath = join(home, "config.toml");
    const original = `notify = ["other.exe", "turn-ended"]\nmodel = "gpt-5"\n`;
    writeFileSync(configPath, original, "utf8");

    const { code, stderr } = await runNode([UNINSTALL], { CODEX_HOME: home });
    expect(code).toBe(1);
    expect(stderr).toContain("does not point at quick-titles");
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  it("reports not installed, and succeeds, when there is no notify key", async () => {
    const home = tempDirSync("qt-codex-");
    const configPath = join(home, "config.toml");
    const original = `model = "gpt-5"\n`;
    writeFileSync(configPath, original, "utf8");

    const { code, stdout } = await runNode([UNINSTALL], { CODEX_HOME: home });
    expect(code).toBe(0);
    expect(stdout).toContain("not installed");
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  it("reports not installed, and succeeds, when there is no config at all", async () => {
    const home = tempDirSync("qt-codex-");
    const { code, stdout } = await runNode([UNINSTALL], { CODEX_HOME: home });
    expect(code).toBe(0);
    expect(stdout).toContain("not installed");
    // Uninstall must never create the file it was asked to remove something from.
    expect(existsSync(join(home, "config.toml"))).toBe(false);
  });

  it("refuses a config that does not parse and changes nothing", async () => {
    const home = tempDirSync("qt-codex-");
    const configPath = join(home, "config.toml");
    const original = `notify = [\nthis is not toml\n`;
    writeFileSync(configPath, original, "utf8");

    const { code, stderr } = await runNode([UNINSTALL], { CODEX_HOME: home });
    expect(code).toBe(1);
    expect(stderr).toContain("not valid TOML");
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  it("refuses rather than splice the wrong line out of a quoted-key config", async () => {
    // `"notify" = [...]` parses to the same property but does not match the
    // plain-key pattern. Falling through to findIndex's -1 and splicing would
    // delete the file's *last* line, so this must be a refusal.
    const home = tempDirSync("qt-codex-");
    const configPath = join(home, "config.toml");
    const original =
      `"notify" = ${JSON.stringify([process.execPath, resolve(join(ROOT, "adapters/codex/notify.mjs"))])}\n` +
      `model = "gpt-5"\n`;
    writeFileSync(configPath, original, "utf8");

    const { code, stderr } = await runNode([UNINSTALL], { CODEX_HOME: home });
    expect(code).toBe(1);
    expect(stderr).toContain("plain `notify =` line");
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  it("is idempotent", async () => {
    const home = tempDirSync("qt-codex-");
    const configPath = join(home, "config.toml");
    writeFileSync(configPath, `model = "gpt-5"\n`, "utf8");

    expect((await runNode([INSTALL], { CODEX_HOME: home })).code).toBe(0);
    expect((await runNode([UNINSTALL], { CODEX_HOME: home })).code).toBe(0);
    const after = readFileSync(configPath, "utf8");
    const second = await runNode([UNINSTALL], { CODEX_HOME: home });
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("not installed");
    expect(readFileSync(configPath, "utf8")).toBe(after);
  });

  it("does not remove a notify line that is only string content", async () => {
    // The line pattern alone would match this; the re-parse is what proves the
    // real key was removed and nothing else was.
    const home = tempDirSync("qt-codex-");
    const configPath = join(home, "config.toml");
    const body = `description = """\nnotify = 5\n"""\nmodel = "gpt-5"\n`;
    writeFileSync(configPath, body, "utf8");

    expect((await runNode([INSTALL], { CODEX_HOME: home })).code).toBe(0);
    // install prepends our entry, leaving the string body one line further down.
    const { code } = await runNode([UNINSTALL], { CODEX_HOME: home });
    expect(code).toBe(0);
    expect(readFileSync(configPath, "utf8")).toBe(body);
    expect(parseToml(configPath).description).toBe("notify = 5\n");
  });
});

describe("codex notify entry point", () => {
  it("exits 0 and does nothing for a non-turn payload", async () => {
    const { code, stdout, stderr } = await runNode([NOTIFY, JSON.stringify({ type: "other" })], {
      CODEX_HOME: tempDirSync("qt-codex-"),
    });
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
    expect(stderr.trim()).toBe("");
  });


  it("exits 0 and does nothing when the payload has no thread-id", async () => {
    const { code } = await runNode(
      [NOTIFY, JSON.stringify({ type: "agent-turn-complete" })],
      { CODEX_HOME: tempDirSync("qt-codex-") }
    );
    expect(code).toBe(0);
  });

  it("never writes the state database", () => {
    const src = readFileSync(NOTIFY, "utf8");
    expect(src).toContain("thread/name/set");
    expect(src).toContain("initialize");
    expect(src).not.toMatch(/state_\d*\.sqlite|UPDATE\s+threads/i);
  });

  it("carries a generated title from a turn-complete payload to thread/name/set", async () => {
    // Exercises the whole notify entry point: the CLI-arg payload, the rollout
    // walk, the daemon call, and the handshaked RPC — with a stubbed app-server
    // standing in for the 295 MB binary. The read of the current name comes
    // first, in the same app-server session as the write (D40).
    const stub = writeStub();
    const log = logPath();
    const nameLog = join(tempDirSync("qt-codex-"), "name.log");
    const shim = writeBinShim(stub);

    const id = "01a0aaaa-bbbb-cccc-dddd-eeeeffff0000";
    const home = codexHomeWithRollout(id);

    const daemon = await startFakeDaemon("Generated Codex Title");
    try {
      const { code } = await runNode(
        [NOTIFY, JSON.stringify({ type: "agent-turn-complete", "thread-id": id })],
        {
          CODEX_HOME: home,
          CODEX_BIN: shim,
          QUICK_TITLES_DATA_DIR: tempDirSync("qt-codex-"),
          QUICK_TITLES_SOCKET: daemon.socket,
          STUB_LOG: log,
          STUB_THREAD_ID: id,
          STUB_NAME_LOG: nameLog,
        }
      );
      expect(code).toBe(0);
      // One generate; ensureDaemon's ping is not a generate.
      expect(daemon.generates()).toBe(1);
      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
        "initialize",
        "thread/list",
        "thread/name/set",
      ]);
      expect(readFileSync(nameLog, "utf8").trim()).toBe("Generated Codex Title");
    } finally {
      await daemon.close();
    }
  });

  it("starts a daemon from a cold start and still lands the title", async () => {
    // Defect 1: run() used to call generate() alone, and generate() returns null
    // when nothing is listening — so with no already-running daemon the adapter
    // emitted no title, ever, with no retry. Here nothing listens until
    // ensureDaemon() spawns the stub, whose boot line proves it did.
    const data = tempDirSync("qt-codex-");
    const boot = join(tempDirSync("qt-codex-"), "boots.log");
    const entry = writeStubDaemon(boot, "Cold Codex Title");

    const stub = writeStub();
    const log = logPath();
    const nameLog = join(tempDirSync("qt-codex-"), "name.log");
    const shim = writeBinShim(stub);

    const id = "01a0bbbb-bbbb-cccc-dddd-eeeeffff0000";
    const home = codexHomeWithRollout(id);

    const { code } = await runNode(
      [NOTIFY, JSON.stringify({ type: "agent-turn-complete", "thread-id": id })],
      {
        CODEX_HOME: home,
        CODEX_BIN: shim,
        QUICK_TITLES_DATA_DIR: data,
        QUICK_TITLES_SOCKET: inertSocket(),
        QUICK_TITLES_DAEMON_ENTRY: entry,
        // ensureDaemon() skips the spawn when no model is provisioned; pretend
        // the stub's model is installed.
        QT_MODEL: join(data, "provisioned.gguf"),
        STUB_LOG: log,
        STUB_THREAD_ID: id,
        STUB_NAME_LOG: nameLog,
      }
    );
    expect(code).toBe(0);
    // Exactly one boot line: the adapter starts the daemon once, not per step.
    expect(readFileSync(boot, "utf8").trim().split("\n").filter(Boolean)).toHaveLength(1);
    expect(readFileSync(nameLog, "utf8").trim()).toBe("Cold Codex Title");
  });

  it("never overwrites a thread name the user set by hand", async () => {
    // Defect 2: run() wrote unconditionally every turn, clobbering a rename.
    // The current name is read from the app-server; a name that is neither empty
    // nor one we wrote is left alone, and nothing is generated for it.
    const stub = writeStub();
    const log = logPath();
    const nameLog = join(tempDirSync("qt-codex-"), "name.log");
    const shim = writeBinShim(stub);

    const id = "01a0cccc-bbbb-cccc-dddd-eeeeffff0000";
    const home = codexHomeWithRollout(id);
    const data = tempDirSync("qt-codex-");

    const daemon = await startFakeDaemon("Should Never Land");
    try {
      const { code } = await runNode(
        [NOTIFY, JSON.stringify({ type: "agent-turn-complete", "thread-id": id })],
        {
          CODEX_HOME: home,
          CODEX_BIN: shim,
          QUICK_TITLES_DATA_DIR: data,
          QUICK_TITLES_SOCKET: daemon.socket,
          STUB_LOG: log,
          STUB_THREAD_ID: id,
          STUB_THREAD_NAME: "A name I chose myself",
          STUB_NAME_LOG: nameLog,
        }
      );
      expect(code).toBe(0);
      // The read happened; the write did not.
      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
        "initialize",
        "thread/list",
      ]);
      expect(existsSync(nameLog)).toBe(false);
      // No title was generated for a thread we may not rename, and the daemon
      // was never even pinged (ensureDaemon lives inside the guarded branch).
      expect(daemon.requests()).toBe(0);
      const state = JSON.parse(
        readFileSync(join(data, `codex-name-${id}.json`), "utf8")
      );
      expect(state.lastTitle).toBeNull();
    } finally {
      await daemon.close();
    }
  });

  it("writes on turn 1, refines on turn 3, and does nothing on turn 4", async () => {
    // One early pass, then one refine — the same cadence as the Claude Code and
    // Pi adapters. Turn state persists per thread because notify is a fresh
    // process every turn and Codex passes no turn number.
    const id = "01a0dddd-bbbb-cccc-dddd-eeeeffff0000";
    const home = codexHomeWithRollout(id);
    const data = tempDirSync("qt-codex-");
    const shim = writeBinShim(writeStub());

    const daemon = await startFakeDaemon("Generated Codex Title");
    const runs: { log: string; nameLog: string; wrote: boolean; read: boolean }[] = [];
    try {
      for (let i = 0; i < 4; i++) {
        const log = logPath();
        const nameLog = join(tempDirSync("qt-codex-"), "name.log");
        await runNode([NOTIFY, JSON.stringify({ type: "agent-turn-complete", "thread-id": id })], {
          CODEX_HOME: home,
          CODEX_BIN: shim,
          QUICK_TITLES_DATA_DIR: data,
          QUICK_TITLES_SOCKET: daemon.socket,
          STUB_LOG: log,
          STUB_THREAD_ID: id,
          // Turn 1 sees an untitled thread; turn 3 sees the title turn 1 wrote,
          // which is the only non-empty name this adapter may replace.
          STUB_THREAD_NAME: i >= 1 ? "Generated Codex Title" : "",
          STUB_NAME_LOG: nameLog,
        });
        const methods = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
        runs.push({
          log,
          nameLog,
          read: methods.includes("thread/list"),
          wrote: methods.includes("thread/name/set"),
        });
      }
      expect(runs.map((r) => r.read)).toEqual([true, false, true, false]);
      expect(runs.map((r) => r.wrote)).toEqual([true, false, true, false]);
      expect(existsSync(runs[0].nameLog)).toBe(true);
      expect(existsSync(runs[2].nameLog)).toBe(true);
      // Turn 4 must not even spawn the app-server.
      expect(existsSync(runs[3].log)).toBe(false);

      const state = JSON.parse(readFileSync(join(data, `codex-name-${id}.json`), "utf8"));
      expect(state.turns).toBe(4);
      expect(state.lastTitle).toBe("Generated Codex Title");
    } finally {
      await daemon.close();
    }
  });
});

// The only test that touches the real 295 MB binary. Gated so the default run
// stays independent of it, and it names only a scratch thread it creates and
// deletes — never one of the user's. Run with QUICK_TITLES_CODEX_E2E=1.
interface Rpc {
  call(method: string, params?: unknown): Promise<{ id?: number; result?: unknown; error?: { message: string }; timeout?: boolean }>;
  close(): void;
}
function appServer(bin: string): Rpc {
  const useShell = platform() === "win32" && /\.(cmd|bat)$/i.test(bin);
  const child = spawn(bin, ["app-server", "--listen", "stdio://"], {
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
    shell: useShell,
  });
  child.on("error", (e) => {
    throw new Error(`failed to spawn app-server at ${bin}: ${e.message}`);
  });
  const pending = new Map<number, (m: never) => void>();
  let buf = "";
  let nextId = 1;
  child.stdout.on("data", (c) => {
    buf += c.toString("utf8");
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
      const w = pending.get(msg.id);
      if (w) {
        pending.delete(msg.id);
        (w as (m: unknown) => void)(msg);
      }
    }
  });
  return {
    call(method, params = {}) {
      return new Promise((res) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          res({ id, timeout: true });
        }, 20_000);
        pending.set(id, ((m: { id?: number }) => {
          clearTimeout(timer);
          res(m);
        }) as never);
        child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      });
    },
    close() {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    },
  };
}

const E2E = process.env.QUICK_TITLES_CODEX_E2E === "1";
const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), ".codex");
function dbName(id: string): string | null {
  // `node:sqlite` is Node 22.5+, so a static import here makes this whole file
  // fail to load on Node 20 — and it took the 60-odd tests that have nothing to
  // do with SQLite down with it. That import is only ever needed by the live
  // round-trip suite below, which already skips unless QUICK_TITLES_CODEX_E2E=1,
  // so it is required lazily inside the one function that uses it.
  const { DatabaseSync } = createRequire(import.meta.url)(
    "node:sqlite"
  ) as typeof import("node:sqlite");
  const db = new DatabaseSync(join(CODEX_HOME, "state_5.sqlite"), { readOnly: true });
  try {
    return (db.prepare("select name from threads where id = ?").get(id)?.name as string) ?? null;
  } finally {
    db.close();
  }
}

describe.skipIf(!E2E)("codex live round trip", () => {
  it(
    "creates and deletes a scratch thread, then renames an existing one via setThreadName and restores it",
    async () => {
      const bin = notify.resolveCodexBin() as string;
      expect(bin).toBeTruthy();
      const rpc = appServer(bin);
      let scratchId: string | undefined;
      let deleted = false;
      try {
        const init = await rpc.call("initialize", {
          clientInfo: { name: "quick-titles-e2e", version: "0.1.0" },
        });
        expect(init.error).toBeUndefined();

        // Part 1 — scratch thread lifecycle. A turn-less thread has no rollout,
        // so a *fresh* app-server (what notify.spawns) refuses to name it; this
        // half only proves create/delete, and the id below is the report.
        const started = await rpc.call("thread/start", { cwd: ROOT });
        scratchId =
          (started.result as { thread?: { id?: string } })?.thread?.id ??
          (started.result as { id?: string })?.id;
        expect(scratchId).toBeTruthy();
        const del = await rpc.call("thread/delete", { threadId: scratchId });
        expect(del.error).toBeUndefined();
        deleted = true;
        console.log(`[codex-e2e] scratch thread id ${scratchId} -> thread/delete ok`);

        // Part 2 — the real write path. Pick an existing thread (it has a
        // rollout), rename it through the shipped setThreadName (which spawns
        // its own app-server, as notify does), read the sidebar name straight
        // from state_5.sqlite, then restore the original exactly.
        const list = await rpc.call("thread/list", { limit: 20 });
        const rows = ((list.result as { data?: { id: string; name: string | null }[] })?.data ?? []);
        const target = rows.find((r) => r.name && r.name.length > 0);
        expect(target, "no existing named thread to test against").toBeTruthy();
        const original = dbName(target!.id) ?? target!.name;
        const marker = "quick-titles e2e (safe to ignore)";
        console.log(`[codex-e2e] existing thread ${target!.id}, original name ${JSON.stringify(original)}`);

        try {
          const ok = await notify.setThreadName({ bin, threadId: target!.id, name: marker });
          expect(ok).toBe(true);
          const now = dbName(target!.id);
          console.log(`[codex-e2e] setThreadName -> true; state_5.sqlite name = ${JSON.stringify(now)}`);
          expect(now).toBe(marker);
        } finally {
          const back = await notify.setThreadName({ bin, threadId: target!.id, name: original! });
          const restored = dbName(target!.id);
          console.log(`[codex-e2e] restore -> ${back}; name now = ${JSON.stringify(restored)}`);
          expect(restored).toBe(original);
        }
      } finally {
        if (scratchId && !deleted) {
          try {
            await rpc.call("thread/delete", { threadId: scratchId });
          } catch {
            /* best effort cleanup */
          }
        }
        rpc.close();
      }
    },
    120_000
  );
});

