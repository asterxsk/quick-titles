import { describe, expect, it } from "vitest";
import { readClip, isDefaultTitle } from "../../src/core/session/index.js";

const fixtures = "tests/fixtures/sessions";

describe("readClip", () => {
  it.each([
    ["claude-code", `${fixtures}/claude-code.jsonl`],
    ["codex", `${fixtures}/codex.jsonl`],
    ["opencode2", `${fixtures}/opencode2.json`],
    ["pi", `${fixtures}/pi.jsonl`],
  ] as const)("extracts text for %s", async (agent, path) => {
    const clip = await readClip(agent, path);
    expect(clip.length).toBeGreaterThan(20);
  });

  it("throws a typed error when the file is missing", async () => {
    await expect(readClip("pi", `${fixtures}/nope.jsonl`)).rejects.toThrow(/unreadable session/);
  });

  it("returns an empty string rather than throwing on unparseable content", async () => {
    await expect(readClip("pi", "package.json")).resolves.toBe("");
  });
});

describe("isDefaultTitle", () => {
  it("detects opencode2 placeholders", () => {
    expect(isDefaultTitle("opencode2", "New session - 2026-09-14T10:00:00.000Z")).toBe(true);
    expect(isDefaultTitle("opencode2", "Child session - 2026-09-14T10:00:00.000Z")).toBe(true);
    expect(isDefaultTitle("opencode2", "Auth refactor")).toBe(false);
  });

  it("treats an empty title as default for every agent", () => {
    for (const agent of ["claude-code", "codex", "opencode2", "pi"] as const) {
      expect(isDefaultTitle(agent, "")).toBe(true);
    }
  });
});
