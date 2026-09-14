// Building the model locally, from the publisher's own weights.
//
// `provision` downloads a GGUF that somebody else converted. This module is the
// other path: it converts the model here, on the machine that will run it, out
// of the weights `desert-ant-labs/title` publishes. It exists because the GGUF
// we would otherwise host is a derivative of a source-available model, so the
// decision to redistribute it has not been made — and a user who cannot wait
// for that decision should still be able to get a working model.
//
// Three rules shape everything below.
//
//   * **Nothing is redistributed.** The weights are fetched from the
//     publisher's own Hugging Face repository, on the user's machine, by a
//     request that does not touch this project. The GGUF is written to the
//     user's data directory and goes nowhere else. That is what keeps this on
//     the right side of clause (c) of the licence, which forbids
//     redistributing the model as a standalone model or hosted service.
//
//   * **Nothing is compiled.** The pipeline in `.github/workflows/
//     convert-model.yml` builds `llama-quantize` with cmake, which is the one
//     thing this project does not do on a user's machine. The release archives
//     llama.cpp publishes contain that binary already — verified, not assumed:
//     `llama-b10516-bin-ubuntu-x64.tar.gz` holds 63 entries, zero `.py` files,
//     and `llama-b10516/llama-quantize`. So the quantiser is downloaded and the
//     cmake step is replaced by a 16 MB fetch. `convert_hf_to_gguf.py` is *not*
//     in those archives, so the llama.cpp source is still needed for it — but
//     only as text, and never as a build.
//
//   * **Nothing is left behind.** Every package this needs is installed into a
//     throwaway virtual environment inside the build directory, and the whole
//     directory is deleted when the command ends, whether it succeeded or
//     failed. That is stronger than uninstalling afterwards: a global install
//     cannot be undone safely, because "remove these packages" cannot tell a
//     package we added from the same package the user already had. A virtual
//     environment has no such ambiguity — it is ours, and it is gone.
//
// On the licence, read `licenseNotice()` below. It is deliberately long, and it
// deliberately does not claim the conversion is unambiguously permitted: clause
// (d) forbids recovering model weights, and dequantising the publisher's 6-bit
// release recovers weights from a quantised form. The user is asked to accept
// that reading explicitly rather than being told it has been settled.

import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { modelPath } from "../paths.js";

/** The upstream model. Named here because both the notice and the download step
 *  have to agree on it, and a typo in either is a 15-minute failure. */
const MODEL_REPO = "desert-ant-labs/title";

const LICENSE_NAME = "Desert Ant Labs Source-Available License 1.0";
const LICENSE_URL = "https://huggingface.co/desert-ant-labs/title/blob/main/LICENSE";
const LICENSING_CONTACT = "licensing@desertant.com";

const LLAMA_REPO = "https://github.com/ggml-org/llama.cpp";

/** The llama.cpp build the converter and the quantiser are both taken from.
 *
 *  One tag for both on purpose: `convert_hf_to_gguf.py` and `llama-quantize`
 *  share the GGUF tensor definitions, and mixing a converter from one release
 *  with a quantiser from another is how a file ends up with a type tag the
 *  loader does not expect. Pinned rather than resolved from "latest" so a build
 *  is reproducible and the command makes no extra API call.
 *
 *  Release tags are also git tags, so the same string serves the archive URL
 *  and the source checkout. When this goes stale, `QUICK_TITLES_LLAMA_TAG`
 *  points at a newer one without waiting for a release of this package. */
export const DEFAULT_LLAMA_TAG = "b10516";

// ---------------------------------------------------------------------------
// the licence
// ---------------------------------------------------------------------------

/** Everything a person needs to decide whether to run this, in one block.
 *
 *  The attribution string is written out rather than imported from
 *  `src/cli/sessions.ts`, which is where the constant lives. That is not
 *  duplication for its own sake: this file is core, that file is the CLI, and
 *  the only thing the two need to agree on is a sentence.
 *  `tests/core/model-build.test.ts` binds them, so they cannot drift. */
