<div align="center">

<img src="assets/readme/header.svg" alt="quick-titles — a Claude Code session on black: a prompt is submitted, a UserPromptSubmit hook returns the session title 'Auth middleware token expiry refactor', which types itself into the session's own name slot, on-device" width="920">

**On-device session titles and descriptions for your coding agents.**
No API calls, no telemetry, no session content leaving your machine.

[![License: MIT](https://img.shields.io/badge/license-MIT-3fb950?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-43853d?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-windows%20%7C%20macos%20%7C%20linux-58a6ff?style=flat-square)](#requirements)
[![Telemetry](https://img.shields.io/badge/telemetry-none-7ee787?style=flat-square)](#privacy)
[![Model](https://img.shields.io/badge/model-desert--ant--labs%2Ftitle-d29922?style=flat-square)](https://huggingface.co/desert-ant-labs/title)

</div>

> **Untested on Windows, and new overall.** This project is days old. The adapters, daemon, and
> conversion have been run on macOS; the Linux and WSL paths are untested, and on Windows the only
> route to a model is `npx quick-titles model-build --guide` — step-by-step instructions for WSL
> that have never been run end to end. Expect rough edges, and
> [report them](https://github.com/asterxsk/quick-titles/issues).

---

Your agent's session list is a wall of `New session` and `Untitled`. quick-titles reads the first
prompt, writes a real title in about a second, and puts it in the session's own name slot — using a
350M-parameter model running **locally on your GPU**. The description goes alongside it, surfaced by
`quick-titles sessions`.

Works with **Claude Code**, **Codex CLI**, **opencode2** (beta), and **Pi**.

## Quickstart

> **Status:** v0.1.0 is in development and not yet published to npm. The commands below are the
> target interface. Part of the reason it is incomplete is a licensing constraint rather than a
> development one — see [Legal status](#legal-status--why-this-project-is-incomplete).

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

**Then fetch the model, once**

```bash
npx quick-titles provision
```

Anything not working?

```bash
npx quick-titles doctor
```

**To remove it again**

```bash
npx quick-titles uninstall
```

That removes it from every agent you installed it into. `npx quick-titles uninstall codex` removes
it from one. Only the files quick-titles itself wrote are touched — a file of your own that happens
to share the name is left alone and reported — and the model is kept, so a later reinstall does not
download it again.

## What you get

| | |
|---|---|
| **Title** | 3–8 words, in the session's own slot — not a separate sidebar you have to check |
| **Description** | One or two sentences of what the session actually covered |
| **Refine** | A second pass on a later turn, once there is more to go on |
| **Refuse** | If the model produces something unusable, quick-titles writes nothing and your host's own title stays. A token loop never reaches your session list |

## How it works

```
your prompt ─▶ host adapter ─▶ resident daemon ─▶ granite-4.0-350m (q8_0) ─▶ session title
                                      │
                                      └─ loads once, answers in ~800 ms
```

A small resident daemon loads the model once and answers over a local socket; the adapters are thin
clients that never block your session on a missing daemon. If the daemon is not running and cannot
be started, every adapter degrades to doing nothing — no title, no error, no slowdown.

## Supported agents

| Agent | Integration | Titles |
|---|---|---|
| **Claude Code** | `SessionStart` + `UserPromptSubmit` hooks | Session title, visible in `/resume` |
| **Codex CLI** | `notify` callback + `thread/name/set` | Thread name, visible in the sidebar |
| **opencode2** (beta) | Plugin API | Session name |
| **Pi** | Extension API | Session name |

**Known limitation:** ChatGPT-app Codex threads are not titled yet. The desktop app shares the CLI's
local thread store and the write path is implemented, but the trigger that would fire it has never
been observed — see [adapter verification](docs/adapter-verification.md). Earlier revisions of these
docs said the titles live on OpenAI's servers; that was wrong.

## Requirements

- **Node 20 or newer.** The Pi extension is the one exception: it runs inside Pi, and Pi's SDK
  requires Node 22.19 or newer (it imports `globSync` from `node:fs`, which Node 20 does not
  export). The other three adapters work on Node 20.
- **~380 MB of model weights**, fetched once by `quick-titles provision` and checksum-verified
  before they are put in place. Every run after that is offline. This build has no published weights
  URL yet — see [docs/install.md](docs/install.md) for the three ways to supply a model today.
- **Windows GPU acceleration uses Vulkan** by default and needs only your GPU drivers. CUDA is used
  automatically if the CUDA Toolkit (13.1+, or 12.4+ for 12.x) is already installed. quick-titles
  never compiles anything — if neither is available it falls back to CPU.
- **NPUs are not supported.** llama.cpp does not target them; GPU or CPU only.

Prefer the slower path on purpose? quick-titles uses whatever backend is available by default.

## Privacy

Everything runs locally. Your prompts and transcripts are read from disk, summarised on your own
hardware, and written back to your agent's own session store. Only two commands touch the network,
both of them one-time and both of them yours to run: `provision` fetches the converted model, and
`model-build` fetches the weights it converts. Once a model is in place quick-titles makes
**no network requests at all** — no telemetry, no analytics, no crash reporting. Nothing is ever
uploaded, by either command.

## Legal status — why this project is incomplete

**The project is unfinished for a licensing reason, not a technical one, and it is better to say so
up front than to let it look like ordinary work in progress.**

The title model is [`desert-ant-labs/title`](https://huggingface.co/desert-ant-labs/title), released
under the [Desert Ant Labs Source-Available License 1.0](https://license.desertant.com/1.0). That is
**not an open-source licence.** It grants the right to modify the weights and embed them in an
application you ship. It forbids distributing them — or a substantially unmodified derivative of
them — "as a standalone product, model, SDK, or hosted service". A converted GGUF is both a
derivative of the weights and, on a release page, standalone.

Three gaps follow directly from that one clause:

| What is missing | Why it is missing |
|---|---|
| **No published weights URL.** `provision` has nothing to fetch, and says so rather than guessing. | Hosting the converted GGUF would be distributing a derivative as a standalone model. |
| **`model-build` needs Python and `git`, and does not run on Windows directly.** | Local conversion is the one path that redistributes nothing — it runs on your machine, from the publisher's own download. MLX, whose quantisation format the publisher's weights use, ships no Windows build. For the WSL route, `model-build --guide` prints it step by step — untested, see below. |
| **No model in the npm package, ever.** | Same clause, applied to the tarball. |

So the shipped package cannot carry the model, and the one command that can produce it does not run
on Windows. For Windows there is a new route — `npx quick-titles model-build --guide`, which prints
the conversion as commands to run in WSL, with the copy destination filled in — and it is also the
least-tested thing in this project. The guide says so itself: neither it nor the Linux path it is
modelled on has been run end to end, and this is a new project — the maintainer has not got to it
yet. Everything else in this README describes code that exists in this repository and runs. The
[defect register](docs/plan-deviations.md) records what was tested and what was not.

This is this project's reading of the licence, not a lawyer's, and it is stated as a reading rather
than as settled law. If you need certainty before relying on it, ask the licensor directly:
`licensing@desertant.com`. The clause in full, the argument on both sides, and what would make
publishing a converted model permissible are in [LICENSE-NOTICE.md](LICENSE-NOTICE.md).

**Not legal advice.** Do not treat this section, or anything else in this repository, as a legal
opinion or as a substitute for one.

## Model and attribution

The title model is [`desert-ant-labs/title`](https://huggingface.co/desert-ant-labs/title), a
fine-tune of [`ibm-granite/granite-4.0-350m`](https://huggingface.co/ibm-granite/granite-4.0-350m),
converted to GGUF q8_0 by this project. **All credit for the model belongs to Desert Ant Labs** —
quick-titles is a delivery mechanism for their work, not a competitor to it.

> Powered by Desert Ant Labs

That line is a licence requirement, not a courtesy, so it is emitted verbatim by
`quick-titles --version`, `quick-titles sessions`, `quick-titles doctor`, and the daemon's startup
log as well. See [Legal status](#legal-status--why-this-project-is-incomplete) above for the clause
it comes from and [LICENSE-NOTICE.md](LICENSE-NOTICE.md) for it in full.

Inference runs on [llama.cpp](https://github.com/ggml-org/llama.cpp) via
[node-llama-cpp](https://github.com/withcatai/node-llama-cpp). See [LICENSE-NOTICE.md](LICENSE-NOTICE.md)
for the full third-party notices.

## Documentation

- [Installation and platform notes](docs/install.md)
- [Adapter verification](docs/adapter-verification.md) — what was tested against which version, including what did not work
- [Implementation plan](docs/plans/2026-09-14-quick-titles.md)
- [Defect register](docs/plan-deviations.md) — every place the implementation diverged from the plan, with the evidence

## Contributing

Contributions are welcome, and this project has unusually specific constraints, so
[CONTRIBUTING.md](CONTRIBUTING.md) is worth reading before the first pull request. The short version,
and the reason each one exists:

- **Prebuilt binaries only.** Nothing is ever compiled on a user's machine.
- **The prompt is immutable.** The instruction and chat template are vendored byte-for-byte from
  the model and hash-pinned. A paraphrase is a different task.
- **The weights are never committed, published, or attached to a release.** A converted GGUF is a
  derivative, and the licence forbids distributing a derivative as a standalone model.
- **Adapters no-op rather than degrade.** A wrong title is worse than the host's own title.
- **New tests come with a mutation check** — break the source, watch it go red, put it back. If it
  stays green, the test is not testing what it claims.

Divergences from the plan go in [docs/plan-deviations.md](docs/plan-deviations.md); dead code you
find along the way goes in `to-delete.md`, not into the commit.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Security issues go through
[SECURITY.md](SECURITY.md), not the issue tracker.

## License

MIT. The model weights are licensed separately under the
[Desert Ant Labs Source-Available License 1.0](https://license.desertant.com/1.0).

<div align="center">
<sub>Powered by <a href="https://huggingface.co/desert-ant-labs/title">Desert Ant Labs</a></sub>
</div>
