// Tests for `quick-titles model-build`.
//
// The conversion itself needs a Python toolchain, a 294 MB download and half an
// hour, so it is not something a test can run — and pretending otherwise with a
// stubbed toolchain would assert that the code calls the commands the code
// calls. What is testable is everything that decides whether the conversion is
// *allowed to start* and what is left on disk afterwards, and that is what is
// covered here:
//
//   * the platform gate, which is the difference between a clear refusal and a
//     thirty-minute failure on a machine that never had a chance;
//   * the licence notice, which has to name the clauses it is asking the user
//     to accept rather than waving at them;
//   * the shape and order of the plan, including the one ordering constraint
//     inherited from the workflow and the absence of any compile step;
//   * the teardown, which is the property a user is least able to check and
//     most likely to be surprised by.
//
// Nothing here spawns a real toolchain, and nothing is written outside
// <repo>/.tmp.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPlan,
  install,
  licenseNotice,
  mlxToolchain,
  quantizeArchive,
  removeBuildDir,
  runModelBuild,
  venvPython,
  DEFAULT_LLAMA_TAG,
  type BuildStep,
} from "../../src/core/model-build.js";
import { ATTRIBUTION } from "../../src/cli/sessions.js";
import { cleanupTempDirs, tempDirSync } from "../helpers/tmp.js";

afterEach(cleanupTempDirs);

/** A plan for a platform that is supported, so the gate is not what is under
 *  test. `darwin`/`arm64` is the combination the repository's own CI uses. */
function steps(platform = "darwin", arch = "arm64"): BuildStep[] {
  const plan = buildPlan({
    workDir: tempDirSync("qt-build-"),
    python: "python3",
    platform,
    arch,
    llamaTag: DEFAULT_LLAMA_TAG,
  });
  if (!plan.ok) throw new Error(`expected a plan, got: ${plan.reason}`);
  return plan.steps;
}

/** The step with this id. Throws rather than returning undefined, so a renamed
 *  step fails here instead of quietly making an assertion vacuous. */
function step(steps: BuildStep[], id: string): BuildStep {
  const found = steps.find((s) => s.id === id);
  if (!found) throw new Error(`no step "${id}"; have: ${steps.map((s) => s.id).join(", ")}`);
  return found;
}

function argvOf(s: BuildStep): string[] {
  if (!("argv" in s)) throw new Error(`step "${s.id}" is not a command`);
  return s.argv;
}

describe("mlxToolchain", () => {
  it("allows macOS on Apple silicon, where mlx-lm brings mlx itself", () => {
    expect(mlxToolchain("darwin", "arm64")).toEqual({ ok: true, packages: [] });
  });

  it("allows Linux, naming the CPU build of MLX explicitly", () => {
    // Not the default `pip install mlx`: on Linux the base wheel is macOS-only
    // and the platform package has to be asked for by name.
    const result = mlxToolchain("linux", "x64");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.packages).toContain("mlx[cpu]");
  });

  it("refuses Intel macOS, and says why rather than failing later", () => {
    const result = mlxToolchain("darwin", "x64");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("Apple silicon");
  });

  it("refuses Windows and points at WSL", () => {
    const result = mlxToolchain("win32", "x64");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("WSL");
      // The refusal has to be actionable on its own: without a route to a GGUF
      // it is just a wall.
      expect(result.reason).toContain("GGUF");
    }
  });
});

describe("licenseNotice", () => {
  const notice = licenseNotice();

  it("names the model, the licence, and where to read it", () => {
    expect(notice).toContain("desert-ant-labs/title");
    expect(notice).toContain("Desert Ant Labs Source-Available License 1.0");
    expect(notice).toContain("https://huggingface.co/desert-ant-labs/title/blob/main/LICENSE");
  });

  it("quotes the two clauses the conversion has to be measured against", () => {
    // Both clauses are reproduced rather than paraphrased: the redistribution
    // clause turns on "substantially unmodified derivative" and "standalone",
    // and the extraction clause turns on "to reconstruct or replicate them",
    // and a summary drops exactly those words.
    expect(notice).toContain("Do not redistribute the Models on their own");
    expect(notice).toContain("substantially unmodified derivative");
    expect(notice).toContain("Do not reverse engineer for extraction");
    expect(notice).toContain("to reconstruct or replicate them");
  });

  it("separates the clause that constrains distribution from the one that does not", () => {
    // The two clauses point in opposite directions and the notice is only
    // honest if it says so: redistribution is the binding constraint, and
    // extraction is not what a dequantise for interoperability is. Collapsing
    // them into one warning would be the over-cautious version of a false
    // claim, which is still a false claim.
    expect(notice).toContain("Redistribution is not engaged");
    expect(notice).toContain("Extraction is not what this does");
    expect(notice.toLowerCase()).toContain("dequantis");
    expect(notice).toContain("not a lawyer's");
    expect(notice).toContain("licensing@desertant.com");
  });

  it("carries the attribution string the licence requires, verbatim", () => {
    // Binds this file's copy to the one the rest of the tool prints, so the two
    // cannot drift apart silently.
    expect(notice).toContain(ATTRIBUTION);
  });

  it("states where everything is installed and that it is removed", () => {
    expect(notice).toContain("virtual environment");
    expect(notice).toContain("never modified");
  });
});

