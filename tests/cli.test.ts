// Tests for bin/quick-titles.mjs, the one command a user actually types.
//
// Every case here runs the real CLI as a child process rather than importing it,
// because the things worth asserting are process-level: the exit status, what
// lands on stdout versus stderr, and — most importantly — that `doctor` reports
// without starting anything. Importing the module would test none of those.
//
// Each run gets its own data directory and socket path. That is not tidiness:
// without them the suite would read the developer's real quick-titles state, and
// a `doctor` that reported "provisioned" on one machine and "absent" on another
// is a test that passes for the wrong reason.
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { tempDirSync, cleanupTempDirs } from "./helpers/tmp.js";

const run = promisify(execFile);

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "bin", "quick-titles.mjs");

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the CLI in an isolated data directory and returns its streams.
 *
 *  `execFile` rejects on a non-zero exit, which is the normal case here — the
 *  rejection carries the same stdout/stderr/status, so it is unwrapped rather
 *  than treated as a failure. */
async function cli(
  args: string[],
  opts: { model?: boolean; dataDir?: string; env?: Record<string, string> } = {}
): Promise<Run & { dataDir: string }> {
  const dataDir = opts.dataDir ?? tempDirSync("qt-cli-");
  if (opts.model) {
    mkdirSync(join(dataDir, "models"), { recursive: true });
    writeFileSync(join(dataDir, "models", "title-q8_0.gguf"), "stub");
  }
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        QUICK_TITLES_DATA_DIR: dataDir,
        // Cleared, not merely outranked. dataDir() prefers CLAUDE_PLUGIN_DATA,
        // so an inherited value would send every one of these runs at the real
        // store and the isolated data directory would never be consulted.
        CLAUDE_PLUGIN_DATA: "",
        // A socket that cannot exist, so "is the daemon running?" is answered by
        // a failed connect rather than by touching the machine-wide named pipe.
        QUICK_TITLES_SOCKET: join(dataDir, "no-such.sock"),
        QT_MODEL: "",
        ...opts.env,
      },
    });
    return { code: 0, stdout, stderr, dataDir };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "", dataDir };
  }
}

afterEach(cleanupTempDirs);

