// Regression tests for the failure modes the Task 3 quality gate found on real
// transcripts. Every rejected title here is one the model actually produced;
// none of them is hypothetical.
import { describe, expect, it, vi } from "vitest";
import {
  copiesClipOpening,
  echoesRun,
  isDegenerateRepetition,
  type ParsedTitle,
} from "../../src/core/parse.js";
import { INSTRUCTION } from "../../src/core/prompt.js";
import { isAcceptableTitle, titleWithRetry } from "../../src/core/inference.js";

describe("isDegenerateRepetition", () => {
  it("catches the token loop the gate produced on a Blender session", () => {
    expect(isDegenerateRepetition("Blender MCP MCP MCP MCP MCP MCP MCP")).toBe(true);
  });

  it("catches a loop with no leading word at all", () => {
    expect(isDegenerateRepetition("the the the the the")).toBe(true);
  });

  it("keeps a title that merely repeats a word once", () => {
    expect(isDegenerateRepetition("Fixing the the tests")).toBe(false);
    expect(isDegenerateRepetition("Fixing the tests")).toBe(false);
  });

  it("keeps a long title where one word is common but not dominant", () => {
    expect(isDegenerateRepetition("MCP server config for the MCP client")).toBe(false);
  });

  it("does not flag a title too short to be a loop", () => {
    expect(isDegenerateRepetition("MCP MCP")).toBe(false);
  });
});

describe("echoesRun", () => {
  it("catches the title that echoed our own instruction back", () => {
    expect(echoesRun("Write a factual title (3-8 words) and 1-2", INSTRUCTION)).toBe(true);
  });

  it("ignores punctuation and case when matching", () => {
    expect(echoesRun("write a FACTUAL title, 3–8 words!", INSTRUCTION)).toBe(true);
  });

  it("keeps a title that only shares a word or two", () => {
    expect(echoesRun("Rendering a 3D pose in Blender", INSTRUCTION)).toBe(false);
  });

  it("does not flag a run shorter than the minimum", () => {
    expect(echoesRun("Write a factual title", INSTRUCTION)).toBe(false);
  });
});

describe("copiesClipOpening", () => {
  const clip =
    "User: I have hunyuan installed (3d ai generated) and want to render a pose.\nAssistant: ...";

  it("catches the title lifted from the transcript's first line", () => {
    expect(copiesClipOpening("User: I have hunyuan installed (3d ai generated", clip)).toBe(true);
  });

  it("does not flag short titles, which collide by chance", () => {
    expect(copiesClipOpening("I have hunyuan", clip)).toBe(false);
  });

  it("keeps a title drawn from the middle of the passage", () => {
    // Regression, and the reason this check is a prefix test rather than a
    // substring search. The opencode2 session's user had literally asked for
    // "a custom plugin for opencode 2"; compressing that into a title is the
    // job, not a failure, and a substring search refused it.
    const oc =
      "User: Can you make a custom plugin for opencode 2 that configures skills, " +
      "to be user only, name only, or full in context?";
    expect(copiesClipOpening("Custom plugin for OpenCode 2", oc)).toBe(false);
  });

  it("requires a word boundary, not a partial word", () => {
    expect(copiesClipOpening("User: I have hunyuan installed", "User: I have hunyuan installedness")).toBe(
      false
    );
  });
});

const title = (t: string | null): ParsedTitle => ({ title: t, description: null });

describe("isAcceptableTitle", () => {
  const clip = "a transcript about wiring up an MCP server";

  it("accepts a specific title", () => {
    expect(isAcceptableTitle(title("Configure the MCP server"), clip)).toBe(true);
  });

  it("rejects the loop, the instruction echo and the transcript echo", () => {
    expect(isAcceptableTitle(title("MCP MCP MCP MCP MCP"), clip)).toBe(false);
    expect(isAcceptableTitle(title("Write a factual title (3-8 words) and 1-2"), clip)).toBe(false);
    expect(isAcceptableTitle(title("a transcript about wiring up an MCP server"), clip)).toBe(false);
  });

  it("rejects a missing title and a single word", () => {
    expect(isAcceptableTitle(title(null), clip)).toBe(false);
    expect(isAcceptableTitle(title("Refactoring"), clip)).toBe(false);
  });

  it("rejects a fragment of the transcript's own scaffolding", () => {
    // Shipped past every other guard on a real session: five words, nothing
    // repeated, no line of the passage — and unmistakably not a title.
    expect(isAcceptableTitle(title("Reviewer:*No visual feedback yet.*"), clip)).toBe(false);
    expect(isAcceptableTitle(title("<task-notification> build failed"), clip)).toBe(false);
  });

  it("accepts a backtick, which marks up a command name rather than scaffolding", () => {
    // This title was generated, thrown away, generated again, and thrown away
    // again on one of the forty real transcripts, because MARKUP used to include
    // a backtick. Both the "no title of ours contains one" premise and the
    // conclusion drawn from it ("refusing them costs nothing real") were wrong,
    // and the cost was a good title silently replaced by the host's own.
    //
    // The other four characters keep the guard's real job: the fragment above is
    // still caught, by its asterisks.
    expect(isAcceptableTitle(title("Running `npx fallow` and inspecting results"), clip)).toBe(true);
    // ...and a backtick does not make markup acceptable.
    expect(isAcceptableTitle(title("Running `npx fallow` | grep `<path>`"), clip)).toBe(false);
  });
});

describe("titleWithRetry", () => {
  it("returns the first attempt and never retries when it is usable", async () => {
    const run = vi.fn(async () => title("Fix the login redirect"));
    expect(await titleWithRetry(run, "clip")).toEqual({
      title: "Fix the login redirect",
      description: null,
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(false);
  });

  it("retries once with penalties when the first attempt is a loop", async () => {
    const run = vi
      .fn<(penalise: boolean) => Promise<ParsedTitle>>()
      .mockResolvedValueOnce(title("MCP MCP MCP MCP MCP"))
      .mockResolvedValueOnce(title("Configure the MCP server"));

    expect((await titleWithRetry(run, "clip")).title).toBe("Configure the MCP server");
    expect(run).toHaveBeenNthCalledWith(1, false);
    expect(run).toHaveBeenNthCalledWith(2, true);
  });

  it("returns no title at all when both attempts are unusable", async () => {
    const run = vi
      .fn<(penalise: boolean) => Promise<ParsedTitle>>()
      .mockResolvedValueOnce(title("Write a factual title (3-8 words) and 1-2"))
      .mockResolvedValueOnce(title("MCP MCP MCP MCP MCP"));

    expect(await titleWithRetry(run, "clip")).toEqual({ title: null, description: null });
    expect(run).toHaveBeenCalledTimes(2);
  });
});