describe("quantizeArchive", () => {
  it("names the release asset for each platform MLX supports", () => {
    expect(quantizeArchive("b10516", "darwin", "arm64")?.url).toBe(
      "https://github.com/ggml-org/llama.cpp/releases/download/b10516/llama-b10516-bin-macos-arm64.tar.gz"
    );
    expect(quantizeArchive("b10516", "linux", "x64")?.url).toContain("llama-b10516-bin-ubuntu-x64.tar.gz");
    expect(quantizeArchive("b10516", "linux", "arm64")?.url).toContain("llama-b10516-bin-ubuntu-arm64.tar.gz");
  });

  it("points at the binary the archive actually contains", () => {
    // Verified against the published tarball: `llama-b10516-bin-ubuntu-x64`
    // unpacks to a top-level `llama-b10516/`, and `llama-b10516/` holds 63
    // entries and zero .py files. Both halves of this path come from that.
    expect(quantizeArchive("b10516", "linux", "x64")?.binary).toBe("llama-b10516/llama-quantize");
  });

  it("has nothing to offer where MLX cannot run", () => {
    expect(quantizeArchive("b10516", "win32", "x64")).toBeNull();
  });
});

describe("buildPlan", () => {
  it("refuses before producing steps on an unsupported platform", () => {
    const plan = buildPlan({
      workDir: "/tmp/irrelevant",
      python: "python3",
      platform: "win32",
      arch: "x64",
      llamaTag: DEFAULT_LLAMA_TAG,
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toContain("WSL");
  });

  it("never compiles anything", () => {
    // The rule the project is built on. `llama-quantize` is the one binary the
    // workflow builds with cmake, and it is the reason the release archive is
    // downloaded instead.
    const plan = steps();
    for (const s of plan) {
      if (!("argv" in s)) continue;
      const line = s.argv.join(" ");
      expect(line).not.toContain("cmake");
      expect(line).not.toContain("--build");
      expect(line).not.toContain("-DLLAMA");
    }
  });

  it("installs the converter's dependencies after the dequantise, not before", () => {
    // The one ordering constraint inherited from the workflow. mlx-lm needs
    // transformers 5.x and llama.cpp's requirements pin 4.57.6; pip cannot hold
    // both, so moving the install earlier breaks the dequantise with a
    // tokenizer error two steps later.
    const ids = steps().map((s) => s.id);
    expect(ids.indexOf("converter-deps")).toBeGreaterThan(ids.indexOf("dequantise"));
  });

  it("fetches the quantiser as a prebuilt binary rather than building it", () => {
    const plan = steps();
    const quantizer = step(plan, "quantizer");
    expect("download" in quantizer).toBe(true);
    if ("download" in quantizer) {
      expect(quantizer.download.url).toContain("github.com/ggml-org/llama.cpp/releases/download/");
    }
    expect(argvOf(step(plan, "quantise"))[0]).toContain("llama-quantize");
  });

  it("takes the converter and the quantiser from the same llama.cpp tag", () => {
    // Mixing a converter from one release with a quantiser from another is how
    // a file ends up with a tensor type the loader does not expect.
    const plan = steps();
    const clone = argvOf(step(plan, "llama-src"));
    expect(clone).toContain(DEFAULT_LLAMA_TAG);
    expect(argvOf(step(plan, "gguf-f16")).some((a) => a.endsWith("convert_hf_to_gguf.py"))).toBe(true);
    expect(argvOf(step(plan, "quantise"))[0]).toContain(DEFAULT_LLAMA_TAG);
  });

  it("checks the weights are the quantised format before dequantising them", () => {
    // If the publisher re-uploads an unquantised model, `--dequantize` is wrong
    // in a way that produces a plausible-looking GGUF, so this has to come
    // first.
    const ids = steps().map((s) => s.id);
    expect(ids.indexOf("check-weights")).toBeLessThan(ids.indexOf("dequantise"));
    expect(argvOf(step(steps(), "check-weights")).join(" ")).toContain("group_size");
  });

  it("runs the MLX install with the platform's packages", () => {
    const mlx = argvOf(step(steps("linux", "x64"), "mlx")).join(" ");
    expect(mlx).toContain("mlx[cpu]");
    expect(mlx).toContain("mlx-lm");
  });

  it("sends every command through the throwaway environment's interpreter", () => {
    // The cleanup guarantee rests on this: if a step ran the system Python, pip
    // would install into it and there would be packages left behind that
    // deleting the build directory cannot undo.
    const workDir = tempDirSync("qt-build-");
    const plan = buildPlan({
      workDir,
      python: "python3",
      platform: "darwin",
      arch: "arm64",
      llamaTag: DEFAULT_LLAMA_TAG,
    });
    if (!plan.ok) throw new Error(plan.reason);

    const venv = venvPython(workDir);
    for (const s of plan.steps) {
      if (!("argv" in s) || s.id === "python" || s.id === "venv" || s.id === "llama-src") continue;
      const program = s.argv[0]!;
      // `tar` and the tree's own binary are not interpreters; everything that
      // is must be the venv's.
      if (program === "tar" || program.includes("llama-quantize")) continue;
      expect(program.startsWith(join(workDir, "venv"))).toBe(true);
    }
    expect(venv).toBe(join(workDir, "venv", "bin", "python"));
  });
});

describe("removeBuildDir", () => {
  it("removes a populated build directory", () => {
    const dir = tempDirSync("qt-rm-");
    mkdirSync(join(dir, "venv", "bin"), { recursive: true });
    writeFileSync(join(dir, "venv", "bin", "python"), "stub");
    writeFileSync(join(dir, "title-f16.gguf"), "700 MB of intermediate");

    removeBuildDir(dir);

    expect(existsSync(dir)).toBe(false);
  });

  it("is silent when there is nothing to remove", () => {
    // It runs from a `finally`, including on the paths that never created the
    // directory — a refusal at the platform gate, for instance.
    expect(() => removeBuildDir(join(tempDirSync("qt-rm-"), "never-created"))).not.toThrow();
  });
});

describe("install", () => {
  it("moves the built model to its destination", () => {
    const work = tempDirSync("qt-inst-");
    const data = tempDirSync("qt-inst-");
    const built = join(work, "title-q8_0.gguf");
    writeFileSync(built, "weights");
    const dest = join(data, "models", "title-q8_0.gguf");

    const result = install(built, dest);

    expect(result).toEqual({ ok: true, path: dest, bytes: 7 });
    expect(readFileSync(dest, "utf8")).toBe("weights");
    // The directory did not exist and had to be made.
    expect(existsSync(built)).toBe(false);
  });

  it("leaves no .part file behind", () => {
    const work = tempDirSync("qt-inst-");
    const data = tempDirSync("qt-inst-");
    const built = join(work, "title-q8_0.gguf");
    writeFileSync(built, "weights");
    const dest = join(data, "title-q8_0.gguf");

    install(built, dest);

    // A `.part` next to a finished model is the kind of thing a later `doctor`
    // or a directory scan reads as a half-installed model.
    expect(readdirSync(data)).toEqual(["title-q8_0.gguf"]);
  });

  it("reports rather than throws when the build produced no file", () => {
    // Every step can report success and still leave nothing, if a tool is
    // replaced by a stub — and a CLI that turns that into an unhandled
    // exception prints a stack trace instead of the reason.
    const result = install(join(tempDirSync("qt-inst-"), "absent.gguf"), join(tempDirSync("qt-inst-"), "m.gguf"));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("could not be installed");
  });
});

describe("runModelBuild", () => {
  it("removes its build directory when a step fails", () => {
    // The property the command exists to keep, and the one a user cannot check
    // for themselves. The interpreter is deliberately one that cannot exist, so
    // the plan fails at its first step without running anything: what is under
    // test is the teardown, not the toolchain.
    const workDir = join(tempDirSync("qt-run-"), "build");

    return runModelBuild({
      workDir,
      python: "quick-titles-no-such-interpreter",
      platform: "darwin",
      arch: "arm64",
      dest: join(tempDirSync("qt-run-"), "title-q8_0.gguf"),
    }).then((result) => {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("Checking the Python version");
      expect(existsSync(workDir)).toBe(false);
    });
  });

  it("does not run a step when the platform is not supported", async () => {
    const workDir = join(tempDirSync("qt-run-"), "build");
    const dest = join(tempDirSync("qt-run-"), "title-q8_0.gguf");

    const result = await runModelBuild({
      workDir,
      python: "python3",
      platform: "win32",
      arch: "x64",
      dest,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("WSL");
    // Nothing was created, so there is nothing to have cleaned up.
    expect(existsSync(workDir)).toBe(false);
    expect(existsSync(dest)).toBe(false);
  });
});
