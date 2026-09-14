import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentId, TitleRecord } from "./types.js";

/** Append-only JSONL. The description has no home in any host agent, so we keep
 *  our own store; titles are mirrored here too so one listing can span agents.
 *  Last record per (agent, sessionId) wins. */
export class TitleStore {
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async append(record: TitleRecord): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, JSON.stringify(record) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  async #readAll(): Promise<TitleRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      return [];
    }
    const latest = new Map<string, TitleRecord>();
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as TitleRecord;
        if (!record.agent || !record.sessionId) continue;
        latest.set(`${record.agent}\u0000${record.sessionId}`, record);
      } catch {
        // A corrupt line must never take the store down.
        continue;
      }
    }
    return [...latest.values()];
  }

  async get(agent: AgentId, sessionId: string): Promise<TitleRecord | null> {
    return (await this.#readAll()).find((r) => r.agent === agent && r.sessionId === sessionId) ?? null;
  }

  async list(opts: { agent?: AgentId; limit?: number } = {}): Promise<TitleRecord[]> {
    let records = await this.#readAll();
    if (opts.agent) records = records.filter((r) => r.agent === opts.agent);
    records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return opts.limit ? records.slice(0, opts.limit) : records;
  }
}