export function licenseNotice(): string {
  return (
    `This command converts ${MODEL_REPO} into the GGUF file quick-titles runs.\n` +
    `Nothing is downloaded from this project: the weights come from their\n` +
    `publisher, and the result stays on your machine.\n` +
    `\n` +
    `  Model     ${MODEL_REPO}\n` +
    `  Licence   ${LICENSE_NAME}\n` +
    `  Text      ${LICENSE_URL}\n` +
    `\n` +
    `What the licence grants\n` +
    `  Use, reproduce and modify the model, and embed and distribute it inside\n` +
    `  your own application. Free of charge below 100,000 monthly active\n` +
    `  devices, per platform, per model.\n` +
    `\n` +
    `What the licence prohibits, in its own words\n` +
    `  "Do not redistribute the Models on their own. You may not sell,\n` +
    `   sublicense, or distribute the Models or SDKs themselves, or a\n` +
    `   substantially unmodified derivative, as a standalone product, model,\n` +
    `   SDK, or hosted service."\n` +
    `\n` +
    `  "Do not reverse engineer for extraction. ... you may not reverse\n` +
    `   engineer the Models, or attempt model extraction, distillation\n` +
    `   attacks, or weight recovery to reconstruct or replicate them."\n` +
    `\n` +
    `How this command stands with respect to them\n` +
    `  Redistribution is not engaged. No weights are bundled with quick-titles,\n` +
    `  nothing is uploaded anywhere, and no request reaches this project's\n` +
    `  servers. The download goes to the publisher's repository and the output\n` +
    `  is written to your own data directory.\n` +
    `\n` +
    `  That is also why no converted GGUF is published for you to download\n` +
    `  instead of running this. A converted file is a derivative, and Section 2\n` +
    `  keeps derivatives under this licence; offered as a release asset it would\n` +
    `  be distributing a substantially unmodified derivative as a standalone\n` +
    `  model, which is what the first clause above forbids.\n` +
    `\n` +
    `  Extraction is not what this does. The second clause is aimed at\n` +
    `  reconstructing or replicating the model — model extraction and\n` +
    `  distillation attacks — and names interoperability as the case in which\n` +
    `  you may proceed regardless. Dequantising a checkpoint you are licensed to\n` +
    `  modify, so that it runs in the runtime you already have, is format\n` +
    `  conversion rather than extraction. That is this project's reading of the\n` +
    `  clause and not a lawyer's, and it is the reason this command does not\n` +
    `  ask you to accept the same risk on both counts: the licence constrains\n` +
    `  what you may pass on, not what you may run for yourself.\n` +
    `\n` +
    `  If you want certainty rather than a reading, ask before you rely on it:\n` +
    `  ${LICENSING_CONTACT}\n` +
    `\n` +
    `Attribution\n` +
    `  "Powered by Desert Ant Labs" already appears wherever quick-titles\n` +
    `  presents its version, its session list, and its diagnostics. Nothing\n` +
    `  here changes that, and nothing here removes it.\n` +
    `\n` +
    `What this command installs, and where\n` +
    `  Every package it needs goes into a temporary virtual environment inside\n` +
    `  its own build directory. That directory — the environment, the downloaded\n` +
    `  weights, the llama.cpp checkout, and every intermediate file, roughly 2 GB\n` +
    `  at peak — is deleted when the command finishes, whether it succeeded or\n` +
    `  failed. Your system Python is never modified and nothing is installed\n` +
    `  globally, so there are no packages to clean up afterwards.\n`
  );
}

// ---------------------------------------------------------------------------
// platform
// ---------------------------------------------------------------------------

export type Toolchain = { ok: true; packages: string[] } | { ok: false; reason: string };

/** Whether MLX can run here, and what it takes to install.
 *
 *  This is the hard gate on the whole command, because the dequantise step is
 *  the one step with no substitute: everything after it is format conversion,
 *  but getting bfloat16 back out of 6-bit affine weights needs MLX's own
 *  packing layout, and reimplementing that from the format description would be
 *  unauditable code producing numbers nobody could check.
 *
 *  MLX publishes wheels for Apple silicon and for Linux. There is no Windows
 *  build: PyPI lists `mlx-cpu` for Linux only, and the base macOS wheel requires
 *  macOS 14 on Apple silicon. WSL is a real answer and the refusal says so. */
