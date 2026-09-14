# Adapter verification

What was actually tested, against which version, and what did not work. A negative result recorded
honestly is worth more than an optimistic one that is never re-checked — so this file distinguishes
**verified against the real host** from **inferred from the host's sources**, and says plainly which
adapters have never been driven end to end by a live session.

Last updated: 2026-09-14.

## Summary

| Adapter | Host tested against | Protocol verified | Driven by a live session? |
|---|---|---|---|
| Claude Code | 2.1.270 (installed binary + docs) | yes | **no** |
| Codex CLI | codex-cli 0.153.4 | yes | **partly** — the rename write path, not the shipped entry point |
| opencode2 (beta) | beta build on this machine | partly | **no** |
| Pi | `@earendil-works/pi-coding-agent` 0.85.1 | partly | **no** |

No adapter has yet been verified end to end by a real host session producing a real title from the
real model. The work below establishes that each adapter speaks its host's protocol correctly; it
does not establish that a user sees a title. That test is still outstanding and is the single
largest open risk in this project.

## Claude Code — 2.1.270

Verified by reading the installed `claude.exe` bundle and the official hooks reference.

**Confirmed:**

- **`args` is a real field.** A `"type": "command"` hook may be written either as a single shell
  string or in *exec form* with `"command"` plus an `"args"` array, in which case no shell is
  involved. quick-titles uses exec form. This was worth confirming: an unrecognised key inside a
  hook handler causes the entry to be **dropped with a warning**, so a wrong guess here would have
  produced a hook that silently never ran.
- **`timeout` is in seconds**, and an exceeded timeout cancels the hook and discards its output.
  `UserPromptSubmit` defaults to 30 s; quick-titles sets 25 s, which is why the hook's worst path is
  bounded well below it (see D36).
- **`hookSpecificOutput.sessionTitle` is honoured on both `SessionStart` and `UserPromptSubmit`.**
  This was the risk that mattered most — the "refine on a later turn" design depends on
  `UserPromptSubmit` being able to rename a session, and if it could not, that pass would have been
  a silent no-op. Unknown keys in hook output are ignored with a log, not an error, so a typo here
  would have failed quietly.
- `${CLAUDE_PLUGIN_ROOT}` is substituted inside `command` and inside each `args` element as a plain
  string, so a plugin path containing spaces needs no quoting.

**Defect found and fixed:** the plugin manifest declared `"hooks": "./hooks/hooks.json"`. The loader
already adds that exact path to its hook-file list, so the declaration made it appear twice and
raised an error-level "Duplicate hooks file detected — resolves to already-loaded file". Removed.
See D42 — and D43 for why nothing in this repository would have caught it.

**Not verified:** the hooks have never run inside a live Claude Code session, because the plugin is
not enabled in the user's `settings.json`. Everything above is protocol conformance, not an
observation of a title appearing.

## Codex CLI — codex-cli 0.153.4

**Confirmed by running the binary:**

- `codex app-server --listen stdio://` speaks newline-delimited JSON-RPC.
- **`initialize` is mandatory.** Any method before it is answered
  `{"code":-32600,"message":"Not initialized"}`. quick-titles handshakes first.
- `thread/name/set {threadId, name}` returns `{}` and lands **synchronously** in both `thread/list`
  and the `name` column of `~/.codex/state_5.sqlite`.
- A freshly created thread with no turns reports `name: null`, and `thread/name/set` on it returns
  `ok` without the name sticking. quick-titles only titles threads that have a rollout.

**Confirmed by live round trip:** an existing thread was renamed through the shipped code and
restored to its exact original name, with the value read back from `state_5.sqlite` each time (D29).

**Why not hooks:** Codex hooks require a `trusted_hash` approval, and their
`UserPromptSubmitHookSpecificOutputWire` is `deny_unknown_fields` with only `hookEventName` and
`additionalContext` — **there is no title field**, so hooks cannot set a thread name at all. The
`notify` callback plus the app-server RPC is the only supported write path (D30).

**Not verified:** the shipped `notify.mjs` has never been invoked by Codex itself with a real
payload. The payload shape was taken from Codex's Rust source, not observed.

**Open — not a negative result:** ChatGPT-desktop Codex threads. Earlier revisions of this file said
their titles "live on OpenAI's servers"; **that was wrong.** The desktop app shares the CLI's local
store — `~/.codex/state_5.sqlite` → `threads`, with `title` and `name` columns — and an external
process can write it. `remote_control_enrollments.app_server_client_name = "Codex Desktop"` on the
verifying machine confirms the app is an app-server client on that store.

What is genuinely unverified is the **trigger**. `notify` is a CLI config key and it has not been
observed firing from the desktop app (openai/codex#13019 is open: OpenAI says it should, one user
measured on 0.106.0 that it does not). Even when a write lands, the desktop sidebar may not repaint
live (#25456), and a state-DB rebuild regenerates rows from the rollout files, which do not carry
the name (#41614). Until the trigger is observed, treat desktop as **write path implemented, trigger
unverified** — do not claim support.

## opencode2 (beta) — not opencode

opencode2 is a distinct beta product from opencode; this adapter targets the beta.

**Confirmed:** the beta host's plugin context exposes `event.subscribe` and a `session` domain with
`get`, `context`, and `rename`. Events deliver the session id at
`event.properties.sessionID` — **not** `event.data.sessionID`, which is what the first
implementation read and why it silently never fired (D34). The published `@opencode-ai/plugin`
package's v2 typings do not describe these domains, so the context is typed locally in the adapter.

**Not verified:** live use. No opencode2 session has been observed producing a generated title, and
the beta's plugin API may change without notice.

## Pi

**Confirmed:** the extension directory must be resolved through the SDK's `getAgentDir()`, which
honours `PI_CODING_AGENT_DIR` (tilde-expanded) and otherwise falls back to `~/.pi/agent`. Hardcoding
the home path installs somewhere Pi never scans whenever that variable is set.

**Not verified:** live use against a real Pi session.

## What the verification rounds actually cost

Four of the five defects recorded in D34 were **silent no-ops** — code that ran, exited 0, and did
nothing. None of them would have been caught by a test that only asserted "no error was thrown", and
none of them surfaced without an agent deliberately trying to falsify the implementation. That
pattern is the main reason the adapters now carry process-level tests that assert an observable
effect (a boot count, a rename call, a written name) rather than a return value.
