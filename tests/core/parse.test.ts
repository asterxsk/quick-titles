// tests/core/parse.test.ts
import { describe, expect, it } from "vitest";
import { parseTitleOutput } from "../../src/core/parse.js";

describe("parseTitleOutput", () => {
  it("parses a well-formed response", () => {
    const out = parseTitleOutput("TITLE: Auth middleware refactor\nDESC: Reworked token expiry checks.");
    expect(out.title).toBe("Auth middleware refactor");
    expect(out.description).toBe("Reworked token expiry checks.");
  });

  it("parses the concatenated form the probe produced", () => {
    expect(parseTitleOutput("TITLE:Tomato planting").title).toBe("Tomato planting");
  });

  it("keeps the title when DESC is missing", () => {
    const out = parseTitleOutput("TITLE: Tomato planting");
    expect(out.title).toBe("Tomato planting");
    expect(out.description).toBeNull();
  });

  it("falls back to the first line when the model ignores the format", () => {
    const out = parseTitleOutput("Refactoring the auth middleware\nmore text");
    expect(out.title).toBe("Refactoring the auth middleware");
  });

  it("strips a terminal period from the title", () => {
    expect(parseTitleOutput("TITLE: Auth middleware refactor.").title).toBe("Auth middleware refactor");
  });

  it("caps the title at 8 words", () => {
    const out = parseTitleOutput("TITLE: one two three four five six seven eight nine ten");
    expect(out.title?.split(/\s+/).length).toBe(8);
  });

  it("drops a description opening with the known forbidden stock phrase", () => {
    const out = parseTitleOutput(
      "TITLE: Good title\nDESC: This text is about a refactor of the auth middleware."
    );
    expect(out.title).toBe("Good title");
    expect(out.description).toBe("Refactor of the auth middleware.");
  });

  it("returns nulls rather than throwing on garbage", () => {
    const out = parseTitleOutput("!!!");
    expect(out.title).toBeNull();
    expect(out.description).toBeNull();
  });

  it("returns nulls on empty input", () => {
    expect(parseTitleOutput("").title).toBeNull();
  });
});
