#!/usr/bin/env node
// The user-facing entry point for quick-titles.
//
// Everything under adapters/ is normally invoked by a *host*, never by a person:
// Claude Code reads the hook script paths out of hooks.json, Codex runs
// notify.mjs from an argv array in config.toml, and the opencode2 and Pi loaders
// import their plugin modules directly. A user never types those paths. This
// file is the one command a human runs, and it exists so that the install
// commands printed in the README and docs actually resolve.
//
// It is deliberately dependency-free and stays in plain JavaScript: it has to
// run before anything is built, from an npx install, on a machine with nothing
// but Node.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const dist = join(root, "dist");

/** The agents quick-titles can install into, in the order they are documented. */
const AGENTS = ["claude-code", "codex", "opencode2", "pi"];

/** The attribution string the model's licence requires, verbatim.
 *
 *  Duplicated rather than imported, and that is deliberate: `--version` and
 *  `doctor` must both work from an unbuilt checkout, and importing it would mean
 *  loading `dist/`. `tests/cli.test.ts` asserts this equals the exported
 *  constant in `src/cli/sessions.ts`, so the two cannot drift apart silently. */
const ATTRIBUTION = "Powered by Desert Ant Labs";

function packageJson() {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
}

function usage() {
  const { version } = packageJson();
  process.stdout.write(
    `quick-titles ${version} — on-device session titles\n` +
      `\n` +
      `Usage\n` +
      `  quick-titles install <agent>   Install into a supported agent\n` +
      `  quick-titles uninstall [agent] Remove it again (default: every agent)\n` +
      `  quick-titles provision         Download the model, once, verified\n` +
      `  quick-titles model-build       Build the model here from the publisher's weights\n` +
      `                                 --guide explains the Windows route through WSL\n` +
      `  quick-titles sessions          List recent sessions with their titles\n` +
      `  quick-titles doctor            Report what is provisioned and what is running\n` +
      `  quick-titles --version         Print the version\n` +
      `  quick-titles --help            Print this message\n` +
      `\n` +
      `Agents\n` +
      `  claude-code   Claude Code (plugin)\n` +
      `  codex         Codex CLI (notify callback)\n` +
      `  opencode2     opencode2 beta (plugin)\n` +
      `  pi            Pi (extension)\n` +
      `\n` +
      `Installing never compiles anything: prebuilt llama.cpp binaries only.\n` +
      `Uninstalling removes only the files quick-titles itself wrote; the model\n` +
      `and your titles are left where they are.\n`
  );
}

// ---------------------------------------------------------------------------
// shared adapter plumbing
// ---------------------------------------------------------------------------

/** Writes `quick-titles: <message>` to stderr and returns 1. */
function refuse(message) {
  process.stderr.write(`quick-titles: ${message}\n`);
  return 1;
}

/** The tail `provision` and `model-build` both end on.
 *
 *  Shared because the two commands are the same shape from the user's side —
 *  a long fetch or a long build, then either a reason on stderr or a line on
 *  stdout — and reading two different renderings of the same outcome is a cost
 *  paid for nothing. `success` builds the line from the result. */
function report(result, success) {
  if (!result.ok) {
    process.stderr.write(`\nquick-titles: ${result.reason}\n`);
    return 1;
  }
  process.stdout.write(`${success(result)}\n`);
  return 0;
}

/** Runs `adapters/<agent>/<verb>.mjs` as a child process and returns its status.
 *
 *  install and uninstall are the same operation in opposite directions — build
 *  the path, run it, report what happened — so they share this.
 *
 *  The adapters resolve `dist/client.js` themselves and exit 1 with their own
 *  message when it is absent, so this does not pre-check the build: one place
 *  decides that, not two. */
