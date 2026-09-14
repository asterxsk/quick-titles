import { describe, expect, it, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readClip } from "../../src/core/session/index.js";
import { materialise, type Opencode2Message } from "../../adapters/opencode2/plugin.js";
import { tempDirSync, cleanupTempDirs } from "../helpers/tmp.js";

const source = readFileSync("adapters/opencode2/plugin.ts", "utf8");

afterEach(cleanupTempDirs);

describe("opencode2 adapter", () => {
  it("uses the documented rename method, not a storage write", () => {
    expect(source).toContain("ctx.session.rename");
  });

  it("does not reach into SQLite directly", () => {
    expect(source).not.toMatch(/opencode\.db|sqlite|better-sqlite3/i);
  });

  it("guards on the placeholder title pattern", () => {
    expect(source).toContain("New session");
    expect(source).toContain("Child session");
  });

  it("swallows generation failures", () => {
    expect(source).toMatch(/\.catch\(\(\) => null\)/);
  });
});

// One decoded opencode2 session, in the shape `ctx.session.context()` yields:
// `{...data, id, type}` per row. user/system rows carry `text`; assistant rows
// carry an array of parts.
const raw: Opencode2Message[] = [
  { type: "user", text: "The Windows runner keeps failing the build." },
  {
    type: "assistant",
    content: [
      { type: "reasoning", text: "" },
      { type: "text", text: "It's the path separator in the test assertion." },
      { type: "tool", tool: "bash" },
    ],
  },
  { type: "system", text: "Today's date is now: Fri Sep 11 2026" },
  { type: "synthetic", text: "Continue." },
  { type: "user", text: "Fix it so the suite is platform independent." },
  { type: "assistant", content: [{ type: "text", text: "Switched the prefix check to an exact path join comparison." }] },
];

