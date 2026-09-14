import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { isAbsolute, join } from "node:path";
import {
  cacheDir,
  dataDir,
  modelsDir,
  pidFile,
  socketPath,
  storeFile,
} from "../src/paths.js";

// `platform()` and `homedir()` are read at path-resolution time, not at import
// time, so a mutable holder lets this file exercise every branch on any host.
// Spying on a live ESM namespace export does not work (D15); vi.mock does.
const osMock = vi.hoisted(() => ({
  platform: null as NodeJS.Platform | null,
  home: null as string | null,
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    platform: () => osMock.platform ?? actual.platform(),
    homedir: () => osMock.home ?? actual.homedir(),
  };
});

describe("paths", () => {
  const original = process.env.QUICK_TITLES_DATA_DIR;

  beforeEach(() => {
    process.env.QUICK_TITLES_DATA_DIR = "/tmp/qt-test";
  });

  afterEach(() => {
    process.env.QUICK_TITLES_DATA_DIR = original;
  });

  it("honours the data dir override", () => {
    expect(dataDir()).toBe("/tmp/qt-test");
  });

  it("places the store inside the data dir", () => {
    // Compared via join, not startsWith: the override above is a POSIX literal,
    // but path.join normalises separators per platform, so on win32 the store
    // path comes back as "\tmp\qt-test\titles.jsonl" and never startsWith "/tmp/...".
    expect(storeFile()).toBe(join(dataDir(), "titles.jsonl"));
  });

  it("returns a pipe path on win32 and a socket path elsewhere", () => {
    const p = socketPath();
    if (process.platform === "win32") {
      expect(p.startsWith("\\\\.\\pipe\\")).toBe(true);
    } else {
      expect(p.startsWith(dataDir())).toBe(true);
    }
  });
});

describe("paths: empty-string environment variables", () => {
  const keys = ["QUICK_TITLES_DATA_DIR", "LOCALAPPDATA", "XDG_DATA_HOME"] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of keys) saved[k] = process.env[k];
    osMock.platform = null;
    osMock.home = null;
  });

  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    osMock.platform = null;
    osMock.home = null;
  });

  it("dataDir() falls back on an empty QUICK_TITLES_DATA_DIR instead of returning a relative path", () => {
    osMock.platform = "linux";
    osMock.home = "/home/u";
    delete process.env.XDG_DATA_HOME;
    process.env.QUICK_TITLES_DATA_DIR = "";
    expect(dataDir()).toBe(join("/home/u", ".local", "share", "quick-titles"));
    expect(isAbsolute(dataDir())).toBe(true);
  });

  it("baseDataDir() falls back on an empty XDG_DATA_HOME", () => {
    osMock.platform = "linux";
    osMock.home = "/home/u";
    process.env.QUICK_TITLES_DATA_DIR = "";
    process.env.XDG_DATA_HOME = "";
    expect(dataDir()).toBe(join("/home/u", ".local", "share", "quick-titles"));
  });

  it("baseDataDir() falls back on an empty LOCALAPPDATA", () => {
    osMock.platform = "win32";
    osMock.home = "C:\\Users\\u";
    process.env.QUICK_TITLES_DATA_DIR = "";
    process.env.LOCALAPPDATA = "";
    expect(dataDir()).toBe(join("C:\\Users\\u", "AppData", "Local", "quick-titles"));
  });

  it("still honours a non-empty LOCALAPPDATA", () => {
    osMock.platform = "win32";
    process.env.QUICK_TITLES_DATA_DIR = "";
    process.env.LOCALAPPDATA = "D:\\LocalAppData";
    expect(dataDir()).toBe(join("D:\\LocalAppData", "quick-titles"));
  });

  // One test per function the empty override used to break. Each must resolve
  // inside the fallback data dir — an absolute path — not the bare leaf name.
  const derived: Array<[string, () => string, string]> = [
    ["cacheDir", cacheDir, "cache"],
    ["modelsDir", modelsDir, "models"],
    ["storeFile", storeFile, "titles.jsonl"],
    ["pidFile", pidFile, "daemon.pid"],
  ];

  for (const [name, fn, leaf] of derived) {
    it(`${name}() is absolute under an empty QUICK_TITLES_DATA_DIR`, () => {
      osMock.platform = "linux";
      osMock.home = "/home/u";
      delete process.env.XDG_DATA_HOME;
      process.env.QUICK_TITLES_DATA_DIR = "";
      expect(fn()).toBe(join("/home/u", ".local", "share", "quick-titles", leaf));
      expect(isAbsolute(fn())).toBe(true);
    });
  }
});

