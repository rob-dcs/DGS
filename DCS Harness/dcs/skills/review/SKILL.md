---
name: review
description: Run the dcs review passes (with the refuter) on one task and record the verdicts, or on the current branch diff as a report only. Use when Navin runs /dcs:review.
argument-hint: "[<task id> | --diff]"
---

# /dcs:review

First read `${CLAUDE_PLUGIN_ROOT}/references/captain.md`. You are the Captain.

## A task: `/dcs:review <id>`
1. Run `dcs show <id>`. The task must be `verified`. If it isn't, report its status and stop, because review refuses every other status.
2. Required passes:
   - work: ac, security, performance, quality, plus a11y when `ui`
   - spec: ac, a11y
   - spec-sync: ac
3. Dispatch one `dcs:reviewer` per pass, in parallel, using the Reviewer template. The `ac` pass must return `acResults` for every AC.
4. If any pass returns `needs_input`, ask Navin (captain.md rules 3–5) and SendMessage the answer back.
5. **Refuter.** If any reply has a critical or major finding, dispatch the Refuter template once. Merge every `upheld: false` result into its pass's findings as `refuted: true` plus `refuteReason`.
6. **Integrity flags.** If the `ac` reviewer upholds an unexplained integrity flag, ask Navin before recording.
7. **Record** each pass. Save its JSON to `$TMPDIR/dcs-<id>-<pass>.json`, then run `dcs review <id> --pass <pass> --findings "$TMPDIR/dcs-<id>-<pass>.json"`. The CLI decides the verdict:
   - critical or major findings that have an exact quote and weren't refuted block;
   - so does any unmet AC.
8. Report the resulting status: either `approved`, or `doing` together with the blocking findings.

## The branch: `/dcs:review --diff`
1. The base is `settings.base`; if there are no settings, ask Navin. The diff is `git diff <base>...HEAD` plus uncommitted changes (`git diff HEAD`).
2. Dispatch these passes with the Reviewer template: ac, security, performance, quality, plus a11y when the diff touches UI files. Give them Task: "branch diff, no dcs task" and AC: "the change is correct and follows the repo rule skills".
3. Report the findings grouped by severity. Don't run the refuter, and **record nothing** (no `dcs review`).
