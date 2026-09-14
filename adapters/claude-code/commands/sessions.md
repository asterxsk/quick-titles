---
description: List recent sessions with locally generated titles and descriptions
allowed-tools: Bash
---

Recent sessions, titled on this machine. Show the block below verbatim, exactly
as it is printed — the titles, the host each came from, the timestamp, the
description, and the attribution line at the end. Do not summarise it into a
sentence, do not reorder it, and do not drop the attribution.

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/sessions.mjs"`

If the block reads "No titles yet", that is the honest answer: quick-titles
writes its first title once a session has enough of a transcript to describe,
so a fresh install shows an empty list until then.
