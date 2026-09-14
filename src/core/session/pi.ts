import type { SessionReader } from "./types.js";
import { mustRead } from "./clip.js";

interface Line {
  type?: string;
  message?: { role?: string; content?: unknown };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && "text" in part
          ? String((part as { text: unknown }).text)
          : ""
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export const piReader: SessionReader = {
  async read(transcriptPath) {
    const raw = await mustRead(transcriptPath);
    const turns: string[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let parsed: Line;
      try {
        parsed = JSON.parse(line) as Line;
      } catch {
        continue;
      }
      // Skips the {"type":"session"} header and session_info entries.
      if (parsed.type !== "message") continue;
      const text = textOf(parsed.message?.content).trim();
      if (text) turns.push(`${parsed.message?.role ?? "unknown"}: ${text}`);
    }
    return turns.join("\n");
  },

  // Pi has no titler at all, so an unnamed session simply has an empty name.
  isDefaultTitle(title) {
    return title.trim() === "";
  },
};