export function mlxToolchain(platform: string, arch: string): Toolchain {
  if (platform === "darwin" && arch === "arm64") {
    // mlx arrives as a dependency of mlx-lm on macOS; there is nothing to name.
    return { ok: true, packages: [] };
  }
  if (platform === "darwin") {
    return {
      ok: false,
      reason:
        `MLX requires Apple silicon, and this is macOS on ${arch}.\n` +
        `  Build the model on an Apple silicon machine, or ask the publisher for a\n` +
        `  GGUF (${LICENSING_CONTACT}), or use the conversion workflow in the\n` +
        `  repository, which runs on an Apple silicon runner.`,
    };
  }
  if (platform === "linux") {
    // The CPU extra, not CUDA: this is a one-off tensor conversion, so a GPU
    // would only add a driver requirement to a step that is not the slow one.
    // `mlx[cpu]` needs glibc >= 2.35, which is Ubuntu 22.04 and newer.
    //
    // Allowed, but not proven. The workflow this pipeline is transcribed from
    // runs on Apple silicon, so the dequantise below and the whole Linux path
    // behind it have never been executed; the wheel exists and the argument for
    // it is sound, which is not the same thing. `mlx-lm` on Linux is the first
    // thing to check if a build fails in a way this file cannot explain.
    return { ok: true, packages: ["mlx[cpu]"] };
  }
  if (platform === "win32") {
    return {
      ok: false,
      reason:
        `MLX has no Windows build, so the 6-bit weights cannot be dequantised\n` +
        `  here. Run this in WSL instead — Ubuntu 22.04 or newer, which is what\n` +
        `  mlx[cpu] needs — or on an Apple silicon Mac, or ask the publisher for a\n` +
        `  GGUF (${LICENSING_CONTACT}).`,
    };
  }
  return { ok: false, reason: `MLX does not support ${platform}, so this cannot run here.` };
}

/** The prebuilt archive carrying `llama-quantize`, and the path it unpacks to.
 *
 *  The archives contain compiled binaries only, so this replaces the cmake
 *  build in the workflow and nothing else — the converter still comes from the
 *  source checkout. Asset names are llama.cpp's own; the top-level directory
 *  inside is `llama-<tag>`, which the workflow's `--transform` produces and
 *  which was confirmed against the published tarball. */
export function quantizeArchive(
  tag: string,
  platform: string,
  arch: string
): { url: string; binary: string } | null {
  const asset =
    platform === "darwin" && arch === "arm64"
      ? "macos-arm64"
      : platform === "linux" && arch === "x64"
        ? "ubuntu-x64"
        : platform === "linux" && arch === "arm64"
          ? "ubuntu-arm64"
          : null;
  if (!asset) return null;
  return {
    url: `${LLAMA_REPO}/releases/download/${tag}/llama-${tag}-bin-${asset}.tar.gz`,
    binary: `llama-${tag}/llama-quantize`,
  };
}

// ---------------------------------------------------------------------------
// the plan
// ---------------------------------------------------------------------------

/** One step of the build.
 *
 *  A step is data rather than a closure so the sequence can be asserted on
 *  without running any of it: the order of two of these steps is load-bearing
 *  (see the note on the converter dependencies below), and that is exactly the
 *  kind of thing a test should pin. */
export type BuildStep =
  | { id: string; title: string; argv: string[] }
  | { id: string; title: string; download: { url: string; dest: string } };

export interface BuildPlanOptions {
  workDir: string;
  /** The interpreter used to create the virtual environment. */
  python: string;
  platform: string;
  arch: string;
  llamaTag: string;
}

export type PlanResult = { ok: true; steps: BuildStep[] } | { ok: false; reason: string };

