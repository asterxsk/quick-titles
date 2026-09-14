export type AgentId = "claude-code" | "codex" | "opencode2" | "pi";

export const AGENT_IDS: readonly AgentId[] = ["claude-code", "codex", "opencode2", "pi"];

/** One generated title. Appended to the JSONL store; last record per
 *  (agent, sessionId) wins. */
export interface TitleRecord {
  agent: AgentId;
  sessionId: string;
  title: string;
  description: string | null;
  /** Which inference backend served this: "metal" | "cuda" | "vulkan" | "cpu" */
  backend: string;
  /** Model identifier, e.g. "title-q8_0@v0.1.0" */
  modelVersion: string;
  /** ISO8601 */
  createdAt: string;
}

export interface GenerateRequest {
  agent: AgentId;
  sessionId: string;
  transcriptPath: string;
}

export interface GenerateResult {
  title: string;
  description: string | null;
}

export function isAgentId(value: string): value is AgentId {
  return (AGENT_IDS as readonly string[]).includes(value);
}
