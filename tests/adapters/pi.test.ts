// tests/adapters/pi.test.ts
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join, resolve as resolvePath } from "node:path";
import quickTitles from "../../adapters/pi/quick-titles.ts";
import { fallbackAgentDir, resolveAgentDir } from "../../adapters/pi/install.mjs";
import { cleanupTempDirs, tempDirSync } from "../helpers/tmp.js";
import { readClip } from "../../src/core/session/index.js";

// Force the SDK import to fail in-process, so `resolveAgentDir()` is exercised
// through the fallback branch — the one every `npx quick-titles` user actually
// hits, because npx does not install a package's devDependencies. Child
// processes spawned by the installer tests below are unaffected; they still
// resolve the real SDK, which is what lets those tests bind the fallback to it.
vi.mock("@earendil-works/pi-coding-agent", () => {
  throw new Error("simulated: devDependency absent");
});

const SRC = "adapters/pi/quick-titles.ts";
const FIXTURE = "tests/fixtures/sessions/pi.jsonl";

// The Pi SDK is installed here (a devDependency) but does not *run* on every
// Node this project supports. It declares `engines.node >= 22.19.0` and imports
// `globSync` from `node:fs`, which Node 20 does not export — so on Node 20 the
// module is present and still throws a SyntaxError the moment it is
// instantiated. "Resolvable" and "importable" are different questions, and the
// install suite below is written against the second one: its whole premise is
// comparing the installer's answer to the live SDK's, which it reads by running
// the SDK in a child process.
//
// On Node 20 there is nothing to compare against, and the suite failed CI's
// Node 20 jobs on the probe rather than on the installer. Gating is the honest
// fix, not deleting: on a runtime Pi actually supports (its own floor is Node
// 22.19) the comparison still runs, and that comparison is the only thing
// keeping the hand-written fallback in `adapters/pi/install.mjs` from drifting
// away from the SDK's real rule.
//
// Checked out-of-process on purpose. An in-process probe would be answered by
// this file's own `vi.mock` of the SDK rather than by the runtime.
const SDK_RUNS_HERE =
  spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", 'import "@earendil-works/pi-coding-agent";'],
    { cwd: process.cwd(), stdio: "ignore", timeout: 60_000 }
  ).status === 0;

// The shipped extension imports `join(DIST, "client.js")`, where DIST is the
// token install.mjs replaces with an absolute path. Left as the token it
// resolves against the cwd, so the test creates a directory of exactly that
// name and drops a stub client into it. That exercises the real shipped source
// rather than a rewritten copy.
const TOKEN_DIR = "__QUICK_TITLES_DIST__";

interface FakePi {
  on(event: string, handler: (event: unknown, ctx?: unknown) => unknown): void;
  getSessionName(): string | undefined;
  setSessionName(name: string): void;
}

function makeFakePi(existingName?: string) {
  const handlers = new Map<string, Array<(event: unknown, ctx?: unknown) => unknown>>();
  const names: string[] = [];
  let current: string | undefined = existingName;
  const pi: FakePi = {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    getSessionName: () => current,
    setSessionName(name) {
      names.push(name);
      current = name;
    },
  };
  return { pi, handlers, names };
}

const sessionCtx = {
  sessionManager: {
    getSessionId: () => "fixture-session",
    getSessionFile: () => FIXTURE,
  },
};

const requests: Array<{ agent: string; sessionId: string; transcriptPath: string }> = [];
// The stub client records the per-call options it received, so a test can prove
// the extension passed an explicit bound rather than relying on the client default.
const generateOpts: Array<{ timeoutMs?: number } | undefined> = [];
const ensureOpts: Array<{ timeoutMs?: number } | undefined> = [];
let tmp = "";

/** Mutable controls the stub client reads out of globalThis. */
type StubGlobals = {
  __qtPiFail?: boolean;
  __qtPiWedged?: boolean;
  __qtPiReady?: boolean;
  __qtPiEnsureDelay?: number;
};
const stub = () => globalThis as unknown as StubGlobals;