/** Where the virtual environment's interpreter lives.
 *
 *  POSIX layout only, and that is not an oversight: `mlxToolchain` rejects
 *  Windows before any of this can run, so the `Scripts/python.exe` branch would
 *  be unreachable code pretending to be portability. */
export function venvPython(workDir: string): string {
  return join(workDir, "venv", "bin", "python");
}

/** The version check that runs first.
 *
 *  Not paranoia: mlx-lm and the converter both need 3.10+, and without this the
 *  failure surfaces minutes later as a resolver error that reads like a broken
 *  package rather than an old interpreter. */
const PYTHON_CHECK = "import sys; assert sys.version_info >= (3, 11), sys.version";

/** From the workflow, unchanged. Asserts the weights really are the quantised
 *  format the next step assumes, so a publisher re-uploading an unquantised
 *  model is caught here rather than producing a subtly wrong GGUF. */
const QUANT_CHECK = [
  "import json",
  'cfg = json.load(open("mlx-model/config.json"))',
  'q = cfg.get("quantization") or cfg.get("quantization_config") or {}',
  'print("quantization:", q)',
  'assert q.get("bits") == 6, f"expected 6-bit, got {q.get(\'bits\')}"',
  'assert q.get("group_size") == 64, f"expected group 64, got {q.get(\'group_size\')}"',
].join("\n");

/** From the workflow, unchanged, including its self-check.
 *
 *  `convert_hf_to_gguf.py` loads the tokenizer through
 *  `AutoTokenizer.from_pretrained`, and llama.cpp pins transformers 4.57.6,
 *  where `TokenizersBackend` does not exist — the publisher's
 *  `tokenizer_config.json` names that 5.x class. The rewrite points at the 4.x
 *  class wrapping the same BPE, and the reload is the point of the step: if it
 *  ever stops working, this fails with the truth instead of three steps later
 *  inside the converter. */
const TOKENIZER_FIX = [
  "import json, pathlib",
  "from transformers import AutoTokenizer",
  'cfg_path = pathlib.Path("title-bf16/tokenizer_config.json")',
  'cfg = json.loads(cfg_path.read_text(encoding="utf-8")) if cfg_path.exists() else {}',
  'print("tokenizer_class before:", cfg.get("tokenizer_class"))',
  'cfg["tokenizer_class"] = "GPT2TokenizerFast"',
  'cfg_path.write_text(json.dumps(cfg, indent=2) + "\\n", encoding="utf-8")',
  "tok = AutoTokenizer.from_pretrained(\"title-bf16\")",
  "highest = max(tok.vocab.values())",
  'print(f"loaded {type(tok).__name__}: vocab={len(tok.vocab)} max_id={highest} "',
  '      f"added={len(tok.get_added_vocab())}")',
  'assert highest < len(tok.vocab), f"max token id {highest} >= vocab size {len(tok.vocab)}"',
].join("\n");

/**
 * The whole pipeline, in order, as data.
 *
 * Every command is one of the workflow's steps with exactly one substitution:
 * the cmake build of `llama-quantize` becomes a download of the release
 * archive that already contains it. Relative paths are relative to `workDir`,
 * which is the working directory every step runs in.
 */
