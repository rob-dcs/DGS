---
name: status
description: Draft Navin's weekly status report from the dcs weekly board. Use when Navin runs /dcs:status or asks for the weekly status report or status update.
argument-hint: "[--week 2026-W40]"
---

# /dcs:status

1. Run `dcs board --report` (add `--week <week>` if given; the default is this week). It runs the merged check first; show Navin any warnings, such as gh being offline or unauthenticated.
2. If it exits 3 with "missing component/title for: …", ask Navin for each missing value, run `dcs board edit <key-or-id> --component "…" --title "…"`, and repeat step 1.
3. Show the week's board (`dcs board --week <week> --offline`) and ask Navin whether anything is missing, such as work done outside dcs, or feedback fixes from RNHost Eng or another team. Add or update rows only after Navin confirms (`dcs board add …`, `dcs board set …`; untracked feedback items take `--source "<team>"`), then repeat step 1. Never propose minor infra, lint or CI chores (a CI heap bump, a lint baseline cleanup) as rows, even when they shipped that week. They don't belong in the report. If you can't tell whether an item is team feedback or a routine chore, ask Navin.
4. Print the report text **exactly** as dcs printed it, inside a plain code block, for Navin to copy. Never send it anywhere, and never add links or extra sections.

The format comes from the dcs renderer: one line per ticket (`KEY — Component | Title`, plus `(Undergoing PR)`, `(In progress)` or `(Blocked: reason)`), then `Other shipped work (no ticket - issues pointed out by <team>):` with that team's done items only. There is no housekeeping section.
