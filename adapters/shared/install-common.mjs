// Helpers shared by the per-agent installers.
//
// The opencode2 and Pi installers each grew their own copy of the build guard
// and of the "exit 1 with one clear line" failure path. The guard is a real
// invariant — every adapter loads `<repo>/dist/client.js`, which only exists
// after `npm run build` — and the message telling a developer how to fix a
// missing build must not drift between installers, so it lives in one place.

import { readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** True if `path` exists, whatever its type. */
export function exists(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The first line of every file this project writes into an agent's own
 * directory.
 *
 * Uninstall checks for it before deleting anything. The installed files are all
 * called `quick-titles.ts`, in directories the user also owns and writes to, so
 * a name collision is not far-fetched — a reader could plausibly have an
 * extension of their own under that name. Deleting a file we did not write is
 * unrecoverable, whereas refusing is merely inconvenient, so a file without this
 * line is left alone and the refusal is reported.
 *
 * It doubles as the answer to "what is this file and how do I get rid of it",
 * which is the question someone opening it from their editor will have.
 */
export const MARKER =
  "// quick-titles — installed by `npx quick-titles install`, removed by `npx quick-titles uninstall`";

/** True if this project wrote `path`. */
function isOurs(path) {
  try {
    return readFileSync(path, "utf8").includes(MARKER);
  } catch {
    return false;
  }
}

/**
 * Removes the files this project installed, from every candidate location.
 *
 * Idempotent on purpose: the end state that is wanted is "not installed", and a
 * file that is already gone *is* that state, so nothing here treats absence as a
 * failure. A candidate that exists but lacks the marker is refused with exit 1
 * rather than deleted.
 *
 * `candidates` is a list, not a single path, because several of the installers
 * choose their directory from the environment or the cwd — opencode2 writes
 * project-locally when it sees an `.opencode` directory, Pi honours
 * `PI_CODING_AGENT_DIR`. Those inputs can differ between the install and the
 * uninstall (a different cwd, an unset variable), and checking only the
 * freshly-computed path would silently leave the real file behind while
 * reporting success.
 */
export function removeInstalledFile(candidates, label) {
  const paths = [...new Set(candidates)].filter((p) => p !== undefined);
  let removed = 0;
  let refused = 0;

  for (const target of paths) {
    if (!exists(target)) continue;
    if (!isOurs(target)) {
      console.error(
        `quick-titles: ${target} exists but was not written by quick-titles; leaving it alone`
      );
      refused += 1;
      continue;
    }
    try {
      rmSync(target, { force: true });
    } catch (err) {
      return fail(`could not remove ${target}: ${err.message}`);
    }
    console.log(`quick-titles: removed the ${label} from ${target}`);
    removed += 1;
  }

  if (refused > 0) return 1;
  if (removed === 0) {
    console.log(`quick-titles: the ${label} is not installed (checked ${paths.join(", ")})`);
  }
  return 0;
}

/**
 * Exits with status 1 after printing `quick-titles: <message>`.
 *
 * Every condition an installer cannot turn into a working installation goes
 * through here, so a failure is one line on stderr and a non-zero status —
 * never an uncaught exception with a stack trace.
 */
export function fail(message) {
  console.error(`quick-titles: ${message}`);
  process.exit(1);
}

/**
 * The package's `dist` directory, derived from the calling module's own URL so
 * it does not depend on the cwd the installer happened to be run from. Pass
 * `import.meta.url` from a file at `adapters/<agent>/`.
 */
function distDir(callerUrl) {
  return resolve(dirname(fileURLToPath(callerUrl)), "..", "..", "dist");
}

/**
 * Returns the `dist` directory, or exits 1 with an actionable message if
 * `dist/client.js` is missing.
 */
export function requireBuiltClient(callerUrl) {
  const dist = distDir(callerUrl);
  if (!exists(join(dist, "client.js"))) {
    fail("run `npm run build` first; dist/client.js is missing");
  }
  return dist;
}
