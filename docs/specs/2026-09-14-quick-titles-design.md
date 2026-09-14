# quick-titles — Design

**Date:** 2026-09-14
**Status:** approved for planning

## Goal

Generate session titles and one-line descriptions locally, on-device, for coding agents —
Claude Code, Codex CLI, opencode2, and Pi — with no API call and no data leaving the machine.

## Non-goals

- **Session recap / away-summary.** Rejected. Recap is state reconstruction (what happened,
  what's decided, what's next), not summarization of a passage. The model is a 0.4B
  task-specific fine-tune trained against one instruction; the model card states a paraphrase
  is a different task to it. Different task, wrong model.
- **Titles for ChatGPT-app Codex threads.** Read-only at best. Those titles live on OpenAI's
  servers; the local row in `codex-dev.db → local_thread_catalog` is a replica the app
  overwrites on sync. No local file is authoritative and no local push path exists.
- **NPU acceleration.** llama.cpp has no NPU path. GPU (Metal/CUDA/Vulkan) or CPU only.
- **Redistributing the model weights.** The license permits embedding weights in an app and
  shipping the app; it forbids distributing them as a standalone model.

## Constraints

| Constraint | Consequence |
|---|---|
| Desert Ant Labs Source-Available License 1.0 | Free below 100k monthly active devices **per platform**. Attribution required — a legal obligation, not courtesy. No publishing the GGUF as a downloadable model. "No weight recovery" clause is a grey area for dequantisation; get legal review before scaling. |
| Model is MLX-only, Apple silicon | Weights must be converted to GGUF on a macOS runner. |
| Plugin install runs `npm ci --ignore-scripts`, 60s cap | GPU binaries and the GGUF **cannot** be fetched at install time. Provision at first daemon start. |
| CUDA on Windows needs CUDA Toolkit 13.1+ (12.4+ for 12.x) | Without it node-llama-cpp silently builds from source — "up to an hour". `build: "never"` + `skipDownload: true` and a CPU fallback. Vulkan needs only drivers and is the realistic default. |
| Model quality unverified | The model card gives no benchmarks and no independent review. Task 3 is a hard gate; if it fails, the project stops and re-evaluates rather than building adapters around a model that cannot do the job. |

## Measured facts that drive the design

From the runtime probe (Windows, RTX 4050, `granite-4.0-h-350m` Q4_K_M, node-llama-cpp 3.21.1):

- Prebuilt binaries resolved for all four Windows variants. **Zero compilation.**
- GPU auto-selection chose **Vulkan**, not CUDA — CUDA runtime absent even with an NVIDIA GPU
  present. This is what real users will get.
- Process start to ready: **4.8–5.6 s**. Same-process reload: **3.67–4.54 s** — no faster than
  cold, because the cost is model *init*, not disk.
- Serving a prompt from a resident model: **150–450 ms** at 120–169 tok/s.

**Therefore a resident daemon is required.** Per-prompt process spawn cannot work.

From the Claude Code probe (2.1.270, Windows):

- `hookSpecificOutput.sessionTitle` works from `SessionStart` **and** `UserPromptSubmit`.
- Persisted as `{"type":"custom-title","customTitle":"..."}`.
- It **suppresses** the built-in titler — the control run emitted
  `"query_source":"generate_session_title"`, the probe runs did not.
- The title is real session identity: usable as a `--resume` handle.

## Architecture

One daemon per machine, many thin adapters.

```
  Claude Code plugin ─┐
  Codex CLI hook ─────┤
  opencode2 plugin ───┼──► quick-titles daemon ──► node-llama-cpp ──► GGUF
  Pi extension ───────┤        (resident model)         (Vulkan/CUDA/Metal/CPU)
  quick-titles CLI ───┘              │
                                     └──► SQLite store (title + description)
```

The daemon exists because model load is ~5 s and never gets faster. It is the only component
that touches the model. Everything else is a client.

**Why one shared daemon rather than four agent-native hosts:** Claude Code hooks and Codex
hooks are *spawned processes* — there is no long-lived host to embed in. Pi extensions and
opencode2 plugins *are* long-lived, but giving each its own loaded model would mean four
resident copies of the same weights. One daemon serves all four.

### Components

**`core/prompt`** — builds the exact input the model was trained on. The model card is explicit
that a paraphrase is a different task, so `Titles.prompt` wording and `chat_template.jinja` are
ported verbatim and treated as immutable constants.

**`core/parse`** — lenient `TITLE:` / `DESC:` extraction. The card advises degrading to a
usable title rather than throwing, and documents a bug where descriptions open with a stock
phrase the instruction forbids. Strips that phrase; never throws.

