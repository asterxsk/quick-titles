import type { AgentId } from "../types.js";
import type { SessionReader } from "./types.js";
import { claudeCodeReader } from "./claude-code.js";
import { codexReader } from "./codex.js";
import { opencode2Reader } from "./opencode2.js";
import { piReader } from "./pi.js";
import { toClip } from "./clip.js";

const READERS: Record<AgentId, SessionReader> = {
  "claude-code": claudeCodeReader,
  codex: codexReader,
  opencode2: opencode2Reader,
  pi: piReader,
};

export async function readClip(agent: AgentId, transcriptPath: string): Promise<string> {
  return toClip(await READERS[agent].read(transcriptPath));
}

export function isDefaultTitle(agent: AgentId, title: string): boolean {
  return READERS[agent].isDefaultTitle(title);
}
