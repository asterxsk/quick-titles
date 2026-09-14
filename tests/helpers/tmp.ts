// Temp directories for tests, rooted in the repository rather than in the OS
// temp directory.
//
// `os.tmpdir()` is `C:\Users\<user>\AppData\Local\Temp` on Windows, and these
// suites create a directory per test. Two of them never removed theirs, which
// left 539 `qt-*` directories behind — the single largest source of C: clutter
// this project produced. Scratch space belongs under the project directory,
// which is also the rule the repository already follows elsewhere.
//
// `.tmp/` is gitignored. Call `cleanupTempDirs()` from `afterEach` or
// `afterAll`; a directory left behind on failure is worth having for
// debugging, so nothing cleans up implicitly.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** `<repo>/.tmp`. Derived from this file's own location, so it does not depend
 *  on the cwd a test happens to run from. */
const TMP_ROOT = join(fileURLToPath(new URL("../..", import.meta.url)), ".tmp");

const created: string[] = [];

/** Creates a temp directory under `<repo>/.tmp`. */
export async function tempDir(prefix = "t-"): Promise<string> {
  mkdirSync(TMP_ROOT, { recursive: true });
  const dir = await mkdtemp(join(TMP_ROOT, prefix));
  created.push(dir);
  return dir;
}

/** Synchronous sibling of `tempDir()`, for suites whose setup is not async. */
export function tempDirSync(prefix = "t-"): string {
  mkdirSync(TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TMP_ROOT, prefix));
  created.push(dir);
  return dir;
}

/** Removes every directory this module created for the current test file. */
export function cleanupTempDirs(): void {
  while (created.length) {
    try {
      rmSync(created.pop()!, { recursive: true, force: true });
    } catch {
      // Best effort: a locked directory (Windows, a socket still closing) is
      // not a test failure, and the next run creates its own.
    }
  }
}
