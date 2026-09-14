# quick-titles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate session titles and one-line descriptions locally, on-device, for Claude Code, Codex CLI, opencode2, and Pi — with no API call and no data leaving the machine.

**Architecture:** One resident daemon per machine holds the model in memory and serves requests over a local socket; thin per-agent adapters act as clients. The daemon exists because measured model load is 4.8–5.6 s and never gets faster when warm — per-invocation loading is not viable.

**Tech Stack:** TypeScript (ESM, Node 20+), `vitest`, `node-llama-cpp`, `net` for IPC, JSONL for the store, GitHub Actions (macOS) for model conversion.

**Spec:** `docs/specs/2026-09-14-quick-titles-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **Node >= 20.** ESM only. TypeScript `strict: true`.
- **Prebuilt binaries only.** `getLlama({ build: "never", skipDownload: true })`. Never compile from source, ever, on a user's machine.
- **Never block a user's prompt.** Any pass that exceeds its timeout is abandoned silently.
- **Never write a host agent's storage directly.** Adapters use documented APIs only. If an adapter cannot set a title, it no-ops.
- **Attribution string, verbatim:** `Powered by Desert Ant Labs`
- **Model id string, verbatim:** `title-q8_0@v0.1.0`
- **Ship precision: Q8_0.** Source is already 6-bit; f16 buys nothing, Q6_K double-quantises.
- **Prompt is immutable.** `chat_template.jinja` and the instruction string are vendored verbatim and hash-pinned. Do not reword, reformat, or "improve" them. The model card states a paraphrase is a different task.
- **No native dependencies** beyond `node-llama-cpp`. The store is JSONL, not SQLite.
- **Licence:** Desert Ant Labs Source-Available 1.0. Do not publish the GGUF as a standalone downloadable model. Fetch it inside the app only.

---

## Execution model (workflow-based ultracode)

This plan is written for `Workflow` dispatch, not sequential single-agent work.

**Phases and parallelism.** Tasks within a phase run concurrently. A phase begins only when
every task in the previous phase has passed review.

| Phase | Tasks | Parallel | Rationale |
|---|---|---|---|
| 1 | 1, 2 | 2 | Scaffold and the macOS conversion job are independent |
| 2 | 3 | 1 | **Hard gate.** Nothing else starts until model quality passes |
| 3 | 4, 5, 7, 8 | 4 | Pure functions + store; disjoint files |
| 4 | 6, 9, 10 | 1 (sequential) | 6 feeds 9; 9 feeds 10 |
| 5 | 11, 12, 13, 14 | 4 | One adapter per agent; strictly disjoint directories |
| 6 | 15, 16, 17 | 3 | Listing, provisioning, diagnostics |
| 7 | 18 | 1 | Packaging and publish |

**File ownership.** Parallel tasks must not write the same file. Ownership is declared per task
in its `Files:` block. A task that needs a change outside its ownership appends to
`docs/plan-deviations.md` instead of editing.

**Per-task protocol for each dispatched agent:**

1. Read this plan's `Global Constraints` and the spec.
2. Read the task's `Files:` and `Interfaces:` blocks. The task's `Produces` signatures are
   binding — later tasks import them verbatim.
3. Work the steps in order. Each step is one action.
4. Run the stated verification command. Paste actual output, not a description.
5. Commit at the end of the task with the given message.
6. Report: files changed, verification output, and any deviation.

**Phase-2 gate rule.** If Task 3 fails its quality threshold, **stop the workflow**. Do not
start Phase 3. Report the measured scores and the failing examples. The project's premise is
that the fine-tune is good at this task; if it is not, the correct response is to re-evaluate
the model, not to build adapters around it.

---

## Task 1: Repository scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `README.md`
- Create: `src/core/types.ts`
- Create: `src/paths.ts`
- Create: `tests/paths.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `src/core/types.ts` exporting `AgentId`, `TitleRecord`, `GenerateRequest`,
  `GenerateResult`; `src/paths.ts` exporting `dataDir()`, `cacheDir()`, `modelsDir()`,
  `socketPath()`, `pidFile()`, `storeFile()`

- [ ] **Step 1: Initialise the package**

```bash
cd /d/Apps/projects/titles
npm init -y
npm pkg set type=module
npm pkg set engines.node=">=20"
npm install --save-dev typescript vitest @types/node
npm install node-llama-cpp
```

- [ ] **Step 2: Write `tsconfig.json` and `vitest.config.ts`**

`vitest.config.ts` exists mostly to keep `spike/` out of the run:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
```

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Write `src/core/types.ts`**

```ts
export type AgentId = "claude-code" | "codex" | "opencode2" | "pi";

export const AGENT_IDS: readonly AgentId[] = ["claude-code", "codex", "opencode2", "pi"];

/** One generated title. Appended to the JSONL store; last record per
 *  (agent, sessionId) wins. */
export interface TitleRecord {
  agent: AgentId;
  sessionId: string;
  title: string;
  description: string | null;
  /** Which inference backend served this: "metal" | "cuda" | "vulkan" | "cpu" */
  backend: string;
  /** Model identifier, e.g. "title-q8_0@v0.1.0" */
  modelVersion: string;
  /** ISO8601 */
  createdAt: string;
}

export interface GenerateRequest {
  agent: AgentId;
  sessionId: string;
  transcriptPath: string;
}

export interface GenerateResult {
  title: string;
  description: string | null;
}

export function isAgentId(value: string): value is AgentId {
  return (AGENT_IDS as readonly string[]).includes(value);
}
```

- [ ] **Step 4: Write `src/paths.ts`**

```ts
import { homedir, platform } from "node:os";
import { join } from "node:path";

const APP = "quick-titles";

function baseDataDir(): string {
  const home = homedir();
  switch (platform()) {
    case "win32":
      return process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    case "darwin":
      return join(home, "Library", "Application Support");
    default:
      return process.env.XDG_DATA_HOME ?? join(home, ".local", "share");
  }
}

export function dataDir(): string {
  return process.env.QUICK_TITLES_DATA_DIR ?? join(baseDataDir(), APP);
}

export function cacheDir(): string {
  return join(dataDir(), "cache");
}

export function modelsDir(): string {
  return join(dataDir(), "models");
}

export function storeFile(): string {
  return join(dataDir(), "titles.jsonl");
}

export function pidFile(): string {
  return join(dataDir(), "daemon.pid");
}

/** Unix domain socket on macOS/Linux, named pipe on Windows. */
export function socketPath(): string {
  if (platform() === "win32") return `\\\\.\\pipe\\${APP}`;
  return join(dataDir(), "daemon.sock");
}
```

- [ ] **Step 5: Write `tests/paths.test.ts`**

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { dataDir, socketPath, storeFile } from "../src/paths.js";

describe("paths", () => {
  const original = process.env.QUICK_TITLES_DATA_DIR;

  beforeEach(() => {
    process.env.QUICK_TITLES_DATA_DIR = "/tmp/qt-test";
  });

  afterEach(() => {
    process.env.QUICK_TITLES_DATA_DIR = original;
  });

  it("honours the data dir override", () => {
    expect(dataDir()).toBe("/tmp/qt-test");
  });

  it("places the store inside the data dir", () => {
    expect(storeFile().startsWith(dataDir())).toBe(true);
  });

  it("returns a pipe path on win32 and a socket path elsewhere", () => {
    const p = socketPath();
    if (process.platform === "win32") {
      expect(p.startsWith("\\\\.\\pipe\\")).toBe(true);
    } else {
      expect(p.startsWith(dataDir())).toBe(true);
    }
  });
});
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/paths.test.ts`
Expected: 3 passed

- [ ] **Step 7: Write `.gitignore` and `README.md`**

`.gitignore`:

```
node_modules/
dist/
spike/
*.gguf
```

`README.md` must contain the attribution line verbatim:

```markdown
# quick-titles

Local, on-device session titles and descriptions for coding agents.

Powered by Desert Ant Labs — see https://huggingface.co/desert-ant-labs/title

The title model is licensed under the Desert Ant Labs Source-Available License 1.0.
```

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore README.md src/core/types.ts src/paths.ts tests/paths.test.ts
git commit -m "chore: scaffold quick-titles with types and platform paths"
```

---

## Task 2: Model conversion CI job

**Files:**
- Create: `.github/workflows/convert-model.yml`
- Create: `tools/verify-gguf.mjs`
- Create: `docs/model-pipeline.md`

**Interfaces:**
- Consumes: nothing
- Produces: a GitHub release asset `title-q8_0.gguf` plus `title-q8_0.gguf.sha256`;
  `docs/model-pipeline.md` recording the exact commands and the resulting SHA-256

- [ ] **Step 1: Write the conversion workflow**

```yaml
# .github/workflows/convert-model.yml
name: Convert title model to GGUF

on:
  workflow_dispatch:
  push:
    paths: ["tools/convert/**", ".github/workflows/convert-model.yml"]

jobs:
  convert:
    # MLX requires Apple silicon. macos-14 and later are arm64.
    runs-on: macos-14
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"

      - name: Install toolchain
        run: |
          python -m pip install --upgrade pip
          pip install mlx-lm huggingface_hub
          git clone --depth 1 https://github.com/ggml-org/llama.cpp.git
          pip install -r llama.cpp/requirements.txt

      - name: Fetch the MLX weights
        run: |
          huggingface-cli download desert-ant-labs/title \
            --local-dir mlx-model

      - name: Verify the weights really are 6-bit affine group 64
        run: |
          python - <<'PY'
          import json, sys
          cfg = json.load(open("mlx-model/config.json"))
          q = cfg.get("quantization") or cfg.get("quantization_config") or {}
          print("quantization:", q)
          assert q.get("bits") == 6, f"expected 6-bit, got {q.get('bits')}"
          assert q.get("group_size") == 64, f"expected group 64, got {q.get('group_size')}"
          PY

      - name: Dequantise 6-bit MLX back to bf16 safetensors
        run: |
          mlx_lm.convert --hf-path mlx-model --mlx-path title-bf16 \
            --dequantize --dtype bfloat16

      - name: Convert to GGUF f16
        run: |
          python llama.cpp/convert_hf_to_gguf.py title-bf16 \
            --outfile title-f16.gguf --outtype f16

      - name: Quantise to Q8_0
        run: |
          cmake -S llama.cpp -B llama.cpp/build -DLLAMA_CURL=OFF
          cmake --build llama.cpp/build --config Release -j --target llama-quantize
          ./llama.cpp/build/bin/llama-quantize title-f16.gguf title-q8_0.gguf Q8_0

      - name: Check the GGUF is loadable and is granitehybrid
        run: node tools/verify-gguf.mjs title-q8_0.gguf

      - name: Checksum
        run: shasum -a 256 title-q8_0.gguf | tee title-q8_0.gguf.sha256

      - uses: actions/upload-artifact@v4
        with:
          name: title-q8_0
          path: |
            title-q8_0.gguf
            title-q8_0.gguf.sha256
