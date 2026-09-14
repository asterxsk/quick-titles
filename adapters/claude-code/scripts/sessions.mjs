#!/usr/bin/env node
// Backs the `/sessions` command: one listing of every title quick-titles has
// written, across all four hosts, with the description the host has nowhere to
// put.
//
// This reads the title store directly instead of asking the daemon over its
// socket, and that is a deliberate departure from the other adapters. The store
// is an append-only JSONL file, so reading it is a plain file read with no lock.
// The daemon, by contrast, is started lazily by a session's first prompt and
// `request()` does not spawn one — so at the moment a user types `/sessions` it
// may not be running, and going through the socket would print "No titles yet"
// over a store full of titles. A wrong answer that looks exactly like an empty
// one is the failure this project keeps finding; it is not worth reintroducing
// to save one file read.
import { loadDist, loadPaths } from "./lib.mjs";

const LIMIT = 20;

async function main() {
  let resources;
  try {
    resources = await Promise.all([
      loadPaths(),
      loadDist("core/store.js"),
      loadDist("cli/sessions.js"),
    ]);
  } catch (err) {
    // The only user-invoked entry point in this adapter, so it is the one that
    // has to fail legibly: a raw ERR_MODULE_NOT_FOUND tells a user nothing about
    // what to do, and the fix (build it) is a single command.
    console.error(`quick-titles: cannot load the built client - run \`npm run build\` (${err.message})`);
    process.exit(1);
  }

  const [{ storeFile }, { TitleStore }, { renderSessionList }] = resources;
  const records = await new TitleStore(storeFile()).list({ limit: LIMIT });
  process.stdout.write(renderSessionList(records) + "\n");
}

await main();