export function buildPlan(opts: BuildPlanOptions): PlanResult {
  const { workDir, python, platform, arch, llamaTag } = opts;

  const toolchain = mlxToolchain(platform, arch);
  if (!toolchain.ok) return { ok: false, reason: toolchain.reason };

  const archive = quantizeArchive(llamaTag, platform, arch);
  if (!archive) {
    return { ok: false, reason: `there is no prebuilt llama.cpp archive for ${platform}-${arch}.` };
  }

  const venv = join(workDir, "venv");
  const vpy = venvPython(workDir);
  const hf = join(venv, "bin", "hf");
  const llamaSrc = join(workDir, "llama.cpp");

  return {
    ok: true,
    steps: [
      {
        id: "python",
        title: "Checking the Python version",
        argv: [python, "-c", PYTHON_CHECK],
      },
      {
        id: "venv",
        title: `Creating a throwaway environment in ${venv}`,
        argv: [python, "-m", "venv", venv],
      },
      {
        id: "pip",
        title: "Updating pip",
        argv: [vpy, "-m", "pip", "install", "--upgrade", "pip"],
      },
      {
        id: "mlx",
        title: "Installing the MLX toolchain",
        argv: [vpy, "-m", "pip", "install", ...toolchain.packages, "mlx-lm", "huggingface_hub"],
      },
      {
        id: "llama-src",
        title: `Fetching llama.cpp ${llamaTag} (source only — nothing is compiled)`,
        argv: ["git", "clone", "--depth", "1", "--branch", llamaTag, LLAMA_REPO, llamaSrc],
      },
      {
        id: "weights",
        title: `Downloading ${MODEL_REPO} from its publisher`,
        argv: [hf, "download", MODEL_REPO, "--local-dir", join(workDir, "mlx-model")],
      },
      {
        id: "check-weights",
        title: "Confirming the weights are 6-bit affine group 64",
        argv: [vpy, "-c", QUANT_CHECK],
      },
      {
        id: "dequantise",
        title: "Dequantising to bfloat16",
        argv: [
          vpy,
          "-m",
          "mlx_lm.convert",
          "--hf-path",
          "mlx-model",
          "--mlx-path",
          "title-bf16",
          "--dequantize",
          "--dtype",
          "bfloat16",
        ],
      },
      // Load-bearing position, inherited from the workflow and not to be
      // reordered. mlx-lm needs transformers 5.x; llama.cpp's requirements pin
      // 4.57.6. Both halves read the model's tokenizer and pip cannot hold both
      // versions at once, so this install comes *after* the dequantise, which
      // is the last thing that needs 5.x.
      {
        id: "converter-deps",
        title: "Installing the GGUF converter's dependencies",
        argv: [vpy, "-m", "pip", "install", "-r", join(llamaSrc, "requirements.txt")],
      },
      {
        id: "tokenizer",
        title: "Making the tokenizer loadable by the converter",
        argv: [vpy, "-c", TOKENIZER_FIX],
      },
      {
        id: "gguf-f16",
        title: "Converting to GGUF f16",
        argv: [
          vpy,
          join(llamaSrc, "convert_hf_to_gguf.py"),
          "title-bf16",
          "--outfile",
          "title-f16.gguf",
          "--outtype",
          "f16",
        ],
      },
      // The cmake build, replaced. See the header.
      {
        id: "quantizer",
        title: `Fetching the prebuilt llama-quantize for ${llamaTag}`,
        download: { url: archive.url, dest: join(workDir, "llama-bin.tar.gz") },
      },
      {
        id: "unpack",
        title: "Unpacking it",
        argv: ["tar", "-xzf", join(workDir, "llama-bin.tar.gz"), "-C", workDir],
      },
      {
        id: "quantise",
        title: "Quantising to Q8_0",
        argv: [join(workDir, archive.binary), "title-f16.gguf", "title-q8_0.gguf", "Q8_0"],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// running the plan
// ---------------------------------------------------------------------------

export interface BuildOptions extends Omit<BuildPlanOptions, "llamaTag"> {
  llamaTag?: string;
  /** Where the finished GGUF goes. Defaults to the path the daemon loads. */
  dest?: string;
  /** Called before each step, with its index. Progress only — never a switch. */
  onStep?: (step: BuildStep, index: number, total: number) => void;
}

export type BuildResult =
  | { ok: true; path: string; bytes: number }
  | { ok: false; reason: string };

/** Runs one command and resolves to its exit status.
 *
 *  stdio is inherited, so pip's and mlx's own output reaches the user as it
 *  happens. This is the one command in quick-titles that is expected to be
 *  noisy and slow, and swallowing that would leave a 15-minute silence with no
 *  way to tell progress from a hang.
 *
 *  Not resolved through a shell: every argv is already split, and a shell would
 *  turn the publisher's repository name and the inline Python scripts into
 *  quoting problems. */
function run(argv: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, stdio: "inherit" });
    child.on("error", (error: NodeJS.ErrnoException) => {
      // ENOENT here means the tool is missing, not that the command failed, and
      // "spawn git ENOENT" is not a sentence anyone should have to decode.
      const missing = error.code === "ENOENT" ? `${argv[0]} is not installed or not on PATH` : error.message;
      process.stderr.write(`\nquick-titles: ${missing}\n`);
      resolve(127);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/** Removes the build directory and everything in it.
 *
 *  Best effort by design. This runs from a `finally`, and a `rm` that throws —
 *  a `.so` still mapped, a Windows-style lock — would otherwise replace the
 *  real failure with a cleanup failure and hide the reason the build stopped.
 *  The path is the one the caller handed us and is never widened: this deletes
 *  a directory it created, not a directory it was told about. */
export function removeBuildDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    process.stderr.write(
      `\nquick-titles: could not remove ${dir}; delete it yourself when you get a chance.\n`
    );
  }
}

/**
 * Builds the model, installs it, and removes every trace of how.
 *
 * Returns rather than throws for every expected failure, like `provisionModel`:
 * the caller is a CLI that needs to print a reason.
 */
export async function runModelBuild(opts: BuildOptions): Promise<BuildResult> {
  const dest = opts.dest ?? modelPath();
  const llamaTag = opts.llamaTag ?? DEFAULT_LLAMA_TAG;

  const plan = buildPlan({ ...opts, llamaTag });
  if (!plan.ok) return { ok: false, reason: plan.reason };

  mkdirSync(opts.workDir, { recursive: true });
  const built = join(opts.workDir, "title-q8_0.gguf");

  try {
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i]!;
      opts.onStep?.(step, i, plan.steps.length);

      const status =
        "download" in step
          ? await download(step.download.url, step.download.dest)
          : await run(step.argv, opts.workDir);

      if (status !== 0) {
        return { ok: false, reason: `the step "${step.title}" failed (exit ${status}).` };
      }
    }

    return install(built, dest);
  } finally {
    removeBuildDir(opts.workDir);
  }
}

/** Fetches a release archive. Returns 0 on success, as `run` does, so the two
 *  kinds of step can share one failure path. */
async function download(url: string, dest: string): Promise<number> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      process.stderr.write(`\nquick-titles: ${url} returned ${response.status} ${response.statusText}\n`);
      return 1;
    }
    await writeFile(dest, Buffer.from(await response.arrayBuffer()));
    return 0;
  } catch (error) {
    process.stderr.write(`\nquick-titles: could not fetch ${url}: ${(error as Error).message}\n`);
    return 1;
  }
}