```

- [ ] **Step 2: Write `tools/verify-gguf.mjs`**

This runs inside the workflow after `npm ci`, so it may use `node-llama-cpp`.

```js
// tools/verify-gguf.mjs
// Fails loudly if the converted GGUF is not the architecture we expect.
import { getLlama } from "node-llama-cpp";

const file = process.argv[2];
if (!file) {
  console.error("usage: node tools/verify-gguf.mjs <file.gguf>");
  process.exit(2);
}

const llama = await getLlama({ build: "never" });
const gguf = await llama.loadModel({ modelPath: file });

const arch = gguf.fileInfo?.metadata?.["general.architecture"];
console.log("architecture:", arch);
console.log("trainContextSize:", gguf.trainContextSize);
console.log("tokenizerModel:", gguf.tokenizerModel);

if (arch !== "granitehybrid") {
  console.error(`FATAL: expected granitehybrid, got ${arch}`);
  process.exit(1);
}

const template = gguf.fileInfo?.metadata?.["tokenizer.chat_template"];
if (typeof template !== "string" || template.length === 0) {
  console.error("FATAL: GGUF carries no chat template; the model cannot be prompted as trained");
  process.exit(1);
}
console.log("chat template present, %d chars", template.length);

await gguf.dispose();
await llama.dispose();
console.log("OK");
```

- [ ] **Step 3: Trigger the workflow and record the result**

Run: `gh workflow run convert-model.yml && gh run watch`
Expected: green; artifact `title-q8_0` produced.

Then record in `docs/model-pipeline.md`: the commit SHA converted, the exact commands, the
artifact size, and the full SHA-256. Later tasks pin against this value.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/convert-model.yml tools/verify-gguf.mjs docs/model-pipeline.md
git commit -m "feat: convert title model from MLX 6-bit to Q8_0 GGUF on macOS CI"
```

---

## Task 3: Model quality gate — **HARD GATE**

**Files:**
- Create: `tools/eval/transcripts.jsonl`
- Create: `tools/eval/run-eval.mjs`
- Create: `tools/eval/score.md`
- Create: `tests/eval/thresholds.json`

**Interfaces:**
- Consumes: `title-q8_0.gguf` from Task 2
- Produces: `tools/eval/score.md` with measured scores; `tests/eval/thresholds.json` pinning
  the baseline so later tasks can detect regressions

**This task decides whether the project continues.** The model card publishes no benchmarks and
no independent review, and the only quality evidence we have is a probe of the *base* model,
which failed the task outright. Measure before building.

- [ ] **Step 1: Assemble 40 real transcripts**

```bash
mkdir -p tools/eval
# Pull 40 real transcripts from this machine's agents. Must span:
#  - 20 Claude Code sessions from ~/.claude/projects/*/*.jsonl
#  - 10 Codex rollouts from ~/.codex/sessions/YYYY/MM/DD/*.jsonl
#  - 5 opencode2 sessions from ~/.local/share/opencode/opencode.db (session_v2.message)
#  - 5 Pi sessions from ~/.pi/agent/sessions/--*--/*.jsonl
# Each record: {"id","source","clip"}
# Write the FIRST 2000 tokens of each, not the whole session.
```

Write one JSON object per line to `tools/eval/transcripts.jsonl`. Redact anything sensitive
before committing — these are real sessions.

- [ ] **Step 2: Write `tools/eval/run-eval.mjs`**

```js
// tools/eval/run-eval.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { getLlama } from "node-llama-cpp";
import { buildPrompt } from "../../dist/core/prompt.js";
import { parseTitleOutput } from "../../dist/core/parse.js";

const llama = await getLlama({ build: "never" });
const model = await llama.loadModel({ modelPath: process.env.QT_MODEL });
const context = await model.createContext({ sequences: 2 });

const rows = readFileSync("tools/eval/transcripts.jsonl", "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));

const out = [];
for (const row of rows) {
  const session = await context.getSequence();
  const started = Date.now();
  const result = await session.prompt(buildPrompt(row.clip), { maxTokens: 64, temperature: 0 });
  session.dispose();
  out.push({
    id: row.id,
    source: row.source,
    ms: Date.now() - started,
    raw: result.trim(),
    parsed: parseTitleOutput(result),
  });
}

writeFileSync("tools/eval/results.json", JSON.stringify(out, null, 2));

const titled = out.filter((r) => r.parsed.title).length;
const wordCounts = out.filter((r) => r.parsed.title).map((r) => r.parsed.title.split(/\s+/).length);
const inRange = wordCounts.filter((n) => n >= 3 && n <= 8).length;

console.log("titled:      %d/%d", titled, out.length);
console.log("3-8 words:   %d/%d", inRange, titled);
console.log("median ms:   %d", out.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(out.length / 2)]);
console.log("with DESC:   %d", out.filter((r) => r.parsed.description).length);
```

- [ ] **Step 3: Run it and read the output yourself**

Run: `QT_MODEL=<path>/title-q8_0.gguf npm run build && node tools/eval/run-eval.mjs`
Expected: prints the four counters. **Open `tools/eval/results.json` and read all 40 titles.**

The counters are necessary but not sufficient. A model can produce 3–8 word strings that are
generic, wrong, or echo the transcript. Human judgement on the 40 titles is the actual test.

- [ ] **Step 4: Record the verdict in `tools/eval/score.md`**

State plainly: the four counters, your own assessment of the 40 titles, and at least three
titles quoted verbatim as representative. If quality is poor, say so and stop the workflow.

- [ ] **Step 5: Pin thresholds — only if quality is acceptable**

```json
{
  "titledRatio": 0.9,
  "inRangeRatio": 0.8,
  "descRatio": 0.6,
  "medianMs": 1500
}
```

Write to `tests/eval/thresholds.json`, set slightly below the measured values so the gate
catches regressions without failing on noise.

- [ ] **Step 6: Commit**

```bash
git add tools/eval tests/eval/thresholds.json
git commit -m "test: add model quality gate with 40-transcript eval set"
```

---

## Task 4: Prompt construction

**Files:**
- Create: `src/core/prompt.ts`
- Create: `assets/chat_template.jinja`
- Create: `assets/instruction.txt`
- Create: `tests/core/prompt.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `src/core/prompt.ts` exporting `buildPrompt(clip: string): string`,
  `INSTRUCTION_SHA256: string`, `TEMPLATE_SHA256: string`, `MAX_CLIP_TOKENS: number`

- [ ] **Step 1: Vendor the chat template and instruction verbatim**

```bash
curl -L -o assets/chat_template.jinja \
  https://huggingface.co/desert-ant-labs/title/raw/main/chat_template.jinja
```

For `assets/instruction.txt`: retrieve `Titles.prompt` from the Desert Ant SDK docs
(`desert-ant-core/docs/models/title.md`). If the SDK docs are unreachable, determine the
instruction empirically — run Task 3's eval with candidate phrasings and keep the one that
reproduces the trained behaviour. Record whichever path you took in the commit message.

Do not reword either file. Copy them byte-for-byte.

- [ ] **Step 2: Write the failing test**

```ts
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
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/core/prompt.test.ts`
Expected: FAIL — cannot resolve `../../src/core/prompt.js`

- [ ] **Step 4: Write `src/core/prompt.ts`**

```ts
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, "..", "..", "assets");

export const MAX_CLIP_TOKENS = 2000;

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const templateBytes = readFileSync(join(assets, "chat_template.jinja"));
const instructionBytes = readFileSync(join(assets, "instruction.txt"));

export const TEMPLATE_SHA256 = sha(templateBytes);
export const INSTRUCTION_SHA256 = sha(instructionBytes);

const INSTRUCTION = instructionBytes.toString("utf8").trim();

/** Rough token estimate. The clip is bounded in characters, not exact tokens:
 *  we would rather under-fill the context than pay for a tokenizer round trip
 *  on a hook's critical path. */
export function buildPrompt(clip: string): string {
  const maxChars = MAX_CLIP_TOKENS * 4;
  const bounded = clip.length > maxChars ? clip.slice(-maxChars) : clip;
  return `${INSTRUCTION}\n\n${bounded.trim()}\n`;
}
```

`buildPrompt` takes the tail of the clip, not the head — the end of a session is where its
topic has settled.

- [ ] **Step 5: Run the tests and make them pass**

Run: `npx vitest run tests/core/prompt.test.ts`
Expected: 4 passed

If the hash assertions fail, the vendored file does not match the constant. Fix the constant by
copying the real hash from the failure output — but only after confirming the file on disk is a
byte-exact copy of the upstream file.

- [ ] **Step 6: Commit**

```bash
git add src/core/prompt.ts assets/ tests/core/prompt.test.ts
git commit -m "feat: build prompts from vendored, hash-pinned template and instruction"
```

---

## Task 5: Output parsing

**Files:**
- Create: `src/core/parse.ts`
- Create: `tests/core/parse.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `src/core/parse.ts` exporting
  `parseTitleOutput(raw: string): { title: string | null; description: string | null }`

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/core/parse.test.ts`
Expected: FAIL — cannot resolve `../../src/core/parse.js`

- [ ] **Step 3: Write `src/core/parse.ts`**

```ts
export interface ParsedTitle {
  title: string | null;
  description: string | null;
}

const MAX_TITLE_WORDS = 8;

/** The model card documents a known bug: descriptions sometimes open with a
 *  stock phrase the instruction explicitly forbids. */
const STOCK_PHRASES = [
  /^this text is about\s+/i,
  /^this (?:passage|transcript|conversation) is about\s+/i,
  /^the text is about\s+/i,
];

function tidyTitle(value: string): string | null {
  const cleaned = value
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[.,;:]+$/, "")
    .trim();
  if (!cleaned) return null;
  const words = cleaned.split(/\s+/);
  return (words.length > MAX_TITLE_WORDS ? words.slice(0, MAX_TITLE_WORDS) : words).join(" ");
}

function tidyDescription(value: string): string | null {
  let cleaned = value.trim();
  if (!cleaned) return null;
  for (const phrase of STOCK_PHRASES) cleaned = cleaned.replace(phrase, "");
  cleaned = cleaned.trim();
  if (cleaned) cleaned = cleaned[0].toUpperCase() + cleaned.slice(1);
  return cleaned || null;
}

