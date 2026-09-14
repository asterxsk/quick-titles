#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  MARKER,
  exists as existsSync,
  requireBuiltClient,
} from "../shared/install-common.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dist = requireBuiltClient(import.meta.url);

// Project-local plugin dir if the cwd looks like an opencode2 project,
// otherwise the user-global one.
const target = existsSync(join(process.cwd(), ".opencode"))
  ? join(process.cwd(), ".opencode", "plugins")
  : join(homedir(), ".config", "opencode", "plugins");

mkdirSync(target, { recursive: true });

// The token sits inside a double-quoted string literal, so substitute the JSON
// encoding of the path: a raw Windows path would be read as escape sequences
// (`...\titles` would become a TAB) and corrupt the generated module.
const source = readFileSync(resolve(here, "plugin.ts"), "utf8");
const output = source.replaceAll('"__QUICK_TITLES_DIST__"', JSON.stringify(dist));
// MARKER first, so `uninstall` can tell a file we wrote from one the user wrote
// under the same name. See install-common.mjs.
writeFileSync(join(target, "quick-titles.ts"), `${MARKER}\n${output}`, "utf8");

console.log(`quick-titles: installed opencode2 plugin to ${join(target, "quick-titles.ts")}`);