describe("materialise", () => {
  it("keeps only conversation turns, in order", () => {
    expect(materialise(null, raw).messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("flattens assistant content parts and drops scaffolding", () => {
    const { messages } = materialise({ title: "New session - 2026-09-14T10:00:00.000Z" }, raw);
    expect(messages[1].content).toBe("It's the path separator in the test assertion.");
    expect(messages).toHaveLength(4);
    expect(messages.some((m) => m.content.includes("Today's date"))).toBe(false);
  });

  it("carries the session title through", () => {
    expect(materialise({ title: "Auth refactor" }, []).session_v2.title).toBe("Auth refactor");
    expect(materialise(null, []).session_v2.title).toBeNull();
  });
});

describe("materialised file round-trips through the opencode2 reader", () => {
  it("produces a usable clip", async () => {
    const dir = tempDirSync(".tmp-opencode2-");
    try {
      const path = join(dir, "session.json");
      const file = materialise({ title: "New session - 2026-09-14T10:00:00.000Z" }, raw);
      writeFileSync(path, JSON.stringify(file), "utf8");

      const clip = await readClip("opencode2", path);
      expect(clip).toContain("user: The Windows runner keeps failing the build.");
      expect(clip).toContain("assistant: It's the path separator in the test assertion.");
      expect(clip).toContain("Switched the prefix check to an exact path join comparison.");
      expect(clip).not.toContain("Today's date");
      expect(clip.length).toBeGreaterThan(60);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("install", () => {
  it("substitutes an absolute, correctly-escaped dist path", () => {
    const dir = tempDirSync(".tmp-install-");
    try {
      // A project-local .opencode/ keeps the installer inside the repo; without
      // it install.mjs would write to the user's home config directory.
      mkdirSync(join(dir, ".opencode"), { recursive: true });
      execFileSync(process.execPath, [join(process.cwd(), "adapters", "opencode2", "install.mjs")], {
        cwd: dir,
      });

      const installed = readFileSync(join(dir, ".opencode", "plugins", "quick-titles.ts"), "utf8");
      expect(installed).not.toContain("__QUICK_TITLES_DIST__");
      const literal = installed.match(/const DIST = (".*");/);
      expect(literal).toBeTruthy();
      // The literal must survive JSON.parse — a raw Windows path would be read
      // as escape sequences and corrupt the module.
      expect(JSON.parse(literal![1])).toMatch(/[\\/]dist$/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("uninstall", () => {
  const UNINSTALL = join(process.cwd(), "adapters", "opencode2", "uninstall.mjs");
  const INSTALL = join(process.cwd(), "adapters", "opencode2", "install.mjs");
  const PLUGIN = join("plugins", "quick-titles.ts");

  /** A fresh HOME. Every run below goes through this, including the ones that
   *  only touch a project directory: the candidate list always contains the
   *  global path, so a run with the real HOME would consult — and, for a file
   *  carrying our marker, remove — the user's own opencode2 config. Both
   *  spellings are set because os.homedir() reads USERPROFILE on Windows and
   *  HOME everywhere else. */
  function envWithHome(home: string): NodeJS.ProcessEnv {
    return { ...process.env, USERPROFILE: home, HOME: home };
  }

  function run(script: string, cwd: string, env: NodeJS.ProcessEnv) {
    return spawnSync(process.execPath, [script], { cwd, env, encoding: "utf8" });
  }

  it("removes the plugin the installer put in the project directory", () => {
    const dir = tempDirSync(".tmp-install-");
    const home = tempDirSync("qt-opencode2-");
    try {
      mkdirSync(join(dir, ".opencode"), { recursive: true });
      const env = envWithHome(home);
      expect(run(INSTALL, dir, env).status).toBe(0);
      const installed = join(dir, ".opencode", PLUGIN);
      expect(existsSync(installed)).toBe(true);

      const { status, stdout } = run(UNINSTALL, dir, env);
      expect(status).toBe(0);
      expect(stdout).toContain("removed the opencode2 plugin");
      expect(existsSync(installed)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("removes a global install even when run from inside a project", () => {
    // The reason the candidate list exists. install.mjs chose the global path
    // because its cwd held no .opencode; this uninstall runs from a directory
    // that does, so a single freshly-computed path would be the project-local
    // one — nothing there — and the real file would survive a successful-looking
    // uninstall.
    const home = tempDirSync("qt-opencode2-");
    const plain = tempDirSync(".tmp-install-");
    const project = tempDirSync(".tmp-install-");
    try {
      mkdirSync(join(project, ".opencode"), { recursive: true });
      const env = envWithHome(home);

      expect(run(INSTALL, plain, env).status).toBe(0);
      const installed = join(home, ".config", "opencode", PLUGIN);
      expect(existsSync(installed)).toBe(true);

      const { status, stdout } = run(UNINSTALL, project, env);
      expect(status).toBe(0);
      expect(stdout).toContain("removed the opencode2 plugin");
      expect(existsSync(installed)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(plain, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("leaves a file it did not write alone", () => {
    const dir = tempDirSync(".tmp-install-");
    const home = tempDirSync("qt-opencode2-");
    try {
      const plugins = join(dir, ".opencode", "plugins");
      mkdirSync(plugins, { recursive: true });
      const mine = join(plugins, "quick-titles.ts");
      const body = "// an extension I wrote myself\nexport default {};\n";
      writeFileSync(mine, body, "utf8");

      const { status, stderr } = run(UNINSTALL, dir, envWithHome(home));
      expect(status).toBe(1);
      expect(stderr).toContain("was not written by quick-titles");
      expect(readFileSync(mine, "utf8")).toBe(body);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("succeeds and names the paths it checked when nothing is installed", () => {
    const dir = tempDirSync(".tmp-install-");
    const home = tempDirSync("qt-opencode2-");
    try {
      const { status, stdout } = run(UNINSTALL, dir, envWithHome(home));
      expect(status).toBe(0);
      expect(stdout).toContain("is not installed");
      // Both candidates are listed, so the answer is checkable rather than bare.
      expect(stdout).toContain(join(dir, ".opencode", PLUGIN));
      expect(stdout).toContain(join(home, ".config", "opencode", PLUGIN));
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("is idempotent", () => {
    const dir = tempDirSync(".tmp-install-");
    const home = tempDirSync("qt-opencode2-");
    try {
      const env = envWithHome(home);
      mkdirSync(join(dir, ".opencode"), { recursive: true });
      expect(run(INSTALL, dir, env).status).toBe(0);
      expect(run(UNINSTALL, dir, env).status).toBe(0);
      const second = run(UNINSTALL, dir, env);
      expect(second.status).toBe(0);
      expect(second.stdout).toContain("is not installed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// The tests above never touch the host boundary: they read plugin.ts as text or
// exercise the pure `materialise` helper, so a `setup` that did nothing (or read
// the wrong event field) would pass them all. These drive the real default
// export against a fake event emitter and a fake daemon socket and assert the
// whole chain: event in -> transcript materialised -> rename called with the
// generated title.

type FakeEvent = {
  type?: string;
  // The real opencode2 payload field (EventSessionIdle / EventMessageUpdated).
  properties?: { sessionID?: string };
  // The field the buggy adapter read. Must not be enough to trigger anything.
  data?: { sessionID?: string };
};

type EventHandler = (event: FakeEvent) => void | Promise<void>;

async function startFakeDaemon(title: string): Promise<{ pipe: string; close: () => Promise<void> }> {
  const pipe = `\\\\.\\pipe\\quick-titles-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const server: Server = createServer((socket) => {
    socket.on("data", () => {
      socket.write(`${JSON.stringify({ ok: true, result: { title } })}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(pipe, resolve));
  return {
    pipe,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A daemon *entry* the client spawns on a cold start. Nothing is listening
 *  until this process boots, so an appended line per boot is proof the plugin
 *  actually started a daemon. It serves ping/generate on QUICK_TITLES_SOCKET
 *  and exits once its one job is done. */
function writeStubDaemon(marker: string, title: string): string {
  const file = join(tempDirSync(".tmp-entry-"), "stub-daemon.mjs");
  writeFileSync(
    file,
    `import { createServer } from "node:net";
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(marker)}, String(process.pid) + "\\n");
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
      setTimeout(() => process.exit(0), 200);
    } else {
      conn.write(JSON.stringify({ id: req.id, ok: true, result: "pong" }) + "\\n");
    }
  });
  conn.on("error", () => {});
});
server.on("error", () => process.exit(1));
server.listen(process.env.QUICK_TITLES_SOCKET);
setTimeout(() => process.exit(0), 20000);
`,
    "utf8"
  );
  return file;
}

async function mountRealSetup(options: {
  daemonTitle?: string;
  sessionTitle?: string | null;
  renameThrows?: boolean;
  dataDir?: string;
  /** Cold-start seam: nothing is listening until the plugin spawns `entry`,
   *  which then binds `socket`. Proves the plugin itself starts the daemon. */
  coldStart?: { entry: string; socket: string };
} = {}) {
  const root = process.cwd();
  const pluginDir = tempDirSync(".tmp-plugin-");
  const source = readFileSync(join(root, "adapters", "opencode2", "plugin.ts"), "utf8");
  // install.mjs performs this exact substitution; without it setup() would try
  // to import the unresolved placeholder and never reach the handler.
  const generated = source.replaceAll('"__QUICK_TITLES_DIST__"', JSON.stringify(join(root, "dist")));
  writeFileSync(join(pluginDir, "plugin.ts"), generated, "utf8");

  const mod = (await import(pathToFileURL(join(pluginDir, "plugin.ts")).href)) as {
    default: { setup(ctx: unknown): Promise<(() => void) | void> };
  };

  const dataDir = options.dataDir ?? tempDirSync(".tmp-data-");
  const daemon = options.coldStart ? null : await startFakeDaemon(options.daemonTitle ?? "Generated Title");
  const socket = options.coldStart ? options.coldStart.socket : daemon!.pipe;

  const previousSocket = process.env.QUICK_TITLES_SOCKET;
  const previousData = process.env.QUICK_TITLES_DATA_DIR;
  const previousEntry = process.env.QUICK_TITLES_DAEMON_ENTRY;
  const previousModel = process.env.QT_MODEL;
  process.env.QUICK_TITLES_SOCKET = socket;
  process.env.QUICK_TITLES_DATA_DIR = dataDir;
  if (options.coldStart) {
    process.env.QUICK_TITLES_DAEMON_ENTRY = options.coldStart.entry;
    // ensureDaemon() refuses to spawn when no model is provisioned; this test
    // simulates a provisioned machine so the spawn path is exercised.
    process.env.QT_MODEL = join(dataDir, "provisioned.gguf");
  }

  const handlers: EventHandler[] = [];
  const renames: { sessionID: string; title: string }[] = [];
  const ctx = {
    event: {
      subscribe(handler: EventHandler) {
        handlers.push(handler);
        return { dispose() {} };
      },
    },
    session: {
      get: async () => ({
        title:
          options.sessionTitle === undefined
            ? "New session - 2026-09-14T10:00:00.000Z"
            : options.sessionTitle,
      }),
      context: async () => raw,
      rename: async (args: { sessionID: string; title: string }) => {
        renames.push(args);
        if (options.renameThrows) throw new Error("rename rejected by host");
        return {};
      },
    },
  };

  const dispose = await mod.default.setup(ctx);

  return {
    emit: (event: FakeEvent) => handlers[0](event),
    renames,
    transcriptPath: (sessionID: string) => join(dataDir, "cache", `${sessionID}.json`),
    async cleanup() {
      await dispose?.();
      if (daemon) await daemon.close();
      if (previousSocket === undefined) delete process.env.QUICK_TITLES_SOCKET;
      else process.env.QUICK_TITLES_SOCKET = previousSocket;
      if (previousData === undefined) delete process.env.QUICK_TITLES_DATA_DIR;
      else process.env.QUICK_TITLES_DATA_DIR = previousData;
      if (previousEntry === undefined) delete process.env.QUICK_TITLES_DAEMON_ENTRY;
      else process.env.QUICK_TITLES_DAEMON_ENTRY = previousEntry;
      if (previousModel === undefined) delete process.env.QT_MODEL;
      else process.env.QT_MODEL = previousModel;
      rmSync(pluginDir, { recursive: true, force: true });
      if (options.dataDir === undefined) rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

describe("opencode2 setup over a fake daemon", () => {
  it("materialises the transcript and renames on session.idle (properties.sessionID)", async () => {
    const h = await mountRealSetup();
    try {
      await h.emit({ type: "session.idle", properties: { sessionID: "ses_test" } });

      expect(existsSync(h.transcriptPath("ses_test"))).toBe(true);
      const written = JSON.parse(readFileSync(h.transcriptPath("ses_test"), "utf8"));
      expect(written.messages.length).toBeGreaterThan(0);
      expect(written.session_v2.title).toBe("New session - 2026-09-14T10:00:00.000Z");
      expect(h.renames).toEqual([{ sessionID: "ses_test", title: "Generated Title" }]);
    } finally {
      await h.cleanup();
    }
  });

  it("renames on message.updated too (properties.sessionID)", async () => {
    const h = await mountRealSetup({ daemonTitle: "Message Updated Title" });
    try {
      await h.emit({ type: "message.updated", properties: { sessionID: "ses_msg" } });
      expect(h.renames).toEqual([{ sessionID: "ses_msg", title: "Message Updated Title" }]);
    } finally {
      await h.cleanup();
    }
  });

  it("does not rename when the id sits in the wrong field (data.sessionID)", async () => {
    const h = await mountRealSetup();
    try {
      await h.emit({ type: "session.idle", data: { sessionID: "ses_wrong" } });
      expect(existsSync(h.transcriptPath("ses_wrong"))).toBe(false);
      expect(h.renames).toEqual([]);
    } finally {
      await h.cleanup();
    }
  });

  it("does not reject the event callback when rename throws", async () => {
    const h = await mountRealSetup({ renameThrows: true });
    try {
      await expect(
        h.emit({ type: "session.idle", properties: { sessionID: "ses_throw" } })
      ).resolves.toBeUndefined();
      expect(h.renames).toHaveLength(1);
    } finally {
      await h.cleanup();
    }
  });

  it("does not reject the event callback when the transcript write fails", async () => {
    const notADir = join(tempDirSync(".tmp-filedir-"), "blocker");
    writeFileSync(notADir, "regular file, not a directory", "utf8");
    // QUICK_TITLES_DATA_DIR points at a file, so mkdirSync(<file>/cache) throws.
    const h = await mountRealSetup({ dataDir: notADir });
    try {
      await expect(
        h.emit({ type: "session.idle", properties: { sessionID: "ses_nodir" } })
      ).resolves.toBeUndefined();
      expect(h.renames).toEqual([]);
    } finally {
      await h.cleanup();
      rmSync(join(notADir, ".."), { recursive: true, force: true });
    }
  });
});

// The tests above all inject an already-listening fake daemon, so none of them
// can see that the plugin never starts one. These point QUICK_TITLES_SOCKET at
// a dead pipe and let the plugin spawn the daemon itself, which is the only way
// to observe the cold-start path on a machine with no daemon running.
describe("opencode2 cold start", () => {
  it("spawns the daemon exactly once and renames with the generated title", async () => {
    const dir = tempDirSync(".tmp-cold-");
    const marker = join(dir, "boots.log");
    const socket = `\\\\.\\pipe\\quick-titles-cold-${process.pid}-${Math.random()
      .toString(36)
      .slice(2)}`;
    const entry = writeStubDaemon(marker, "Cold Start Title");
    const h = await mountRealSetup({ dataDir: join(dir, "data"), coldStart: { entry, socket } });
    try {
      await h.emit({ type: "session.idle", properties: { sessionID: "ses_cold" } });

      // Pre-fix the plugin imported only `generate`, so no process was ever
      // spawned and this file does not exist.
      expect(readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(1);
      expect(h.renames).toEqual([{ sessionID: "ses_cold", title: "Cold Start Title" }]);
    } finally {
      await h.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not throw out of the handler and does not rename when the daemon never binds", async () => {
    const dir = tempDirSync(".tmp-nodaemon-");
    // A real, spawnable entry that exits immediately: the spawn succeeds but
    // nothing ever listens, which is distinct from a missing entry (whose
    // spawn error is emitted asynchronously).
    const entry = join(dir, "dead-entry.mjs");
    writeFileSync(entry, "process.exit(0);\n", "utf8");
    const socket = `\\\\.\\pipe\\quick-titles-absent-${process.pid}-${Math.random()
      .toString(36)
      .slice(2)}`;
    const h = await mountRealSetup({ dataDir: join(dir, "data"), coldStart: { entry, socket } });
    try {
      await expect(
        h.emit({ type: "session.idle", properties: { sessionID: "ses_dead" } })
      ).resolves.toBeUndefined();
      expect(h.renames).toEqual([]);
    } finally {
      await h.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);
});