function field(raw: string, label: string): string | null {
  const match = raw.match(new RegExp(`^\\s*${label}\\s*:?\\s*(.*)$`, "im"));
  const value = match?.[1]?.trim();
  return value ? value : null;
}

/** Never throws. A titler that breaks a session is worse than no titler. */
export function parseTitleOutput(raw: string): ParsedTitle {
  if (!raw || !raw.trim()) return { title: null, description: null };

  const title = tidyTitle(field(raw, "TITLE") ?? "");
  const description = tidyDescription(field(raw, "DESC") ?? "");

  if (title) return { title, description };

  // The model ignored the format. Better a rough title than none.
  const firstLine = raw.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  return { title: firstLine ? tidyTitle(firstLine) : null, description };
}
```

Note the ordering in the fallback: `field(raw, "TITLE")` runs first, so the echoed-transcript
failure the probe hit still yields a plausible first line.

- [ ] **Step 4: Run the tests and make them pass**

Run: `npx vitest run tests/core/parse.test.ts`
Expected: 9 passed

- [ ] **Step 5: Commit**

```bash
git add src/core/parse.ts tests/core/parse.test.ts
git commit -m "feat: lenient TITLE/DESC parser that degrades instead of throwing"
```

---

## Task 6: Inference wrapper

**Files:**
- Create: `src/core/inference.ts`
- Create: `tests/core/inference.test.ts`

**Interfaces:**
- Consumes: `buildPrompt` from Task 4, `parseTitleOutput` from Task 5
- Produces: `src/core/inference.ts` exporting
  `class TitleEngine { static async create(opts: TitleEngineOptions): Promise<TitleEngine>; generate(clip: string): Promise<{ result: ParsedTitle; backend: string }>; dispose(): Promise<void> }`
  and `interface TitleEngineOptions { modelPath: string; contextSequences?: number }`

- [ ] **Step 1: Write the failing test**

The engine is exercised against a real GGUF, so this test is skipped unless `QT_MODEL` is set.

```ts
// tests/core/inference.test.ts
import { describe, expect, it } from "vitest";
import { TitleEngine } from "../../src/core/inference.js";

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
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `QT_MODEL=./title-q8_0.gguf npx vitest run tests/core/inference.test.ts`
Expected: FAIL — cannot resolve `../../src/core/inference.js`

- [ ] **Step 3: Write `src/core/inference.ts`**

```ts
import { getLlama, type Llama, type LlamaModel, type LlamaContext } from "node-llama-cpp";
import { buildPrompt } from "./prompt.js";
import { parseTitleOutput, type ParsedTitle } from "./parse.js";

export interface TitleEngineOptions {
  modelPath: string;
  /** Concurrent generations. The probe hit "No sequences left" with the
   *  default of 1. */
  contextSequences?: number;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export class TitleEngine {
  readonly backend: string;
  #llama: Llama;
  #model: LlamaModel;
  #context: LlamaContext;
  #timeoutMs: number;

  private constructor(
    llama: Llama,
    model: LlamaModel,
    context: LlamaContext,
    backend: string,
    timeoutMs: number
  ) {
    this.#llama = llama;
    this.#model = model;
    this.#context = context;
    this.backend = backend;
    this.#timeoutMs = timeoutMs;
  }

  static async create(opts: TitleEngineOptions): Promise<TitleEngine> {
    // Prebuilt binaries only. build:"never" plus skipDownload:true means
    // node-llama-cpp can never decide to compile llama.cpp from source, which
    // on a user's machine would take up to an hour.
    const llama = await getLlama({ gpu: "auto", build: "never", skipDownload: true });
    const model = await llama.loadModel({ modelPath: opts.modelPath });
    const context = await model.createContext({
      sequences: opts.contextSequences ?? 1,
    });
    return new TitleEngine(
      llama,
      model,
      context,
      String(llama.gpu ?? "cpu"),
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    );
  }

  async generate(clip: string): Promise<{ result: ParsedTitle; backend: string }> {
    const sequence = await this.#context.getSequence();
    try {
      const raw = await Promise.race([
        sequence.prompt(buildPrompt(clip), { maxTokens: 64, temperature: 0 }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("inference timeout")), this.#timeoutMs)
        ),
      ]);
      return { result: parseTitleOutput(String(raw)), backend: this.backend };
    } finally {
      sequence.dispose();
    }
  }

  async dispose(): Promise<void> {
    await this.#context.dispose();
    await this.#model.dispose();
    await this.#llama.dispose();
  }
}
```

- [ ] **Step 4: Run the tests and make them pass**

Run: `QT_MODEL=./title-q8_0.gguf npx vitest run tests/core/inference.test.ts`
Expected: 3 passed

If `getLlama` throws `NoBinaryFoundError`, that is the prebuilt-only policy working correctly —
record the platform and skip. Do **not** relax `build: "never"` to make a test pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/inference.ts tests/core/inference.test.ts
git commit -m "feat: resident inference engine using prebuilt binaries only"
```

---

## Task 7: Session readers and clip building

**Files:**
- Create: `src/core/session/types.ts`
- Create: `src/core/session/clip.ts`
- Create: `src/core/session/claude-code.ts`
- Create: `src/core/session/codex.ts`
- Create: `src/core/session/opencode2.ts`
- Create: `src/core/session/pi.ts`
- Create: `src/core/session/index.ts`
- Create: `tests/core/session.test.ts`
- Create: `tests/fixtures/sessions/*`

**Interfaces:**
- Consumes: `AgentId` from Task 1
- Produces: `src/core/session/index.ts` exporting
  `readClip(agent: AgentId, transcriptPath: string): Promise<string>`,
  `isDefaultTitle(agent: AgentId, title: string): boolean`

- [ ] **Step 1: Write fixture files**

Create one small fixture per agent under `tests/fixtures/sessions/`, each a real-shaped but
synthetic session of 3–5 turns:

- `claude-code.jsonl` — lines with `{"type":"user","message":{"content":"..."}}` and
  `{"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}`
- `codex.jsonl` — lines with `{"timestamp","ordinal","type":"response_item","payload":{...}}`
- `opencode2.json` — `{"session_v2":{"title":"New session - 2026-09-14T10:00:00.000Z"}}` plus a
  `messages` array of `{"role","content"}`
- `pi.jsonl` — a header `{"type":"session",...}` then `{"type":"message","role","content"}`
  lines

- [ ] **Step 2: Write the failing test**

```ts
// tests/core/session.test.ts
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/core/session.test.ts`
Expected: FAIL — cannot resolve `../../src/core/session/index.js`

- [ ] **Step 4: Write the readers**

`src/core/session/types.ts`:

```ts
export interface SessionReader {
  /** Extracts plain conversation text. Returns "" rather than throwing when the
   *  content is not a session we recognise. */
  read(transcriptPath: string): Promise<string>;
  /** True when the title is a host-generated placeholder, i.e. ours to replace. */
  isDefaultTitle(title: string): boolean;
}
```

`src/core/session/clip.ts`:

```ts
import { buildPrompt, MAX_CLIP_TOKENS } from "../prompt.js";

const CHAR_BUDGET = MAX_CLIP_TOKENS * 4;

/** Keeps the tail: the end of a session is where its topic has settled. */
export function toClip(text: string): string {
  return text.length > CHAR_BUDGET ? text.slice(-CHAR_BUDGET) : text;
}

export async function mustRead(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    throw new Error(`unreadable session: ${path}`, { cause });
  }
}
```

`src/core/session/claude-code.ts`:

```ts
import type { SessionReader } from "./types.js";
import { mustRead } from "./clip.js";

interface Line {
  type?: string;
  message?: { content?: unknown };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export const claudeCodeReader: SessionReader = {
  async read(transcriptPath) {
    const raw = await mustRead(transcriptPath);
    const turns: string[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let parsed: Line;
      try {
        parsed = JSON.parse(line) as Line;
      } catch {
        continue;
      }
      if (parsed.type !== "user" && parsed.type !== "assistant") continue;
      const text = textOf(parsed.message?.content).trim();
      if (text) turns.push(`${parsed.type}: ${text}`);
    }
    return turns.join("\n");
  },

  isDefaultTitle(title) {
    return title.trim() === "";
  },
};
```

`src/core/session/codex.ts`:

```ts
import type { SessionReader } from "./types.js";
import { mustRead } from "./clip.js";

interface Line {
  type?: string;
  payload?: { type?: string; role?: string; content?: unknown };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && "text" in part
          ? String((part as { text: unknown }).text)
          : ""
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export const codexReader: SessionReader = {
  async read(transcriptPath) {
    const raw = await mustRead(transcriptPath);
    const turns: string[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let parsed: Line;
      try {
        parsed = JSON.parse(line) as Line;
      } catch {
        continue;
      }
      if (parsed.type !== "response_item") continue;
      const text = textOf(parsed.payload?.content).trim();
      if (text) turns.push(`${parsed.payload?.role ?? "item"}: ${text}`);
    }
    return turns.join("\n");
  },

  // Codex has no placeholder string: an untitled thread has name = null.
  isDefaultTitle(title) {
    return title.trim() === "";
  },
};
```

`src/core/session/opencode2.ts`:

```ts
import type { SessionReader } from "./types.js";
import { mustRead } from "./clip.js";

/** opencode2 writes this when its own titler has not run yet. */
const PLACEHOLDER = /^(New session|Child session) - \d{4}-\d{2}-\d{2}T[\d:.]+Z$/;

interface File {
  session_v2?: { title?: string | null };
  messages?: { role?: string; content?: unknown }[];
}

export const opencode2Reader: SessionReader = {
  async read(transcriptPath) {
    const raw = await mustRead(transcriptPath);
    let parsed: File;
    try {
      parsed = JSON.parse(raw) as File;
    } catch {
      return "";
    }
    return (parsed.messages ?? [])
      .map((message) => {
        const text = typeof message.content === "string" ? message.content.trim() : "";
        return text ? `${message.role ?? "unknown"}: ${text}` : "";
      })
      .filter(Boolean)
      .join("\n");
  },

  isDefaultTitle(title) {
    const trimmed = title.trim();
    return trimmed === "" || PLACEHOLDER.test(trimmed);
  },
};
```

`src/core/session/pi.ts`:

```ts
import type { SessionReader } from "./types.js";
import { mustRead } from "./clip.js";

interface Line {
  type?: string;
  role?: string;
  content?: unknown;
}

export const piReader: SessionReader = {
  async read(transcriptPath) {
    const raw = await mustRead(transcriptPath);
    const turns: string[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let parsed: Line;
      try {
        parsed = JSON.parse(line) as Line;
      } catch {
        continue;
      }
      // Skips the {"type":"session"} header and session_info entries.
      if (parsed.type !== "message") continue;
      const text = typeof parsed.content === "string" ? parsed.content.trim() : "";
      if (text) turns.push(`${parsed.role ?? "unknown"}: ${text}`);
    }
    return turns.join("\n");
  },

  // Pi has no titler at all, so an unnamed session simply has an empty name.
  isDefaultTitle(title) {
    return title.trim() === "";
  },
};
```

Each returns `""` on unparseable content. Only a genuinely unreadable file throws, with the
message `unreadable session: <path>`.

- [ ] **Step 5: Write `src/core/session/index.ts`**

```ts
import type { AgentId } from "../types.js";
import type { SessionReader } from "./types.js";
import { claudeCodeReader } from "./claude-code.js";
import { codexReader } from "./codex.js";
import { opencode2Reader } from "./opencode2.js";
import { piReader } from "./pi.js";
import { toClip } from "./clip.js";

const READERS: Record<AgentId, SessionReader> = {
  "claude-code": claudeCodeReader,
  codex: codexReader,
  opencode2: opencode2Reader,
  pi: piReader,
};

export async function readClip(agent: AgentId, transcriptPath: string): Promise<string> {
  return toClip(await READERS[agent].read(transcriptPath));
}

export function isDefaultTitle(agent: AgentId, title: string): boolean {
  return READERS[agent].isDefaultTitle(title);
}
```

- [ ] **Step 6: Run the tests and make them pass**

Run: `npx vitest run tests/core/session.test.ts`
Expected: 9 passed

- [ ] **Step 7: Commit**

```bash
git add src/core/session tests/core/session.test.ts tests/fixtures
git commit -m "feat: per-agent session readers with shared clip bounding"
```

---

## Task 8: Title store

**Files:**
- Create: `src/core/store.ts`
- Create: `tests/core/store.test.ts`

**Interfaces:**
- Consumes: `TitleRecord`, `AgentId` from Task 1
- Produces: `src/core/store.ts` exporting
  `class TitleStore { constructor(filePath: string); append(record: TitleRecord): Promise<void>; get(agent: AgentId, sessionId: string): Promise<TitleRecord | null>; list(opts?: { agent?: AgentId; limit?: number }): Promise<TitleRecord[]>; }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/core/store.test.ts
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TitleStore } from "../../src/core/store.js";
import type { TitleRecord } from "../../src/core/types.js";

const record = (over: Partial<TitleRecord> = {}): TitleRecord => ({
  agent: "claude-code",
  sessionId: "s1",
  title: "Auth refactor",
  description: "Reworked token expiry.",
  backend: "vulkan",
  modelVersion: "title-q8_0@v0.1.0",
  createdAt: "2026-09-14T10:00:00.000Z",
  ...over,
});

let store: TitleStore;

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), "qt-store-"));
  store = new TitleStore(join(dir, "titles.jsonl"));
});

