// The `/sessions` listing. The description has no home in any host agent, so
// this view is the only place a user ever sees it — which makes the formatting
// the feature, not decoration on top of it.
import { describe, expect, it } from "vitest";
import { ATTRIBUTION, renderSessionList } from "../../src/cli/sessions.js";
import type { TitleRecord } from "../../src/core/types.js";

const rec = (over: Partial<TitleRecord> = {}): TitleRecord => ({
  agent: "claude-code",
  sessionId: "ses_abc",
  title: "Auth middleware refactor",
  description: "Reworked token expiry checks and added coverage.",
  backend: "vulkan",
  modelVersion: "title_q8_0@v0.1.0",
  createdAt: "2026-09-14T10:00:00.000Z",
  ...over,
});

describe("renderSessionList", () => {
  it("renders title and description", () => {
    const out = renderSessionList([rec()]);
    expect(out).toContain("Auth middleware refactor");
    expect(out).toContain("Reworked token expiry checks");
  });

  it("shows the agent, so one listing can span four hosts", () => {
    const out = renderSessionList([rec({ agent: "pi" }), rec({ agent: "codex" })]);
    expect(out).toContain("[pi]");
    expect(out).toContain("[codex]");
  });

  it("handles a null description", () => {
    const out = renderSessionList([rec({ description: null })]);
    expect(out).toContain("Auth middleware refactor");
    expect(out).not.toContain("null");
  });

  it("always includes the attribution line", () => {
    expect(renderSessionList([])).toContain("Powered by Desert Ant Labs");
    expect(ATTRIBUTION).toBe("Powered by Desert Ant Labs");
  });

  it("reports an empty list rather than printing nothing", () => {
    expect(renderSessionList([])).toMatch(/no titles yet/i);
  });

  it("labels the timestamp as UTC instead of implying local time", () => {
    // Stored as ISO8601 UTC. Printed bare, `2026-09-14 10:00` reads as the
    // reader's local time and is silently wrong by their UTC offset.
    const out = renderSessionList([rec()]);
    expect(out).toContain("2026-09-14 10:00 UTC");
  });
});
