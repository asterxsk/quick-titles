#!/usr/bin/env node
// Removes the Pi extension. The inverse of install.mjs.
//
// The directory comes from the same resolver install.mjs uses, imported rather
// than reimplemented — the SDK owns that rule, and a second copy of it would be
// free to drift. Importing is safe because install.mjs only runs its main() when
// it is the program being executed, not when it is imported.
//
// The default location is checked as well, for the case where
// PI_CODING_AGENT_DIR was *unset* when the extension was installed and is set
// now: the resolver answers with the variable's directory, nothing is there, and
// the real file sits in the default one. (The reverse — installed into a custom
// directory, uninstalled with the variable unset — is not recoverable, because
// the directory that was used is recorded nowhere. The paths checked are printed
// when there is nothing to remove.)
import { join } from "node:path";
import { homedir } from "node:os";
import { removeInstalledFile } from "../shared/install-common.mjs";
import { resolveAgentDir } from "./install.mjs";

const resolved = join(await resolveAgentDir(), "extensions", "quick-titles.ts");
const fallback = join(homedir(), ".pi", "agent", "extensions", "quick-titles.ts");

process.exit(removeInstalledFile([resolved, fallback], "Pi extension"));
