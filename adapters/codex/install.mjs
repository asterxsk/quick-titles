#!/usr/bin/env node
// Registers quick-titles as a Codex notify callback. `notify` is
// fire-and-forget and carries no trust gate, unlike Codex hooks which require a
// trusted_hash the user must approve (D30).
//
// `notify` is a single-valued key, so this refuses to clobber an existing
// notifier rather than silently replacing it.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
// A real TOML parser, not a regex. The guard below used to be
// /^\s*notify\s*=/m, which is wrong in both directions: it matches a `notify =`
// line *inside* a triple-quoted or literal string (refusing to install on a
// config that has no notify key), and it misses a quoted root key
// `"notify" = [...]` (prepending a second notify, which TOML forbids, leaving
// the user's config invalid so Codex will not start). smol-toml is a zero-
// dependency parser, so the whole decision is made on the parsed document.
import { parse } from "smol-toml";

const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
const configPath = join(codexHome, "config.toml");
const here = dirname(fileURLToPath(import.meta.url));
const notifyScript = resolve(here, "notify.mjs");

// JSON.stringify produces a valid TOML inline array: both escape backslashes and
// quotes the same way, which matters because the node and checkout paths are
// full of backslashes on Windows. A raw template write would emit `\P`, `\n`
// and friends and make config.toml unparseable.
const entry = `notify = ${JSON.stringify([process.execPath, notifyScript])}`;

mkdirSync(codexHome, { recursive: true });
// The exact bytes we read, kept in memory so a failed verification can restore
// the file rather than re-emitting a parse tree that drops comments.
const original = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";

const BOM = String.fromCharCode(0xfeff); // byte-order mark
// smol-toml rejects a leading BOM, so strip it for the parser only; the write
// path re-attaches it so the user's file keeps its byte-order mark.
function parseConfig(text) {
  return parse(text.startsWith(BOM) ? text.slice(1) : text);
}

// Decide from the parsed document whether a root `notify` key exists. A quoted
// root key (`"notify"` / `'notify'`) parses to the same `notify` property as a
// bare key, so this catches the duplicate the regex missed; a `notify =` line
// inside a string is just string content and does not appear as a key, so this
// no longer refuses a config that has none. If the file does not parse we
// refuse and change nothing: "fixing" a config we cannot read risks destroying.
let before;
try {
  before = parseConfig(original);
} catch (err) {
  console.error(`quick-titles: ${configPath} is not valid TOML; leaving it untouched`);
  console.error(`  ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

if (Object.prototype.hasOwnProperty.call(before, "notify")) {
  console.error("quick-titles: a notify entry already exists in config.toml; leaving it alone");
  console.error(`Add this manually if you want quick-titles:\n  ${entry}`);
  process.exit(1);
}

// TOML is not order-free: a bare key written after a table header belongs to
// that table until the next header. Appending `notify` at end-of-file therefore
// nested it inside the final table whenever config.toml ends with one — exactly
// the shape of the real ~/.codex/config.toml, whose last line is a
// `trusted_hash` under [hooks.state."…"]. The notifier then never registers and
// the hooks table is polluted.
//
// The key goes at the *top*, before all other content. A bare key with nothing
// above it is a root key by definition, so this needs no scan for the first
// table header — and scanning was itself a defect. The first fix here inserted
// before /^[ \t]*\[/m, which also matches a line that merely begins with `[`
// inside a multi-line string or a nested array:
//
//     description = """
//     [not a table]
//     """
//
// Inserting there puts `notify` inside a string value: it does not register,
// and the same silent no-op returns. Prepending cannot be wrong about scope,
// because there is nothing above it to be inside of. A parse-and-re-emit would
// also be correct but would discard the user's comments and formatting, so
// insertion is the smaller change.
const bom = original.startsWith(BOM) ? BOM : "";
const next = `${bom}${entry}\n${original.slice(bom.length)}`;
writeFileSync(configPath, next, "utf8");

// RE-PARSE the result before declaring success. The write is trusted only if
// the parsed document shows our root notify array exactly *and* every other
// key, table and value is unchanged. On any failure the original bytes go back
// and we exit non-zero — the user's config is never left corrupted.
let verified = false;
try {
  const after = parseConfig(next);
  const withoutNotify = (o) => {
    const copy = { ...o };
    delete copy.notify;
    return copy;
  };
  verified =
    isDeepStrictEqual(after.notify, [process.execPath, notifyScript]) &&
    isDeepStrictEqual(withoutNotify(after), withoutNotify(before));
} catch {
  verified = false;
}

if (!verified) {
  writeFileSync(configPath, original, "utf8");
  console.error("quick-titles: post-write verification failed; restored config.toml unchanged");
  process.exit(1);
}

console.log(`quick-titles: wrote notify entry to ${configPath}`);
