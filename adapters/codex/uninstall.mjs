#!/usr/bin/env node
// Removes quick-titles' Codex notify callback. The inverse of install.mjs.
//
// No marker line is possible here: the registration lives inside a config file
// the user owns and edits, not in a file we wrote whole. Identity is therefore
// taken from the notify *script path* — the entry is ours only if it is a
// two-element array whose second element is this checkout's notify.mjs.
//
// Matching on process.execPath instead would be wrong: the node that ran the
// install is whatever `npx` happened to resolve, and it changes on every node
// upgrade (or on switching between system node and nvm). The script path is the
// half of the pair that belongs to us and does not move.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parse } from "smol-toml";

const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
const configPath = join(codexHome, "config.toml");
const here = dirname(fileURLToPath(import.meta.url));
const notifyScript = resolve(here, "notify.mjs");

// Not installed is the desired end state, so a missing config is success, not an
// error. Nothing is created here — uninstall never makes a file to delete.
if (!existsSync(configPath)) {
  console.log(`quick-titles: the Codex notifier is not installed (no ${configPath})`);
  process.exit(0);
}

const original = readFileSync(configPath, "utf8");
const BOM = String.fromCharCode(0xfeff); // byte-order mark
const bom = original.startsWith(BOM) ? BOM : "";
const body = original.slice(bom.length);

// Refuse to touch a config that does not parse: "repairing" one we cannot read
// risks destroying whatever it does say. Same rule as the installer.
let before;
try {
  before = parse(body);
} catch (err) {
  console.error(`quick-titles: ${configPath} is not valid TOML; leaving it untouched`);
  console.error(`  ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

if (!Object.prototype.hasOwnProperty.call(before, "notify")) {
  console.log(`quick-titles: the Codex notifier is not installed (no notify key in ${configPath})`);
  process.exit(0);
}

/** True if `value` is the notify pair this adapter installs, ignoring the node path. */
function isOurEntry(value) {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[1] === "string" &&
    resolve(value[1]) === notifyScript
  );
}

if (!isOurEntry(before.notify)) {
  console.error("quick-titles: a notify entry exists in config.toml but does not point at quick-titles");
  console.error(`  notify = ${JSON.stringify(before.notify)}`);
  console.error("quick-titles: leaving it alone; remove it yourself if it is yours to remove");
  process.exit(1);
}

// Line removal rather than parse-and-re-emit, because a re-emit would discard
// the user's comments and formatting. The installer always writes the pair as a
// single line, so one line is the whole key.
const lines = body.split("\n");
const index = lines.findIndex((line) => /^[ \t]*notify[ \t]*=/.test(line));
// A quoted root key (`"notify" = [...]`) parses to the same property but does not
// match the pattern above. splice(-1, 1) would then delete the file's *last*
// line — so refuse instead. Verification would catch it and restore, but only
// after having written a mangled config, and that is not a state to pass through.
if (index === -1) {
  console.error("quick-titles: found a notify key that is not written as a plain `notify =` line");
  console.error(`quick-titles: remove it from ${configPath} by hand`);
  process.exit(1);
}
// The pattern could also match a `notify =` line *inside* a multi-line string;
// the re-parse below is what proves it removed the real key and nothing else.
lines.splice(index, 1);
const next = `${bom}${lines.join("\n")}`;

// Re-parse and confirm both halves of the change: our key is gone, and every
// other key, table and value survived byte-for-byte. On any doubt the original
// goes back and the exit status is non-zero, so a run can never leave a config
// that is neither installed nor clean.
/** `object` with `key` removed, as a new object. */
function withoutKey(object, key) {
  const copy = { ...object };
  delete copy[key];
  return copy;
}

let verified = false;
try {
  const after = parse(next.slice(bom.length));
  verified =
    !Object.prototype.hasOwnProperty.call(after, "notify") &&
    isDeepStrictEqual(after, withoutKey(before, "notify"));
} catch {
  verified = false;
}

if (!verified) {
  writeFileSync(configPath, original, "utf8");
  console.error("quick-titles: post-removal verification failed; restored config.toml unchanged");
  process.exit(1);
}

writeFileSync(configPath, next, "utf8");
console.log(`quick-titles: removed the notify entry from ${configPath}`);