describe("TitleStore", () => {
  it("returns null for an unknown session", async () => {
    expect(await store.get("claude-code", "nope")).toBeNull();
  });

  it("round-trips a record", async () => {
    await store.append(record());
    expect((await store.get("claude-code", "s1"))?.title).toBe("Auth refactor");
  });

  it("last write wins", async () => {
    await store.append(record({ title: "First" }));
    await store.append(record({ title: "Second" }));
    expect((await store.get("claude-code", "s1"))?.title).toBe("Second");
  });

  it("does not confuse the same session id across agents", async () => {
    await store.append(record({ agent: "claude-code", title: "From Claude" }));
    await store.append(record({ agent: "pi", title: "From Pi" }));
    expect((await store.get("claude-code", "s1"))?.title).toBe("From Claude");
    expect((await store.get("pi", "s1"))?.title).toBe("From Pi");
  });

  it("lists newest first and honours the limit", async () => {
    await store.append(record({ sessionId: "a", createdAt: "2026-09-14T10:00:00.000Z" }));
    await store.append(record({ sessionId: "b", createdAt: "2026-09-14T11:00:00.000Z" }));
    const listed = await store.list({ limit: 1 });
    expect(listed).toHaveLength(1);
    expect(listed[0]!.sessionId).toBe("b");
  });

  it("survives a corrupt line in the file", async () => {
    await store.append(record());
    await store.append(record({ sessionId: "c" }));
    const { appendFile } = await import("node:fs/promises");
    await appendFile(store.filePath, "{not json}\n");
    expect(await store.get("claude-code", "s1")).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/core/store.test.ts`
Expected: FAIL — cannot resolve `../../src/core/store.js`

- [ ] **Step 3: Write `src/core/store.ts`**

```ts
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
```

- [ ] **Step 4: Run the tests and make them pass**

Run: `npx vitest run tests/core/store.test.ts`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add src/core/store.ts tests/core/store.test.ts
git commit -m "feat: append-only JSONL store for titles and descriptions"
```

---

## Task 9: Daemon and IPC protocol

**Files:**
- Create: `src/daemon/protocol.ts`
- Create: `src/daemon/server.ts`
- Create: `src/daemon/main.ts`
- Create: `tests/daemon/server.test.ts`

**Interfaces:**
- Consumes: `TitleEngine` (Task 6), `TitleStore` (Task 8), `readClip` (Task 7), `paths` (Task 1)
- Produces: `src/daemon/protocol.ts` exporting `Request`, `Response`, `METHODS`;
  `src/daemon/server.ts` exporting `startServer(opts: { socketPath: string; engine: TitleEngine; store: TitleStore }): Promise<{ close(): Promise<void> }>`

- [ ] **Step 1: Write `src/daemon/protocol.ts`**

Newline-delimited JSON, one request and one response per line.

```ts
import type { AgentId, GenerateResult } from "../core/types.js";

export type Request =
  | { id: string; method: "ping" }
  | { id: string; method: "status" }
  | { id: string; method: "shutdown" }
  | { id: string; method: "generate"; params: { agent: AgentId; sessionId: string; transcriptPath: string } }
  | { id: string; method: "list"; params?: { agent?: AgentId; limit?: number } };

export type Response =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string };

export const PROTOCOL_VERSION = 1;

export interface StatusResult {
  version: number;
  backend: string;
  modelVersion: string;
  pid: number;
  uptimeMs: number;
}
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/daemon/server.test.ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createConnection, type Socket } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../src/daemon/server.js";
import { TitleStore } from "../../src/core/store.js";
import type { TitleEngine } from "../../src/core/inference.js";

/** Stub engine: the daemon's job is routing and I/O, not inference. */
const stubEngine = {
  backend: "stub",
  async generate(clip: string) {
    return { result: { title: `stub:${clip.slice(0, 10)}`, description: null }, backend: "stub" };
  },
  async dispose() {},
} as unknown as TitleEngine;

let socketPath: string;
let close: () => Promise<void>;

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), "qt-daemon-"));
  socketPath = process.platform === "win32" ? `\\\\.\\pipe\\qt-test-${Date.now()}` : join(dir, "d.sock");
  const store = new TitleStore(join(dir, "titles.jsonl"));
  ({ close } = await startServer({ socketPath, engine: stubEngine, store }));
});

afterEach(async () => {
  await close();
});

function call(payload: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket: Socket = createConnection(socketPath);
    let buffer = "";
    socket.on("connect", () => socket.write(JSON.stringify(payload) + "\n"));
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const nl = buffer.indexOf("\n");
      if (nl === -1) return;
      resolve(JSON.parse(buffer.slice(0, nl)));
      socket.end();
    });
    socket.on("error", reject);
  });
}

describe("daemon server", () => {
  it("answers ping", async () => {
    const res = await call({ id: "1", method: "ping" });
    expect(res.ok).toBe(true);
  });

  it("reports status", async () => {
    const res = await call({ id: "2", method: "status" });
    expect(res.result.backend).toBe("stub");
    expect(res.result.version).toBe(1);
  });

  it("rejects an unknown method without crashing", async () => {
    const res = await call({ id: "3", method: "nope" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unknown method/);
  });

  it("rejects malformed JSON without crashing", async () => {
    const res = await new Promise<any>((resolve, reject) => {
      const socket = createConnection(socketPath);
      let buffer = "";
      socket.on("connect", () => socket.write("not json\n"));
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        const nl = buffer.indexOf("\n");
        if (nl === -1) return;
        resolve(JSON.parse(buffer.slice(0, nl)));
        socket.end();
      });
      socket.on("error", reject);
    });
    expect(res.ok).toBe(false);
  });

  it("generates and persists a title", async () => {
    const res = await call({
      id: "4",
      method: "generate",
      params: { agent: "pi", sessionId: "s1", transcriptPath: "tests/fixtures/sessions/pi.jsonl" },
    });
    expect(res.ok).toBe(true);
    expect(res.result.title).toMatch(/^stub:/);
    expect(res.result.description).toBeNull();
  });

  it("lists stored titles", async () => {
    await call({
      id: "5",
      method: "generate",
      params: { agent: "pi", sessionId: "s2", transcriptPath: "tests/fixtures/sessions/pi.jsonl" },
    });
    const res = await call({ id: "6", method: "list", params: { agent: "pi" } });
    expect(res.result.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/daemon/server.test.ts`
Expected: FAIL — cannot resolve `../../src/daemon/server.js`

- [ ] **Step 4: Write `src/daemon/server.ts`**

```ts
import { createServer, type Server } from "node:net";
import { unlink } from "node:fs/promises";
import type { TitleEngine } from "../core/inference.js";
import type { TitleStore } from "../core/store.js";
import type { AgentId, TitleRecord } from "../core/types.js";
import { readClip } from "../core/session/index.js";
import { PROTOCOL_VERSION, type Request, type Response, type StatusResult } from "./protocol.js";

const MODEL_VERSION = "title-q8_0@v0.1.0";

export interface StartServerOptions {
  socketPath: string;
  engine: TitleEngine;
  store: TitleStore;
}

async function handle(
  request: Request,
  engine: TitleEngine,
  store: TitleStore,
  startedAt: number
): Promise<unknown> {
  switch (request.method) {
    case "ping":
      return "pong";

    case "status":
      return {
        version: PROTOCOL_VERSION,
        backend: engine.backend,
        modelVersion: MODEL_VERSION,
        pid: process.pid,
        uptimeMs: Date.now() - startedAt,
      } satisfies StatusResult;

    case "generate": {
      const { agent, sessionId, transcriptPath } = request.params;
      const clip = await readClip(agent as AgentId, transcriptPath);
      if (!clip) return { title: null, description: null };
      const { result, backend } = await engine.generate(clip);
      if (result.title) {
        const record: TitleRecord = {
          agent: agent as AgentId,
          sessionId,
          title: result.title,
          description: result.description,
          backend,
          modelVersion: MODEL_VERSION,
          createdAt: new Date().toISOString(),
        };
        await store.append(record);
      }
      return result;
    }

    case "list":
      return store.list(request.params ?? {});

    case "shutdown":
      setImmediate(() => process.kill(process.pid, "SIGTERM"));
      return "shutting down";

    default:
      throw new Error(`unknown method: ${(request as { method: string }).method}`);
  }
}

export async function startServer(
  opts: StartServerOptions
): Promise<{ close(): Promise<void> }> {
  const startedAt = Date.now();

  const server: Server = createServer((socket) => {
    let buffer = "";
    socket.on("data", async (chunk) => {
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        let response: Response;
        const id = (() => {
          try {
            return String(JSON.parse(line).id ?? "");
          } catch {
            return "";
          }
        })();
        try {
          const request = JSON.parse(line) as Request;
          response = { id, ok: true, result: await handle(request, opts.engine, opts.store, startedAt) };
        } catch (error) {
          response = { id, ok: false, error: (error as Error).message };
        }
        socket.write(JSON.stringify(response) + "\n");
      }
    });
    // A client disconnecting mid-request must not take the daemon down.
    socket.on("error", () => {});
  });

  if (process.platform !== "win32") {
    await unlink(opts.socketPath).catch(() => {});
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.socketPath, () => resolve());
  });

  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          if (process.platform !== "win32") unlink(opts.socketPath).catch(() => {});
          resolve();
        });
      }),
  };
}
```

- [ ] **Step 5: Write `src/daemon/main.ts`**

```ts
import { writeFile, unlink } from "node:fs/promises";
import { TitleEngine } from "../core/inference.js";
import { TitleStore } from "../core/store.js";
import { pidFile, socketPath, storeFile, modelsDir } from "../paths.js";
import { startServer } from "./server.js";
import { join } from "node:path";

const modelPath = process.env.QT_MODEL ?? join(modelsDir(), "title-q8_0.gguf");

const engine = await TitleEngine.create({ modelPath, contextSequences: 2 });
const store = new TitleStore(storeFile());
const { close } = await startServer({ socketPath: socketPath(), engine, store });

await writeFile(pidFile(), String(process.pid), "utf8");
console.log(`quick-titles daemon listening on ${socketPath()} (backend: ${engine.backend})`);
console.log("Powered by Desert Ant Labs");

const shutdown = async () => {
  await close().catch(() => {});
  await engine.dispose().catch(() => {});
  if (process.platform !== "win32") await unlink(pidFile()).catch(() => {});
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
```

- [ ] **Step 6: Run the tests and make them pass**

Run: `npx vitest run tests/daemon/server.test.ts`
Expected: 6 passed

- [ ] **Step 7: Commit**

```bash
git add src/daemon tests/daemon/server.test.ts
git commit -m "feat: resident daemon with newline-delimited JSON IPC"
```

---

## Task 10: Client library

**Files:**
- Create: `src/client.ts`
- Create: `tests/client.test.ts`

**Interfaces:**
- Consumes: `protocol.ts` (Task 9), `paths` (Task 1)
- Produces: `src/client.ts` exporting
  `request<T>(req: Omit<Request,"id">, opts?: { timeoutMs?: number }): Promise<T | null>`,
  `ensureDaemon(): Promise<boolean>`, `generate(req: GenerateRequest): Promise<GenerateResult | null>`

`request` returns `null` rather than throwing whenever the daemon is unreachable. Every adapter
depends on that: a missing daemon must be a silent no-op, never a broken session.

- [ ] **Step 1: Write the failing test**

```ts
// tests/client.test.ts
import { describe, expect, it, vi } from "vitest";
import { request } from "../src/client.js";
import * as paths from "../src/paths.js";

describe("client", () => {
  it("returns null when no daemon is listening", async () => {
    vi.spyOn(paths, "socketPath").mockReturnValue(
      process.platform === "win32" ? "\\\\.\\pipe\\qt-does-not-exist" : "/tmp/qt-does-not-exist.sock"
    );
    expect(await request({ method: "ping" }, { timeoutMs: 300 })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/client.test.ts`
Expected: FAIL — cannot resolve `../src/client.js`

- [ ] **Step 3: Write `src/client.ts`**

```ts
import { createConnection } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { socketPath } from "./paths.js";
import type { Request, Response } from "./daemon/protocol.js";
import type { GenerateRequest, GenerateResult } from "./core/types.js";

const DEFAULT_TIMEOUT_MS = 15_000;

/** Returns null on any failure. Callers treat null as "no title", never as an error. */
export async function request<T>(
  req: Omit<Request, "id">,
  opts: { timeoutMs?: number } = {}
): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    let settled = false;
    const done = (value: T | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };

    const socket = createConnection(socketPath());
    socket.setTimeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    socket.on("timeout", () => done(null));
    socket.on("error", () => done(null));

    let buffer = "";
    socket.on("connect", () =>
      socket.write(JSON.stringify({ ...req, id: Math.random().toString(36).slice(2) }) + "\n")
    );
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const nl = buffer.indexOf("\n");
      if (nl === -1) return;
      try {
        const response = JSON.parse(buffer.slice(0, nl)) as Response;
        done(response.ok ? (response.result as T) : null);
      } catch {
        done(null);
      }
    });
  });
}

/** Best-effort daemon start. Returns whether the daemon answered afterwards. */
export async function ensureDaemon(): Promise<boolean> {
  if (await request({ method: "ping" }, { timeoutMs: 500 })) return true;

  const here = dirname(fileURLToPath(import.meta.url));
  const entry = join(here, "daemon", "main.js");
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // Model load is measured at 4.8-5.6s; retry inside that window.
  for (let attempt = 0; attempt < 12; attempt++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await request({ method: "ping" }, { timeoutMs: 500 })) return true;
  }
  return false;
}

export async function generate(req: GenerateRequest): Promise<GenerateResult | null> {
  return request<GenerateResult>({ method: "generate", params: req });
}
```

- [ ] **Step 4: Run the tests and make them pass**

Run: `npx vitest run tests/client.test.ts`
Expected: 1 passed

- [ ] **Step 5: Commit**

```bash
git add src/client.ts tests/client.test.ts
git commit -m "feat: daemon client that returns null instead of throwing"
```

---

## Task 11: Claude Code adapter

**Files:**
- Create: `adapters/claude-code/.claude-plugin/plugin.json`
- Create: `adapters/claude-code/hooks/hooks.json`
- Create: `adapters/claude-code/scripts/session-start.mjs`
- Create: `adapters/claude-code/scripts/user-prompt.mjs`
- Create: `adapters/claude-code/scripts/lib.mjs`
- Create: `tests/adapters/claude-code.test.ts`

**Interfaces:**
- Consumes: `generate` / `ensureDaemon` from Task 10 (via the built `dist/client.js`)
- Produces: a loadable Claude Code plugin directory; `.mjs` scripts that print
  `{"hookSpecificOutput":{"hookEventName":...,"sessionTitle":...}}`

The scripts are plain `.mjs` calling into `dist/`, so the plugin needs no build step of its own.

- [ ] **Step 1: Write `adapters/claude-code/.claude-plugin/plugin.json`**

```json
{
  "$schema": "https://json.schemastore.org/claude-code-plugin-manifest.json",
  "name": "quick-titles",
  "displayName": "quick-titles",
  "version": "0.1.0",
  "description": "Local, on-device session titles and descriptions. Powered by Desert Ant Labs.",
  "license": "MIT",
  "hooks": "./hooks/hooks.json"
}
```

- [ ] **Step 2: Write `adapters/claude-code/hooks/hooks.json`**

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|fork",
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/session-start.mjs"],
            "timeout": 30
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/user-prompt.mjs"],
            "timeout": 25
          }
        ]
      }
    ]
  }
}
```

`UserPromptSubmit` carries a hard 30 s ceiling. The hook declares 25 s so our own timeout fires
first and we exit cleanly rather than being killed mid-write.

- [ ] **Step 3: Write `adapters/claude-code/scripts/lib.mjs`**

```js
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "..", "..", "dist");

