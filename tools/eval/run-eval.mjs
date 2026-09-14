// Task 3 model quality gate.
//
// Runs the 40-transcript corpus (tools/eval/transcripts.jsonl) through the
// SHIPPING engine — `TitleEngine` from src/core/inference.ts — and writes
// tools/eval/results.json.
//
// The first version of this harness hand-rolled its own LlamaChatSession and
// measured a path that does not ship. That mattered: it re-used one context
// sequence across all 40 rows, and every row after about the tenth collapsed to
// the byte-identical string `Audit of Claude Code workflow`. It also could not
// see the retry-and-reject policy that now sits in the shipping path, so its
// counters would have missed exactly the failures the gate exists to catch.
// Driving the real engine removes both problems: this measures what users get.
//
// The prompt itself is pinned by tests/../tools/verify-gguf.mjs, which asserts
// the GGUF's embedded chat template is byte-identical to assets/chat_template.jinja,
// and by src/core/prompt.ts, which hash-pins both vendored assets at import.

import { readFileSync, writeFileSync } from "node:fs";
import { TitleEngine } from "../../dist/core/inference.js";

const MODEL = process.env.QT_MODEL || new URL("../../.probe/title-q8_0.gguf", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const rows = readFileSync(new URL("./transcripts.jsonl", import.meta.url), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

// Every raw response, so a refusal can be told apart from a guard that fired on
// a good title. Without this a rejected row records `title: null` and nothing
// else, which is indistinguishable from a bug in the rejection policy.
const raws = [];
const engine = await TitleEngine.create({
  modelPath: MODEL,
  timeoutMs: 60_000,
  onRaw: (raw, { penalised }) => raws.push({ penalised, raw }),
});
console.log(`backend: ${engine.backend}`);

const out = [];
for (const row of rows) {
  const started = Date.now();
  let parsed = { title: null, description: null };
  let error = null;
  raws.length = 0;
  try {
    ({ result: parsed } = await engine.generate(row.clip));
  } catch (err) {
    error = err.message;
  }
  const ms = Date.now() - started;
  out.push({ id: row.id, source: row.source, ms, error, parsed, raws: [...raws] });
  console.error(`${row.id}\t${String(ms).padStart(6)}ms\t${JSON.stringify(parsed.title)}`);
}

await engine.dispose();
writeFileSync(new URL("./results.json", import.meta.url), JSON.stringify(out, null, 2));

const titled = out.filter((r) => r.parsed.title);
const wordCounts = titled.map((r) => r.parsed.title.split(/\s+/).length);
const inRange = wordCounts.filter((n) => n >= 3 && n <= 8).length;
const withDesc = out.filter((r) => r.parsed.description).length;
const completeDesc = out.filter(
  (r) => r.parsed.description && /[.!?]\s*$/.test(r.parsed.description)
).length;
const med = out.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(out.length / 2)];

console.log("titled:         %d/%d", titled.length, out.length);
console.log("3-8 words:      %d/%d", inRange, titled.length);
console.log("with DESC:      %d", withDesc);
console.log("DESC complete:  %d", completeDesc);
console.log("median ms:      %d", med);
console.log("errors:         %d", out.filter((r) => r.error).length);
const rejected = out.filter((r) => !r.parsed.title && !r.error);
console.log("rejected:       %d  (%s)", rejected.length, rejected.map((r) => r.id).join(", "));
