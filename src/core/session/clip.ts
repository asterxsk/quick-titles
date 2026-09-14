import { buildPrompt, MAX_CLIP_TOKENS } from "../prompt.js";

const CHAR_BUDGET = MAX_CLIP_TOKENS * 4;

/** Keeps the tail: the end of a session is where its topic has settled. */
export function toClip(text: string): string {
  return text.length > CHAR_BUDGET ? text.slice(-CHAR_BUDGET) : text;
}

export async function mustRead(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    throw new Error(`unreadable session: ${path}`, { cause });
  }
}