function resetStub(): void {
  stub().__qtPiFail = false;
  stub().__qtPiWedged = false;
  stub().__qtPiReady = false;
  stub().__qtPiEnsureDelay = 0;
}

beforeAll(() => {
  rmSync(TOKEN_DIR, { recursive: true, force: true });
  mkdirSync(TOKEN_DIR, { recursive: true });
  writeFileSync(
    join(TOKEN_DIR, "client.js"),
    [
      "export async function generate(req, opts) {",
      "  globalThis.__qtPiRequests.push(req);",
      "  globalThis.__qtPiGenerateOpts.push(opts);",
      "  if (globalThis.__qtPiFail) return null;",
      "  if (globalThis.__qtPiWedged) {",
      "    const ms = opts && typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 0;",
      "    if (!ms) return await new Promise(() => {});",
      "    await new Promise((r) => setTimeout(r, ms));",
      "    return null;",
      "  }",
      "  if (!globalThis.__qtPiReady) return null;",
      '  return { title: "Investigate the flaky retry helper", description: null };',
      "}",
      "export async function ensureDaemon(opts) {",
      "  globalThis.__qtPiEnsureOpts.push(opts);",
      "  if (globalThis.__qtPiWedged) {",
      "    const ms = opts && typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 0;",
      "    if (!ms) return await new Promise(() => {});",
      "    await new Promise((r) => setTimeout(r, ms));",
      "    return false;",
      "  }",
      "  const delay = globalThis.__qtPiEnsureDelay || 0;",
      "  if (delay) await new Promise((r) => setTimeout(r, delay));",
      "  globalThis.__qtPiReady = true;",
      "  return true;",
      "}",
    ].join("\n"),
    "utf8"
  );
  (globalThis as { __qtPiRequests?: unknown }).__qtPiRequests = requests;
  (globalThis as { __qtPiGenerateOpts?: unknown }).__qtPiGenerateOpts = generateOpts;
  (globalThis as { __qtPiEnsureOpts?: unknown }).__qtPiEnsureOpts = ensureOpts;
  resetStub();

  tmp = mkdtempSync(join("tests", "adapters", ".tmp-"));
});

