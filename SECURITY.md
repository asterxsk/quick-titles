# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.** Use GitHub's private
[Report a vulnerability](https://github.com/asterxsk/quick-titles/security/advisories/new)
form on this repository. That opens a draft advisory only you and the maintainer can see.

Please include what you did, what happened, and what you expected. A reproduction is worth more
than an assessment — this project has been wrong about its own failure modes more than once.

This is a small project maintained by one person. Expect an acknowledgement within a few days
rather than hours. If the report is valid, you will be credited in the advisory unless you ask
not to be.

## Supported versions

The latest release only. There are no maintained back-port branches.

## What is in scope

quick-titles runs entirely on the user's machine, has no server, and makes no network requests
after provisioning. That removes most of the usual attack surface and leaves these:

**The daemon's local socket.** A resident process listens on a unix socket, or a named pipe
(`\\.\pipe\quick-titles`) on Windows. The Windows pipe name is a machine-wide constant, so
**every user on a shared Windows machine can reach it**. Anything that lets another local user
read generated titles, or drive inference, or cause the daemon to write outside its data
directory is in scope.

**The installers.** `quick-titles install <agent>` edits files the user's agent reads —
`config.toml` for Codex, an extensions directory for Pi. A path-traversal, a symlink followed
somewhere it should not be, or a config clobber that destroys a user's settings is in scope. The
Codex installer parses the TOML rather than pattern-matching it, and re-parses after writing to
verify the round trip, precisely because this class of bug is easy to ship.

**Parsing of untrusted input.** Transcripts come from the user's own agents but their contents are
arbitrary text, including text an attacker could have put there — a malicious repository whose
README ends up in a transcript, for instance. Anything that turns a crafted transcript into code
execution, a path escape, or a write outside the data directory is in scope. Prompt injection that
only produces a *bad title* is not, by itself; see below.

**Supply chain.** Anything that could cause a build or a release here to ship code the maintainer
did not write.

## What is out of scope

- **A wrong, odd, or low-quality title.** That is the model's output, not a vulnerability. The
  project ships explicit guards that refuse bad output, and `tools/eval/` scores quality on real
  transcripts; a title that slips past them is a bug report, not a security report.
- **Emitting the model's instruction back as a title,** or copying a passage's opening. Both are
  known, both are caught by tests in `tests/core/gate.test.ts`.
- **Running the model at all.** It executes no code from a transcript.
- Denial of service against your own machine by your own transcripts.

## Design properties worth knowing

These are load-bearing, and a change that breaks one is a security regression even if nothing
fails:

- After provisioning, **no network requests at all**. No telemetry, no analytics, no crash
  reporting.
- **The weights are not distributed by this project.** They cannot be downloaded from it, and no
  release asset carries them.
- **Adapters no-op rather than degrade.** If the daemon is absent, slow, or wedged, an adapter
  leaves the host's own title in place. It never writes host storage as a fallback.
- **The title store is a plain JSONL file** in the user's data directory. It is created with mode
  `0o600`; a report that it is world-readable on some platform is in scope.
