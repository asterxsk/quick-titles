# Contributing to quick-titles

Thanks for looking. This is a small project with unusually specific constraints, so a few of the
rules below are not the usual ones. Read the "Hard rules" section before you write code — most of
them exist because breaking them already shipped a bug once.

## Getting set up

```bash
git clone https://github.com/asterxsk/quick-titles.git
cd quick-titles
npm install
npm run build
npm test
```

`npm run build` is not optional before `npm test`. The adapters load `dist/client.js` at runtime,
so the suite fails without it.

| Command | What it does |
|---|---|
| `npm run build` | `tsc`. Produces `dist/`, which the adapters load. |
| `npm run typecheck` | Both tsconfigs: `src` and the TypeScript adapters. |
| `npm test` | The whole suite. About a minute. |

**You do not need the model.** `tests/core/inference.test.ts` skips itself unless `QT_MODEL`
points at a GGUF file, and nothing else in the suite loads one. That is deliberate: the suite has
to run in CI, and the weights cannot be redistributed — see below.

## Hard rules

**Never compile llama.cpp from source on a user's machine.** `getLlama` is called with
`build: "never"` and prebuilt binaries only. A contributor's machine may compile for its own
experiments; the shipped code must not.

**The prompt is immutable.** `assets/instruction.txt` and `assets/chat_template.jinja` are
vendored byte-for-byte from the model and hash-pinned in `src/core/prompt.ts`. Do not reword,
reformat, "fix" the missing spaces between sentences, or re-wrap them. The model card is explicit
that a paraphrase is a different task, and the upstream implementation has already shipped this
bug once. If a hash check fires, you changed one of them by accident — restore it.

**The weights are never committed.** `*.gguf` is gitignored, and the model's licence forbids
redistributing the converted file as a standalone download. Nothing in this repository may publish
it: not git, not CI, not a release asset. quick-titles fetches it inside the app from a URL the
user supplies.

**Adapters never write a host agent's storage directly.** Only documented APIs. If an adapter
cannot set a title, it no-ops and lets the host's own title stand. A wrong title is worse than no
title, and a corrupted host config file is much worse than both.

**Never block a user's prompt.** Every pass has a timeout and is abandoned silently when it
exceeds it.

## How changes are tested here

The suite is heavy on **mutation checks**, and a new test is expected to come with one. The
question a test has to answer is not "does this pass" but "what would have to break for this to
fail". Write the test, then deliberately break the source, confirm the test goes red, and put it
back. If it stays green, it is not testing what it says.

This is not ceremony. It has caught, in this repository: an async test helper that silently
passed an empty stdin to every child process, four "SDK absent" cases that were resolving the SDK
after all, and a listing that would print "No titles yet" over a store full of titles.

Two more conventions:

- **Test the artifact, not just the checkout.** `tests/packaging.test.ts` packs the real npm
  tarball, unpacks it elsewhere, and runs the shipped code with no repository around it. The
  `files` field in `package.json` shipped a package missing two files the code reads at load time;
  no checkout-based test could see that.
- **Say why in the comment.** Several tests in this suite look redundant. Each carries a comment
  naming the bug it exists for. Keep that up.

## Where to write things down

**Deviations go in `docs/plan-deviations.md`,** not silently into the code. The plan is a real
document and the implementation diverged from it in dozens of places; each divergence is recorded
with what the plan said, what was done instead, and why. If you change something a plan or a
previous deviation decided, add an entry rather than editing history.

**Dead code you find goes in `to-delete.md`,** not into the commit. The rule is: mention it,
don't delete it in a change that is about something else.

## Pull requests

Small and single-purpose. The template asks for the three things a reviewer here needs: what
changed, how it was verified, and whether a mutation check was run.

Before opening one:

```bash
npm run build && npm run typecheck && npm test
```

CI runs the same on Linux, macOS, and Windows across Node 20 and 22. Please do not disable a
failing job to get green — the platform-specific ones are the reason the matrix exists.

## Reporting bugs

Use the issue templates. For a title that came out wrong, the most useful thing you can attach is
`quick-titles sessions` output for the session plus the first few lines of the prompt, with
anything private redacted. `tools/eval/` has the machinery the project uses to score title
quality on real transcripts.

Security issues do not go in the issue tracker; see [SECURITY.md](SECURITY.md).

## Licence

Contributions are accepted under the MIT licence in [LICENSE](LICENSE). The model and its
derived weights are separately licensed by Desert Ant Labs; see [LICENSE-NOTICE.md](LICENSE-NOTICE.md).