export async function readStdin() {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function loadClient() {
  return import(join(dist, "client.js"));
}

export function emitTitle(eventName, title) {
  if (!title) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: eventName, sessionTitle: title },
    }) + "\n"
  );
}

/** The most recent title the host already has, read from the transcript.
 *  SessionStart's input has no session_title field, so we keep our own marker. */
export function readMarkerFile(dataDir, sessionId) {
  try {
    return readFileSync(join(dataDir, `titled-${sessionId}`), "utf8").trim();
  } catch {
    return "";
  }
}
```

- [ ] **Step 4: Write `adapters/claude-code/scripts/session-start.mjs`**

```js
#!/usr/bin/env node
// SessionStart fires on startup|resume|fork and receives no prompt text, but it
// does receive transcript_path - so on resume we can title a session that was
// never titled, and backfill history.
import { readStdin, loadClient, emitTitle } from "./lib.mjs";

const input = await readStdin();
if (!input?.session_id || !input?.transcript_path) process.exit(0);

// Never block session start. The daemon warms in the background; if it is not
// up yet, this session simply gets its title on the first prompt instead.
const client = await loadClient();
client.ensureDaemon().catch(() => {});

const title = process.env.QT_TITLE_ON_RESUME === "1"
  ? (await client.generate({
      agent: "claude-code",
      sessionId: input.session_id,
      transcriptPath: input.transcript_path,
    }))?.title
  : null;

emitTitle("SessionStart", title);
process.exit(0);
```

- [ ] **Step 5: Write `adapters/claude-code/scripts/user-prompt.mjs`**

The early pass runs on prompt 1 from the prompt text alone; the refine runs on prompt 3 with the
accumulated transcript. Guarding is by a per-session counter under `${CLAUDE_PLUGIN_DATA}`.

```js
#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readStdin, loadClient, emitTitle } from "./lib.mjs";

const input = await readStdin();
if (!input?.session_id) process.exit(0);

const dataDir = process.env.CLAUDE_PLUGIN_DATA || process.env.QUICK_TITLES_DATA_DIR || "";
if (!dataDir) process.exit(0);

const counterFile = join(dataDir, `prompts-${input.session_id}`);
let count = 0;
try {
  count = Number(readFileSync(counterFile, "utf8").trim()) || 0;
} catch {
  count = 0;
}
count += 1;
try {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(counterFile, String(count));
} catch {
  // Counting is best-effort; a failure just means we may title twice.
}

