// Assemble the Task 3 quality-gate corpus from this machine's real agent stores.
//
// Sources:
//   claude-code  20  ~/.claude/projects/*/*.jsonl
//   codex        10  ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
//   opencode2     5  ~/.local/share/opencode/opencode.db   (SQLite, node:sqlite)
//   pi            5  ~/.pi/agent/sessions/--*--/*.jsonl
//
// Output: tools/eval/transcripts.jsonl — one {"id","source","clip"} per line.
// Each clip is the first ~2000 tokens (character-bounded at 4 chars/token) of
// the conversation turns, after redaction. Redaction is applied on the way out,
// so the committed file is safe to treat as public.

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "transcripts.jsonl");
const HOME = homedir();
const MAX_CHARS = 2000 * 4; // ~2000 tokens

// ---------------------------------------------------------------- redaction

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function redact(text) {
  let s = text;

  // 1. Home directory, any separator casing (/c/Users/x, C:\Users\x, C:/Users/x).
  const homeRe = new RegExp(
    HOME.split(/[\\/]/).map(escapeRe).join("[\\\\/]"),
    "gi",
  );
  s = s.replace(homeRe, "<home>");

  // 2. Remaining bare username.
  s = s.replace(/asterxsk/gi, "<user>");

  // 3. Secret-looking tokens.
  s = s
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, "Bearer <secret>")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, "<secret>")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "<secret>")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "<secret>")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "<secret>")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "<secret>")
    .replace(/\b(?:AIza|ya29\.)[A-Za-z0-9._-]{20,}/g, "<secret>")
    .replace(/\b(?=[A-Za-z0-9+]*[0-9])(?=[A-Za-z0-9+]*[A-Za-z])[A-Za-z0-9+]{50,}={0,2}\b/g, "<secret>");

  // 4. Emails (before hostnames, so the @ form wins).
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>");

  // 5. URLs down to their host.
  s = s.replace(/\bhttps?:\/\/[^\s<>"'`)\]]+/gi, (u) => {
    try {
      return new URL(u).hostname;
    } catch {
      return "<host>";
    }
  });

  // 6. Bare hostnames.
  s = s.replace(
    /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|io|dev|ai|app|co|sh|gg|me|info|xyz|cloud|run|vercel|local|internal|lan)\b/gi,
    "<host>",
  );

  // 7. Absolute paths (after home is gone).
  s = s
    .replace(/[A-Za-z]:[\\/][^\s"'<>|`]+/g, "<path>")
    .replace(/\/c\/[A-Za-z0-9_.-]+(?:[\\/][^\s"'<>|`]+)*/g, "<path>")
    .replace(/\/(?:home|Users|tmp|var|opt|etc|mnt|root)\/[^\s"'<>|`]+/g, "<path>");

  return s;
}

// ------------------------------------------------------------- turn parsing

function textOf(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p && (p.type === "text" || p.type === "input_text" || p.type === "output_text"))
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

const WRAPPER = /<(?:command-name|command-message|local-command-caveat|local-command-stdout)>/;

function clipFromTurns(turns) {
  const body = turns
    .filter((t) => t.text && t.text.length > 0 && !WRAPPER.test(t.text))
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`)
    .join("\n\n");
  return body.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").slice(0, MAX_CHARS).trim();
}

function readJsonl(file) {
  const out = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

function claudeTurns(file) {
  const turns = [];
  for (const row of readJsonl(file)) {
    if (row.type !== "user" && row.type !== "assistant") continue;
    if (row.isMeta) continue;
    const text = textOf(row.message?.content);
    if (text) turns.push({ role: row.type, text });
  }
  return turns;
}

// Harness scaffolding codex injects as a user turn (never the human's request).
const CODEX_SCAFFOLD =
  /^(?:<environment_context|<recommended_plugins|<permissions instructions|<in-app-browser-context|<turn_aborted|# AGENTS\.md instructions)/;

function codexTurns(file) {
  const turns = [];
  for (const row of readJsonl(file)) {
    if (row.type !== "response_item") continue;
    const p = row.payload;
    if (!p || p.type !== "message") continue;
    if (p.role !== "user" && p.role !== "assistant") continue; // skip developer/system
    const text = textOf(p.content);
    if (!text) continue;
    if (p.role === "user" && CODEX_SCAFFOLD.test(text.trimStart())) continue;
    turns.push({ role: p.role, text });
  }
  return turns;
}

function piTurns(file) {
  const turns = [];
  for (const row of readJsonl(file)) {
    if (row.type !== "message") continue; // skip session/model_change/thinking_level_change/custom_message
    const m = row.message;
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    const text = textOf(m.content);
    if (text) turns.push({ role: m.role, text });
  }
  return turns;
}

// ------------------------------------------------------------------ corpus

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

/** Round-robin across groups so the corpus spans projects rather than taking
 *  the twenty longest clips, which all come from one busy repo. */
function pickSpread(list, n, keyOf) {
  const byGroup = new Map();
  for (const it of list) {
    if (!byGroup.has(it.group)) byGroup.set(it.group, []);
    byGroup.get(it.group).push(it);
  }
  for (const arr of byGroup.values()) arr.sort((a, b) => keyOf(b) - keyOf(a));
  const groups = [...byGroup.keys()].sort((a, b) => keyOf(byGroup.get(b)[0]) - keyOf(byGroup.get(a)[0]));
  const picked = [];
  const seen = new Set();
  const key = (it) => it.clip.slice(0, 300);
  for (let round = 0; picked.length < n; round++) {
    let added = false;
    for (const g of groups) {
      const arr = byGroup.get(g);
      const it = arr[round];
      if (!it) continue;
      if (seen.has(key(it))) continue; // same prompt shared across sessions
      seen.add(key(it));
      picked.push(it);
      added = true;
      if (picked.length >= n) break;
    }
    if (!added) break;
  }
  return picked;
}

const rows = [];

// --- claude-code (20) ---
{
  const root = join(HOME, ".claude", "projects");
  const cands = [];
  for (const f of walk(root)) {
    if (!f.endsWith(".jsonl")) continue;
    const rel = f.slice(root.length + 1).split(/[\\/]/);
    const clip = clipFromTurns(claudeTurns(f));
    if (clip.length < 400) continue; // stillborn / meta-only sessions
    cands.push({ file: f, group: rel[0], clip });
  }
  const picked = pickSpread(cands, 20, (c) => c.clip.length);
  picked.forEach((c, i) => rows.push({ id: `cc-${String(i + 1).padStart(2, "0")}`, source: "claude-code", clip: c.clip }));
  console.error(`claude-code: ${cands.length} candidates, took ${picked.length} (${new Set(picked.map((p) => p.group)).size} projects)`);
}

// --- codex (10) ---
{
  const root = join(HOME, ".codex", "sessions");
  const cands = [];
  for (const f of walk(root)) {
    if (!f.endsWith(".jsonl")) continue;
    const clip = clipFromTurns(codexTurns(f));
    if (clip.length < 400) continue;
    cands.push({ file: f, group: dirname(f), clip });
  }
  const picked = [...cands].sort((a, b) => b.clip.length - a.clip.length).slice(0, 10);
  picked.forEach((c, i) => rows.push({ id: `codex-${String(i + 1).padStart(2, "0")}`, source: "codex", clip: c.clip }));
  console.error(`codex: ${cands.length} candidates, took ${picked.length}`);
}

// --- opencode2 (5) ---
{
  const dbfile = join(HOME, ".local", "share", "opencode", "opencode.db");
  const db = new DatabaseSync(dbfile, { readOnly: true });
  const sessions = db
    .prepare("select id, directory, tokens_input from session_v2 where tokens_input > 0 order by tokens_input desc limit 200")
    .all();
  const cands = [];
  for (const s of sessions) {
    const msgs = db
      .prepare("select type, data from session_message where session_id = ? order by seq")
      .all(s.id);
    const turns = [];
    for (const m of msgs) {
      let d;
      try {
        d = JSON.parse(m.data);
      } catch {
        continue;
      }
      if (m.type === "user" && typeof d.text === "string") turns.push({ role: "user", text: d.text });
      else if (m.type === "assistant") turns.push({ role: "assistant", text: textOf(d.content) });
    }
    const clip = clipFromTurns(turns);
    if (clip.length < 400) continue;
    cands.push({ group: s.directory || "?", clip });
  }
  db.close();
  const picked = pickSpread(cands, 5, (c) => c.clip.length);
  picked.forEach((c, i) => rows.push({ id: `oc-${String(i + 1).padStart(2, "0")}`, source: "opencode2", clip: c.clip }));
  console.error(`opencode2: ${cands.length} candidates, took ${picked.length}`);
}

// --- pi (5) ---
{
  const root = join(HOME, ".pi", "agent", "sessions");
  const cands = [];
  for (const f of walk(root)) {
    if (!f.endsWith(".jsonl")) continue;
    const clip = clipFromTurns(piTurns(f));
    if (clip.length < 400) continue;
    const rel = f.slice(root.length + 1).split(/[\\/]/);
    cands.push({ file: f, group: rel[0], clip });
  }
  const picked = pickSpread(cands, 5, (c) => c.clip.length);
  picked.forEach((c, i) => rows.push({ id: `pi-${String(i + 1).padStart(2, "0")}`, source: "pi", clip: c.clip }));
  console.error(`pi: ${cands.length} candidates, took ${picked.length}`);
}

// ------------------------------------------------------------- redact + write

if (process.env.QT_RAW) {
  writeFileSync(OUT + ".raw", rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.error("QT_RAW set: wrote UNREDACTED rows for inspection only; delete before committing");
  process.exit(0);
}

const redacted = rows.map((r) => ({ id: r.id, source: r.source, clip: redact(r.clip) }));
writeFileSync(OUT, redacted.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.error(`wrote ${redacted.length} rows -> ${OUT}`);
