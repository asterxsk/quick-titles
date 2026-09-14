import { homedir, platform } from "node:os";
import { join } from "node:path";

const APP = "quick-titles";

/** Read an environment override for a filesystem path.
 *
 *  An unset, empty, or all-whitespace value means "no override" and falls
 *  through to the platform default: `" "` is not a path, but it is truthy, so
 *  an unguarded read turns it into a path relative to whatever cwd the host
 *  happens to have. A value that has any non-whitespace content is returned
 *  verbatim — leading and trailing spaces are legal in unix paths, so trimming
 *  a real value would corrupt it. Only the all-whitespace case is discarded. */
export function envPathOverride(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return undefined;
  return value;
}

function baseDataDir(): string {
  const home = homedir();
  switch (platform()) {
    case "win32":
      return envPathOverride("LOCALAPPDATA") ?? join(home, "AppData", "Local");
    case "darwin":
      return join(home, "Library", "Application Support");
    default:
      return envPathOverride("XDG_DATA_HOME") ?? join(home, ".local", "share");
  }
}

/** The one rule for where quick-titles keeps state. CLAUDE_PLUGIN_DATA is the
 *  Claude Code plugin host's own directory and takes precedence; every consumer
 *  (hooks, daemon, client, adapters) must resolve through here rather than
 *  re-reading the variables, or the title store and the prompt counter drift. */
export function dataDir(): string {
  return (
    envPathOverride("CLAUDE_PLUGIN_DATA") ??
    envPathOverride("QUICK_TITLES_DATA_DIR") ??
    join(baseDataDir(), APP)
  );
}

export function cacheDir(): string {
  return join(dataDir(), "cache");
}

export function modelsDir(): string {
  return join(dataDir(), "models");
}

/** The model file quick-titles loads. A data directory holds exactly one model,
 *  and provisioning, the daemon, the client's "is anything provisioned?" check,
 *  and `doctor` must all agree on its name — three copies of the literal is how
 *  a directory ends up with a model the daemon will not look for. */
export const MODEL_FILE = "title-q8_0.gguf";

/** The model the daemon loads. `QT_MODEL` overrides it wholesale, which is what
 *  lets a test or a sideloaded model run without touching the data directory.
 *
 *  Routed through `envPathOverride` deliberately: a plain nullish check treats
 *  `QT_MODEL=""` as an override and resolves the model to the empty path, so an
 *  exported-but-empty variable silently disables titles. Empty and
 *  all-whitespace are "unset" here for the same reason they are everywhere else
 *  in this file. */
export function modelPath(): string {
  return envPathOverride("QT_MODEL") ?? join(modelsDir(), MODEL_FILE);
}

export function storeFile(): string {
  return join(dataDir(), "titles.jsonl");
}

export function pidFile(): string {
  return join(dataDir(), "daemon.pid");
}

/** Unix domain socket on macOS/Linux, named pipe on Windows.
 *
 *  The override is checked first and is not merely a test affordance: on win32
 *  the pipe name is a machine-wide constant, so without it two data directories
 *  on one machine would fight over a single pipe and a test could not point the
 *  client somewhere inert. */
export function socketPath(): string {
  const override = envPathOverride("QUICK_TITLES_SOCKET");
  if (override !== undefined) return override;
  if (platform() === "win32") return `\\\\.\\pipe\\${APP}`;
  return join(dataDir(), "daemon.sock");
}