// Pass 1 on the first prompt, refine once on the third. Nothing after that.
if (count !== 1 && count !== 3) process.exit(0);

const client = await loadClient();
const title = (
  await client.generate({
    agent: "claude-code",
    sessionId: input.session_id,
    transcriptPath: input.transcript_path,
  })
)?.title;

emitTitle("UserPromptSubmit", title);
process.exit(0);
```

- [ ] **Step 6: Write the contract test**

```ts
// tests/adapters/claude-code.test.ts
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";

const run = promisify(execFile);
const script = "adapters/claude-code/scripts/user-prompt.mjs";

async function invoke(payload: unknown, env: NodeJS.ProcessEnv = {}) {
  return run(process.execPath, [script], {
    env: { ...process.env, ...env },
    input: JSON.stringify(payload),
  } as never).catch((error) => ({ stdout: error.stdout ?? "", stderr: error.stderr ?? "" }));
}

describe("claude-code adapter", () => {
  it("exits silently when the daemon is absent", async () => {
    const { stdout } = await invoke(
      { session_id: "s1", transcript_path: "nowhere.jsonl" },
      { QUICK_TITLES_DATA_DIR: "/tmp/qt-absent", QUICK_TITLES_SOCKET: "/tmp/qt-nope.sock" }
    );
    expect(stdout.trim()).toBe("");
  });

  it("exits silently with no input", async () => {
    const { stdout } = await invoke({});
    expect(stdout.trim()).toBe("");
  });

  it("never writes anything but JSON to stdout", async () => {
    const { stdout } = await invoke({ session_id: "s2", prompt: "hi" });
    if (stdout.trim()) expect(() => JSON.parse(stdout.trim())).not.toThrow();
  });

  it("declares a timeout below the 30s UserPromptSubmit ceiling", () => {
    const hooks = JSON.parse(readFileSync("adapters/claude-code/hooks/hooks.json", "utf8"));
    const timeout = hooks.hooks.UserPromptSubmit[0].hooks[0].timeout;
    expect(timeout).toBeLessThan(30);
  });

  it("titles on prompt 1 and prompt 3 only", () => {
    const source = readFileSync(script, "utf8");
    expect(source).toContain("count !== 1 && count !== 3");
  });
});
```

- [ ] **Step 7: Run the tests and make them pass**

Run: `npm run build && npx vitest run tests/adapters/claude-code.test.ts`
Expected: 5 passed

- [ ] **Step 8: Verify against a live Claude Code session**

```bash
cd /d/Apps/projects/titles
claude --plugin-dir adapters/claude-code -p "Reply with exactly: adapter ok"
# then inspect the session transcript for a custom-title line
```

Expected: a `{"type":"custom-title",...}` line whose `customTitle` is a real generated title, and
**no** `ai-title` line — confirming the built-in titler was suppressed.

- [ ] **Step 9: Commit**

```bash
git add adapters/claude-code tests/adapters/claude-code.test.ts
git commit -m "feat: Claude Code adapter that replaces the built-in titler"
```

---

## Task 12: opencode2 adapter

**Files:**
- Create: `adapters/opencode2/plugin.ts`
- Create: `adapters/opencode2/install.mjs`
- Create: `tests/adapters/opencode2.test.ts`

**Interfaces:**
- Consumes: `generate` from Task 10
- Produces: an opencode2 plugin exporting a `Plugin.define({ id, setup })` default

- [ ] **Step 1: Add the plugin types and write the plugin**

```bash
npm install --save-dev @opencode-ai/plugin
```

```ts
// adapters/opencode2/plugin.ts
import type { Plugin } from "@opencode-ai/plugin";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// install.mjs substitutes this token with an absolute path. A relative import
// would break the moment the plugin is copied to ~/.config/opencode/plugins/
// rather than symlinked out of this repo.
const DIST = "__QUICK_TITLES_DIST__";

/** opencode2 fires session events we can subscribe to, and exposes a documented
 *  rename method. No storage writes, no polling. */
export default {
  id: "quick-titles",
  async setup(ctx) {
    // pathToFileURL matters: a Windows absolute path is not a valid import specifier.
    const { generate } = (await import(pathToFileURL(join(DIST, "client.js")).href)) as {
      generate: typeof import("../../dist/client.js").generate;
    };

    const unsub = ctx.event.subscribe(async (event) => {
      if (event.type !== "session.idle" && event.type !== "message.updated") return;

      const sessionID = event.data?.sessionID;
      if (!sessionID) return;

      // Only title sessions still showing a placeholder.
      const session = await ctx.session.get({ sessionID }).catch(() => null);
      const current = session?.title ?? "";
      if (!/^(New session|Child session) - \d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(current) && current !== "") {
        return;
      }

      const result = await generate({
        agent: "opencode2",
        sessionId: sessionID,
        transcriptPath: ctx.paths.data(`session/${sessionID}.json`),
      }).catch(() => null);

      if (result?.title) {
        await ctx.session.rename({ sessionID, title: result.title });
      }
    });

    return () => unsub?.dispose?.();
  },
} satisfies Plugin;
```

`adapters/opencode2/install.mjs`:

```js
#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

function existsSync(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, "..", "..", "dist");

if (!existsSync(join(dist, "client.js"))) {
  console.error("quick-titles: run `npm run build` first; dist/client.js is missing");
  process.exit(1);
}

// Project-local plugin dir if the cwd looks like an opencode2 project,
// otherwise the user-global one.
const target = existsSync(join(process.cwd(), ".opencode"))
  ? join(process.cwd(), ".opencode", "plugins")
  : join(homedir(), ".config", "opencode", "plugins");

mkdirSync(target, { recursive: true });

const source = readFileSync(resolve(here, "plugin.ts"), "utf8");
const output = source.replace("__QUICK_TITLES_DIST__", dist);
writeFileSync(join(target, "quick-titles.ts"), output, "utf8");

console.log(`quick-titles: installed opencode2 plugin to ${join(target, "quick-titles.ts")}`);
```

- [ ] **Step 2: Write the contract test**

```ts
// tests/adapters/opencode2.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = readFileSync("adapters/opencode2/plugin.ts", "utf8");

describe("opencode2 adapter", () => {
  it("uses the documented rename method, not a storage write", () => {
    expect(source).toContain("ctx.session.rename");
  });

  it("does not reach into SQLite directly", () => {
    expect(source).not.toMatch(/opencode\.db|sqlite|better-sqlite3/i);
  });

  it("guards on the placeholder title pattern", () => {
    expect(source).toContain("New session");
    expect(source).toContain("Child session");
  });

  it("swallows generation failures", () => {
    expect(source).toMatch(/\.catch\(\(\) => null\)/);
  });
});
```

- [ ] **Step 3: Run the tests and make them pass**

Run: `npx vitest run tests/adapters/opencode2.test.ts`
Expected: 4 passed

- [ ] **Step 4: Verify against a live opencode2 session**

```bash
node adapters/opencode2/install.mjs
opencode2 serve &
# drive one short session, then inspect the title column:
#   sqlite3 ~/.local/share/opencode/opencode.db \
#     "select id, title from session_v2 order by time_updated desc limit 5;"
```

Expected: the installed plugin contains an absolute path, not the literal token —

```bash
rg -c '__QUICK_TITLES_DIST__' ~/.config/opencode/plugins/quick-titles.ts || echo "token substituted"
```

— and the newest session's `title` is a real generated title, not a `New session - ...`
placeholder. Record the observed result in `docs/adapter-verification.md`.

- [ ] **Step 5: Commit**

```bash
git add adapters/opencode2 tests/adapters/opencode2.test.ts package.json package-lock.json docs/adapter-verification.md
git commit -m "feat: opencode2 adapter using ctx.session.rename"
```

---

## Task 13: Codex adapter

**Files:**
- Create: `adapters/codex/notify.mjs`
- Create: `adapters/codex/install.mjs`
- Create: `tests/adapters/codex.test.ts`

**Interfaces:**
- Consumes: `generate` from Task 10
- Produces: `adapters/codex/notify.mjs` (a `notify` callback target) and
  `adapters/codex/install.mjs` (writes the config entry)

Codex hooks cannot set a title — their return values have no title field. The path that works is
the **app-server RPC**: `thread/name/set`. `notify` is the trigger, RPC is the writer.

- [ ] **Step 1: Write `adapters/codex/install.mjs`**

```js
#!/usr/bin/env node
// Registers quick-titles as a Codex notify callback. notify is fire-and-forget
// and carries no trust gate, unlike Codex hooks which require a trusted_hash.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
const configPath = join(codexHome, "config.toml");
const here = dirname(fileURLToPath(import.meta.url));
const notifyScript = resolve(here, "notify.mjs");

mkdirSync(codexHome, { recursive: true });
let config = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";

if (/^\s*notify\s*=/m.test(config)) {
  console.error("quick-titles: a notify entry already exists in config.toml; leaving it alone");
  console.error(`Add this manually if you want quick-titles:\n  notify = ["${process.execPath}", "${notifyScript}"]`);
  process.exit(1);
}

config += `\nnotify = ["${process.execPath}", "${notifyScript}"]\n`;
writeFileSync(configPath, config, "utf8");
console.log(`quick-titles: wrote notify entry to ${configPath}`);
```

- [ ] **Step 2: Write `adapters/codex/notify.mjs`**

```js
#!/usr/bin/env node
// Codex calls this with one JSON argument after a turn completes:
// {type:"agent-turn-complete", thread-id, turn-id, cwd, input-messages,
//  last-assistant-message}. We generate locally, then push the title back
// through Codex's own app-server RPC.
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const payload = JSON.parse(process.argv[process.argv.length - 1] ?? "{}");
if (payload.type !== "agent-turn-complete") process.exit(0);

const threadId = payload["thread-id"];
if (!threadId) process.exit(0);

const here = dirname(fileURLToPath(import.meta.url));
const { generate } = await import(pathToFileURL(join(here, "..", "..", "dist", "client.js")));

const rollout = await findRollout(threadId);
if (!rollout) process.exit(0);

const result = await generate({
  agent: "codex",
  sessionId: threadId,
  transcriptPath: rollout,
}).catch(() => null);

if (!result?.title) process.exit(0);

// thread/name/set on the app-server. Never write state_5.sqlite: it is
// documented as unsafe while Codex runs.
const rpc = JSON.stringify({
  id: 1,
  method: "thread/name/set",
  params: { threadId, name: result.title },
});
spawnSync("codex", ["app-server", "--listen", "stdio://"], {
  input: rpc + "\n",
  encoding: "utf8",
  timeout: 10_000,
});

process.exit(0);