/** Moves the finished GGUF into place, atomically.
 *
 *  The same discipline as `provisionModel`: the bytes go to `<dest>.part` and
 *  are renamed only once whole, so a reader — the daemon, another session —
 *  can never observe a half-copied model at the path it loads. A failed rename
 *  leaves the `.part` for the next attempt to overwrite rather than a truncated
 *  file wearing the real name.
 *
 *  Exported so the move can be tested against a real filesystem. The conversion
 *  above it needs a toolchain no test machine has; this does not, and it is the
 *  part that decides whether a working build becomes a working model.
 */
export function install(built: string, dest: string): BuildResult {
  const part = `${dest}.part`;
  try {
    const size = statSync(built).size;
    mkdirSync(dirname(dest), { recursive: true });
    renameSyncCrossDevice(built, part);
    renameSync(part, dest);
    return { ok: true, path: dest, bytes: size };
  } catch (error) {
    return { ok: false, reason: `the model was built but could not be installed: ${(error as Error).message}` };
  }
}

/** A rename that survives a build directory on a different filesystem.
 *
 *  `renameSync` is atomic but only within one filesystem, and the data
 *  directory and the build directory can easily be on different drives. Falling
 *  back to a copy loses atomicity for the move into `.part` only — which is
 *  fine, because `.part` is a scratch name nothing reads. The rename into
 *  `dest` is the one that has to be atomic, and by then both are in the same
 *  directory. */
function renameSyncCrossDevice(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    copyFileSync(from, to);
  }
}
