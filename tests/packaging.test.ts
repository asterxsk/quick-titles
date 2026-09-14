// The published tarball is the product. Everything else in this suite tests a
// checkout, and a checkout has every file in it — so nothing here would notice
// if `files` in package.json omitted something the shipped code reads at
// runtime. This suite packs the real tarball, unpacks it somewhere else, and
// runs the shipped code out of the unpacked tree with no repository around it.
//
// The bug it was written after: `src/core/prompt.ts` reads
// `assets/chat_template.jinja` and `assets/instruction.txt` at module load and
// throws if their hashes do not match the pinned constants. `files` did not
// list `assets/`, so the tarball shipped without them and every import of
// `dist/core/prompt.js` in the published package threw. From a checkout
// everything passed. The package was dead on arrival and no test could see it.
import { describe, expect, it, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { mkdirSync, readdirSync } from "node:fs";
import { cleanupTempDirs, tempDirSync } from "./helpers/tmp.js";

const run = promisify(execFile);
const ROOT = process.cwd();

afterAll(cleanupTempDirs);

interface Packed {
  /** Directory holding the unpacked package — a `node_modules/quick-titles`. */
  root: string;
  /** Every path in the tarball, relative to the package root. */
  files: string[];
}

/** Packs the package for real and unpacks it somewhere with no repository in
 *  its ancestry, so nothing can quietly resolve back to the working tree.
 *
 *  Memoized: packing and unpacking is the slow part of this file and every case
 *  wants the same artifact. Six packs of the same tree would also be six chances
 *  for two cases to disagree about what was tested. */
let packed: Promise<Packed> | null = null;
function packAndExtract(): Promise<Packed> {
  packed ??= doPackAndExtract();
  return packed;
}

async function doPackAndExtract(): Promise<Packed> {
  const out = tempDirSync("qt-pack-");
  const { stdout } = await run("npm", ["pack", "--pack-destination", out, "--json"], {
    cwd: ROOT,
    shell: process.platform === "win32",
  });
  const [info] = JSON.parse(stdout) as [{ filename: string; files: { path: string }[] }];

  const dest = join(out, "unpacked");
  mkdirSync(dest, { recursive: true });
  // `tar` is in System32 on Windows 10+ and present on the macOS and Linux
  // runners. Extracting here rather than reading the file list keeps the test
  // honest: it proves the files can be unpacked and run, not just that npm
  // would have included them.
  //
  // Both arguments are relative and `cwd` carries the location, which is not
  // tidiness: Git Bash's GNU tar treats `D:` in an absolute Windows path as a
  // remote-host spec, and backslash paths reach it unescaped when Node builds
  // the argument. Relative names sidestep both, and macOS and Linux are
  // unaffected.
  await run("tar", ["-xzf", info.filename, "-C", "unpacked"], { cwd: out });

  return { root: join(dest, "package"), files: info.files.map((f) => f.path) };
}

describe("the published package", () => {
  it("contains every asset the shipped code reads at load time", async () => {
    const { files } = await packAndExtract();

    // Named individually rather than as a prefix. `assets/` also holds the
    // README's demo image, so "is there an assets directory" would pass while
    // the two files that actually matter were missing.
    expect(files).toContain("assets/chat_template.jinja");
    expect(files).toContain("assets/instruction.txt");
  });

  it("ships the files each adapter and the CLI are loaded from", async () => {
    const { files } = await packAndExtract();

    for (const required of [
      "bin/quick-titles.mjs",
      "dist/client.js",
      "dist/paths.js",
      "dist/core/prompt.js",
      "dist/core/store.js",
      "dist/cli/sessions.js",
      "adapters/claude-code/scripts/lib.mjs",
      "adapters/claude-code/scripts/sessions.mjs",
      "adapters/claude-code/commands/sessions.md",
      "adapters/claude-code/.claude-plugin/plugin.json",
      ".claude-plugin/marketplace.json",
      "adapters/codex/install.mjs",
      "adapters/opencode2/plugin.ts",
      "adapters/pi/install.mjs",
      "adapters/pi/quick-titles.ts",
    ]) {
      expect(files, `${required} must ship`).toContain(required);
    }
  });

  it("does not ship the test suite, the tools, or the sources", async () => {
    const { files } = await packAndExtract();

    const stray = files.filter((p) => /^(tests|tools|src|docs|spike)\//.test(p));
    expect(stray).toEqual([]);
  });

  it("runs the pinned-hash check out of the unpacked package", async () => {
    const { root } = await packAndExtract();

    // This is the regression. `prompt.js` verifies both asset hashes at import
    // and throws when they are missing or altered; a zero exit means both files
    // shipped intact. Nothing else in this suite can fail this way.
    const { stderr } = await run(process.execPath, [join(root, "dist", "core", "prompt.js")], {
      cwd: root,
    }).catch((err: { stderr?: string; code?: number }) => {
      throw new Error(`the shipped prompt module failed to load: ${err.stderr ?? err.code}`);
    });
    expect(stderr).toBe("");
  });

  it("runs the shipped CLI out of the unpacked package", async () => {
    const { root } = await packAndExtract();
    const dataDir = tempDirSync("qt-pack-data-");

    // `doctor` imports paths, provisioning and the client — three modules whose
    // own imports would fail if `files` were short — without needing the model,
    // the daemon, or a single byte of node_modules.
    const result = await run(
      process.execPath,
      [join(root, "bin", "quick-titles.mjs"), "doctor"],
      {
        cwd: root,
        env: {
          ...process.env,
          QUICK_TITLES_DATA_DIR: dataDir,
          CLAUDE_PLUGIN_DATA: "",
          QUICK_TITLES_SOCKET: join(dataDir, "no-such.sock"),
        },
      }
    ).catch((err: { stdout?: string; stderr?: string; code?: number }) => err);

    const stdout = String(result.stdout ?? "");
    const stderr = String(result.stderr ?? "");

    // It exits 1 on purpose: no model is provisioned in a fresh data directory.
    // What matters is that it got that far, and that it failed for the stated
    // reason rather than because something it imports was left out of the
    // tarball.
    expect(stderr).not.toMatch(/Cannot find (module|package)/);
    expect(stderr).not.toMatch(/does not match the pinned hash/);
    expect(stdout).toContain("NOT provisioned");
    expect(stdout).toContain("Powered by Desert Ant Labs");
  });

  it("ships no directory that exists only in a checkout", async () => {
    const { root } = await packAndExtract();

    const present = readdirSync(root);
    for (const unwanted of ["node_modules", "tests", "spike", ".probe", ".tmp"]) {
      expect(present, `${unwanted} must not be published`).not.toContain(unwanted);
    }
  });
});
