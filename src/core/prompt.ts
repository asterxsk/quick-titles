import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, "..", "..", "assets");

export const MAX_CLIP_TOKENS = 2000;

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

export const TEMPLATE_SHA256 = "9524df67b77a7b25a2dfee898f75b316a157eb9d855b51e32aeac79d7c8a83ce";
export const INSTRUCTION_SHA256 = "8928323d4f8f74d6b2eb06bbf28028d84ebc8d3e153386718976396b384c294c";

const templateBytes = readFileSync(join(assets, "chat_template.jinja"));
const instructionBytes = readFileSync(join(assets, "instruction.txt"));

if (sha(templateBytes) !== TEMPLATE_SHA256) {
  throw new Error("assets/chat_template.jinja does not match the pinned hash; the vendored template was modified");
}
if (sha(instructionBytes) !== INSTRUCTION_SHA256) {
  throw new Error("assets/instruction.txt does not match the pinned hash; the vendored instruction was modified");
}

/** The trained instruction, verbatim. Exported so the engine can recognise the
 *  model echoing it back instead of answering — a documented failure mode that
 *  the quality gate observed on real input. */
export const INSTRUCTION = instructionBytes.toString("utf8").trim();

/** The vendored template, for binding an explicit JinjaTemplateChatWrapper.
 *  Exported so the engine prompts with these exact bytes rather than whatever
 *  a different node-llama-cpp version might auto-detect. */
export const CHAT_TEMPLATE = templateBytes.toString("utf8");

/** Rough token estimate. The clip is bounded in characters, not exact tokens:
 *  we would rather under-fill the context than pay for a tokenizer round trip
 *  on a hook's critical path. */
export function buildPrompt(clip: string): string {
  const maxChars = MAX_CLIP_TOKENS * 4;
  const bounded = clip.length > maxChars ? clip.slice(-maxChars) : clip;
  return `${INSTRUCTION}\n\nPASSAGE:\n${bounded.trim()}\n`;
}