/** Rollouts live at $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl.
 *  Walked in Node rather than shelling out: `find` and `where /r` both differ
 *  enough across platforms to be a liability, and the tree is small. */
async function findRollout(threadId) {
  const { readdir } = await import("node:fs/promises");
  const home = process.env.CODEX_HOME || join(process.env.USERPROFILE || homedir(), ".codex");
  const root = join(home, "sessions");

  async function walk(dir, depth) {
    if (depth > 4) return null;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isFile() && entry.name.includes(threadId) && entry.name.endsWith(".jsonl")) {
        return path;
      }
      if (entry.isDirectory()) {
        const found = await walk(path, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  return walk(root, 0);
}
```

- [ ] **Step 3: Write the contract test**

```ts
// tests/adapters/codex.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const notify = readFileSync("adapters/codex/notify.mjs", "utf8");
const install = readFileSync("adapters/codex/install.mjs", "utf8");

describe("codex adapter", () => {
  it("writes titles through the app-server RPC, not the database", () => {
    expect(notify).toContain("thread/name/set");
    expect(notify).not.toMatch(/state_\d*\.sqlite|threads\s+SET/i);
  });

  it("ignores payloads that are not turn completions", () => {
    expect(notify).toContain('payload.type !== "agent-turn-complete"');
  });

  it("refuses to clobber an existing notify entry", () => {
    expect(install).toContain("a notify entry already exists");
  });

  it("targets the correct notify payload field name", () => {
    expect(notify).toContain('payload["thread-id"]');
  });
});
```

- [ ] **Step 4: Run the tests and make them pass**

Run: `npx vitest run tests/adapters/codex.test.ts`
Expected: 4 passed

- [ ] **Step 5: Verify against a live Codex session**

```bash
node adapters/codex/install.mjs
codex exec "reply with exactly: adapter ok"
sqlite3 "$CODEX_HOME/state_5.sqlite" \
  "select id, name from threads order by rowid desc limit 3;"
```

Expected: the newest thread's `name` is a generated title, and `session_index.jsonl`
`thread_name` agrees with it.

- [ ] **Step 6: Commit**

```bash
git add adapters/codex tests/adapters/codex.test.ts
git commit -m "feat: Codex adapter driven by notify, writing through app-server RPC"
```

---

## Task 14: Pi adapter

**Files:**
- Create: `adapters/pi/quick-titles.ts`
- Create: `adapters/pi/install.mjs`
- Create: `tests/adapters/pi.test.ts`

**Interfaces:**
- Consumes: `generate` from Task 10
- Produces: a Pi extension calling `pi.setSessionName(name)`

Pi has **no automatic titles at all**, so this adapter adds a feature rather than replacing one.
There is no placeholder to detect — an unnamed session has an empty name.

- [ ] **Step 1: Add the Pi types as a dev dependency**

```bash
npm install --save-dev @earendil-works/pi-coding-agent
```

Types only — the extension file is copied straight into `~/.pi/agent/extensions/` and Pi runs
it. There is no build step and no package to publish for this adapter.

- [ ] **Step 2: Write `adapters/pi/quick-titles.ts`**

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// install.mjs substitutes this token with an absolute path, because the
// extension is copied into ~/.pi/agent/extensions/ and cannot resolve a
// relative import back out to this repo.
const DIST = "__QUICK_TITLES_DIST__";

type Generate = (request: {
  agent: "pi";
  sessionId: string;
  transcriptPath: string;
}) => Promise<{ title: string; description: string | null } | null>;

export default function quickTitles(pi: ExtensionAPI) {
  let turnCount = 0;
  let generate: Generate | null = null;

  pi.on("session_start", async () => {
    turnCount = 0;
    // pathToFileURL matters: a Windows absolute path is not a valid import specifier.
    ({ generate } = (await import(pathToFileURL(join(DIST, "client.js")).href)) as {
      generate: Generate;
    });
  });

  pi.on("turn_end", async (_event, ctx) => {
    turnCount += 1;
    // Pass 1 on the first turn, refine once on the third, then stop.
    if (turnCount !== 1 && turnCount !== 3) return;
    if (!generate) return;
    if (await pi.getSessionName()) return;

    const result = await generate({
      agent: "pi",
      sessionId: ctx.sessionId,
      transcriptPath: ctx.sessionFile,
    }).catch(() => null);

    if (result?.title) await pi.setSessionName(result.title);
  });
}
```

- [ ] **Step 3: Write `adapters/pi/install.mjs`**

```js
#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

function existsSync(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, "..", "..", "dist");

if (!existsSync(join(dist, "client.js"))) {
  console.error("quick-titles: run `npm run build` first; dist/client.js is missing");
  process.exit(1);
}

const target = join(homedir(), ".pi", "agent", "extensions");
mkdirSync(target, { recursive: true });

const source = readFileSync(resolve(here, "quick-titles.ts"), "utf8");
writeFileSync(
  join(target, "quick-titles.ts"),
  source.replace("__QUICK_TITLES_DIST__", dist),
  "utf8"
);

console.log(`quick-titles: installed Pi extension to ${join(target, "quick-titles.ts")}`);
```

- [ ] **Step 4: Write the contract test**

```ts
// tests/adapters/pi.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = readFileSync("adapters/pi/quick-titles.ts", "utf8");

describe("pi adapter", () => {
  it("sets the name through the extension API", () => {
    expect(source).toContain("pi.setSessionName");
  });

  it("never overwrites an existing name", () => {
    expect(source).toContain("if (await pi.getSessionName()) return;");
  });

  it("titles on turn 1 and turn 3 only", () => {
    expect(source).toContain("turnCount !== 1 && turnCount !== 3");
  });

  it("does not write session JSONL directly", () => {
    expect(source).not.toMatch(/appendFile|writeFile|session_info/);
  });
});
```

- [ ] **Step 5: Run the tests and make them pass**

Run: `npx vitest run tests/adapters/pi.test.ts`
Expected: 4 passed

- [ ] **Step 6: Verify against a live Pi session**

```bash
node adapters/pi/install.mjs
pi -p "reply with exactly: adapter ok"
rg -o '"type":"session_info"[^}]*' ~/.pi/agent/sessions/--*/$(ls -t ~/.pi/agent/sessions/--*/ | head -1)
```

Expected: a `session_info` entry carrying a generated `name`.

- [ ] **Step 7: Commit**

```bash
git add adapters/pi tests/adapters/pi.test.ts package.json package-lock.json
git commit -m "feat: Pi extension adding titles via pi.setSessionName"
```

---

## Task 15: Session listing and attribution

**Files:**
- Create: `src/cli/sessions.ts`
- Create: `adapters/claude-code/commands/sessions.md`
- Create: `tests/cli/sessions.test.ts`

**Interfaces:**
- Consumes: `TitleStore` (Task 8), `request` (Task 10)
- Produces: `src/cli/sessions.ts` exporting `renderSessionList(records: TitleRecord[]): string`

- [ ] **Step 1: Write the failing test**

```ts
// tests/cli/sessions.test.ts
import { describe, expect, it } from "vitest";
import { renderSessionList } from "../../src/cli/sessions.js";
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

  it("shows the agent", () => {
    expect(renderSessionList([rec({ agent: "pi" })])).toContain("pi");
  });

  it("handles a null description", () => {
    const out = renderSessionList([rec({ description: null })]);
    expect(out).toContain("Auth middleware refactor");
    expect(out).not.toContain("null");
  });

  it("always includes the attribution line", () => {
    expect(renderSessionList([])).toContain("Powered by Desert Ant Labs");
  });

  it("reports an empty list rather than printing nothing", () => {
    expect(renderSessionList([])).toMatch(/no titles yet/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/cli/sessions.test.ts`
Expected: FAIL — cannot resolve `../../src/cli/sessions.js`

- [ ] **Step 3: Write `src/cli/sessions.ts`**

```ts
import type { TitleRecord } from "../core/types.js";

export const ATTRIBUTION = "Powered by Desert Ant Labs";

export function renderSessionList(records: TitleRecord[]): string {
  const lines: string[] = [];

  if (records.length === 0) {
    lines.push("No titles yet. Titles appear as you use your agents.");
  } else {
    for (const record of records) {
      const when = record.createdAt.slice(0, 16).replace("T", " ");
      lines.push(`${record.title}  [${record.agent}]  ${when}`);
      if (record.description) lines.push(`    ${record.description}`);
    }
  }

  lines.push("", ATTRIBUTION);
  return lines.join("\n");
}
```

- [ ] **Step 4: Write the slash command**

`adapters/claude-code/commands/sessions.md`:

```markdown
---
description: List recent sessions with locally generated titles and descriptions
allowed-tools: Bash
---

Run the session listing and show it verbatim:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/sessions.mjs"`
```

- [ ] **Step 5: Write `adapters/claude-code/scripts/sessions.mjs`**

```js
#!/usr/bin/env node
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "..", "..", "dist");

const [{ request }, { renderSessionList }] = await Promise.all([
  import(pathToFileURL(join(dist, "client.js")).href),
  import(pathToFileURL(join(dist, "cli", "sessions.js")).href),
]);

const records = (await request({ method: "list", params: { limit: 20 } })) ?? [];
process.stdout.write(renderSessionList(records) + "\n");
```

- [ ] **Step 6: Run the tests and make them pass**

Run: `npx vitest run tests/cli/sessions.test.ts`
Expected: 5 passed

- [ ] **Step 7: Commit**

```bash
git add src/cli/sessions.ts adapters/claude-code/commands adapters/claude-code/scripts/sessions.mjs tests/cli/sessions.test.ts
git commit -m "feat: /sessions listing with required Desert Ant Labs attribution"
```

---

## Task 16: First-run provisioning

**Files:**
- Create: `src/provision.ts`
- Create: `src/cli/install.ts`
- Create: `tests/provision.test.ts`

**Interfaces:**
- Consumes: `paths` (Task 1)
- Produces: `src/provision.ts` exporting
  `ensureModel(opts?: { onProgress?: (msg: string) => void }): Promise<string>` returning the
  local GGUF path, and `verifyChecksum(file: string, expected: string): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/provision.test.ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { verifyChecksum } from "../src/provision.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "qt-prov-"));
});

afterEach(() => {
  delete process.env.QUICK_TITLES_DATA_DIR;
});

