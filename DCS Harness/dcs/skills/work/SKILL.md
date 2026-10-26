---
name: work
description: Run approved dcs tasks through worker, reviewers, refuter, landing, re-verify, visual QA and commit, with the main session as Captain. Use when Navin runs /dcs:work.
argument-hint: "[all | t1 t2 ...] [--solo | --parallel | --breezing]"
---

# /dcs:work

First read `${CLAUDE_PLUGIN_ROOT}/references/captain.md`. You are the Captain; follow it exactly.

## 0. Start
1. Run `dcs check`. If there are no settings, stop and suggest `/dcs:setup`. Read `.claude/dcs/settings.json`.
2. Run `dcs run` with a Bash timeout of 600000. It records the run start and verifies main as a baseline. If it exits 1 (**red baseline**), show Navin the failing tails and ask which option to take. There is no "proceed anyway".
   - **Fix main first:** add a task for it.
   - **Narrow the verify commands:** `/dcs:setup`.
   - **Abort.**

   `--skip-baseline` is only for when Navin explicitly asks for it.
3. Tasks: use the ids given, or `dcs next --n 99 --json`. If none are ready, show `dcs list` and stop.
4. Mode: `--solo`, `--parallel` or `--breezing` if given. Otherwise it is solo for 1 ready task, parallel for 2–3, and breezing for 4 or more. Confirm the mode and the task list with Navin **once**.

## 1. Waves
- **Solo:** one task, in the repo root.
- **Parallel:** one wave of up to 3 tasks, each started with `dcs start <id> --worktree`. Stop and report after the wave.
- **Breezing:** repeat waves of up to 3 (`dcs next --n 3 --json`) until nothing is ready. Stop early on any `blocked` task or `land` conflict.
- After each wave, list the discovered work for Navin (captain.md rule 12).

## 2. Per task: a–c run concurrently across the wave

### a. Start
Run `dcs start <id>` with a Bash timeout of 600000 (worktree setup can run `npm ci` or `pod install`), adding `--worktree` in parallel or breezing mode. If it refuses because the branch doesn't name the task's Jira key, follow captain.md rule 13. Otherwise, if it refuses, tell Navin and stop.

### b. Worker
Dispatch the Worker template: all of the wave's workers in one message, each with `run_in_background: true`.
- Every reply → `dcs note` (rule 10), and collect its `discovered` items.
- `needs_input` → rules 3–5, then SendMessage the answer to `worker-<id>`.
- `blocked` → tell Navin and stop that task.
- `failed` → run `dcs show <id>`. If it is `blocked`, go to §3. Otherwise SendMessage the verify tails to the same worker.

### c. Review
Start this step once `dcs show <id>` reports `verified`.
1. Dispatch one Reviewer per required pass, in parallel:
   - work: ac, security, performance, quality, plus a11y when `ui`;
   - spec: ac, a11y;
   - spec-sync: ac.
2. **Refuter:** if any reply contains a critical or major finding, dispatch the Refuter once for the round and merge its `upheld: false` results into the findings files.
3. **Integrity flags:** if the `ac` reviewer upholds an unexplained integrity flag (a deleted, skipped or weakened test, a suppression, or a verify-config edit), ask Navin before recording.
4. Record every pass with `dcs review <id> --pass <p> --findings <file>`.
5. If the task is `doing` after the round, SendMessage the blocking findings to `worker-<id>`. It fixes them and verifies again; then review again.

## 3. Per task: d–g run one task at a time, in id order, after approval

### d. Land (worktree tasks)
Run `dcs land <id>`. On a conflict, main is restored: tell Navin and stop.

### e. Re-verify (landed tasks)
Run `dcs verify <id>` in the repo root, with a Bash timeout of 600000.
- **Pass:** the task stays `approved` and is ready for QA.
- **Fail:** the task goes to `doing`. Dispatch a fresh worker in the repo root with the verify tails, then review and re-verify again.

### f. Visual QA (`ui` is true and `settings.visualQa` is not false)
1. **Capture:** run `dcs apps <id>` and capture each listed app with the Maestro template, for each platform it has. If it lists none (no `maestro`, or no app's `paths` match the diff), tell Navin and let the QA agent capture instead.
2. **Dispatch:** send the Visual QA template, including the captures and the Figma reference and values.
3. **Check the reply:** ask for a re-report once if any of these hold:
   - it has no `verdict`;
   - findings lack `severity` or `location`;
   - it's a `pass`, but a capture you passed in has no `screenshots` entry, or an entry has no `shows` or has `matches: false`. A flow that finished is not a pass.

   If it is still incomplete, ask Navin.
4. **Record** the verdict with `dcs qa <id>`, passing `--evidence <screenshots and recordings>`, and for a fail also `--findings "$TMPDIR/dcs-qa-<id>.json"`:
   - `invalid` → `--invalid`, then recapture. If dcs refuses a third invalid, ask Navin.
   - `fail` → `--fail`, then dispatch a fresh worker in the repo root with the findings. After that, verify, review and QA again.
   - `pass` → `--pass`.

### g. Commit (you, in the repo root)
1. Run `git add -A`, then show Navin `git diff --cached --stat`.
2. Write the message as `<type>(<scope>): <summary>` in the style of `git log -10 --oneline`.
   - It is **ASCII only**, and an optional body is allowed.
   - The last line is `Fixes: <KEY>` when the task has `jira` or `settings.requireFixesTrailer` is true. If there is no key, ask Navin for one.
   - **Never** add Co-Authored-By.
3. Commit with `git commit -F - <<'EOF'` … `EOF`. The guard asks Navin (G1).
4. If Navin rejects it with a reason, run `dcs decide <id> --q "commit rejected" --a "<reason>"` and follow Navin's instruction.
5. Run `dcs done <id> --commit "$(git rev-parse --short HEAD)"`.

Special task kinds:
- **spec tasks:** before committing, show Navin the spec and run `dcs approve-spec <id>` (G6 asks).
  - Approved → set the template's status field to `Approved`, then commit and run `dcs done`.
  - Denied → ask Navin whether to change it, commit it as Draft and pause, or discard it. There is no default.
- **spec-sync tasks:** if nothing changed, run `dcs done <id> --no-changes`.

## 4. Blocked
When a task is `blocked` (3 failures), show Navin the last findings or verify tails and ask what to do next. Run `dcs unblock <id>` only on Navin's instruction; G5 asks too.

## 5. End of run
Print a table with id, status, commit, failures and review rounds. Mention `dcs stats` and suggest `/dcs:pr`.