afterAll(() => {
  rmSync(TOKEN_DIR, { recursive: true, force: true });
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

async function start(pi: FakePi, handlers: ReturnType<typeof makeFakePi>["handlers"]) {
  await handlers.get("session_start")![0]!({ type: "session_start", reason: "startup" }, sessionCtx);
}

async function turn(handlers: ReturnType<typeof makeFakePi>["handlers"]) {
  await handlers.get("turn_end")![0]!({ type: "turn_end" }, sessionCtx);
}

describe("pi adapter", () => {
  const source = readFileSync(SRC, "utf8");

  it("sets the name through the extension API", () => {
    expect(source).toContain("pi.setSessionName");
  });

  it("never overwrites an existing name", () => {
    expect(source).toContain("if (await pi.getSessionName()) return;");
  });

  it("titles on turn 1 and turn 3 only", () => {
    expect(source).toContain("turnCount !== 1 && turnCount !== 3");
  });

  it("does not write session JSONL directly", () => {
    expect(source).not.toMatch(/appendFile|writeFile|session_info/);
  });

  it("takes the session identity from sessionManager, not invented ctx fields", () => {
    expect(source).toContain("ctx.sessionManager.getSessionId()");
    expect(source).toContain("ctx.sessionManager.getSessionFile()");
    expect(source).not.toMatch(/ctx\.session(Id|File)\b/);
  });
});

describe("pi extension behaviour", () => {
  it("titles on turn 1 with the session's real transcript", async () => {
    const { pi, handlers, names } = makeFakePi();
    requests.length = 0;
    quickTitles(pi as never);
    await start(pi, handlers);
    await turn(handlers);

    expect(names).toEqual(["Investigate the flaky retry helper"]);
    expect(requests).toEqual([
      { agent: "pi", sessionId: "fixture-session", transcriptPath: FIXTURE },
    ]);
  });

  it("titles once and never refines over the name it set", async () => {
    const { pi, handlers, names } = makeFakePi();
    requests.length = 0;
    (globalThis as { __qtPiFail?: boolean }).__qtPiFail = false;
    quickTitles(pi as never);
    await start(pi, handlers);
    await turn(handlers); // 1 -> title
    await turn(handlers); // 2 -> skip
    await turn(handlers); // 3 -> name already set, skip
    await turn(handlers); // 4 -> skip

    expect(requests).toHaveLength(1);
    expect(names).toEqual(["Investigate the flaky retry helper"]);
  });

  it("titles late on turn 3 when turn 1 could not (cold daemon)", async () => {
    const { pi, handlers, names } = makeFakePi();
    requests.length = 0;
    (globalThis as { __qtPiFail?: boolean }).__qtPiFail = true;
    quickTitles(pi as never);
    await start(pi, handlers);
    await turn(handlers); // 1 -> generate returns null, no name
    await turn(handlers); // 2 -> skip
    (globalThis as { __qtPiFail?: boolean }).__qtPiFail = false;
    await turn(handlers); // 3 -> retry succeeds

    expect(requests).toHaveLength(2);
    expect(names).toEqual(["Investigate the flaky retry helper"]);
  });

  it("never overwrites a name Pi already has", async () => {
    const { pi, handlers, names } = makeFakePi("Existing name");
    requests.length = 0;
    quickTitles(pi as never);
    await start(pi, handlers);
    await turn(handlers);

    expect(requests).toHaveLength(0);
    expect(names).toHaveLength(0);
  });

  it("waits out a ~3s cold daemon and still titles turn 1", async () => {
    // The defect: turn 1 called generate() immediately and the daemon was not
    // reachable yet, so the request failed fast and no title was set. The stub
    // models a daemon that needs 3s before it can answer.
    const { pi, handlers, names } = makeFakePi();
    requests.length = 0;
    generateOpts.length = 0;
    ensureOpts.length = 0;
    resetStub();
    stub().__qtPiEnsureDelay = 3000;
    quickTitles(pi as never);
    await start(pi, handlers);

    const started = Date.now();
    await turn(handlers);
    const elapsed = Date.now() - started;

    expect(names).toEqual(["Investigate the flaky retry helper"]);
    expect(requests).toHaveLength(1);
    // It really waited for the load instead of generating against a cold socket.
    expect(elapsed).toBeGreaterThanOrEqual(2500);
    expect(elapsed).toBeLessThan(6000);
  }, 20000);

  it("bounds a wedged daemon by the sum of the two explicit budgets", async () => {
    // A daemon that accepts connections and never answers runs every call to its
    // full timeout. Pre-fix the extension passed no timeout, so the request fell
    // back to the client's 15s default and the turn waited on nothing but that.
    const { pi, handlers } = makeFakePi();
    requests.length = 0;
    generateOpts.length = 0;
    ensureOpts.length = 0;
    resetStub();
    stub().__qtPiWedged = true;
    quickTitles(pi as never);
    await start(pi, handlers);

    const started = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const finished = await Promise.race([
      turn(handlers).then(() => true),
      new Promise<false>((r) => {
        // The shipped worst path is 13s; give it margin so the pre-fix hang is
        // detected rather than hanging the suite.
        timer = setTimeout(() => r(false), 16000);
      }),
    ]);
    const elapsed = Date.now() - started;
    clearTimeout(timer);

    const ensure = ensureOpts.at(-1)?.timeoutMs;
    const gen = generateOpts.at(-1)?.timeoutMs;
    expect(typeof ensure).toBe("number");
    expect(typeof gen).toBe("number");
    // Worst path is the SUM of two known bounds, not 15s plus an unknown wait.
    expect((ensure as number) + (gen as number)).toBeLessThan(15000);
    expect(finished).toBe(true);
    expect(elapsed).toBeLessThan(16000);
  }, 30000);
});

describe("pi transcript reader agrees with the extension's transcript", () => {
  it("keeps text parts, drops custom_message entries and thinking-only turns", async () => {
    const clip = await readClip("pi", FIXTURE);
    expect(clip).toContain("@Downloads/retry_helper_notes.md");
    expect(clip).toContain("I'll look into the flaky retry helper");
    expect(clip).toContain("Start with the backoff logic");
    expect(clip).not.toContain("background context, not a conversation turn");

    const thinkingOnly = join(tmp, "thinking-only.jsonl");
    writeFileSync(
      thinkingOnly,
      [
        JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "2026-09-05T07:20:26.264Z" }),
        JSON.stringify({
          type: "message",
          id: "a",
          parentId: null,
          timestamp: "2026-09-05T07:21:00.000Z",
          message: { role: "assistant", content: [{ type: "thinking", thinking: "internal reasoning" }] },
        }),
        JSON.stringify({
          type: "custom_message",
          id: "b",
          parentId: "a",
          timestamp: "2026-09-05T07:21:01.000Z",
          message: { role: "system", content: [{ type: "text", text: "hidden scaffolding" }] },
        }),
      ].join("\n"),
      "utf8"
    );

    await expect(readClip("pi", thinkingOnly)).resolves.toBe("");
  });
});