describe("verifyChecksum", () => {
  it("accepts a matching hash", async () => {
    const file = join(dir, "m.bin");
    await writeFile(file, "hello");
    const sum = createHash("sha256").update("hello").digest("hex");
    expect(await verifyChecksum(file, sum)).toBe(true);
  });

  it("rejects a mismatched hash", async () => {
    const file = join(dir, "m.bin");
    await writeFile(file, "hello");
    expect(await verifyChecksum(file, "0".repeat(64))).toBe(false);
  });

  it("rejects a missing file rather than throwing", async () => {
    expect(await verifyChecksum(join(dir, "nope.bin"), "0".repeat(64))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/provision.test.ts`
Expected: FAIL — cannot resolve `../src/provision.js`

- [ ] **Step 3: Write `src/provision.ts`**

```ts
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { join } from "node:path";
import { modelsDir } from "./paths.js";

const MODEL_URL = process.env.QT_MODEL_URL ?? "";
const MODEL_SHA_URL = `${MODEL_URL}.sha256`;

export async function verifyChecksum(file: string, expected: string): Promise<boolean> {
  try {
    await stat(file);
  } catch {
    return false;
  }
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex") === expected.trim();
}

export const MODEL_FILENAME = "title-q8_0.gguf";

/** Fetches the model once. Returns the local path. Never runs at plugin install
 *  time - plugin install is capped at 60s with --ignore-scripts. */
export async function ensureModel(
  opts: { onProgress?: (msg: string) => void } = {}
): Promise<string> {
  const log = opts.onProgress ?? (() => {});
  const target = join(modelsDir(), MODEL_FILENAME);

  if (await exists(target)) {
    log("model already present");
    return target;
  }
  if (!MODEL_URL) {
    throw new Error("QT_MODEL_URL is not set; cannot provision the model");
  }

  await mkdir(modelsDir(), { recursive: true });
  log("downloading model");

  const expected = (await (await fetch(MODEL_SHA_URL)).text()).split(/\s+/)[0]!;
  const partial = `${target}.partial`;

  const response = await fetch(MODEL_URL);
  if (!response.ok || !response.body) {
    throw new Error(`model download failed: HTTP ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(partial));

  if (!(await verifyChecksum(partial, expected))) {
    throw new Error("model checksum mismatch; refusing to install");
  }

  await rename(partial, target);
  log("model verified");
  return target;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run the tests and make them pass**

Run: `npx vitest run tests/provision.test.ts`
Expected: 3 passed

- [ ] **Step 5: Wire provisioning into daemon start**

In `src/daemon/main.ts`, replace the `modelPath` resolution with:

```ts
import { ensureModel } from "../provision.js";

const modelPath = process.env.QT_MODEL ?? (await ensureModel({ onProgress: console.error }));
```

If provisioning throws, the daemon logs and exits non-zero. Adapters treat an absent daemon as a
no-op, so this degrades to "no titles" rather than a broken session.

- [ ] **Step 6: Commit**

```bash
git add src/provision.ts src/cli/install.ts tests/provision.test.ts src/daemon/main.ts
git commit -m "feat: first-run model provisioning with checksum verification"
```

---

## Task 17: Diagnostics

**Files:**
- Create: `src/cli/doctor.ts`
- Create: `bin/quick-titles.mjs`
- Create: `tests/cli/doctor.test.ts`

**Interfaces:**
- Consumes: `request` (Task 10), `paths` (Task 1)
- Produces: `src/cli/doctor.ts` exporting `runDoctor(): Promise<string>` returning a report

"Titles are not appearing" must have a one-command answer.

- [ ] **Step 1: Write the failing test**

```ts
// tests/cli/doctor.test.ts
import { describe, expect, it } from "vitest";
import { runDoctor } from "../../src/cli/doctor.js";

describe("runDoctor", () => {
  it("reports even when the daemon is down", async () => {
    const report = await runDoctor();
    expect(report).toMatch(/daemon/i);
  });

  it("includes the data directory", async () => {
    expect(await runDoctor()).toMatch(/data dir/i);
  });

  it("includes the attribution line", async () => {
    expect(await runDoctor()).toContain("Powered by Desert Ant Labs");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/cli/doctor.test.ts`
Expected: FAIL — cannot resolve `../../src/cli/doctor.js`

- [ ] **Step 3: Write `src/cli/doctor.ts`**

```ts
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { dataDir, modelsDir, socketPath, storeFile } from "../paths.js";
import { request } from "../client.js";
import { ATTRIBUTION } from "./sessions.js";
import { MODEL_FILENAME } from "../provision.js";
import type { StatusResult } from "../daemon/protocol.js";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function runDoctor(): Promise<string> {
  const lines: string[] = ["quick-titles doctor", ""];

  lines.push(`data dir     ${dataDir()}`);
  lines.push(`socket       ${socketPath()}`);
  lines.push(`store        ${(await exists(storeFile())) ? "present" : "absent"}`);
  lines.push(
    `model        ${
      (await exists(join(modelsDir(), MODEL_FILENAME))) ? "present" : "NOT PROVISIONED"
    }`
  );

  const status = await request<StatusResult>({ method: "status" }, { timeoutMs: 2000 });
  if (status) {
    lines.push(`daemon       up (pid ${status.pid}, ${Math.round(status.uptimeMs / 1000)}s)`);
    lines.push(`backend      ${status.backend}`);
    lines.push(`model ver    ${status.modelVersion}`);
  } else {
    lines.push("daemon       DOWN");
    lines.push("");
    lines.push("Start it with:  node bin/quick-titles.mjs daemon");
  }

  lines.push("", ATTRIBUTION);
  return lines.join("\n");
}
```

- [ ] **Step 4: Write `bin/quick-titles.mjs`**

```js
#!/usr/bin/env node
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");
const command = process.argv[2] ?? "help";

const load = (name) => import(pathToFileURL(join(dist, name)).href);

switch (command) {
  case "daemon":
    await import(pathToFileURL(join(dist, "daemon", "main.js")).href);
    break;
  case "doctor":
    console.log(await (await load("cli/doctor.js")).runDoctor());
    break;
  case "sessions": {
    const { request } = await load("client.js");
    const { renderSessionList } = await load("cli/sessions.js");
    console.log(renderSessionList((await request({ method: "list", params: { limit: 20 } })) ?? []));
    break;
  }
  case "stop": {
    const { request } = await load("client.js");
    await request({ method: "shutdown" });
    console.log("daemon stopped");
    break;
  }
  default:
    console.log(`quick-titles

Usage:
  quick-titles daemon     run the resident daemon in the foreground
  quick-titles doctor     diagnose why titles are not appearing
  quick-titles sessions   list recent sessions with titles and descriptions
  quick-titles stop       stop the daemon

Powered by Desert Ant Labs`);
}
```

- [ ] **Step 5: Add the bin entry**

```bash
npm pkg set bin.quick-titles=./bin/quick-titles.mjs
npm pkg set scripts.build="tsc"
npm pkg set scripts.test="vitest run"
```

- [ ] **Step 6: Run the tests and make them pass**

Run: `npm run build && npx vitest run tests/cli/doctor.test.ts`
Expected: 3 passed

- [ ] **Step 7: Commit**

```bash
git add src/cli/doctor.ts bin/quick-titles.mjs package.json tests/cli/doctor.test.ts
git commit -m "feat: quick-titles CLI with doctor diagnostics"
```

---

## Task 18: Packaging and release

**Files:**
- Create: `docs/install.md`
- Create: `docs/adapter-verification.md`
- Create: `LICENSE-NOTICE.md`
- Modify: `README.md`
- Create: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: everything
- Produces: an installable package and published docs

- [ ] **Step 1: Write `LICENSE-NOTICE.md`**

```markdown
# Third-party notices

## desert-ant-labs/title

The title model used by quick-titles is `desert-ant-labs/title`, fine-tuned from
`ibm-granite/granite-4.0-350m`, and is licensed under the Desert Ant Labs
Source-Available License 1.0 — https://license.desertant.com/1.0

Quick-titles embeds converted weights inside the application, which the licence
permits. It does not redistribute them as a standalone model.

Attribution is required by the licence and appears in the README, in
`quick-titles sessions` output, in `quick-titles doctor` output, and in the daemon
startup log.

## ggml-org/llama.cpp

Inference runs on llama.cpp via `node-llama-cpp`, MIT licensed.

## MLX

Weights were converted using MLX, MIT licensed.
```

- [ ] **Step 2: Write `docs/install.md`**

Include, plainly:

- Node 20+ required.
- **First run downloads ~380 MB.** State the number; do not hide it.
- **Windows: GPU acceleration uses Vulkan by default** and needs nothing beyond your GPU
  drivers. CUDA is used automatically only if the CUDA Toolkit (13.1+, or 12.4+ for 12.x) is
  already installed. Without it, quick-titles uses Vulkan rather than compiling anything.
- **NPUs are not supported** by llama.cpp. GPU or CPU only.
- Per-adapter install commands for Claude Code, Codex, opencode2, and Pi.
- **ChatGPT-app Codex threads cannot be titled.** Their titles live on OpenAI's servers.

- [ ] **Step 3: Write `docs/adapter-verification.md`**

Record the observed outcome of each live verification from Tasks 11–14: which agent, which
version, what was observed, and which did **not** work. A negative result recorded honestly is
worth more than an optimistic one that is never re-checked.

- [ ] **Step 4: Write `.github/workflows/release.yml`**

```yaml
name: Release

on:
  push:
    tags: ["v*"]

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - run: npm ci
      - run: npm run build
      - run: npm test
      - run: npm publish --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

- [ ] **Step 5: Verify the whole suite passes**

Run: `npm run build && npm test`
Expected: all test files pass. Paste the full summary.

- [ ] **Step 6: Commit and tag**

```bash
git add docs LICENSE-NOTICE.md README.md .github/workflows/release.yml
git commit -m "docs: installation, third-party notices, and release workflow"
git tag v0.1.0
```

---

## Self-review notes

**Spec coverage.** Every spec section maps to a task: architecture → Tasks 9–10; components →
4, 5, 6, 7, 8; adapter matrix → 11–14; model pipeline → 2; the quality gate → 3; failure
modes → the no-op contract in 10 and the per-adapter tests; attribution → 1, 15, 17, 18;
open risks → 3 (quality), 11 (`sessionTitle`), 10 (daemon absent), 18 (CUDA docs).

**Deliberately not covered.** ChatGPT-app Codex titles, session recap, NPU acceleration, and
publishing the GGUF — all non-goals in the spec.

**Known ordering risk.** Task 3 gates everything after it, but Task 2 must succeed before Task 3
can run at all. If Task 2 fails — for instance if `convert_hf_to_gguf.py` rejects the model's
odd `granitemoehybrid` config with zero experts — the workflow stops there and the fallback is
to test `convert_hf_to_gguf.py` with a forced `granitehybrid` architecture, or to re-export
from the base checkpoint. That contingency is intentionally not pre-planned in detail, because
it depends on the exact failure.
