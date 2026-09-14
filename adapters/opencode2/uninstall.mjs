#!/usr/bin/env node
// Removes the opencode2 plugin. The inverse of install.mjs.
//
// Both candidate directories are checked, not just the one install.mjs would
// pick right now. install.mjs chooses between the project-local
// `.opencode/plugins` and the user-global `~/.config/opencode/plugins` by
// looking for a `.opencode` directory in the *current* directory. That is what
// makes the global candidate worth carrying: an install that ran outside a
// project went to the global path, and an uninstall run later from inside a
// project would otherwise compute the project-local path, find nothing there,
// and report success with the real file still in place.
//
// The project-local path is not recoverable the same way — it depends on a cwd
// that is not recorded anywhere — so a file installed from one directory is only
// found when uninstall runs from that same directory. The paths checked are
// printed when there is nothing to remove, so the answer is never a bare "fine".
// Only files carrying our marker are ever removed, so checking both is safe.
import { join } from "node:path";
import { homedir } from "node:os";
import { removeInstalledFile } from "../shared/install-common.mjs";

const local = join(process.cwd(), ".opencode", "plugins", "quick-titles.ts");
const global = join(homedir(), ".config", "opencode", "plugins", "quick-titles.ts");

process.exit(removeInstalledFile([local, global], "opencode2 plugin"));