// The installer is run as its own process, exactly as a user would, because the
// directory it picks depends on the environment Pi's loader itself reads.
describe.skipIf(!SDK_RUNS_HERE)("pi install", () => {
  const INSTALL = join(process.cwd(), "adapters/pi/install.mjs");

  // Scratch for the SDK-absent fixtures, deliberately a SIBLING of the repository
  // rather than <repo>/.tmp. See `outsideRepo()` for why: the tests it serves
  // assert that the SDK cannot be resolved, and Node walks node_modules upward
  // from the file, so anywhere inside the repo defeats them. Kept out of
  // os.tmpdir() as well, to stay off C:.
  const OUTSIDE_ROOT = join(resolvePath(process.cwd(), ".."), ".quick-titles-outside");

  afterEach(() => {
    cleanupTempDirs();
  });

  afterAll(() => {
    rmSync(OUTSIDE_ROOT, { recursive: true, force: true });
  });

  function run(
    file: string,
    env: NodeJS.ProcessEnv,
    cwd?: string
  ): Promise<{ stdout: string; code: number | null }> {
    return new Promise((res) => {
      const child = spawn(process.execPath, [file], {
        env,
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => (stdout += c.toString()));
      child.stderr.on("data", (c) => (stderr += c.toString()));
      child.on("close", (code) => res({ stdout: `${stdout}${stderr}`, code }));
    });
  }

  // The expected directory is never our own reading of PI_CODING_AGENT_DIR: it
  // is whatever the real SDK returns in a fresh process with the same
  // environment. That is the property that matters — the installer must agree
  // with Pi's loader, not with a second implementation of it.
  const SDK_PROBE =
    'import { getAgentDir } from "@earendil-works/pi-coding-agent";' +
    "process.stdout.write(getAgentDir());";
  function sdkAgentDir(env: NodeJS.ProcessEnv): Promise<string> {
    return new Promise((res, rej) => {
      const child = spawn(process.execPath, ["--input-type=module", "--eval", SDK_PROBE], {
        env,
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (c) => (out += c.toString()));
      child.stderr.on("data", (c) => (err += c.toString()));
      child.on("close", (code) => (code === 0 ? res(out) : rej(new Error(err))));
    });
  }

  function baseEnv(home: string): NodeJS.ProcessEnv {
    return { ...process.env, USERPROFILE: home, HOME: home };
  }

  function expectNoStackTrace(out: string) {
    expect(out).not.toMatch(/^\s+at\s/m); // V8 stack frames
    expect(out).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(out).not.toContain("ENOENT");
  }

  // A copy of the adapter placed outside the repository. ESM resolves the SDK by
  // walking node_modules up from the file, so outside the repo the devDependency
  // is gone exactly as `npm install --omit=dev` leaves it. NODE_PATH is cleared
  // so a global install cannot hide that.
  //
  // The location is load-bearing and must be genuinely outside the repository,
  // which rules out the shared temp helper: it roots scratch at <repo>/.tmp, and
  // Node's upward lookup from <repo>/.tmp/qt-pi-xxx/adapters/pi still finds
  // <repo>/node_modules. An earlier version of this helper used it, so four
  // "SDK genuinely absent" end-to-end rows exercised the SDK-present branch while
  // claiming the opposite — the tests passed and proved nothing. A sibling of the
  // repository is outside on every platform and never touches the OS temp
  // directory, and the precondition test below fails loudly if that ever stops
  // being true.
  function outsideRepo(): string {
    const root = OUTSIDE_ROOT;
    rmSync(root, { recursive: true, force: true });
    const piDir = join(root, "adapters", "pi");
    const sharedDir = join(root, "adapters", "shared");
    mkdirSync(piDir, { recursive: true });
    mkdirSync(sharedDir, { recursive: true });
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "client.js"), "export {};\n", "utf8");
    copyFileSync(INSTALL, join(piDir, "install.mjs"));
    // install.mjs imports the shared build guard; copy it alongside so the only
    // dependency that is genuinely missing is the SDK devDependency.
    copyFileSync(
      join(process.cwd(), "adapters", "shared", "install-common.mjs"),
      join(sharedDir, "install-common.mjs")
    );
    copyFileSync(
      join(process.cwd(), "adapters", "pi", "quick-titles.ts"),
      join(piDir, "quick-titles.ts")
    );
    return join(piDir, "install.mjs");
  }

  // The whole SDK-absent suite rests on a claim about the filesystem that is easy
  // to break without noticing: that `@earendil-works/pi-coding-agent` cannot be
  // resolved from OUTSIDE_ROOT. This asserts the premise directly, by importing
  // the SDK from inside a real file at that location, so a future move of the
  // fixture (into the repo, into a directory with a stray node_modules, under a
  // workspace root) fails here with a clear reason instead of quietly turning the
  // SDK-absent tests green and meaningless.
  it("places the SDK-absent fixture where the SDK genuinely cannot be resolved", async () => {
    const probe = join(OUTSIDE_ROOT, "probe.mjs");
    mkdirSync(OUTSIDE_ROOT, { recursive: true });
    writeFileSync(
      probe,
      'import { getAgentDir } from "@earendil-works/pi-coding-agent";\n' +
        'console.log("RESOLVED", typeof getAgentDir);\n',
      "utf8"
    );

    // `run` folds stderr into stdout, so one stream carries both.
    const { code, stdout } = await run(probe, { NODE_PATH: "" });

    expect(stdout).not.toContain("RESOLVED");
    expect(code).not.toBe(0);
    expect(stdout).toContain("ERR_MODULE_NOT_FOUND");
  });

  it("installs into PI_CODING_AGENT_DIR when it is set", async () => {
    const home = tempDirSync("qt-pi-");
    const agentDir = tempDirSync("qt-pi-");
    const { code } = await run(INSTALL, {
      ...baseEnv(home),
      PI_CODING_AGENT_DIR: agentDir,
    });

    expect(code).toBe(0);
    expect(existsSync(join(agentDir, "extensions", "quick-titles.ts"))).toBe(true);
    // Pi's loader scans the env-var directory, not the hardcoded home path.
    expect(existsSync(join(home, ".pi", "agent", "extensions", "quick-titles.ts"))).toBe(false);
  });

  it("falls back to ~/.pi/agent when PI_CODING_AGENT_DIR is unset", async () => {
    const home = tempDirSync("qt-pi-");
    const env = baseEnv(home);
    delete env.PI_CODING_AGENT_DIR;

    const { stdout, code } = await run(INSTALL, env);

    expect(code).toBe(0);
    expect(stdout).toContain(join(home, ".pi", "agent", "extensions"));
    expect(existsSync(join(home, ".pi", "agent", "extensions", "quick-titles.ts"))).toBe(true);
  });

  // With the SDK resolvable the installer must land in exactly the directory the
  // SDK names, for every shape of the variable. Git-Bash/WSL drive paths and
  // file:// URLs are the SDK's translation to perform, so the installer only has
  // to agree with it — which it does by calling getAgentDir() and nothing else.
  describe("with the SDK resolvable", () => {
    const cases: Array<{ name: string; value?: string; relativeCwd?: boolean }> = [
      { name: "a normal absolute path", value: "ABSOLUTE" },
      { name: "a relative path", value: "relative-agent", relativeCwd: true },
      { name: "an empty value (unset to getAgentDir)", value: "" },
      { name: "an unset variable", value: undefined },
      { name: '"~"', value: "~" },
      { name: '"~/sub"', value: "~/sub" },
      { name: 'whitespace "   "', value: "   ", relativeCwd: true },
    ];
    if (process.platform === "win32") {
      cases.push({ name: '"~\\\\sub"', value: "~\\sub" });
    }

    for (const c of cases) {
      it(`installs to the SDK's directory for ${c.name}`, async () => {
        const home = tempDirSync("qt-pi-");
        const cwd = c.relativeCwd ? tempDirSync("qt-pi-") : process.cwd();
        const env = baseEnv(home);
        if (c.value === undefined) delete env.PI_CODING_AGENT_DIR;
        else env.PI_CODING_AGENT_DIR = c.value === "ABSOLUTE" ? tempDirSync("qt-pi-") : c.value;

        const raw = await sdkAgentDir(env);
        const { stdout, code } = await run(INSTALL, env, cwd);

        expect(code).toBe(0);
        expectNoStackTrace(stdout);
        expect(existsSync(join(resolvePath(cwd, raw), "extensions", "quick-titles.ts"))).toBe(true);
        expect(stdout).toContain(join(raw, "extensions", "quick-titles.ts"));
        // `~` is not a path segment; an unexpanded value would create a literal
        // "~" directory under the cwd.
        expect(existsSync(join(cwd, "~"))).toBe(false);
      });
    }
  });

  // Every input shape the SDK's getAgentDir() distinguishes, as one matrix shared
  // by the two binding tests below.
  const AGENT_DIR_MATRIX: Array<{ name: string; value?: string }> = [
    { name: "an unset variable", value: undefined },
    { name: "an empty value", value: "" },
    { name: 'whitespace "   "', value: "   " },
    { name: '"~"', value: "~" },
    { name: '"~/sub"', value: "~/sub" },
    { name: "a bare absolute path", value: "ABSOLUTE" },
    { name: "a relative path", value: "relative-agent" },
    { name: '"~\\\\sub"', value: "~\\sub" },
    { name: 'a Git-Bash path "/c/agent"', value: "/c/agent" },
    { name: 'a WSL path "/mnt/c/agent"', value: "/mnt/c/agent" },
    { name: 'a Cygwin path "/cygdrive/c/agent"', value: "/cygdrive/c/agent" },
    { name: 'a file:// URL "file:///D:/agentdir"', value: "file:///D:/agentdir" },
  ];

  // Runs `fn` with process.env pointed at `value`/`home`, then restores it. The
  // fallback reads the home through os.homedir(), which itself reads
  // process.env, so the in-process answer matches the child probe only if the
  // live process env carries the same USERPROFILE/HOME.
  async function withProcessEnv<T>(
    value: string | undefined,
    home: string,
    fn: () => T | Promise<T>
  ): Promise<T> {
    const saved = {
      USERPROFILE: process.env.USERPROFILE,
      HOME: process.env.HOME,
      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    };
    process.env.USERPROFILE = home;
    process.env.HOME = home;
    if (value === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = value;
    try {
      return await fn();
    } finally {
      for (const [key, original] of Object.entries(saved)) {
        if (original === undefined) delete process.env[key];
        else process.env[key] = original;
      }
    }
  }

  function resolveSentinel(value: string | undefined): string | undefined {
    return value === "ABSOLUTE" ? tempDirSync("qt-pi-") : value;
  }

  // THE bind: a reimplementation that is never compared to the original is how
  // the previous hand-rolled copy drifted (it dropped the Windows shell-path and
  // file:// branches). The SDK's own answer is read in a fresh process with the
  // same environment, and the fallback must equal it for every row.
  describe("the SDK-free fallback agrees with getAgentDir()", () => {
    for (const c of AGENT_DIR_MATRIX) {
      it(`agrees for ${c.name}`, async () => {
        const home = tempDirSync("qt-pi-");
        const value = resolveSentinel(c.value);
        const env = baseEnv(home);
        if (value === undefined) delete env.PI_CODING_AGENT_DIR;
        else env.PI_CODING_AGENT_DIR = value;

        const sdk = await sdkAgentDir(env);
        const fallback = await withProcessEnv(value, home, () => fallbackAgentDir());

        expect(fallback).toBe(sdk);
      });
    }
  });

  // The fallback is the only branch a published-package user ever runs (`npx`
  // does not install devDependencies), so `resolveAgentDir()` with the import
  // forced to fail must reach the same answers as the real SDK.
  describe("with the SDK import forced to fail", () => {
    // Without this the matrix below passes even if the mock were inert, because
    // both resolveAgentDir() and the probe would return the SDK's answer. This
    // proves the import really rejects, so the matrix exercises the fallback.
    it("really makes the SDK import reject", async () => {
      await expect(import("@earendil-works/pi-coding-agent")).rejects.toThrow();
    });

    for (const c of AGENT_DIR_MATRIX) {
      it(`agrees for ${c.name}`, async () => {
        const home = tempDirSync("qt-pi-");
        const value = resolveSentinel(c.value);
        const env = baseEnv(home);
        if (value === undefined) delete env.PI_CODING_AGENT_DIR;
        else env.PI_CODING_AGENT_DIR = value;

        const sdk = await sdkAgentDir(env);
        const resolved = await withProcessEnv(value, home, () => resolveAgentDir());

        expect(resolved).toBe(sdk);
      });
    }
  });

  // End-to-end: the adapter copied outside the repository cannot import the SDK
  // devDependency, exactly as `npx quick-titles install pi` leaves it, and must
  // still install into the directory the real SDK names. Inputs whose SDK answer
  // points outside the repository (the /c/… shells) are asserted as strings in
  // the matrix above rather than installed into, so this suite never writes to C:.
  describe("with the SDK genuinely absent (npx / --omit=dev)", () => {
    const cases: Array<{ name: string; value?: string; relativeCwd?: boolean }> = [
      { name: "an unset variable", value: undefined },
      { name: '"~"', value: "~" },
      { name: "a normal absolute path", value: "ABSOLUTE" },
      { name: "a relative path", value: "relative-agent", relativeCwd: true },
    ];

    for (const c of cases) {
      it(`installs to the SDK's directory for ${c.name}`, async () => {
        const install = outsideRepo();
        const home = tempDirSync("qt-pi-");
        const cwd = c.relativeCwd ? tempDirSync("qt-pi-") : process.cwd();
        const env: NodeJS.ProcessEnv = { ...baseEnv(home), NODE_PATH: "" };
        if (c.value === undefined) delete env.PI_CODING_AGENT_DIR;
        else env.PI_CODING_AGENT_DIR = resolveSentinel(c.value);

        const raw = await sdkAgentDir(env);
        const { stdout, code } = await run(install, env, cwd);

        expect(code).toBe(0);
        expectNoStackTrace(stdout);
        expect(existsSync(join(resolvePath(cwd, raw), "extensions", "quick-titles.ts"))).toBe(true);
        expect(stdout).toContain(join(raw, "extensions", "quick-titles.ts"));
      });
    }
  });
});

// Ungated on purpose. The install suite above needs the SDK to compare the
// fallback against, but uninstall must work in the environment the published
// package actually runs in — `npx`, with no devDependencies — so gating these
// would test the one branch no user reaches and skip the one they all do.
describe("pi uninstall", () => {
  const INSTALL = join(process.cwd(), "adapters", "pi", "install.mjs");
  const UNINSTALL = join(process.cwd(), "adapters", "pi", "uninstall.mjs");
  const REL = join("extensions", "quick-titles.ts");

  function envWithHome(home: string): NodeJS.ProcessEnv {
    return { ...process.env, USERPROFILE: home, HOME: home, NODE_PATH: "" };
  }

  /** stderr is folded into stdout because only the exit status and the message
   *  matter here, and one stream makes the assertions simpler to read. */
  function run(script: string, env: NodeJS.ProcessEnv) {
    const r = spawnSync(process.execPath, [script], { env, encoding: "utf8" });
    return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  }

  it("removes an extension installed at the default location", () => {
    const home = tempDirSync("qt-pi-");
    try {
      const env = envWithHome(home);
      delete env.PI_CODING_AGENT_DIR;

      expect(run(INSTALL, env).code).toBe(0);
      const installed = join(home, ".pi", "agent", REL);
      expect(existsSync(installed)).toBe(true);

      const { code, out } = run(UNINSTALL, env);
      expect(code).toBe(0);
      expect(out).toContain("removed the Pi extension");
      expect(existsSync(installed)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("finds a default-location install when the variable is set only now", () => {
    // Why the candidate list exists. Installed with no PI_CODING_AGENT_DIR, so
    // the file went to ~/.pi/agent; uninstalled with the variable pointing
    // somewhere else, so a single freshly-resolved path would be that empty
    // directory and the real extension would survive a successful-looking run.
    const home = tempDirSync("qt-pi-");
    const other = tempDirSync("qt-pi-");
    try {
      const base = envWithHome(home);
      delete base.PI_CODING_AGENT_DIR;
      expect(run(INSTALL, base).code).toBe(0);
      const installed = join(home, ".pi", "agent", REL);
      expect(existsSync(installed)).toBe(true);

      const { code, out } = run(UNINSTALL, { ...base, PI_CODING_AGENT_DIR: other });
      expect(code).toBe(0);
      expect(out).toContain("removed the Pi extension");
      expect(existsSync(installed)).toBe(false);
      expect(existsSync(join(other, REL))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("removes an extension installed into PI_CODING_AGENT_DIR", () => {
    const home = tempDirSync("qt-pi-");
    const agentDir = tempDirSync("qt-pi-");
    try {
      const env = { ...envWithHome(home), PI_CODING_AGENT_DIR: agentDir };
      expect(run(INSTALL, env).code).toBe(0);
      const installed = join(agentDir, REL);
      expect(existsSync(installed)).toBe(true);

      const { code, out } = run(UNINSTALL, env);
      expect(code).toBe(0);
      expect(out).toContain("removed the Pi extension");
      expect(existsSync(installed)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("leaves a file it did not write alone", () => {
    const home = tempDirSync("qt-pi-");
    try {
      const extensions = join(home, ".pi", "agent", "extensions");
      mkdirSync(extensions, { recursive: true });
      const mine = join(extensions, "quick-titles.ts");
      const body = "// an extension I wrote myself\nexport default function () {}\n";
      writeFileSync(mine, body, "utf8");

      const env = envWithHome(home);
      delete env.PI_CODING_AGENT_DIR;
      const { code, out } = run(UNINSTALL, env);
      expect(code).toBe(1);
      expect(out).toContain("was not written by quick-titles");
      expect(readFileSync(mine, "utf8")).toBe(body);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("succeeds and names the paths it checked when nothing is installed", () => {
    const home = tempDirSync("qt-pi-");
    try {
      const env = envWithHome(home);
      delete env.PI_CODING_AGENT_DIR;
      const { code, out } = run(UNINSTALL, env);
      expect(code).toBe(0);
      expect(out).toContain("is not installed");
      expect(out).toContain(join(home, ".pi", "agent", REL));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("is idempotent", () => {
    const home = tempDirSync("qt-pi-");
    try {
      const env = envWithHome(home);
      delete env.PI_CODING_AGENT_DIR;
      expect(run(INSTALL, env).code).toBe(0);
      expect(run(UNINSTALL, env).code).toBe(0);
      const second = run(UNINSTALL, env);
      expect(second.code).toBe(0);
      expect(second.out).toContain("is not installed");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
