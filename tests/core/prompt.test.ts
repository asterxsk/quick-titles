// tests/core/prompt.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { buildPrompt, INSTRUCTION_SHA256, TEMPLATE_SHA256 } from "../../src/core/prompt.js";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("prompt", () => {
  it("pins the vendored template byte-for-byte", () => {
    const onDisk = sha(readFileSync("assets/chat_template.jinja"));
    expect(onDisk).toBe(TEMPLATE_SHA256);
  });

  it("pins the vendored instruction byte-for-byte", () => {
    const onDisk = sha(readFileSync("assets/instruction.txt"));
    expect(onDisk).toBe(INSTRUCTION_SHA256);
  });

  it("includes the clip and the instruction in the rendered prompt", () => {
    const out = buildPrompt("we refactored the auth middleware");
    expect(out).toContain("we refactored the auth middleware");
    expect(out.length).toBeGreaterThan(40);
  });

  it("truncates an over-long clip rather than blowing the context", () => {
    const huge = "word ".repeat(20000);
    const out = buildPrompt(huge);
    expect(out.length).toBeLessThan(huge.length);
  });

  it("labels the passage as the trained prompt does", () => {
    const out = buildPrompt("we refactored the auth middleware");
    expect(out).toContain("PASSAGE:");
  });
});