describe("quick-titles CLI", () => {
  it("prints the version from package.json, not a hardcoded string", async () => {
    const { code, stdout } = await cli(["--version"]);
    expect(code).toBe(0);
    const pkg = JSON.parse(
      await (await import("node:fs/promises")).readFile(join(ROOT, "package.json"), "utf8")
    ) as { version: string };
    // Line 1 stays a bare version so `$(quick-titles --version | head -1)` keeps
    // working; the attribution the model's licence requires rides on line 2.
    expect(stdout.split("\n")[0]).toBe(pkg.version);
    expect(stdout).toContain("Powered by Desert Ant Labs");
  });

  it("cannot let the attribution string drift between bin/ and the build", async () => {
    // bin/ carries its own copy so `--version` works from an unbuilt checkout.
    // This is the guard that makes the duplication safe rather than a second
    // source of truth.
    const { ATTRIBUTION } = await import("../src/cli/sessions.js");
    expect(ATTRIBUTION).toBe("Powered by Desert Ant Labs");
    const { stdout } = await cli(["--version"]);
    expect(stdout).toContain(ATTRIBUTION);
  });

  it("prints usage and exits 0 when given no arguments", async () => {
    const { code, stdout } = await cli([]);
    expect(code).toBe(0);
    expect(stdout).toContain("quick-titles install <agent>");
    expect(stdout).toContain("doctor");
    for (const agent of ["claude-code", "codex", "opencode2", "pi"]) {
      expect(stdout).toContain(agent);
    }
  });

  it("rejects an unknown command with a non-zero status", async () => {
    const { code, stderr } = await cli(["frobnicate"]);
    expect(code).toBe(1);
    expect(stderr).toContain("unknown command");
  });

  it("rejects an unknown agent and names the ones that exist", async () => {
    const { code, stderr } = await cli(["install", "nonsense"]);
    expect(code).toBe(1);
    expect(stderr).toContain("unknown agent");
    expect(stderr).toContain("claude-code");
  });

  it("refuses to install when no agent is named", async () => {
    const { code, stderr } = await cli(["install"]);
    expect(code).toBe(1);
    expect(stderr).toContain("which agent?");
  });

  it("does not treat a bare `install <agent>` name as an unknown command", async () => {
    // The dispatcher must route on argv[0] only. A command that swallowed the
    // agent name would surface here as "unknown command".
    const { stderr } = await cli(["install", "nonsense"]);
    expect(stderr).not.toContain("unknown command");
  });

  describe("uninstall", () => {
    /** A stand-in for the `claude` CLI, put first on PATH.
     *
     *  Two reasons this is a stub and not the real thing. It answers the plugin
     *  and marketplace questions with a shape this test chooses, which is what
     *  makes the "already removed" and "removal failed" branches reachable at
     *  all; and it keeps a test run from uninstalling a plugin the user actually
     *  has installed. It appends every invocation to QT_FAKE_CLAUDE_LOG, so the
     *  order of the two removals can be asserted rather than assumed. */
    function makeFakeClaude(
      dir: string,
      marketplaces: unknown[],
      plugins: unknown[],
      removeStatus = 0
    ): string {
      const script = join(dir, "claude-stub.mjs");
      writeFileSync(
        script,
        `import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
if (process.env.QT_FAKE_CLAUDE_LOG) appendFileSync(process.env.QT_FAKE_CLAUDE_LOG, args.join(" ") + "\\n");
const key = args.join(" ");
if (key === "--version") process.stdout.write("9.9.9\\n");
else if (key === "plugin marketplace list --json") process.stdout.write(${JSON.stringify(
          JSON.stringify(marketplaces)
        )} + "\\n");
else if (key === "plugin list --json") process.stdout.write(${JSON.stringify(
          JSON.stringify(plugins)
        )} + "\\n");
else if (key === "plugin marketplace remove quick-titles") process.exit(${removeStatus});
else process.exit(0);
`,
        "utf8"
      );
      const line =
        process.platform === "win32"
          ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
          : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`;
      const name = process.platform === "win32" ? "claude.cmd" : "claude";
      writeFileSync(join(dir, name), line, process.platform === "win32" ? "utf8" : { mode: 0o755 });
      return dir;
    }

    /** HOME and the per-agent config roots all point into scratch. Uninstall
     *  reads four agents' worth of locations and the candidate lists include
     *  each agent's global path, so an inherited HOME would put the user's real
     *  Claude Code, Codex, opencode2 and Pi installs in reach. */
    function isolated(over: Record<string, string> = {}): Record<string, string> {
      const home = tempDirSync("qt-cli-");
      return {
        HOME: home,
        USERPROFILE: home,
        CODEX_HOME: join(home, ".codex"),
        ...over,
      };
    }

    function fakeClaudeEnv(marketplaces: unknown[], plugins: unknown[], removeStatus = 0) {
      const bin = tempDirSync("qt-cli-");
      const log = join(tempDirSync("qt-cli-"), "claude.log");
      makeFakeClaude(bin, marketplaces, plugins, removeStatus);
      return {
        log,
        env: isolated({
          PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
          QT_FAKE_CLAUDE_LOG: log,
        }),
      };
    }

    function calls(log: string): string[] {
      return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
    }

    it("is listed in the usage text", async () => {
      const { stdout } = await cli(["--help"]);
      expect(stdout).toContain("quick-titles uninstall [agent]");
      expect(stdout).toContain("default: every agent");
    });

    it("rejects an unknown agent and names the ones that exist", async () => {
      const { code, stderr } = await cli(["uninstall", "nonsense"]);
      expect(code).toBe(1);
      expect(stderr).toContain("unknown agent");
      expect(stderr).toContain("claude-code");
      expect(stderr).toContain("all");
    });

    it("asks before removing anything, and exits 0 when nothing is installed", async () => {
      const { log, env } = fakeClaudeEnv([], []);
      const { code, stdout } = await cli(["uninstall"], { env });

      expect(code).toBe(0);
      expect(stdout).toContain("the Claude Code plugin is not installed");
      // Every adapter reported the same, so the bare form really did visit all four.
      expect(stdout).toContain("the Codex notifier is not installed");
      expect(stdout.match(/is not installed/g)?.length).toBeGreaterThanOrEqual(4);
      // It asked rather than blindly running `remove`: the availability probe and
      // the two queries ran, and neither removal command did.
      expect(calls(log)).toEqual([
        "--version",
        "plugin marketplace list --json",
        "plugin list --json",
      ]);
    });

    it("removes the plugin before the marketplace that holds it", async () => {
      // Reversed, the marketplace goes first and the plugin entry is left
      // pointing at a source that no longer exists.
      const { log, env } = fakeClaudeEnv(
        [{ name: "quick-titles", source: "local" }],
        [{ id: "quick-titles@quick-titles", version: "0.1.0" }]
      );
      const { code } = await cli(["uninstall", "claude-code"], { env });

      expect(code).toBe(0);
      expect(calls(log)).toEqual([
        "--version",
        "plugin marketplace list --json",
        "plugin list --json",
        "plugin uninstall quick-titles@quick-titles",
        "plugin marketplace remove quick-titles",
      ]);
    });

    it("still tries when the queries cannot be answered, and reports it cannot tell", async () => {
      // A `claude` that answers --version but fails the JSON queries leaves the
      // state unknown, and unknown must not be read as "not installed" — so the
      // removals are attempted anyway. They fail too, and nothing can then
      // confirm the plugin is gone, which is a non-zero exit rather than a
      // claim of success.
      const bin = tempDirSync("qt-cli-");
      const log = join(tempDirSync("qt-cli-"), "claude.log");
      const script = join(bin, "claude-stub.mjs");
      writeFileSync(
        script,
        `import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
if (process.env.QT_FAKE_CLAUDE_LOG) appendFileSync(process.env.QT_FAKE_CLAUDE_LOG, args.join(" ") + "\\n");
if (args.join(" ") === "--version") { process.stdout.write("9.9.9\\n"); process.exit(0); }
process.exit(3);
`,
        "utf8"
      );
      const name = process.platform === "win32" ? "claude.cmd" : "claude";
      writeFileSync(
        join(bin, name),
        process.platform === "win32"
          ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
          : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
        process.platform === "win32" ? "utf8" : { mode: 0o755 }
      );

      const env = isolated({
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
        QT_FAKE_CLAUDE_LOG: log,
      });
      const { code, stderr } = await cli(["uninstall", "claude-code"], { env });

      expect(calls(log)).toContain("plugin uninstall quick-titles@quick-titles");
      expect(calls(log)).toContain("plugin marketplace remove quick-titles");
      expect(code).toBe(1);
      expect(stderr).toContain("removing the marketplace failed");
    });

    it("reports failure when the marketplace could not be removed", async () => {
      const { env } = fakeClaudeEnv([{ name: "quick-titles" }], [], 1);
      const { code, stderr } = await cli(["uninstall", "claude-code"], { env });
      expect(code).toBe(1);
      expect(stderr).toContain("removing the marketplace failed");
    });

    it("prints the manual commands when the claude CLI is absent", async () => {
      // No `claude` on PATH at all: the only honest thing left is the two
      // commands the user can run themselves.
      const bin = tempDirSync("qt-cli-");
      const { code, stdout } = await cli(["uninstall", "claude-code"], {
        env: isolated({ PATH: bin }),
      });

      expect(code).toBe(0);
      expect(stdout).toContain("claude plugin uninstall quick-titles@quick-titles");
      expect(stdout).toContain("claude plugin marketplace remove quick-titles");
    });

    it("removes an agent's own installation through the adapter", async () => {
      // The CLI is a thin dispatcher over adapters/<agent>/uninstall.mjs; this
      // proves the wiring, with the codex adapter as the cheapest to observe.
      const home = tempDirSync("qt-cli-");
      const codexHome = join(home, ".codex");
      mkdirSync(codexHome, { recursive: true });
      const configPath = join(codexHome, "config.toml");
      const notify = join(ROOT, "adapters", "codex", "notify.mjs");
      writeFileSync(
        configPath,
        `notify = ${JSON.stringify([process.execPath, notify])}\nmodel = "gpt-5"\n`,
        "utf8"
      );

      const { code, stdout } = await cli(["uninstall", "codex"], {
        env: isolated({ CODEX_HOME: codexHome }),
      });

      expect(code).toBe(0);
      expect(stdout).toContain("removed the notify entry");
      expect(readFileSync(configPath, "utf8")).toBe(`model = "gpt-5"\n`);
    });
  });

  describe("doctor", () => {
    it("exits non-zero and says so when the model is not provisioned", async () => {
      const { code, stdout } = await cli(["doctor"]);
      expect(code).toBe(1);
      expect(stdout).toContain("NOT provisioned");
    });

    it("reports the data directory it was actually pointed at", async () => {
      const { stdout, dataDir } = await cli(["doctor"]);
      expect(stdout).toContain(dataDir);
    });

    it("exits 0 once a model is present", async () => {
      const { code, stdout } = await cli(["doctor"], { model: true });
      expect(code).toBe(0);
      expect(stdout).toContain("provisioned");
    });

    it("says the daemon is not running when nothing is listening", async () => {
      const { stdout } = await cli(["doctor"], { model: true });
      expect(stdout).toContain("not running");
    });

    it("reports without starting a daemon", async () => {
      // The whole point of a diagnostic is that observing does not change what
      // is observed. A daemon load is also ~5s and a few hundred MB.
      const { dataDir } = await cli(["doctor"], { model: true });
      expect(existsSync(join(dataDir, "daemon.pid"))).toBe(false);
      expect(existsSync(join(dataDir, "daemon.lock"))).toBe(false);
    });

    it("mentions QT_MODEL when it points somewhere that does not exist", async () => {
      const { code, stdout } = await cli(["doctor"], {
        env: { QT_MODEL: join("nowhere", "missing.gguf") },
      });
      expect(code).toBe(1);
      expect(stdout).toContain("QT_MODEL");
    });

    it("carries the licence attribution, on both the provisioned and unprovisioned paths", async () => {
      const absent = await cli(["doctor"]);
      expect(absent.stdout).toContain("Powered by Desert Ant Labs");

      const present = await cli(["doctor"], { model: true });
      expect(present.code).toBe(0);
      expect(present.stdout).toContain("Powered by Desert Ant Labs");
    });

    it("says whether a download source exists, so the next step is unambiguous", async () => {
      const withoutSource = await cli(["doctor"]);
      expect(withoutSource.stdout).toMatch(/download source\s+not configured/);

      const withSource = await cli(["doctor"], {
        env: { QUICK_TITLES_MODEL_URL: "https://example.invalid/model.gguf" },
      });
      expect(withSource.stdout).toMatch(/download source\s+configured/);
      // A configured source changes the advice from "convert it yourself" to
      // "run provision", and that difference is the whole point of reporting it.
      expect(withSource.stdout).toContain("quick-titles provision");
    });
  });

  describe("provision", () => {
    it("exits 0 and downloads nothing when the model is already there", async () => {
      const { code, stdout } = await cli(["provision"], { model: true });
      expect(code).toBe(0);
      expect(stdout).toContain("already provisioned");
    });

    it("explains how to get a model when this build has no weights URL", async () => {
      const { code, stderr } = await cli(["provision"]);
      expect(code).toBe(1);
      expect(stderr).toContain("no download source is configured");
      // The two supported routes out of this state must both be named.
      expect(stderr).toContain("QT_MODEL");
      expect(stderr).toContain("QUICK_TITLES_MODEL_URL");
    });

    it("never fetches during a title request or a doctor run", async () => {
      // Provisioning is the only thing that touches the network, and it is the
      // only command that may. `doctor` on an unprovisioned install must exit
      // without attempting a download.
      const { code, stdout } = await cli(["doctor"]);
      expect(code).toBe(1);
      expect(stdout).not.toContain("downloading");
    });
  });

  describe("sessions", () => {
    const record = (
      agent: string,
      sessionId: string,
      title: string,
      description: string | null
    ) =>
      JSON.stringify({
        agent,
        sessionId,
        title,
        description,
        backend: "vulkan",
        modelVersion: "title_q8_0@v0.1.0",
        createdAt: "2026-09-14T10:00:00.000Z",
      });

    it("lists titles without a daemon, which is the state a user is usually in", async () => {
      const dataDir = tempDirSync("qt-cli-sessions-");
      writeFileSync(
        join(dataDir, "titles.jsonl"),
        [
          record("claude-code", "ses_1", "Auth middleware refactor", "Reworked token expiry checks."),
          record("codex", "ses_2", "Wiring the Codex notifier", null),
        ].join("\n") + "\n",
        "utf8"
      );

      // The helper points QUICK_TITLES_SOCKET at a path that cannot exist, so a
      // passing run is evidence the listing needs no daemon rather than a claim
      // about it. The daemon is started by a prompt, not by this command.
      const { code, stdout } = await cli(["sessions"], { dataDir });

      expect(code).toBe(0);
      expect(stdout).toContain("Auth middleware refactor");
      expect(stdout).toContain("Reworked token expiry checks.");
      expect(stdout).toContain("Wiring the Codex notifier");
      expect(stdout).toContain("[codex]");
      expect(stdout).toContain("Powered by Desert Ant Labs");
    });

    it("says there are no titles yet rather than printing nothing", async () => {
      const { code, stdout } = await cli(["sessions"]);
      expect(code).toBe(0);
      expect(stdout).toMatch(/no titles yet/i);
      // The licence line is emitted even on the empty path.
      expect(stdout).toContain("Powered by Desert Ant Labs");
    });
  });

  describe("model-build", () => {
    it("shows the licence and stops without --accept-license", async () => {
      const { code, stdout, dataDir } = await cli(["model-build"]);

      expect(code).toBe(1);
      expect(stdout).toContain("Desert Ant Labs Source-Available License 1.0");
      // The clause that constrains this project, quoted verbatim rather than
      // referenced by letter. The notice used to say "(c)" and "(d)"; a reader
      // with the licence open could not match either letter to a clause, so the
      // text is quoted instead and the letters are gone. This asserts the text.
      expect(stdout).toContain("Do not redistribute the Models on their own");
      expect(stdout).toContain("licensing@desertant.com");
      expect(stdout).toContain("--accept-license");
      // Nothing was started, so nothing was created to clean up.
      expect(existsSync(join(dataDir, "build"))).toBe(false);
    });

    it("prints the WSL guide and exits without asking for the licence", async () => {
      // The whole point of the flag is that it answers a question rather than
      // performing an action, so the two things it must not do are build and
      // ask anyone to accept anything.
      const { code, stdout } = await cli(["model-build", "--guide"]);

      expect(code).toBe(0);
      expect(stdout).toContain("mlx_lm.convert");
      expect(stdout).toContain("python3-venv");
      expect(stdout).not.toContain("accept-license to continue");
    });

    it("prints the guide even when a model is already provisioned", async () => {
      // "You already have a model" is not an answer to "how would I build one",
      // and the guide is the only route for a Windows user — who may well have
      // a model they built on another machine.
      const { code, stdout } = await cli(["model-build", "--guide"], { model: true });

      expect(code).toBe(0);
      expect(stdout).toContain("mlx_lm.convert");
      expect(stdout).not.toContain("already provisioned");
    });

    it("names the reader's own data directory in the copy step", async () => {
      // The one step of the guide that is machine-specific, and the whole
      // reason `wslGuide` takes an argument: it has to be rendered from the
      // calling platform's data directory, not from whichever one the module
      // would resolve for itself. Both spellings are printed — the /mnt form to
      // paste, the Windows form to check against `doctor`.
      const dataDir = tempDirSync("qt-cli-");
      const { stdout } = await cli(["model-build", "--guide"], { dataDir });

      expect(stdout).toContain(dataDir);
      expect(stdout).toMatch(/\/mnt\/[a-z]\/.*models\/title-q8_0\.gguf/);
    });

    it("does not ask anyone to accept a licence for a build it will not run", async () => {
      // A model that is already provisioned is the common case for a second
      // run, and a wall of licence text in front of "there is nothing to do"
      // is noise.
      const { code, stdout } = await cli(["model-build"], { model: true });

      expect(code).toBe(0);
      expect(stdout).toContain("already provisioned");
      expect(stdout).not.toContain("Source-Available License");
    });

    it("leaves no build directory behind, whatever it did with the flag", async () => {
      // The interpreter is forced to one that cannot exist so this never
      // downloads anything, on any machine. Two outcomes are correct and the
      // test accepts both — a refusal at the platform gate on Windows and Intel
      // macOS, or a failure at the first step elsewhere — and what it asserts is
      // the one thing that must hold either way.
      const { code, stdout, stderr, dataDir } = await cli(["model-build", "--accept-license"], {
        env: { QUICK_TITLES_PYTHON: "quick-titles-no-such-interpreter" },
      });

      expect(code).toBe(1);
      expect(stdout).toContain("Source-Available License");
      // The refusal goes to stderr with the rest of the diagnostics, so a
      // caller piping stdout gets the licence text it asked for and not the
      // reason it did not run.
      expect(stderr).toContain("quick-titles:");
      expect(stderr).toMatch(/WSL|Apple silicon|Checking the Python version/);
      expect(existsSync(join(dataDir, "build"))).toBe(false);
    });
  });
});
