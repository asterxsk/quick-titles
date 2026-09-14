// tests/core/inference.test.ts
import { describe, expect, it } from "vitest";
import { getLlama, LlamaChatSession } from "node-llama-cpp";
import { TitleEngine } from "../../src/core/inference.js";
import { buildPrompt } from "../../src/core/prompt.js";

const modelPath = process.env.QT_MODEL;
const maybe = modelPath ? describe : describe.skip;

maybe("TitleEngine", () => {
  it("loads with prebuilt binaries only and reports a backend", async () => {
    const engine = await TitleEngine.create({ modelPath: modelPath! });
    expect(["metal", "cuda", "vulkan", "cpu"]).toContain(engine.backend);
    await engine.dispose();
  }, 60_000);

  it("generates a title for a short clip", async () => {
    const engine = await TitleEngine.create({ modelPath: modelPath! });
    const { result } = await engine.generate(
      "user: we need to fix the token expiry check in the auth middleware\n" +
        "assistant: I'll change the comparison to use <= instead of <."
    );
    expect(result.title).toBeTruthy();
    await engine.dispose();
  }, 60_000);

  it("serves concurrent calls from one loaded model", async () => {
    const engine = await TitleEngine.create({ modelPath: modelPath!, contextSequences: 2 });
    const [a, b] = await Promise.all([
      engine.generate("user: refactor the parser\nassistant: done"),
      engine.generate("user: fix the docker build\nassistant: done"),
    ]);
    expect(a.result.title).toBeTruthy();
    expect(b.result.title).toBeTruthy();
    await engine.dispose();
  }, 60_000);

  it("renders the Granite chat template into the prompt", async () => {
    // The engine drives a LlamaChatSession per call; this test builds the same
    // session shape and inspects the prompt that session actually renders, to
    // prove the role markers from chat_template.jinja are applied.
    const llama = await getLlama({ gpu: "auto", build: "never", skipDownload: true });
    const model = await llama.loadModel({ modelPath: modelPath! });
    const context = await model.createContext({ sequences: 1 });
    const sequence = await context.getSequence();
    const session = new LlamaChatSession({ contextSequence: sequence });
    const { contextText } = session.chatWrapper.generateContextState({
      chatHistory: [...session.getChatHistory(), { type: "user", text: buildPrompt("user: hi\nassistant: hello") }],
    });
    const formatted = contextText.toString();
    expect(formatted).toContain("<|start_of_role|>user<|end_of_role|>");
    expect(formatted).toContain("<|end_of_text|>");
    session.dispose();
    sequence.dispose();
    await context.dispose();
    await model.dispose();
    await llama.dispose();
  }, 60_000);
});
