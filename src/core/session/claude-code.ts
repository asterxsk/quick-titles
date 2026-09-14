import type { SessionReader } from "./types.js";
import { mustRead } from "./clip.js";

interface Line {
  type?: string;
  message?: { content?: unknown };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export const claudeCodeReader: SessionReader = {
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
      if (parsed.type !== "user" && parsed.type !== "assistant") continue;
      const text = textOf(parsed.message?.content).trim();
      if (text) turns.push(`${parsed.type}: ${text}`);
    }
    return turns.join("\n");
  },

  isDefaultTitle(title) {
    return title.trim() === "";
  },
};
