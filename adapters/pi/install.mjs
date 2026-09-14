#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { MARKER, fail, requireBuiltClient } from "../shared/install-common.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// =============================================================================
// Where Pi loads extensions from
// =============================================================================
//
// Pi's own loader asks the SDK's getAgentDir() for this directory, so an
// install that disagrees with it lands somewhere Pi never scans. The SDK is
// therefore the authority: `resolveAgentDir()` imports it and uses it whenever
// the import succeeds.
//
// The SDK is a devDependency, and `npx quick-titles install pi` does not install
// a package's devDependencies — so for every published-package user the import
// fails and `fallbackAgentDir()` is the only branch that ever runs. It is a
// hand-written copy of the SDK's own rule (dist/config.js -> getAgentDir() plus
// dist/utils/paths.js -> normalizePath()/normalizeWindowsShellPath()), including
// the branches the previous hand-rolled copy dropped: the Windows shell paths
// (/c/…, /mnt/c/…, /cygdrive/c/…) and file:// URLs. A test asserts this copy
// equals the real getAgentDir() for every input shape whenever the SDK is
// importable, which is what keeps the two from drifting.

/** Git-Bash, MSYS, Cygwin and WSL drive paths -> the form native Windows accepts. */
function normalizeWindowsShellPath(filePath) {
  if (
    !filePath.startsWith("/") ||
    filePath.startsWith("//") ||
    filePath.includes("\\")
  ) {
    return filePath;
  }
  const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (!match) return filePath;
  const suffix = match[2]?.replaceAll("/", "\\");
  return `${match[1].toUpperCase()}:\\${suffix ?? ""}`;
}

/**
 * The SDK's normalizePath() with the options getAgentDir() leaves at their
 * defaults: no trim, tilde expansion on (everything in the value), Windows
 * shell-path translation on win32, then a file:// URL. Order matches the SDK.
 */
function normalizePath(input) {
  let normalized = input;
  if (process.platform === "win32") {
    normalized = normalizeWindowsShellPath(normalized);
  }
  const home = homedir();
  if (normalized === "~") return home;
  if (
    normalized.startsWith("~/") ||
    (process.platform === "win32" && normalized.startsWith("~\\"))
  ) {
    return join(home, normalized.slice(2));
  }
  if (/^file:\/\//.test(normalized)) {
    return fileURLToPath(normalized);
  }
  return normalized;
}

/**
 * The SDK-free equivalent of getAgentDir(). PI_CODING_AGENT_DIR wins whenever it
 * is truthy — an empty string means unset and the value is never trimmed —
 * otherwise the default is <home>/.pi/agent.
 */
export function fallbackAgentDir(env = process.env) {
  const envDir = env.PI_CODING_AGENT_DIR;
  if (envDir) {
    return normalizePath(envDir);
  }
  return join(homedir(), ".pi", "agent");
}

/**
 * The directory Pi loads extensions from. The SDK is used whenever it can be
 * imported (it owns the rule); only a genuinely failed import falls back to the
 * local copy. An error from getAgentDir() itself is not swallowed here — main()
 * turns it into the same actionable refusal as before.
 */
export async function resolveAgentDir(env = process.env) {
  let getAgentDir;
  try {
    ({ getAgentDir } = await import("@earendil-works/pi-coding-agent"));
  } catch {
    return fallbackAgentDir(env);
  }
  return getAgentDir();
}

async function main() {
  const dist = requireBuiltClient(import.meta.url);

  let agentDir;
  try {
    agentDir = await resolveAgentDir();
  } catch (err) {
    fail(
      `PI_CODING_AGENT_DIR is set to ${JSON.stringify(process.env.PI_CODING_AGENT_DIR)} ` +
        `but is not a usable path: ${err.message}`
    );
  }

  const target = join(agentDir, "extensions");
  try {
    mkdirSync(target, { recursive: true });
  } catch (err) {
    fail(`cannot create ${target}: ${err.message}`);
  }

  const source = readFileSync(resolve(here, "quick-titles.ts"), "utf8");
  // The token sits inside a double-quoted string literal, so a raw Windows path
  // (`C:\…`) would be re-read as escape sequences (`\t` a tab, `\A` a bare `A`)
  // and the installed extension would point at a corrupted directory. Escape the
  // backslashes so the literal evaluates back to the real path.
  const installed = source.replace("__QUICK_TITLES_DIST__", dist.replaceAll("\\", "\\\\"));
  // MARKER first, so `uninstall` can tell a file we wrote from one the user wrote
  // under the same name. See install-common.mjs.
  writeFileSync(join(target, "quick-titles.ts"), `${MARKER}\n${installed}`, "utf8");

  console.log(`quick-titles: installed Pi extension to ${join(target, "quick-titles.ts")}`);
}

// Run as a program, not when imported by the tests that bind the fallback to
// the SDK. ESM has no __main__, so compare this module's URL to argv[1].
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
