import type { SessionReader } from "./types.js";
import { mustRead } from "./clip.js";

interface Line {
  type?: string;
  payload?: { type?: string; role?: string; content?: unknown };
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

export const codexReader: SessionReader = {
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
      if (parsed.type !== "response_item") continue;
      const role = parsed.payload?.role;
      // Skip session scaffolding: real rollouts open with developer/system
      // response_items carrying <permissions instructions>, not conversation.
      if (role !== "user" && role !== "assistant") continue;
      const text = textOf(parsed.payload?.content).trim();
      if (text) turns.push(`${role}: ${text}`);
    }
    return turns.join("\n");
  },

  // Codex has no placeholder string: an untitled thread has name = null.
  isDefaultTitle(title) {
    return title.trim() === "";
  },
};
