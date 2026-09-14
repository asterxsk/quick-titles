import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "..", "..", "dist");

export async function readStdin() {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function loadClient() {
  // Dynamic import needs a URL, not an OS path: on Windows an absolute path like
  // `D:\...\client.js` is parsed as scheme "d:" and rejected with
  // ERR_UNSUPPORTED_ESM_URL_SCHEME. pathToFileURL is correct on every platform.
  return import(pathToFileURL(join(dist, "client.js")).href);
}

/** The compiled paths module, so hooks resolve state locations through the same
 *  rule the daemon and client do. Reading the environment directly here would
 *  create a second source of truth for "where does quick-titles keep state". */
export async function loadPaths() {
  return import(pathToFileURL(join(dist, "paths.js")).href);
}

/** Any compiled module under `dist`, named by its path relative to `dist` —
 *  e.g. "core/store.js". Same URL-not-path reasoning as loadClient(): a bare
 *  Windows path is read as a scheme and rejected. */
export async function loadDist(relativePath) {
  return import(pathToFileURL(join(dist, relativePath)).href);
}

export function emitTitle(eventName, title) {
  if (!title) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: eventName, sessionTitle: title },
    }) + "\n"
  );
}
