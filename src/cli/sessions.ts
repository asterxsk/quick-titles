import type { TitleRecord } from "../core/types.js";

/** The model is Desert Ant Labs' work under a source-available licence that
 *  requires attribution, so this line is a licence obligation rather than a
 *  courtesy, and it is emitted even when there is nothing else to emit.
 *  Exported so the adapter and its test name the same string. */
export const ATTRIBUTION = "Powered by Desert Ant Labs";

/** Timestamps are stored as ISO8601 UTC. Rendering one as a bare
 *  `2026-09-14 10:00` reads as local time and is wrong by the reader's UTC
 *  offset, so the zone is spelled out rather than dropped. */
function stamp(iso: string): string {
  return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

export function renderSessionList(records: TitleRecord[]): string {
  const lines: string[] = [];

  if (records.length === 0) {
    lines.push("No titles yet. Titles appear as you use your agents.");
  } else {
    for (const record of records) {
      lines.push(`${record.title}  [${record.agent}]  ${stamp(record.createdAt)}`);
      if (record.description) lines.push(`    ${record.description}`);
    }
  }

  lines.push("", ATTRIBUTION);
  return lines.join("\n");
}
