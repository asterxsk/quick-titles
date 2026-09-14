export interface ParsedTitle {
  title: string | null;
  description: string | null;
}

const MAX_TITLE_WORDS = 8;

/** The model card documents a known bug: descriptions sometimes open with a
 *  stock phrase the instruction explicitly forbids. */
const STOCK_PHRASES = [
  /^this text is about\s+(?:an?\s+|the\s+)?/i,
  /^this (?:passage|transcript|conversation) is about\s+(?:an?\s+|the\s+)?/i,
  /^the text is about\s+(?:an?\s+|the\s+)?/i,
];

function tidyTitle(value: string): string | null {
  const cleaned = value
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[.,;:]+$/, "")
    .trim();
  if (!cleaned) return null;
  if (!/\p{L}/u.test(cleaned)) return null;
  const words = cleaned.split(/\s+/);
  return (words.length > MAX_TITLE_WORDS ? words.slice(0, MAX_TITLE_WORDS) : words).join(" ");
}

function tidyDescription(value: string): string | null {
  let cleaned = value.trim();
  if (!cleaned) return null;
  for (const phrase of STOCK_PHRASES) cleaned = cleaned.replace(phrase, "");
  cleaned = cleaned.trim();
  if (cleaned) cleaned = cleaned[0].toUpperCase() + cleaned.slice(1);
  return cleaned || null;
}

function field(raw: string, label: string): string | null {
  const match = raw.match(new RegExp(`^\\s*${label}(?=\\s|:)\\s*:?\\s*(.*)$`, "im"));
  const value = match?.[1]?.trim();
  return value ? value : null;
}

/** True when a title is the same word over and over rather than a title.
 *
 *  The quality gate caught this on real input: one clip came back as
 *  `Blender MCP MCP MCP MCP MCP MCP MCP`, generated to the token cap. Greedy
 *  decoding makes it reproducible, and it passed every counter we had, because
 *  it is seven words long and contains letters. */
export function isDegenerateRepetition(title: string): boolean {
  const words = title.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < 4) return false;
  const counts = new Map<string, number>();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  const most = Math.max(...counts.values());
  // Four of one word is never a title; over half is a loop that has not
  // saturated yet but is heading there.
  return most >= 4 || most / words.length > 0.5;
}

const fold = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/** How many consecutive words must appear in the source, in order, before we
 *  call a title an echo.
 *
 *  Word *overlap* is the wrong test: a good title describes its passage, so it
 *  necessarily reuses that passage's vocabulary — `Claude Code status line
 *  schema and agent view` is a correct title for a transcript that contains
 *  every one of those words. Only a run of words in the source's own order is
 *  evidence that the model copied rather than summarised. */
const ECHO_MIN_RUN = 5;

/** True when the title reproduces a run of the source word-for-word.
 *
 *  Reserved for the *instruction* we sent, which is short, fixed, and never
 *  something a title should be drawn from — the gate caught
 *  `Write a factual title (3-8 words) and 1-2` as a title, which is the
 *  instruction itself coming back. Do not point this at a transcript: a model
 *  that compresses the user's own wording into a title is doing the job. */
export function echoesRun(title: string, source: string): boolean {
  const words = fold(title).split(" ");
  if (!source || words.length < ECHO_MIN_RUN) return false;

  const haystack = ` ${fold(source)} `;
  for (let i = 0; i + ECHO_MIN_RUN <= words.length; i++) {
    if (haystack.includes(` ${words.slice(i, i + ECHO_MIN_RUN).join(" ")} `)) return true;
  }
  return false;
}

/** True when the title is the transcript's own opening rather than a summary.
 *
 *  This is the other half of the documented echoing failure mode: the gate saw
 *  `User: I have hunyuan installed (3d ai generated` — the first line of the
 *  passage, complete with its role prefix.
 *
 *  Deliberately narrow. Matching anywhere in the clip was tried and rejected:
 *  it refused `Custom plugin for OpenCode 2` for a session whose user had asked
 *  for "a custom plugin for opencode 2", which is a good title, not an echo.
 *  Only the opening is diagnostic, because that is where a model that has given
 *  up on summarising starts copying. */
export function copiesClipOpening(title: string, clip: string): boolean {
  const folded = fold(title);
  if (!clip || folded.split(" ").length < ECHO_MIN_RUN) return false;
  const opening = fold(clip);
  return opening === folded || opening.startsWith(`${folded} `);
}

/** Never throws. A titler that breaks a session is worse than no titler. */
export function parseTitleOutput(raw: string): ParsedTitle {
  if (!raw || !raw.trim()) return { title: null, description: null };

  const title = tidyTitle(field(raw, "TITLE") ?? "");
  const description = tidyDescription(field(raw, "DESC") ?? field(raw, "DESCRIPTION") ?? "");

  if (title) return { title, description };

  // The model ignored the format. Better a rough title than none.
  const firstLine = raw.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  return { title: firstLine ? tidyTitle(firstLine) : null, description };
}
