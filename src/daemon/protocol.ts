import type { AgentId, GenerateResult } from "../core/types.js";

export type Request =
  | { id: string; method: "ping" }
  | { id: string; method: "status" }
  | { id: string; method: "shutdown" }
  | { id: string; method: "generate"; params: { agent: AgentId; sessionId: string; transcriptPath: string } }
  | { id: string; method: "list"; params?: { agent?: AgentId; limit?: number } };

export type Response =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string };

export const PROTOCOL_VERSION = 1;

export interface StatusResult {
  version: number;
  backend: string;
  modelVersion: string;
  pid: number;
  uptimeMs: number;
}
