# Installing quick-titles

## Status

v0.1.0 is in development. The npm package is **not published yet**, so the `npx quick-titles …`
commands below do not resolve today. Everything else in this document — the platform behaviour, the
provisioning behaviour, the GPU rules — describes the code in this repository and has been tested.

## Requirements

- **Node 20 or newer.** No other runtime, no Python, no build tools.
- **~380 MB of free disk** for the model, fetched once. See [Getting the model](#getting-the-model).

quick-titles ships prebuilt llama.cpp binaries through `node-llama-cpp` and is configured with
`build: "never"`. Installing it never compiles anything — not even on a machine without a compiler.

The one exception is `quick-titles model-build`, which converts the model locally and needs Python
and `git` to do it. It is opt-in, it is not part of any install path, and it does not compile
anything either. [Getting the model](#getting-the-model) has the details.

## Per-agent installation

**Claude Code**

```bash
npx quick-titles install claude-code
```

**Codex CLI**

```bash
npx quick-titles install codex
```

**opencode2** (beta)

```bash
npx quick-titles install opencode2
```

**Pi**

```bash
npx quick-titles install pi
```

Each installer is idempotent and refuses to overwrite configuration it did not write. In particular,
the Codex installer will not clobber an existing `notify` entry in `~/.codex/config.toml` — `notify`
is a single-valued key, and silently replacing another tool's notifier would be worse than declining.

## GPU acceleration

| Platform | Backend | What you need |
|---|---|---|
| Windows | **Vulkan** (default) | GPU drivers only. Nothing else. |
| Windows | CUDA | Used automatically **only if** the CUDA Toolkit is already installed (13.1+, or 12.4+ for 12.x). quick-titles never installs it for you. |
| macOS | Metal | Built in. |
| Linux | Vulkan or CUDA | As your driver stack provides. |
| Any | CPU | Always available as a fallback. Slower; still under a few seconds. |

**NPUs are not supported.** llama.cpp does not target them. If you have an NPU, quick-titles will
use your GPU or CPU and ignore it.

To see which backend actually loaded:

```bash
npx quick-titles doctor
```

## Getting the model

The model is not committed to this repository and is not fetched implicitly. It is one ~380 MB file
in your platform's data directory (`%LOCALAPPDATA%\quick-titles` on Windows,
`~/Library/Application Support/quick-titles` on macOS, `$XDG_DATA_HOME/quick-titles` on Linux), and
there are two ways to put it there.

**1. Let quick-titles fetch it**

```bash
npx quick-titles provision
```

This streams the file to `title-q8_0.gguf.part`, hashes it as it arrives, and renames it into place
only once the digest matches — so an interrupted or corrupted transfer can never be mistaken for a
working model. A `.part` file is discarded on any failure, and a run that finds a model already in
place makes no request at all.

**This build does not yet have a published weights URL**, so `provision` currently stops and says so
rather than guessing at one. The repository is private and the weights are a conversion of
`desert-ant-labs/title`, which is source-available rather than open — hosting them is a decision that
has not been made yet. Until it is, `provision` works as soon as a URL and digest are supplied:

```bash
QUICK_TITLES_MODEL_URL=https://… QUICK_TITLES_MODEL_SHA256=<hex> npx quick-titles provision
```

**2. Build it here from the publisher's weights**

```bash
npx quick-titles model-build --accept-license
```

This converts `desert-ant-labs/title` into the GGUF, on your machine, out of the weights the publisher
publishes. Nothing is fetched from this project and nothing is uploaded anywhere; the result is
written straight to the data directory.

It is the slow path, and it is deliberately not part of `install`. Expect **10 to 20 minutes** and
about **2 GB of disk at peak**, and these requirements — which nothing else in quick-titles needs:

| | |
|---|---|
| Platform | Apple silicon macOS, or Linux with glibc 2.35+ (Ubuntu 22.04 and newer). **No Windows** — MLX ships no Windows build; use WSL. |
| Tools | Python 3.11+, `git` |
| Network | Two downloads: the weights (~294 MB) and a prebuilt llama.cpp archive (~16 MB) |

**Which platforms have actually been run.** Only Apple silicon macOS. That is what
`.github/workflows/convert-model.yml` executes, and the pipeline below is transcribed from it. The
Linux path is real — `mlx[cpu]` is a published wheel and the command is otherwise identical — but
nobody has run this end to end on Linux, and the `mlx[cpu]` dequantise in particular is the step with
no substitute if it turns out not to work there. Treat a first Linux run as the test that it is, and
[open an issue](https://github.com/asterxsk/quick-titles/issues) either way.

Nothing is compiled. `llama-quantize` comes from llama.cpp's published release binaries rather than
being built with cmake — the one place quick-titles would otherwise need a compiler.

Everything it installs goes into a virtual environment inside its own build directory, and that whole
directory is deleted when the command ends, whether it succeeded or failed. Your system Python is
never modified and no packages are installed globally, so there is nothing left to uninstall.

**Read what it prints before you pass `--accept-license`.** The weights are under the Desert Ant Labs
Source-Available License 1.0, not an open-source licence, and the command explains what that licence
grants and what it forbids. Two clauses matter, and they point opposite ways.

**Distribution.** The licence forbids distributing the model "or a substantially unmodified
derivative … as a standalone product, model, SDK, or hosted service". That is the binding constraint
on this project: it is why no converted GGUF is published for you to download instead of running
this command. It is not a constraint on the conversion itself.

**Extraction.** The licence also forbids reverse engineering "for extraction" — model extraction,
distillation, "weight recovery **to reconstruct or replicate them**" — and excepts the interoperability
right your local law gives you. Dequantising a checkpoint you are licensed to modify, so that it runs
in the runtime you already have, is format conversion, not reconstruction of their model.

That reading is this project's, not a lawyer's, and the command says so on screen rather than
presenting it as settled. If you want certainty before relying on it, ask:
`licensing@desertant.com`. Note also that the licence is free below **100,000 monthly active
devices** and needs a commercial licence above that — see [LICENSE-NOTICE.md](../LICENSE-NOTICE.md).

**3. Supply your own**

Point `QT_MODEL` at a GGUF you converted yourself (see [plan](../docs/plans/2026-09-14-quick-titles.md)
for the conversion pipeline):

```bash
QT_MODEL=/path/to/title-q8_0.gguf npx quick-titles doctor
```

`QT_MODEL` takes precedence over the data directory entirely, and setting it to an empty value means
"not set" rather than "the current directory".

## Seeing what was generated

The title goes into your agent's own session list, where it belongs. The description has nowhere to
live in any host, so quick-titles keeps its own store and shows both together:

```bash
npx quick-titles sessions
```

In Claude Code the same listing is a slash command:

```
/sessions
```

It reads the store directly, so it works whether or not the daemon happens to be running, and it needs
no model and no network. The listing ends with the attribution line the model's licence requires.

## After the first run

Every title after the first is fully offline. `provision` and `model-build` are the only commands
that make a network request — both one-time, both yours to run — and a title request never triggers
one: if the model is missing, the adapters do nothing and your host's own title stands.

## Uninstalling

```bash
npx quick-titles uninstall
```

With no agent named, every agent is attempted. Name one to remove just that one:

```bash
npx quick-titles uninstall opencode2
```

What each one removes:

| Agent | What goes |
|---|---|
| Claude Code | The plugin, then the marketplace registration that held it |
| Codex CLI | The `notify` line this tool added to `config.toml`, and nothing else in the file |
| opencode2 | The installed plugin file, project-local or global |
| Pi | The installed extension file |

Three properties hold across all four. **Undeclared files are never touched:** each installed file
begins with a marker line naming this tool, and a file without it is left alone with a message rather
than deleted — the installed files are named `quick-titles.ts` inside directories you also own, so a
name collision is not far-fetched, and deleting a file we did not write is unrecoverable. **A foreign
`notify` entry is refused:** the Codex uninstaller only removes an entry whose script path is this
tool's; if another tool owns that key, it says so and changes nothing. **Running it twice is
harmless:** "not installed" is the state the command exists to produce, so the second run reports that
and exits zero.

The model is kept. It is a 357 MB download that nothing else reads, and leaving it means a reinstall
does not fetch it again; `doctor` reports the path if you want to delete it yourself. Your generated
titles are kept too — they are a plain append-only file in the data directory, and they are yours.

One case does not resolve on its own: if the extension was installed into a custom directory — a
`PI_CODING_AGENT_DIR` that is no longer set, or an opencode2 project you have since moved away from
— uninstall has no way to know that path, because nothing recorded it. It prints the locations it
checked, so the answer is checkable rather than a bare "done".

## What is not supported

- **ChatGPT-app Codex threads are not titled yet.** The desktop app shares the CLI's local thread
  store (`~/.codex/state_5.sqlite`), so the write path is implemented, but the trigger has never been
  observed firing. The Codex *CLI* is fully supported.
- **Session recap.** quick-titles writes titles and descriptions, not summaries of a whole session.

## Troubleshooting

```bash
npx quick-titles doctor
```

`doctor` reports the data directory, whether the model is provisioned, whether the daemon is running,
which backend loaded, and the model version. If titles are not appearing, that is the one command
that answers why.