describe("paths: whitespace-only environment variables", () => {
  const keys = [
    "QUICK_TITLES_DATA_DIR",
    "CLAUDE_PLUGIN_DATA",
    "LOCALAPPDATA",
    "XDG_DATA_HOME",
    "QUICK_TITLES_SOCKET",
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of keys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    osMock.platform = null;
    osMock.home = null;
  });

  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    osMock.platform = null;
    osMock.home = null;
  });

  // A value of " " is truthy, so an unguarded env read treats it as a real
  // path and dataDir() becomes " " (or " \quick-titles") — relative to whatever
  // cwd the host happens to have. Each of these four variables had that hole.

  it('treats a whitespace-only QUICK_TITLES_DATA_DIR as unset, not a relative path', () => {
    osMock.platform = "linux";
    osMock.home = "/home/u";
    process.env.QUICK_TITLES_DATA_DIR = " ";
    expect(dataDir()).toBe(join("/home/u", ".local", "share", "quick-titles"));
    expect(isAbsolute(dataDir())).toBe(true);
  });

  it("treats a whitespace-only XDG_DATA_HOME as unset", () => {
    osMock.platform = "linux";
    osMock.home = "/home/u";
    process.env.XDG_DATA_HOME = " ";
    expect(dataDir()).toBe(join("/home/u", ".local", "share", "quick-titles"));
    expect(isAbsolute(dataDir())).toBe(true);
  });

  it("treats a whitespace-only LOCALAPPDATA as unset", () => {
    osMock.platform = "win32";
    osMock.home = "C:\\Users\\u";
    process.env.LOCALAPPDATA = " ";
    expect(dataDir()).toBe(join("C:\\Users\\u", "AppData", "Local", "quick-titles"));
    // Gated on the mocked platform being the host's, and this is not a
    // convenience. `dataDir()` builds its result with the *host's* `join`, so
    // the value here only has win32 shape on Windows. On macOS and Linux the
    // same call returns a mixed-separator string that no platform's
    // `isAbsolute` accepts, and asserting otherwise is exactly what failed CI's
    // first run on macos-latest. The `toBe` above is host-independent and still
    // pins the branch; this line adds the absoluteness check where it means
    // something.
    if (osMock.platform === process.platform) {
      expect(isAbsolute(dataDir())).toBe(true);
    }
  });

  it("treats a whitespace-only QUICK_TITLES_SOCKET as unset", () => {
    osMock.platform = "linux";
    osMock.home = "/home/u";
    process.env.QUICK_TITLES_SOCKET = " ";
    expect(socketPath()).toBe(join("/home/u", ".local", "share", "quick-titles", "daemon.sock"));
    expect(isAbsolute(socketPath())).toBe(true);
  });

  it("treats a whitespace-only CLAUDE_PLUGIN_DATA as unset", () => {
    osMock.platform = "linux";
    osMock.home = "/home/u";
    process.env.CLAUDE_PLUGIN_DATA = " ";
    expect(dataDir()).toBe(join("/home/u", ".local", "share", "quick-titles"));
  });

  it("resolves CLAUDE_PLUGIN_DATA in paths.dataDir so hook and daemon agree", () => {
    osMock.platform = "linux";
    osMock.home = "/home/u";
    process.env.CLAUDE_PLUGIN_DATA = "/plugin/data";
    expect(dataDir()).toBe("/plugin/data");
  });

  it("uses a path with legitimate surrounding spaces verbatim rather than trimming it", () => {
    // " /tmp/with space " is a legal unix path; only an all-whitespace value is
    // meaningless, so the fix must fall through on " " without trimming a value
    // that has real content around its spaces.
    osMock.platform = "linux";
    osMock.home = "/home/u";
    process.env.QUICK_TITLES_DATA_DIR = " /tmp/with space ";
    expect(dataDir()).toBe(" /tmp/with space ");
  });
});
