// tools/verify-gguf.mjs
// Fails loudly if the converted GGUF is not the architecture we expect.
//
// On the expected architecture: `desert-ant-labs/title` is a
// GraniteMoeHybridForCausalLM with all 28 layer_types set to "attention" and
// zero experts. llama.cpp's converter has an explicit branch for exactly that
// shape (conversion/granite.py, in GraniteHybridModel.__init__): when there are
// no SSM layers it rewrites the arch to GRANITE_MOE or GRANITE depending on
// whether experts are present. Zero experts therefore lands on `granite`, not
// `granitehybrid`, and that is correct rather than a degraded conversion.
//
// On the metadata shape: node-llama-cpp nests fileInfo.metadata by key prefix,
// so these live under metadata.general / metadata.tokenizer rather than at the
// top level.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { getLlama } from "node-llama-cpp";

const EXPECTED_ARCH = "granite";
const TEMPLATE_IN_ASSETS = "assets/chat_template.jinja";

const file = process.argv[2];
if (!file) {
  console.error("usage: node tools/verify-gguf.mjs <file.gguf>");
  process.exit(2);
}

const llama = await getLlama({ build: "never" });
const gguf = await llama.loadModel({ modelPath: file });

const metadata = gguf.fileInfo?.metadata ?? {};
const arch = gguf.architecture ?? metadata.general?.architecture;

console.log("architecture:", arch);
console.log("trainContextSize:", gguf.trainContextSize);
console.log("tokenizerModel:", metadata.tokenizer?.ggml?.model);
console.log("blockCount:", metadata.granite?.block_count, "embeddingLength:", metadata.granite?.embedding_length);

let failed = false;
const fail = (msg) => {
  console.error(`FATAL: ${msg}`);
  failed = true;
};

if (arch !== EXPECTED_ARCH) {
  fail(`expected ${EXPECTED_ARCH}, got ${arch}`);
}

const template = metadata.tokenizer?.chat_template;
if (typeof template !== "string" || template.length === 0) {
  fail("GGUF carries no chat template; the model cannot be prompted as trained");
} else {
  console.log("chat template present, %d chars", template.length);

  // The GGUF's template is what node-llama-cpp will actually prompt with, so it
  // must be byte-identical to the one we hash-pinned in Task 4. A mismatch means
  // the model would be served a prompt it was never trained on.
  const embedded = createHash("sha256").update(template, "utf8").digest("hex");
  const vendored = createHash("sha256").update(readFileSync(TEMPLATE_IN_ASSETS)).digest("hex");
  console.log("embedded template sha256:", embedded);
  if (embedded !== vendored) {
    fail(`embedded chat template does not match ${TEMPLATE_IN_ASSETS} (${vendored})`);
  } else {
    console.log("chat template matches %s byte-for-byte", TEMPLATE_IN_ASSETS);
  }
}

await gguf.dispose();
await llama.dispose();

if (failed) process.exit(1);
console.log("OK");
