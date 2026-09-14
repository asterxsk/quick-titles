## What changed

<!-- One or two sentences. If this fixes something, say what was broken and who it broke. -->

## How it was verified

<!-- Not "tests pass" — which tests, and what they would catch. -->

- [ ] `npm run build && npm run typecheck && npm test` is green
- [ ] A test was added or changed, and it fails without this change
- [ ] Mutation check: I broke the source on purpose, watched the new test go red, and restored it
      <!-- Delete this line only for docs-only changes, and say so below. -->

## Checklist

- [ ] Single purpose. Unrelated cleanups were left out, or called out below.
- [ ] Dead code found along the way was added to `to-delete.md` rather than deleted here
- [ ] A divergence from `docs/plans/2026-09-14-quick-titles.md` is recorded in
      `docs/plan-deviations.md`
- [ ] Adds or changes user-visible behaviour, so `CHANGELOG.md` has an entry
- [ ] No `.gguf` file, no converted weights, and no model download URL is included
      <!-- The model's licence forbids redistributing the converted file. See LICENSE-NOTICE.md. -->
- [ ] `assets/instruction.txt` and `assets/chat_template.jinja` are byte-for-byte unchanged

## Notes for the reviewer

<!-- Anything you are unsure about, any decision you made that could have gone the other way, and
     anything you deliberately did not do. -->
