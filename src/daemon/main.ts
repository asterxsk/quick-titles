import { writeFile, unlink } from "node:fs/promises";
import { TitleEngine } from "../core/inference.js";
import { TitleStore } from "../core/store.js";
import { pidFile, socketPath, storeFile, modelPath } from "../paths.js";
import { startServer } from "./server.js";

// The pid file is written FIRST, before the model load, and that ordering is
// load-bearing rather than cosmetic.
//
// `ensureDaemon` has no other way to see a daemon that has been spawned but has
// not bound yet: it cannot ping a socket that does not exist, so a live pid is
// the only durable evidence that someone is already bringing one up. Writing the
// pid after `TitleEngine.create()` — which takes 4.8-5.6 s — means the entire
// model-load window is a state in which the daemon exists but is invisible,
// which is precisely the state `src/client.ts` step 2 describes as "a daemon
// exists but is still loading its model" and claims to handle.
//
// D35 recorded that window and closed most of it with a spawn lock and a
// re-ping; neither helps when the winner never answers, because a re-ping only
// detects a daemon that is *up*. A caller that then spawns loads the same model
// a second time, and on unix steals the first daemon's socket path (D53).
//
// A pid left behind by a daemon that dies during the load is harmless: nothing
// trusts the file on its own, and `processAlive()` is what decides.
await writeFile(pidFile(), String(process.pid), "utf8");

const engine = await TitleEngine.create({ modelPath: modelPath(), contextSequences: 2 });
const store = new TitleStore(storeFile());
const { close } = await startServer({ socketPath: socketPath(), engine, store });

console.log(`quick-titles daemon listening on ${socketPath()} (backend: ${engine.backend})`);
console.log("Powered by Desert Ant Labs");

const shutdown = async () => {
  await close().catch(() => {});
  await engine.dispose().catch(() => {});
  if (process.platform !== "win32") await unlink(pidFile()).catch(() => {});
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
