import type { SessionReader } from "./types.js";
import { mustRead } from "./clip.js";

/** opencode2 writes this when its own titler has not run yet. */
const PLACEHOLDER = /^(New session|Child session) - \d{4}-\d{2}-\d{2}T[\d:.]+Z$/;

/** Interchange file written by the opencode2 adapter into the quick-titles cache
 *  directory before it calls generate — not a file opencode2 produces itself.
 *  opencode2's real transcript is SQLite (`~/.local/share/opencode/opencode.db`,
 *  tables `session_v2` + `session_message`), so the adapter materialises the
 *  conversation into this JSON shape to keep readClip storage-agnostic. */
interface File {
  session_v2?: { title?: string | null };
  messages?: { role?: string; content?: unknown }[];
}

export const opencode2Reader: SessionReader = {
  async read(transcriptPath) {
    const raw = await mustRead(transcriptPath);
    let parsed: File;
    try {
      parsed = JSON.parse(raw) as File;
    } catch {
      return "";
    }
    return (parsed.messages ?? [])
      .map((message) => {
        const text = typeof message.content === "string" ? message.content.trim() : "";
        return text ? `${message.role ?? "unknown"}: ${text}` : "";
      })
      .filter(Boolean)
      .join("\n");
  },

  isDefaultTitle(title) {
    const trimmed = title.trim();
    return trimmed === "" || PLACEHOLDER.test(trimmed);
  },
};
