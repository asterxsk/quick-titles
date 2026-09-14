# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A packaging test that packs the real npm tarball, unpacks it elsewhere, and runs the shipped
  code with no repository around it. It exists because `files` in `package.json` shipped a package
  missing two files the code reads at import.

## [0.1.0] — 2026-09-14

First release. Titles are generated locally by a 350M-parameter model on the user's own GPU; the
description, which no host agent has a field for, is surfaced by `quick-titles sessions`.

### Added

- **Titles for Claude Code, Codex CLI, opencode2 (beta), and Pi.** Each adapter writes a title
  into that host's own session slot and no-ops when the daemon is unavailable, so the host's title
  stands rather than being replaced by something worse.
- **A resident daemon** over a unix socket, or a named pipe on Windows, with a client that starts
  it lazily on the first prompt of a session.
- **`quick-titles sessions` and the `/sessions` slash command,** sharing one renderer. The listing
  reads the title store directly, so it works whether or not the daemon is running.
- **`quick-titles install <agent>`,** `provision`, and `doctor`, plus a Claude Code plugin
  marketplace manifest so `claude plugin install` works.
- **Model provisioning** that streams to a `.part` file, hashes while streaming, and renames only
  on a digest match.
- **GPU acceleration** by default where a backend exists: Metal on macOS, CUDA and Vulkan on
  Windows and Linux, with a CPU fallback. Prebuilt llama.cpp binaries only; nothing is ever
  compiled on a user's machine.
- **A quality gate** (`tools/eval/`) that scores the model against 40 real transcripts through the
  shipping engine: 37 titled, 3 refused, 0 catastrophic outputs, median 549 ms, descriptions
  complete 37 of 37.
- **Adapter contract tests** asserting each adapter no-ops cleanly when the daemon is absent.

### Fixed

- **The Codex adapter overwrote a user's thread name and never started the daemon.** It wrote the
  title before the daemon could answer, clobbering whatever the user had named the thread.
- **The Pi installer raced its own daemon warm-up** and let the client's 15-second default pick
  the timeout bound, instead of the bound the adapter chose.
- **A markup guard refused any title containing a backtick,** discarding
  ``Running `npx fallow` and inspecting results`` — a correct title, produced on both attempts.
  The regression is pinned by a test that names both sides of the guard.
- **The plugin manifest declared the hooks file Claude Code already loads,** which meant the
  hooks were registered twice.
- **Four suites left a temp directory per test in the OS temp directory** — 792 of them by the
  end of development. All now clean up under the project's own scratch root.
- **The README claimed the licence attribution appeared in four places.** It appeared in two, and
  the README was one of the two that had it missing.

### Notes

- **The weights are not distributed with this release.** The converted GGUF is not committed, not
  published as a release asset, and not downloadable from this project — the model's licence
  forbids redistributing it as a standalone model. `provision` fetches it inside the app, and a
  build without a published weights URL says so and names both ways to supply one.
- **ChatGPT-app Codex threads are not titled yet.** The desktop app shares the CLI's local thread
  store, so the write path exists, but the trigger that would fire it has never been observed. The
  Codex CLI is fully supported.
- All credit for the model belongs to [Desert Ant Labs](https://huggingface.co/desert-ant-labs/title).

[Unreleased]: https://github.com/asterxsk/quick-titles/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/asterxsk/quick-titles/releases/tag/v0.1.0