**`core/inference`** — node-llama-cpp wrapper. Auto-detects GPU, **prebuilt binaries only**
(`build: "never"`, `skipDownload: true`), falls back to CPU rather than compiling. Ports a
context with `sequences: N > 1`.

**`core/session`** — reads a transcript and produces a bounded clip. One reader per agent, one
shared clip-builder. The clip is what the model sees; bounding it is what keeps latency flat.

**`core/store`** — SQLite. Holds what host agents do not: the description, the backend used,
the model version, the timestamp. Titles are also mirrored here so `/sessions` can list
sessions across agents in one place.

**`daemon`** — holds the model, serves requests over a local socket (Unix domain socket;
named pipe on Windows). Owns provisioning on first start.

**`adapters/*`** — one per agent. Each is thin and degrades honestly.

### Adapter capability matrix

| Agent | Trigger | Set title | Mode | Verified |
|---|---|---|---|---|
| Claude Code | `SessionStart` / `UserPromptSubmit` hooks | `hookSpecificOutput.sessionTitle` | **replace** (suppresses built-in) | yes, empirically |
| opencode2 | plugin `ctx.event.subscribe()` | `ctx.session.rename({sessionID, title})` | **replace** | mechanism documented, not exercised |
| Codex CLI | `notify` callback | app-server RPC `thread/name/set` | **replace** | mechanism documented, not exercised |
| Pi | `pi.on("session_start" \| "turn_end")` | `pi.setSessionName(name)` | **add** (Pi has no titles at all) | mechanism documented, not exercised |
| ChatGPT app Codex | — | — | **out of reach**, read-only | yes |

Notes:

- opencode2's own titler can alternatively be intercepted outright via
  `ctx.session.hook("title")`. Its placeholder titles match
  `^(New session|Child session) - <ISO8601>$`, a precise "still default" detector.
- Codex hooks **cannot** set a title — their return values have no title field. Hooks may only
  *trigger* us. `notify` is simpler and has no trust gate. Never write `state_5.sqlite`
  directly; it is documented as unsafe while Codex runs.
- Codex keeps the generated title in `threads.name`, mirrored in `session_index.jsonl →
  thread_name` and `codex-dev.db → local_thread_catalog.display_title`. All three must agree.
- Pi stores names as a `session_info` JSONL entry.
- opencode2 stores its title in a SQLite `title` column (`session_v2`).

## Model pipeline

Runs on a GitHub Actions macOS runner (Apple silicon required by MLX):

```
mlx_lm.convert --dequantize     # mx.dequantize handles 6-bit affine, group 64
convert_hf_to_gguf.py --outtype f16
llama-quantize ... Q8_0
```

Q8_0 rather than f16 or Q6_K: the source is already 6-bit, so f16 buys nothing real and Q6_K
stacks a second quantisation on top of the first. Output published as a release asset with a
SHA-256, fetched by the daemon on first start.

## Failure modes

Every one of these must degrade silently. A titler that breaks someone's session is worse than
no titler.

| Failure | Behaviour |
|---|---|
| Model not yet provisioned | Title arrives late rather than blocking. Never block a prompt. |
| No prebuilt binary for the platform | Fall back to CPU prebuilt. If none, disable and log. |
| Daemon not running | Adapter attempts one start; on failure, no-ops. |
| Slow inference | Hard timeout, abandon the pass. |
| Malformed model output | `core/parse` degrades to a usable title or returns nothing. |
| Host agent changes its API | Adapter no-ops. Never write host storage directly as a fallback. |

## Testing strategy

- **Unit:** prompt construction (byte-exact against the template), parser (including the
  stock-phrase bug and truncated output), clip bounding.
- **Integration:** inference against a small fixture GGUF; daemon IPC round-trip.
- **Golden quality:** a fixed set of transcripts scored for title quality. This is the gate in
  Task 3 and it re-runs whenever the model version changes.
- **Adapter contract tests:** each adapter asserted to no-op cleanly when the daemon is absent.
  Adapters are not integration-tested against live agents in CI.

## Attribution

"Powered by Desert Ant Labs" in the README, in `quick-titles --version`, in the `/sessions`
output, and in the daemon's startup log. Required by the licence.

## Open risks

1. **Model quality.** Unverified. Nothing downstream is worth building if Task 3 fails.
2. **`sessionTitle` is undocumented.** Verified empirically on 2.1.270, but if Anthropic removes
   it the Claude Code adapter silently stops working. Design for graceful no-op.
3. **`--ignore-scripts` at plugin install** may break node-llama-cpp's own binary resolution.
   Untested. Provisioning must therefore not depend on it.
4. **CUDA packaging.** Whether `win-x64-cuda-ext` bundles the CUDA runtime is unverified.