function runAdapter(agent, verb) {
  const script = join(root, "adapters", agent, `${verb}.mjs`);
  if (!existsSync(script)) {
    return refuse(`${script} is missing; the package is incomplete`);
  }
  const result = spawnSync(process.execPath, [script], { stdio: "inherit" });
  if (result.error) {
    return refuse(`could not run ${script}: ${result.error.message}`);
  }
  return result.status ?? 1;
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

/** Runs `claude …`, inheriting stdio so any interactive prompt still works. */
function claudeCli(args) {
  return spawnSync("claude", args, { stdio: "inherit", shell: process.platform === "win32" });
}

/** Whether the `claude` CLI answers at all. */
function claudeAvailable() {
  const probe = spawnSync("claude", ["--version"], {
    stdio: "ignore",
    shell: process.platform === "win32",
  });
  return !probe.error && probe.status === 0;
}

/** Claude Code loads plugins through a marketplace, not by copying files into a
 *  directory, so this registers the package as a single-plugin marketplace and
 *  then installs from it. The manual equivalent is printed when the CLI is
 *  missing, because a user can still run those two commands themselves. */
function installClaudeCode() {
  const manual =
    `quick-titles is a Claude Code plugin. To install it, run:\n` +
    `\n` +
    `    claude plugin marketplace add ${root}\n` +
    `    claude plugin install quick-titles@quick-titles\n`;

  if (!claudeAvailable()) {
    process.stdout.write(manual);
    return 0;
  }

  const added = claudeCli(["plugin", "marketplace", "add", root]);
  if (added.status !== 0) {
    process.stderr.write(`\nquick-titles: adding the marketplace failed.\n\n${manual}`);
    return 1;
  }
  const installed = claudeCli(["plugin", "install", "quick-titles@quick-titles"]);
  if (installed.status !== 0) {
    process.stderr.write(
      `\nquick-titles: the marketplace was added but the install did not complete.\n` +
        `    claude plugin install quick-titles@quick-titles\n`
    );
    return 1;
  }
  return 0;
}

function install(agent) {
  if (!agent || !AGENTS.includes(agent)) {
    process.stderr.write(
      `quick-titles: ${agent ? `unknown agent "${agent}"` : "which agent?"}\n` +
        `Expected one of: ${AGENTS.join(", ")}\n`
    );
    return 1;
  }
  return agent === "claude-code" ? installClaudeCode() : runAdapter(agent, "install");
}

// ---------------------------------------------------------------------------
// uninstall
// ---------------------------------------------------------------------------

const MANUAL_UNINSTALL =
  `To remove the Claude Code plugin, run:\n` +
  `\n` +
  `    claude plugin uninstall quick-titles@quick-titles\n` +
  `    claude plugin marketplace remove quick-titles\n`;

/** Asks Claude Code a question whose answer is JSON, and picks a field out of
 *  it. Returns null when the CLI could not be asked or the answer did not
 *  parse — the caller treats that as "unknown", not as "absent". */
function claudeList(args, pick) {
  const result = spawnSync("claude", args, {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.error || result.status !== 0) return null;
  try {
    return pick(JSON.parse(result.stdout));
  } catch {
    return null;
  }
}

/** Whether the plugin is installed: true, false, or null when Claude Code could
 *  not be asked. Both questions are asked because either alone can miss it —
 *  a marketplace can be registered with the plugin not installed from it, and a
 *  plugin entry can outlive a marketplace removal that half-finished. */
function claudePluginInstalled() {
  const marketplaces = claudeList(["plugin", "marketplace", "list", "--json"], (list) =>
    list.map((entry) => entry.name)
  );
  const plugins = claudeList(["plugin", "list", "--json"], (list) =>
    list.map((entry) => entry.id)
  );
  if (marketplaces === null || plugins === null) return null;
  return marketplaces.includes("quick-titles") || plugins.includes("quick-titles@quick-titles");
}

/** Both removals, in the only order that leaves nothing dangling: the
 *  marketplace second, because removing it first leaves the plugin entry
 *  pointing at a source that no longer exists.
 *
 *  The status is decided by asking again rather than by reading the exit code,
 *  because `claude plugin marketplace remove` exits non-zero both when it fails
 *  and when there was nothing to remove. */
function removeClaudePlugin() {
  // Best effort, and its status is ignored for the same reason.
  claudeCli(["plugin", "uninstall", "quick-titles@quick-titles"]);
  const removed = claudeCli(["plugin", "marketplace", "remove", "quick-titles"]);
  if (removed.status === 0 || claudePluginInstalled() === false) return 0;
  process.stderr.write(`\nquick-titles: removing the marketplace failed.\n\n${MANUAL_UNINSTALL}`);
  return 1;
}

/** The inverse of installClaudeCode(). */
function uninstallClaudeCode() {
  if (!claudeAvailable()) {
    process.stdout.write(MANUAL_UNINSTALL);
    return 0;
  }
  // Ask before removing, rather than running `remove` and interpreting its
  // failure: returning 1 for "there was nothing to remove" would break the
  // property the rest of uninstall keeps — removing something that is not there
  // succeeds, because the end state is the one that was asked for. Unknown is
  // deliberately not treated as absent, so it falls through and tries anyway.
  if (claudePluginInstalled() === false) {
    process.stdout.write(`quick-titles: the Claude Code plugin is not installed\n`);
    return 0;
  }
  return removeClaudePlugin();
}

/** The agents a bare or `all` uninstall acts on, or null when `agent` names
 *  nothing that exists. */
function uninstallTargets(agent) {
  if (!agent || agent === "all") return AGENTS;
  return AGENTS.includes(agent) ? [agent] : null;
}

/** Removes one agent's installation, or every agent's when none is named. */
function uninstall(agent) {
  const targets = uninstallTargets(agent);
  if (!targets) {
    process.stderr.write(
      `quick-titles: unknown agent "${agent}"\n` +
        `Expected one of: ${AGENTS.join(", ")}, all\n`
    );
    return 1;
  }

  let status = 0;
  // Every agent is attempted even after one fails. Uninstalling is a cleanup
  // step, so stopping at the first refusal would leave the rest installed and
  // make the user run the command again to find that out.
  for (const name of targets) {
    if (uninstallOne(name) !== 0) status = 1;
  }
  return status;
}

function uninstallOne(agent) {
  return agent === "claude-code" ? uninstallClaudeCode() : runAdapter(agent, "uninstall");
}

// ---------------------------------------------------------------------------
// provision
// ---------------------------------------------------------------------------

/** Fetches the model once, verifying it before it is put in place.
 *
 *  Progress goes to stderr so that stdout stays a clean result stream: a caller
 *  that pipes `provision` somewhere gets the outcome, not a percentage bar. */
async function provision() {
  const { provisionModel, modelStatus } = await import(
    pathToFileURL(join(dist, "core", "provision.js")).href
  );

  const before = modelStatus();
  if (before.present) {
    process.stdout.write(
      `quick-titles: the model is already provisioned at ${before.path} (${bytes(before.bytes)})\n`
    );
    return 0;
  }

  process.stderr.write(`quick-titles: downloading the model to ${before.path}\n`);

  let lastDecile = -1;
  const result = await provisionModel({
    onProgress: (received, total) => {
      if (total === null) return;
      const decile = Math.floor((received / total) * 10);
      if (decile === lastDecile) return;
      lastDecile = decile;
      process.stderr.write(
        `  ${String(decile * 10).padStart(3)}%  ${bytes(received)} of ${bytes(total)}\n`
      );
    },
  });

  return report(
    result,
    (r) =>
      `quick-titles: provisioned ${r.path} (${bytes(r.bytes)})\n` +
      `Everything after this runs offline.`
  );
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** Reports the absolute path and, when it exists, what it is. */
function describeFile(path) {
  try {
    const info = statSync(path);
    return `${path}  (${bytes(info.size)})`;
  } catch {
    return `${path}  (absent)`;
  }
}

/** Counts lines in the title store without parsing them — the question here is
 *  only whether the file is there and whether it holds anything. */
function countLines(path) {
  try {
    const text = readFileSync(path, "utf8").trim();
    return text === "" ? 0 : text.split("\n").length;
  } catch {
    return null;
  }
}

function line(label, value) {
  process.stdout.write(`  ${label.padEnd(16)}${value}\n`);
}

async function doctor() {
  const { version } = packageJson();
  process.stdout.write(`quick-titles ${version} — doctor\n\n`);

  process.stdout.write(`runtime\n`);
  line("node", process.version);
  line("platform", `${process.platform} ${process.arch}`);

  if (!existsSync(join(dist, "paths.js"))) {
    process.stdout.write(
      `\n  dist/paths.js is missing, so the data directory cannot be resolved.\n` +
        `  This package was not built. From a source checkout:\n\n` +
        `      npm install && npm run build\n`
    );
    return 1;
  }

  // Imported from the build, not re-derived here: doctor must report the paths
  // the daemon and the hooks actually use, not a second opinion about them.
  const paths = await import(pathToFileURL(join(dist, "paths.js")).href);
  const dataDir = paths.dataDir();
  const modelFile = paths.modelPath();
  const store = paths.storeFile();

  process.stdout.write(`\nstate\n`);
  line("data directory", dataDir);
  line("socket", paths.socketPath());
  const titles = countLines(store);
  line("store", titles === null ? `${store}  (absent)` : `${store}  (${titles} title${titles === 1 ? "" : "s"})`);

  const model = await import(pathToFileURL(join(dist, "core", "provision.js")).href);
  const modelState = model.modelStatus();
  process.stdout.write(`\nmodel\n`);
  line("path", describeFile(modelFile));
  if (modelState.present) {
    line("status", "provisioned");
  } else if (process.env.QT_MODEL) {
    line("status", `QT_MODEL is set to ${process.env.QT_MODEL}, which does not exist`);
  } else {
    line("status", "NOT provisioned — titles will not be generated");
  }
  line("download source", modelState.sourceConfigured ? "configured" : "not configured");

  // A short timeout and no spawn: doctor reports, it does not start anything.
  const client = await import(pathToFileURL(join(dist, "client.js")).href);
  const status = await client.request({ method: "status" }, { timeoutMs: 1500 });

  process.stdout.write(`\ndaemon\n`);
  if (status) {
    line("status", "running");
    line("pid", String(status.pid));
    line("backend", status.backend);
    line("model", status.modelVersion);
    line("uptime", `${Math.round(status.uptimeMs / 1000)}s`);
  } else {
    line("status", "not running");
    line("note", "it starts on demand, and only once a model is provisioned");
  }

  process.stdout.write(`\n`);
  if (!modelState.present) {
    process.stdout.write(`The model is what makes titles appear, and it is not here yet.\n`);
    process.stdout.write(
      modelState.sourceConfigured
        ? `Run \`quick-titles provision\` to fetch it.\n`
        : `This build has no published weights URL. Convert desert-ant-labs/title and\n` +
            `point QT_MODEL at the result, or set QUICK_TITLES_MODEL_URL and\n` +
            `QUICK_TITLES_MODEL_SHA256 and run \`quick-titles provision\`.\n`
    );
    process.stdout.write(`\n${ATTRIBUTION}\n`);
    return 1;
  }
  process.stdout.write(`Provisioned and reachable. Titles will be generated on the next prompt.\n`);
  process.stdout.write(`\n${ATTRIBUTION}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

/** The listing the README documents, and the only place a description is ever
 *  read by a person: no host agent has a field to put one in.
 *
 *  It reads the title store directly instead of asking the daemon over its
 *  socket. The store is an append-only JSONL file, and the daemon is started
 *  lazily by a session's first prompt — so going through the socket would print
 *  "No titles yet" whenever the daemon happened not to be running, which is the
 *  wrong answer and indistinguishable from the right one. */
async function sessions() {
  if (!existsSync(join(dist, "cli", "sessions.js"))) {
    process.stderr.write(
      `quick-titles: dist/ is missing, so there is nothing to read titles with.\n` +
        `From a source checkout: npm run build\n`
    );
    return 1;
  }

  const [paths, store, render] = await Promise.all([
    import(pathToFileURL(join(dist, "paths.js")).href),
    import(pathToFileURL(join(dist, "core", "store.js")).href),
    import(pathToFileURL(join(dist, "cli", "sessions.js")).href),
  ]);

  const records = await new store.TitleStore(paths.storeFile()).list({ limit: 20 });
  process.stdout.write(render.renderSessionList(records) + "\n");
  return 0;
}

// ---------------------------------------------------------------------------
// model-build
// ---------------------------------------------------------------------------

/** The flag that turns the licence notice into a decision. Spelled out rather
 *  than accepted as `--yes`: this is the one command that asks the user to take
 *  a position on a licence clause, and `-y` implies it is a formality. */
const ACCEPT = "--accept-license";

/** The flag that prints the Windows route instead of trying to run it here.
 *
 *  A separate flag rather than a fallback on refusal: on Windows the refusal is
 *  certain, but a macOS user wanting to build for a Windows machine, or anyone
 *  who would rather drive it by hand, is asking the same question. It never
 *  builds and never asks for the licence, so it is safe to run first. */
const GUIDE = "--guide";

/** Converts the upstream weights into the GGUF quick-titles runs.
 *
 *  The order of the two checks matters. An already-provisioned model is
 *  reported before the notice is printed, because there is nothing to decide
 *  when there is nothing to build; and the notice is printed in full before the
 *  flag is honoured, so `--accept-license` is an answer to something the user
 *  was actually shown rather than a magic word they were told to type. */
async function modelBuild(args) {
  const prepared = await prepareModelBuild({ explainOnly: args.includes(GUIDE) });
  if (typeof prepared === "number") return prepared;

  const { build, workDir, python, llamaTag, dataDir } = prepared;

  // Before the notice, and instead of it. `--guide` builds nothing and asks for
  // nothing, so printing a licence notice the user is not being asked to accept
  // would be noise in front of the answer they came for.
  if (args.includes(GUIDE)) {
    process.stdout.write(build.wslGuide(dataDir) + "\n");
    return 0;
  }

  process.stdout.write(`quick-titles: building the model locally\n\n${build.licenseNotice()}\n`);

  if (!args.includes(ACCEPT)) {
    process.stdout.write(`\nRe-run with ${ACCEPT} to continue.\n`);
    return 1;
  }

  announceBuildStart(workDir);
  const result = await build.runModelBuild({
    workDir,
    python,
    llamaTag,
    platform: process.platform,
    arch: process.arch,
    onStep: announce,
  });

  return report(
    result,
    (r) =>
      `\nquick-titles: built ${r.path} (${bytes(r.bytes)})\n` +
      `Titles will be generated on your next prompt. ${ATTRIBUTION}.`
  );
}

/** Everything the build needs, or the status to exit with instead.
 *
 *  The two guards and the two environment defaults live here rather than in
 *  `modelBuild`, so that the command reads as the three things it does —
 *  explain the licence, take the answer, run the build.
 *
 *  `explainOnly` is `--guide`: the already-provisioned short-circuit is skipped,
 *  because a guide is not a request to build and "you already have a model" is
 *  not an answer to "how would I build one". The dist/ guard still applies —
 *  the guide is text that ships inside it. */
async function prepareModelBuild({ explainOnly = false } = {}) {
  if (!existsSync(join(dist, "core", "model-build.js"))) {
    process.stderr.write(
      `quick-titles: dist/ is missing, so there is nothing to build with.\n` +
        `From a source checkout: npm run build\n`
    );
    return 1;
  }

  const [build, paths, provision] = await Promise.all([
    import(pathToFileURL(join(dist, "core", "model-build.js")).href),
    import(pathToFileURL(join(dist, "paths.js")).href),
    import(pathToFileURL(join(dist, "core", "provision.js")).href),
  ]);

  if (!explainOnly && modelIsPresent(provision.modelStatus())) return 0;

  return {
    build,
    // Inside the data directory, deliberately: it is where the daemon already
    // looks and where `doctor` can report on it, and a rebuild that filled a
    // second location would be a second thing to clean up.
    workDir: join(paths.dataDir(), "build"),
    // Handed to `wslGuide`, which cannot compute it: this file resolves paths
    // for the platform Node is running on, and the guide exists precisely for
    // the case where the build happens on a different one.
    dataDir: paths.dataDir(),
    ...buildEnvironment(),
  };
}

/** The two values the build takes from the environment, defaulted.
 *
 *  `||` throughout, not `??`: an exported-but-empty variable is not a value
 *  here. `QUICK_TITLES_PYTHON=""` would resolve to the empty program name, and
 *  `QUICK_TITLES_LLAMA_TAG=""` would build a download URL ending in
 *  `llama--bin-`, and both would fail a long way from the cause. */
function buildEnvironment() {
  return {
    // `python3` on PATH, overridable because a machine can have several and the
    // one that can create a virtual environment is not always the default.
    python: process.env.QUICK_TITLES_PYTHON || "python3",
    llamaTag: process.env.QUICK_TITLES_LLAMA_TAG || undefined,
  };
}

/** Says so, and whether there is anything to do about it.
 *
 *  `provision` reports the same situation and stops. Here it is worth a
 *  separate sentence: rebuilding is possible, and the only thing standing in
 *  the way is a file the user has to delete themselves. */
function modelIsPresent(status) {
  if (!status.present) return false;
  process.stdout.write(
    `quick-titles: the model is already provisioned at ${status.path} (${bytes(status.bytes)})\n` +
      `Delete it first if you want to rebuild it.\n`
  );
  return true;
}

/** What the build costs, said before it starts rather than discovered. */
function announceBuildStart(workDir) {
  process.stdout.write(
    `\nAccepted. This takes roughly 10 to 20 minutes, and about 2 GB of disk\n` +
      `in ${workDir} while it runs. That directory is removed either way.\n`
  );
}

/** One line per step. The build is long and mostly someone else's output, and
 *  without this a stall and a working run look identical. */
function announce(step, index, total) {
  process.stdout.write(`\n[${index + 1}/${total}] ${step.title}\n`);
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case "install":
  case "i":
    process.exit(install(rest[0]));
    break;
  case "uninstall":
  case "u":
    // Unlike install, no argument means every agent: `install` with no argument
    // cannot guess which agent was meant, whereas "remove everything" is a
    // single unambiguous answer and the one someone typing bare `uninstall`
    // is asking for.
    process.exit(uninstall(rest[0]));
    break;
  case "provision":
    process.exit(await provision());
    break;
  case "model-build":
    process.exit(await modelBuild(rest));
    break;
  case "doctor":
    process.exit(await doctor());
    break;
  case "sessions":
    process.exit(await sessions());
    break;
  case "--version":
  case "-v":
  case "version":
    // Two lines by requirement, not by preference: the model's licence asks for
    // the attribution wherever the version is presented, and the version stays
    // on line 1 so `$(quick-titles --version | head -1)` still parses.
    process.stdout.write(`${packageJson().version}\n${ATTRIBUTION}\n`);
    break;
  case "--help":
  case "-h":
  case "help":
  case undefined:
    usage();
    break;
  default:
    process.stderr.write(`quick-titles: unknown command "${command}"\n\n`);
    usage();
    process.exit(1);
}
