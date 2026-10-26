# dcs-harness — Design Spec (v2)

**Date:** 2026-09-30 · **Owner:** Navin (Digital Creative Studio)
**Status:** v1 approved 2026-09-30. v2 adds the research-round changes listed in §13 and is awaiting review.

`dcs` is a thin, self-contained Claude Code plugin that works in every repo Navin works in. It provides:
- a Captain-led Plan → Work → Review loop
- runtime guardrails
- repo spec files
- a ticket-to-PR flow
- a weekly board

It takes powerball-harness's ideas without its weight. From Shopify's Helix it borrows reference-diff QA, reference-as-spec, decisions carried forward and skeleton-first planning. The research round (§13) adds ideas from Anthropic's harness guidance, Spec Kit, Kiro, beads, superpowers, gitleaks and published guard hooks.

---

## 1. Goals, scope, non-goals

**Goals**
1. **Plan → Work → Review loop.** Tasks carry acceptance criteria (AC). A worker implements each task, and independent reviewers decide when it is done.
2. **Portable.** One user-scope plugin for Fluidity DS, fluidity-spm, RNHost, guest-app-ios, excalibur, excalibur-android-evolution, commerce-android, pre-cruiseTickets and photos2Reel.
3. **Runtime guardrails.** Hooks enforce git, destructive-operation, secret, scope, role and data-egress rules in code, not from memory.
4. **Ticket flow.** Optional Jira key + Figma → implement → verify → review → land → re-verify → visual QA (driven by Maestro where configured) → commit → draft PR with evidence.
5. **Weekly task board.** One cross-project board of every ticket and untracked item, split by ISO week, which feeds the weekly status report.

**Constraints (decided)**
- **Thin.** Node ≥ 22 standard library only, with zero npm dependencies. No Go, no benchmarks, no Codex or OpenCode support.
- **Self-contained.** No dependency on superpowers, ralph-loop or any other plugin.
- **Local only.** Installed from `~/Developer/bin/dcs-harness` through a local marketplace, with no remote. The plugin contains Internal company workflow details, so it must not be pushed to a personal remote.
- **Nothing leaves the machine.** No hosted services, no Maestro Cloud, no remote rendering, and Maestro analytics are always off. The guard log and `dcs stats` are local files only.
- **Stack-agnostic core.** Stack knowledge stays in each repo's `.claude/skills` and `.claude/agents`. dcs reaches it through repo settings.
- **Jira is never read or written.** A task may carry a Jira key. It is used only for commit trailers and PR links.
- **Per-repo dcs files are never committed.** They live under `.claude/dcs/` and are excluded through `.git/info/exclude`. The design doc and plan in `docs/` are never committed either.
- **Repo spec files are the lasting artifact.** In repos with a spec convention, dcs drafts or updates the spec before implementation and syncs it afterwards. Those files are committed with the work.
- **Never assume.** Every skill stops and asks when something is ambiguous. Setup never writes a value Navin hasn't confirmed.

**Non-goals**
- planner, scaffolder and ralph agents
- ralph-loop and the maintenance skill
- CI watch and release tooling
- a memory DB and remote telemetry
- benchmarks and multi-CLI support
- hosted visual-testing services such as Chromatic, Applitools or Percy (they would upload Internal designs)
- a full shell parser
- Spec Kit or Kiro document stacks, and BMAD personas
- issue graphs and Jira sync
- duplicate or voting reviewers
- in-app bypass flags
- a reviewer from another vendor

## 2. Layout

```
~/Developer/bin/dcs-harness/                (local git repo, no remote)
├── .claude-plugin/marketplace.json     marketplace "dcs-local" → plugin source ./dcs
├── docs/spec.md, docs/plan.md          never committed
├── dcs/                                the plugin
│   ├── .claude-plugin/plugin.json
│   ├── bin/dcs                         Node CLI entry; on Bash PATH while the plugin is enabled
│   ├── lib/store.js                    DcsError, readJson, atomic write, lock
│   ├── lib/tasks.js                    task file, validation, state machine, AC lint, history
│   ├── lib/repo.js                     settings, verify runner (+ slots, integrity), worktrees, land, baseline
│   ├── lib/board.js                    weekly board, ISO weeks, carry-over, merged check, renderers
│   ├── lib/guard.js                    guardrail evaluation
│   ├── hooks/hooks.json                PreToolUse → dcs guard (fail closed) · SessionStart → dcs brief
│   ├── references/captain.md           Captain protocol + dispatch templates
│   ├── skills/{setup,plan,work,review,pr,visual-qa,status}/SKILL.md
│   ├── skills/pr/references/example-pr.md
│   └── agents/{worker,reviewer}.md
└── test/*.test.js, test/helpers.js     node:test
```

**Per repo (never committed):**
- `.claude/dcs/settings.json`
- `.claude/dcs/tasks.json`
- `tasks.lock` and `verify-slot-<k>.lock` (both transient)
- `.claude/dcs/evidence/<task-id>/`, which holds:
  - `verify-<n>.log`
  - `review-r<round>-<pass>.json`
  - `worker-<n>.json` (the handoff notes)
  - `qa-<n>/` (screenshots, recordings and findings)
  - `flows/` (throwaway Maestro flows)
- `.claude/dcs/evidence/_baseline/verify-<n>.log`

**Global:**
- `~/.dcs/board/<YYYY>-W<WW>.json` and its `.md`
- `~/.dcs/board/.lock`
- `~/.dcs/guard/<YYYY-MM>.jsonl` (the guard log)

**Worktrees:** a sibling directory, `../<repo-name>.dcs-worktrees/<task-id>`.

**Verified platform facts** (checked against the Claude Code docs and tool schemas on 2026-09-30):

*Plugin basics*
- The plugin's `bin/` directory is on the Bash PATH.
- `${CLAUDE_PLUGIN_ROOT}` resolves in hooks, skills and agents.
- Skills are invoked as `/dcs:<skill>`.
- Plugin agents ignore the `hooks` and `permissionMode` frontmatter keys.

*Hooks and permission modes*
- PreToolUse hook input includes `session_id`, `cwd` and `permission_mode`. Inside a subagent it also includes `agent_type`, which the docs describe as `plugin:<plugin>:<agent>`. The live hook (smoke test, 2026-09-30) sends `dcs:worker`, so the guard accepts both forms.
- The docs say a hook `"ask"` still prompts in auto mode, but in the 2026-09-30 smoke test (desktop app, auto mode) **no prompt appeared** and the calls ran. It does not survive `bypassPermissions` either. Explicit `permissions.ask` rules **do** prompt in auto mode (same smoke test, probe `echo dcs-ask-probe`).
- `dontAsk` mode denies asks automatically.
- A hook that times out does not block: the call carries on through the normal permission flow.
- `SessionStart` supports the matchers `startup`, `resume`, `clear` and `compact`. Plain stdout from it is added to Claude's context.

*Tools and agents*
- The `Monitor` tool runs shell commands through its `command` field, in the same shell environment as Bash.
- Subagents cannot use AskUserQuestion.
- Subagent `isolation: worktree` exists, but it branches from the default branch unless configured, so dcs manages its own worktrees.

*Maestro*
- Plain `maestro record` uploads the raw screen capture to mobile.dev servers. `--local` renders locally (Beta).
- `startRecording` and `takeScreenshot` inside a flow are local.
- Analytics are on by default. `MAESTRO_CLI_NO_ANALYTICS=true` turns them off.
- `--analyze` and the AI flow commands (`assertWithAI`, `assertNoDefectsWithAI`, `extractTextWithAI`) are routed through Maestro Cloud.

## 3. Task file and state machine

`.claude/dcs/tasks.json`:
```json
{
  "version": 1,
  "runStartedAt": null,
  "baseline": null,
  "tasks": [{
    "id": "t3", "kind": "work", "title": "Tag loading skeleton",
    "jira": "APP2X-1234",
    "figma": ["https://www.figma.com/design/<key>/<name>?node-id=1-2"],
    "refs": ["packages/fluidity-react-native/src/components/Tag/"],
    "ui": true,
    "ac": ["WHEN isLoading is true the Tag shall render TagSkeleton with the Tag's width and height"],
    "depends": ["t1"], "discoveredFrom": null,
    "status": "todo", "failures": 0, "verifyFailStreak": 0, "reviewRound": 1,
    "branch": null, "baseSha": null, "worktree": null, "landed": false, "reverified": false, "setupLockHash": null, "commit": null,
    "verify": null, "qa": null, "reviews": [], "decisions": [],
    "specPath": null, "specApproval": null,
    "history": [{ "status": "todo", "at": "2026-09-30T10:00:00.000Z" }]
  }]
}
```

**Validation (on every write):**
- `id` is unique and looks like `t<n>`. `dcs add` assigns it.
- `title` is not empty.
- `ac` has at least one non-empty string.
- `jira` is null or matches `^[A-Z][A-Z0-9]+-\d+$`.
- Every `figma` URL has host `www.figma.com` or `figma.com`.
- Every id in `depends` exists, and the dependencies form no cycle.
- `discoveredFrom` is null or an existing id.
- Every `refs` path exists when the task is added.
- `kind` is `work`, `spec` or `spec-sync`:
  - spec kinds need a `specPath` under `settings.specs.dir` ending in `.spec.md`, and must have `ui: false`;
  - `work` tasks have `specPath: null`.
- `status` is one of the states below.

**States:** `todo → doing → verified → approved → done`, plus `blocked`. **Every status change appends `{status, at}` to `history`.** The `mutate` wrapper does this, not the individual commands.

| Command | Effect | Refuses when |
|---|---|---|
| `dcs init` | write settings from stdin; create tasks file; append `.claude/dcs/` to `.git/info/exclude` (idempotent) | not a git repo; settings invalid |
| `dcs add [--dry-run]` | read task JSON (one or an array); `depends` may use `#n` for the n-th task in the batch; assign ids; validate; **lint** (below); `--dry-run` prints problems + lint warnings and writes nothing | any task invalid (nothing written) |
| `dcs list [--json]` / `dcs show <id>` / `dcs next [--n N] [--json]` | read-only | — |
| `dcs run [--skip-baseline]` | set `runStartedAt`; unless `--skip-baseline` (only on Navin's instruction), run a **baseline verify** on the main checkout and record `baseline: {sha, ok, results, at}`; red → exit 1 with the failing tails | main checkout dirty (baseline) |
| `dcs start <id> [--worktree] [--branch-ok]` | `todo → doing`; record branch + `baseSha`; with `--worktree`: create `dcs/<id>` worktree from HEAD, run `worktreeSetup` there, record `setupLockHash` | deps not done; no settings; the task has `jira` and the current branch doesn't contain that key (case-insensitive, not followed by a digit) unless `--branch-ok`; main dirty; setup fails (worktree removed, stays `todo`) |
| `dcs verify <id>` | see **Verify** below | status not `doing`/`verified`, and not (`approved` + `landed`) |
| `dcs review <id> --pass <p> --findings <file>` | record one pass; **verdict derived** from the findings file (see **Review verdicts**); findings copied to `evidence/<id>/review-r<round>-<pass>.json`; when all required passes for the round are in: any blocking → `doing`, `failures+1`; none → `approved` | status not `verified`; fingerprint ≠ verify fingerprint; pass not required for this kind; findings file invalid; `ac` pass without a complete `acResults` |
| `dcs diff <id>` | full change since `baseSha` in the task cwd, including untracked files; never touches the index | status `todo` |
| `dcs purge [--yes]` | list, then with `--yes` move to `~/.Trash/dcs-purge-<time>/`: every registered repo's `.claude/dcs/evidence/` (registry `~/.dcs/repos.json`, filled by `init` and every settings-loading command) and the contents of `~/.dcs/guard/`. Keeps `tasks.json`, `settings.json`, `prcheck.json` and `~/.dcs/board/`. Marks repos with in-flight tasks | — |
| `dcs prcheck` | run `settings.prChecks` in order in the repo root, stopping at the first failure. Logs go to `evidence/_prcheck/<sha7>-<n>.log` and `{sha, ok, at, results}` to `.claude/dcs/prcheck.json`. Exits 1 on failure with the tail | no `prChecks`; dirty tree |
| `dcs apps <id>` | JSON list of the `settings.maestro` apps whose `paths` the task's changed files (since the task base, including untracked) fall under, without `paths`; an app with no `paths` always counts; `[]` when `maestro` is `false` | status `todo` |
| `dcs land <id>` | worktree only: `git add -A` in the worktree; `git diff --cached <baseSha> --binary` applied to main (`git apply` when `--check` passes, else `git apply --3way`); on failure `reset --hard` + `clean -fd` main (it was verified clean), keep worktree; on success remove worktree + branch, `landed: true`, `reverified: false` | not `approved`; no worktree; main dirty; conflict |
| `dcs qa <id> (--pass\|--fail\|--invalid) --evidence <paths…> [--findings <file>]` | copy evidence to `evidence/<id>/qa-<n>/`; `--fail` → `doing`, `failures+1`; `--invalid` → no state change, `qa.invalid+1` | not `approved`; still in worktree; landed and not `reverified`; third `--invalid` |
| `dcs approve-spec <id>` | `specApproval: {at}` (G6 asks) | not a `spec` task; not `approved` |
| `dcs done <id> (--commit <sha>\|--no-changes)` | `approved → done` | not approved; in worktree; landed and not reverified; `ui` + `visualQa ≠ false` without QA pass; unapproved `spec`; `--no-changes` except on a `spec-sync` with an empty diff; commit not found |
| `dcs decide <id> --q <q> --a <a> [--why <w>]` | append `{q, a, why, at}` to `decisions` | unknown task; empty q or a |
| `dcs decisions [--run]` | all decisions (oldest first); `--run`: only `at ≥ runStartedAt` | `--run` with no run started |
| `dcs note <id> <file>` | copy a worker reply (JSON) to `evidence/<id>/worker-<n>.json` (the handoff note) | unknown task; file not JSON |
| `dcs brief` | resume summary for the SessionStart hook (§4); silent when nothing is in flight or outside a git repo | never fails loudly |
| `dcs unblock <id>` | `blocked → doing`, `failures = 0` (G5 asks) | not blocked |
| `dcs stats [--json]` | local metrics (§8b) | — |
| `dcs check` | validate settings + tasks | — |
| `dcs guard` | hook entry (§6) | — |

When `dcs start` runs on a task with a `jira` key, it moves that key's board row from `todo` or `blocked` to `in_progress`. If the key has no row, it warns and carries on.

**AC lint.** These are warnings, not refusals. `add` and `add --dry-run` both print them.
- An AC item uses a vague phrase: `correctly`, `properly`, `appropriately`, `as expected`, `as designed`, `matches (the) design`, `looks (good|right|nice)`, `works (fine)`, `user-friendly`, `intuitive`, `seamless(ly)`, `clean` or `nice`.
- A task has more than 5 AC items.
- A title is longer than 6 words.

**Verify** (`dcs verify <id>`):
1. **Spec kinds** skip the commands. They record `{fingerprint, skipped: true, at}` and move to `verified`.
2. **Concurrency.** When `settings.verifyConcurrency` is set, verify first takes a slot lock `verify-slot-<k>.lock` (k < N).
   - It waits up to **9 minutes**, retrying every second.
   - A slot held for more than 60 minutes counts as stale.
   - On timeout it prints "verify busy", exits 1 and records nothing.
3. **Setup re-run.** For worktree tasks, `worktreeSetup` runs again first if any lockfile changed since `baseSha` and its hash differs from `setupLockHash`. The lockfiles checked are `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `Podfile.lock`, `Gemfile.lock` and `Package.resolved`.
4. **Commands.** It runs each `verify` command in the task's working directory (the worktree if there is one, otherwise the main root).
   - The environment gets `DCS_MAIN_ROOT`, `DCS_TASK_ID` and `DCS_WORKTREE` (empty in solo mode).
   - It stores `{fingerprint, results: [{cmd, exit, tail}], integrity, at, log}`.
   - `tail` is the last 40 lines. The full output goes to `verify-<n>.log`.
5. **Integrity flags** come from a scan of `dcs diff`. They never change pass or fail.
   - `test-deleted`
   - `test-skip`: a new `.skip(`, `xit(`, `xdescribe(`, `.only(`, `fit(`, `fdescribe(`, `@Ignore`, `@Disabled` or `XCTSkip`
   - `assertions-removed`: a modified test file loses more assertion lines than it gains
   - `suppression`: a new `eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `swiftlint:disable`, `@Suppress` or `@SuppressLint`
   - `verify-config`: a change to `package.json`, `jest.config.*`, `babel.config.*`, `.eslintrc*`, `eslint.config.*`, `tsconfig*.json`, `.swiftlint.yml`, `detekt.yml` or `*.gradle*`
   - `snapshot-changed`: a change under `__snapshots__/`, `*.snap`, `__Snapshots__/` or `src/test/snapshots/`

   A test file is one matching `/__tests__/`, `.(test|spec).[cm]?[jt]sx?`, `Tests?.swift`, `Test(s)?.kt`, `/src/(test|androidTest)/`, or anything under a `Tests/` directory. `*.spec.md` files are never tests.
6. **Result.**
   - All commands pass: the task moves to `verified`. A landed task instead stays `approved` with `reverified: true`. `verifyFailStreak` resets to 0.
   - Otherwise: the task goes to `doing` and `verifyFailStreak` goes up by 1. **Three failures in a row count as 1 failure.**

**Review verdicts** (worked out by the CLI):
- The findings file is one JSON object: `{pass, findings: [{id, severity: critical|major|minor, file, line, quote, issue, scenario, fix?, refuted?, refuteReason?}], acResults?: [{i, met, evidence}]}`.
- A finding **blocks** only when all three hold:
  - it is critical or major;
  - its `quote` is an exact substring of `file` in the task's working directory;
  - it is not `refuted`.
- If a critical or major finding's quote is missing or doesn't match, the finding is recorded as `downgraded: "quote not found"` and does not block.
- For the `ac` pass, `acResults` must cover every AC index exactly once. Any `met: false` blocks.

**Required passes per round**

| Kind | Passes |
|---|---|
| `work` | `ac` (AC, correctness, repo rules and integrity flags), `security`, `performance`, `quality`, plus `a11y` when `ui: true` |
| `spec` | `ac`, `a11y` |
| `spec-sync` | `ac` |

**Failure cap.** Each of these adds 1 to `failures`:
- a failed verify streak
- a review round with a blocking finding
- a QA fail
- a failed re-verify

When `failures` reaches **3**, the task becomes `blocked`. Only `dcs unblock` resets it, and the G5 guard rule asks Navin first.

**Freshness of verify and review.** `verify.fingerprint` is a sha1 over the working directory's HEAD, `git diff HEAD --binary`, and the paths and contents of untracked, non-ignored files.

**Concurrency of the task file.** The CLI finds the **main** repo's `.claude/dcs/` through `git rev-parse --path-format=absolute --git-common-dir`. Writes go to a temp file that is then renamed, under a lock opened with `wx`. It retries for 5 seconds, and a lock older than 30 seconds is stale.

## 4. The Captain

The **Captain** is the role of Navin's **main session** while running `/dcs:plan`, `/dcs:work` or `/dcs:review`. There's no Captain agent file. Only the main session can ask Navin anything, because subagents can't use AskUserQuestion.

**Protocol.** This lives in `references/captain.md`, which the plan, work and review skills read first.
1. **Only the Captain talks to Navin.** That covers confirming the mode, questions, approvals for commits, pushes and PRs, blocked tasks, and land conflicts.
2. **Nobody guesses.** Crew who hit ambiguity return `{"status": "needs_input", "questions": [{"question", "why", "options", "recommended", "recommendedWhy"}]}`.
3. **Collect, then ask.**
   - In parallel and breezing modes, wait until every worker in the wave has replied, merge identical questions, then ask with AskUserQuestion (at most 4 per call). In solo mode, ask right away.
   - **Every question offers a recommended option**, listed first and labelled "(Recommended)", with a one-line reason. A recommendation is never treated as the answer.
   - **Before asking, check `dcs decisions` (all runs) and the relevant spec file.** If they already answer the question, cite them instead of asking.
4. **Relay.** Send each answer to the **same** crew member with SendMessage.
5. **Record and carry forward.** Save every answer with `dcs decide`, adding `--why` when Navin gives a reason. Record a rejected commit with `--q "commit rejected"`. Every worker, reviewer and QA dispatch includes the output of `dcs decisions --run`.
6. **No tie-breaking.** If a reviewer and a worker disagree, or a finding conflicts with a recorded decision, ask Navin.
7. **Only the Captain changes task state.** Workers run only `dcs verify`. The guard enforces this (rules R1 and R2).
8. **The CLI is the source of truth.** Nobody edits `.claude/dcs/*` or `~/.dcs/*` by hand, and nobody works around a refused command.
9. **Guard prompts belong to Navin.** A denial is final. Never retry it in a different form.
10. **Handoff notes.** After every worker reply, run `dcs note <id> <reply file>`.
11. **Resume.** The SessionStart hook prints `dcs brief` when a session resumes, is compacted, or starts with work in flight. Then the Captain:
    - re-reads `captain.md`;
    - runs `dcs list` and `dcs decisions --run`;
    - picks up each in-flight task from its status.

    Crew agents from before the break may be gone (it's unverified whether SendMessage reaches them after a resume). So re-dispatch a fresh worker with the task, the run's decisions and its latest `worker-<n>.json`.
12. **Discovered work.** Workers never widen scope. They report extra work as `discovered: [{title, why}]`. After each wave, show these to Navin. For each one Navin approves, run `dcs add` with `discoveredFrom`, or `dcs board add`.

## 5. Flow

### `/dcs:plan`
1. **Check settings.** Run `dcs check`. With no settings, stop and point Navin to `/dcs:setup`.
2. **Collect inputs:** the description, Jira keys, Figma URLs and any pasted AC. Never infer a key or a Figma node.
3. **Look before proposing.** Search the repo for existing implementations first.
4. **Clarify.** Ask one question at a time, each with a recommended option, and **at most 5 before the draft**. List any other open questions alongside the draft.
5. **Draft the tasks** as a table:
   - **Skeleton first:** skeleton, then sections, then states, each depending on the one before.
   - **Titles** of at most 6 words.
   - **At most 5 AC per task**, in light EARS form ("WHEN/WHILE/IF … the <component> shall …"), each with an observable outcome and no vague words.
   - **Repo spec files:** a `spec` task before implementation and a `spec-sync` task after.
   - **`refs` as the spec**, with the references confirmed with Navin.
   - **Coverage:** every state or variant listed in a touched repo spec file must be covered by some task.
6. **Dry run.** Run `dcs add --dry-run` on the draft, fix the problems and warnings, and show the table again.
7. **Board rows.** For each new key, ask for the Component and Title exactly as they should read in the weekly report.
8. **Write.** After Navin approves, run `dcs add` and `dcs board add`.

### `/dcs:work [all | <id>…] [--solo | --parallel | --breezing]`

**Start**
1. Run `dcs check`.
2. Run `dcs run`, which includes the baseline verify, with a Bash timeout of 600000 ms. If the baseline is **red**, ask Navin to choose (there's no "proceed anyway"):
   - fix main first, as its own task;
   - narrow the verify commands through `/dcs:setup`;
   - abort.
3. Pick the mode:
   - 1 ready task → solo, 2–3 → parallel, 4 or more → breezing. Flags override this.
   - Navin confirms the mode and the task list **once**.
   - Parallel is one wave of up to 3 worktrees. Breezing repeats waves and stops on a `blocked` task or a land conflict.

**Per task.** Steps a–c run concurrently across the wave. Steps d–g run **one task at a time**.

a. **Start** with `dcs start` (add `--worktree` in parallel or breezing mode).

b. **Worker.** Dispatch one (see §9 and the captain.md template).
   - `needs_input` → handle as in §4, points 3–5.
   - Every reply → record it with `dcs note` and collect its `discovered` items.
   - `blocked` → report to Navin.
   - `failed` → run `dcs show`, then either send the verify tails back to the same worker or treat the task as blocked.

c. **Review.**
   1. Dispatch the required passes in parallel. Each gets the AC, `refs`, `dcs diff`, the verify record (including integrity flags) and the run's decisions. The `ac` pass also gets the repo rule skills.
   2. **Refuter.** If any finding blocks, dispatch **one** reviewer with `pass: refute`. It gets only the blocking findings plus file access, tries to disprove each one, and marks it either `refuted: true` with a reason or upheld. The Captain merges these marks into each pass's findings file.
   3. Record each pass with `dcs review --findings`.
   4. **Integrity flags.** If the `ac` reviewer upholds a flag that no AC or decision explains, it goes to Navin before the task can be approved.
   5. If the round leaves the task in `doing`, send the blocking findings to the same worker with SendMessage, then go back to verify.

d. **Land** worktree tasks with `dcs land`. On a conflict the checkout is restored; ask Navin.

e. **Re-verify** landed tasks with `dcs verify <id>` in the main checkout.
   - Pass → the task stays `approved` with `reverified: true`.
   - Fail → the task goes to `doing`. A fresh worker fixes it in main, then verify, review and re-verify run again.

f. **Visual QA,** when `ui` is true and `visualQa` isn't false. See the protocol below.

g. **Commit.**
   1. Run `git add -A` and show `git diff --cached --stat`.
   2. Write the message as `<type>(<scope>): <summary>` in the repo's style, **ASCII only**. Add a `Fixes: <KEY>` trailer when the task has `jira` or the repo sets `requireFixesTrailer`. **Never** add Co-Authored-By.
   3. Commit with `git commit -F - <<'EOF'`. Rule G1 asks Navin.
   4. If Navin rejects the commit with a reason, record it with `dcs decide`.
   5. Run `dcs done --commit <sha>`.
   - **spec tasks:** before committing, run `dcs approve-spec` (G6 asks Navin) and set the template's status field to `Approved`. If Navin denies it, ask what to do next; there's no default.
   - **spec-sync tasks with nothing to change:** run `dcs done --no-changes`.

**After each wave,** show Navin the discovered work.

**End of run:** print a table of id, status, commit, failures and review rounds, and suggest `/dcs:pr`.

### Visual QA protocol
**0. Prepare the device.** Record the current values first and restore them afterwards.
- **iOS:**
  - `xcrun simctl status_bar booted override --time 9:41 --batteryState charged --batteryLevel 100 --cellularBars 4 --wifiBars 3 --dataNetwork wifi`
  - `xcrun simctl ui booted appearance <light|dark>`
  - `xcrun simctl ui booted content_size large`
  - Afterwards: `xcrun simctl status_bar booted clear`
- **Android:**
  - System UI demo mode, with the clock at 09:41
  - `adb shell cmd uimode night <yes|no>`
  - `adb shell settings put system font_scale 1.0`
  - Window, transition and animator animation scales set to 0
  - Afterwards: restore the recorded values and exit demo mode

**1. Capture**

*With `settings.maestro`,* the **Captain** runs `dcs apps <id>`, which lists the apps whose `paths` the task's diff (committed, uncommitted and untracked, since the task base) touches; an app with no `paths` always counts. For each listed app and each of its platforms:
1. Write a throwaway flow at `.claude/dcs/evidence/<id>/flows/<app>-<platform>-<n>.yaml`:
   - `launchApp` with the `appId`;
   - `openLink` from the `deepLink` template, or tap steps. With the platform's `knownIssues` containing `openLink-noop`, the deep link is opened from the shell (`xcrun simctl openurl` / `adb shell am start`) before the flow; `back-noop` rules out `back`; `metro-banner` adds a wait for Metro's "Refreshing…" banner to clear;
   - brand changes via `tapOn` the app's `brandSwitcher` (or one deep link per brand), each followed by `waitForAnimationToEnd`;
   - `assertVisible` for the reference's key texts or labels;
   - `startRecording`;
   - `takeScreenshot` for each state and brand in scope, named `<screen>_<state>_<brand>_<appearance>_<platform>`;
   - `stopRecording`.
2. Run `MAESTRO_CLI_NO_ANALYTICS=true maestro test <flow> --test-output-dir <evidence>/qa-<n>-<app>-<platform>/`. Maestro waits for the screen to settle.
3. The captures are the screenshots plus the MP4 recording.

*Without Maestro,* the QA agent captures on its own. Before comparing, it waits until two consecutive screenshots are identical.

**2. State check.** The QA agent opens every capture and records what it shows (`shows`, `matches`). If a capture doesn't show the brand and state it's named for, or the reference's key texts or labels are missing (a failed `assertVisible`, or not in the accessibility snapshot), the verdict is `invalid`. Recapture instead of comparing. A finished flow is never evidence on its own.

**3. Reference**, one of:
- the Figma screenshot of the task's node, plus its **Figma values** from `get_design_context` and `get_variable_defs`;
- screenshots Navin supplied, when there's no Figma node;
- none: the QA agent runs its own checks and sets `referenceDiff: false`.

**4. Data checks.** Compare the Figma values with the code the task touched: spacing, sizes, radius, typography (size, weight, line-height) and color tokens. Record them as `tokenChecks: [{property, expected, actual, file, ok}]`. Every `ok: false` is a major finding.

**5. Visual comparison**
1. Crop the capture to the reference's extent.
2. Convert both to **points** (pixels ÷ scale).
3. Compare **paired crops** region by region, each crop at most about 1500 px on its long edge, for each region in scope.
4. Go through this checklist: presence and order, position, size, spacing, typography, color, radius, elevation, icon, copy.
5. Ignore device chrome, placeholder images and copy, and live data.

**6. Findings** take the shape `{severity: blocker|major|minor, location, bbox?: [x, y, w, h] as 0–1 of the reference, crop?, difference, expected, actual}`. Differences default to major. Minor is only for rendering noise you can justify.

**7. Confirm before failing.** Re-check each blocker or major finding against its crops and the tokenChecks. If a finding can't be confirmed, mark it minor and note "unconfirmed".

**8. Own checks.** For tasks that change text, take one capture at the largest accessibility text size and check it for clipping, overlap and truncation only.

**9. Verdict**
- `fail`: any confirmed blocker or major finding, or any failed tokenCheck.
- `invalid`: the captured state doesn't match the reference.
- `pass`: otherwise.

The Captain records the verdict with `dcs qa`.
- If a report lacks a verdict, a severity or a location, ask for it once more. If it's still incomplete, ask Navin.
- After 2 invalid captures, ask Navin.

The reply looks like this:
```json
{"status": "done", "verdict": "pass|fail|invalid", "referenceDiff": true,
 "screenshots": [{"path": "", "platform": "", "device": "", "brand": "", "appearance": "", "contentSize": ""}],
 "recordings": [""], "tokenChecks": [], "findings": []}
```

### `/dcs:review [<id> | --diff]`
- **`<id>`:** runs the same passes as `/dcs:work`, including the refuter and recorded verdicts, for one `verified` task.
- **`--diff`:** reviews the whole branch diff and only reports. Nothing is recorded.

### `/dcs:pr`
Absorbs `pr.md` and `raising-prs`.
1. **Gather facts** from git and from the `done` tasks on this branch: their `jira`, `figma` and evidence.
2. **Draft** in the house format. Links come from `settings.pr` and the title from `pr.titleFormat`. If a value is missing, ask.
3. **Evidence**, per platform:
   - verify results;
   - review verdicts for each pass, plus **per-AC results** (`acResults`);
   - QA verdicts and tokenChecks;
   - **Maestro recordings and screenshot file names**. `gh` can't embed images or video, so Navin attaches those.
4. **Approval.** Print the body and wait for Navin to approve it.
5. **Open the PR.** Check `gh auth status`, push if needed (G4 asks), then run `gh pr create --draft …` (G7 asks).
6. **Board.** Run `dcs board pr` for each key. If the branch has no key, ask whether to attach the PR to an untracked row.

### `/dcs:visual-qa`
The generic QA skill, used when `visualQa` is `{"skill": "dcs:visual-qa"}`. It follows the QA protocol above on the iOS simulator and the Android emulator. It captures with Maestro when that's configured, and otherwise with `agent-device` pinned at 0.17.6 (never `@latest`).

### `/dcs:setup`
Setup detects each value, then confirms it with Navin one at a time, in this order: `base`, `verify`, `worktreeSetup`, `verifyConcurrency`, `requireFixesTrailer`, `repoRules`, `visualQa`, `maestro`, `specs`, then `pr.*`.
- **verify:** each command must finish within 10 minutes. Setup may suggest adding snapshot-test and accessibility-audit commands the repo already has.
- **worktreeSetup:** for npm repos on macOS, suggest the APFS clone form, which copies `node_modules` from main when the lockfile matches and falls back to `npm ci`:
  `cmp -s "$DCS_MAIN_ROOT/package-lock.json" package-lock.json && cp -c -R "$DCS_MAIN_ROOT/node_modules" . || npm ci`
- **verifyConcurrency:** suggest 1 when verify runs Xcode or Gradle builds.
- **maestro:** detect every runnable example app (not web ones like Storybook). For each, detect its bundle ID or applicationId, its deep-link scheme, and the paths it covers (the app folder plus the package it demos). If `maestro` isn't installed, tell Navin to install it themself. Setup never installs anything.

When everything is confirmed, setup runs `dcs init`.

## 6. Guardrails (`dcs guard`)

**Hooks** (`hooks.json`):
- **PreToolUse.** Matcher `Bash|Monitor|Read|Write|Edit|MultiEdit|NotebookEdit|Grep`, timeout **10 seconds**, command `node "${CLAUDE_PLUGIN_ROOT}/bin/dcs" guard || { echo "dcs guard error: disable the dcs plugin to bypass" >&2; exit 2; }`.
- **SessionStart.** Matcher `startup|resume|compact`, command `node "${CLAUDE_PLUGIN_ROOT}/bin/dcs" brief 2>/dev/null || true`.

**Behavior**
- **Fail closed.** Any exception inside the guard exits 2, which blocks the call.
- **Timeout.** A hook that times out lets the call through. That's a known ceiling; the 10-second timeout makes it rare.
- **Output.** The guard returns `hookSpecificOutput.permissionDecision` of `deny` or `ask`.
  - The reason reads `dcs <RULE>: <why>`, joining every rule behind the winning decision with `; `.
  - A deny beats an ask.
  - When nothing matches, the guard prints nothing.

**Tool inputs checked**

| Input | Checks |
|---|---|
| Bash `command`, Monitor `command` | Bash rules |
| `file_path` (Read, Write, Edit, MultiEdit), `notebook_path` (NotebookEdit) | paths |
| Grep `path` and `glob` | paths (S1 only) |
| Write `content`, Edit `new_string`, MultiEdit `edits[].new_string`, NotebookEdit `new_source`, Bash and Monitor command text | S2 |

**Bash parsing.** This is quote-aware tokenizing, not a full shell parser.
- **Splitting.** A command is split on `; && || | &` (except in `>&` and `&>`), on newlines, and on `( ) \``, all only outside quotes.
- **Heredocs.** Their bodies are left out of the parse but kept for S2 and for commit messages.
- **Backslash** escapes only inside double quotes.
- **Keywords.** Leading `if then else elif fi do done while until ! { }` are stripped. Segments that start with `for`, `case` or `select` are skipped.
- **Environment prefixes.** `VAR=value` prefixes are recorded, then stripped.
- **Wrappers** are stripped together with their arguments:
  - `env` (with `-i` and `-u X`), `command`, `builtin`, `nohup`, `time`, `exec`, `noglob`;
  - `nice` (with `-n N`), `timeout` (with its flags and duration), `stdbuf`;
  - `xargs` (with its flags; `-I`, `-n`, `-P`, `-L`, `-d`, `-E` and `-s` take a value).
- **Command word.** A leading `\` and empty quote pairs are removed, then the basename is used.
- **Nesting.** These are re-evaluated with the same rules, up to a depth of 3:
  - `sh|bash|zsh|dash -c <arg>` (also `-lc` and `-ec`);
  - `eval <rest>`;
  - `find … -exec|-execdir|-ok <cmd…> ;|+`;
  - a heredoc fed to a shell;
  - a git alias. An unknown git subcommand is expanded with one `git config --get alias.<name>` call, and an alias starting with `!` is treated as shell.

  Anything nested deeper than 3 asks (D6).

| # | Rule | Action |
|---|---|---|
| **Approvals** |||
| G1 | `git commit` | ask |
| G2 | commit message contains `Co-Authored-By` (case-insensitive) | deny |
| G3 | commit message lacks `Fixes: <KEY>-<n>` when `requireFixesTrailer`, or lacks the `jira` of every `approved` task (at least one must match); also when dcs files are unreadable | deny |
| G4 | `git push` | ask |
| G5 | `dcs unblock` | ask |
| G6 | `dcs approve-spec` | ask |
| G10 | `dcs purge --yes` | ask |
| G9 | `gh pr create` when `settings.prChecks` is set and `.claude/dcs/prcheck.json` isn't `ok` for the current HEAD, or the tree is dirty | deny |
| G8 | `dcs start … --branch-ok` (starting a Jira task off its ticket's branch) | ask |
| G7 | gh writes: `gh pr create\|merge\|close\|reopen\|comment\|review\|edit\|ready`, `gh issue create\|close\|comment\|edit`, `gh release create\|delete\|edit\|upload`, `gh repo create\|delete\|edit\|rename\|archive`, `gh workflow run\|enable\|disable`, `gh gist\|secret\|variable` writes, `gh api` with `-X/--method` ≠ GET or with `-f/-F/--field/--raw-field/--input`. **Not asked** (workers are still denied by R1): `gh api graphql` whose every `query=` is inline and has no `mutation`; a document that is exactly one `resolveReviewThread` mutation; a POST to `repos/<o>/<r>/pulls/<n>/comments/<id>/replies` without `--input` | ask |
| B1 | when `permission_mode` is `bypassPermissions`, G1/G4/G5/G6/G7/G8 become **deny** ("bypass mode would skip your approval; switch to Manual mode or run it yourself"). In `auto`, they become deny unless the hit's top-level segment literally starts with the prefix of a `Bash(<prefix> *)` or `Bash(<prefix>:*)` rule in the user settings `permissions.ask` (`$CLAUDE_CONFIG_DIR` or `~/.claude`, `settings.json`); then they stay ask and the native rule prompts. Other rule forms and other settings files don't count (fail closed). | deny |
| **Roles** |||
| R1 | `agent_type` `plugin:dcs:worker`: `git commit\|push\|merge\|rebase\|reset\|tag\|cherry-pick\|revert`; any G7 gh write; any `dcs` command except `verify show diff list next decisions check brief stats` or a read-only `board` view; Write/Edit/MultiEdit/NotebookEdit under `.claude/dcs/` | deny |
| R2 | `agent_type` `plugin:dcs:reviewer`: Write/Edit/MultiEdit/NotebookEdit; git subcommands other than `diff log show status blame rev-parse ls-files`; `dcs` other than `diff show list decisions`; `rm mv cp tee touch mkdir`, `sed -i`, or a `>`/`>>` redirect to a path other than `/dev/null` | deny |
| **Destructive** |||
| D1 | command word `sudo`, `doas`, `su`, `pkexec` | deny |
| D2 | `git push` with `--force`, `-f` (in a short-flag cluster), `--force-with-lease*`, or a `+refspec` | deny |
| D3 | `--no-verify` on commit or push; a `-n` cluster on commit; `git -c core.hooksPath=…` or `git -c alias.<x>=…`; `HUSKY=0`, `HUSKY_SKIP_HOOKS=1`, `LEFTHOOK=0` or `SKIP=…` prefixes on commit or push | deny |
| D4 | `git push` targeting `main`/`master` (refspec, `HEAD` or a bare push while on it), `--all`, `--mirror` | deny |
| D5 | `rm` with `-r`/`-R`/`--recursive`; `find … -delete`; `git reset --hard\|--merge`; `git clean -f`; `git checkout` with `.`, `-f/--force` or any path after `--`; `git restore` unless `--staged` without `--worktree`/`-W`; `git switch -f\|--force\|--discard-changes`; `git branch -D` or `--delete --force`; `git stash drop\|clear` | ask |
| D6 | dynamic command word (`$VAR`, `${…}`, `$'…'`, `$(…)`, backticks); a shell reading a script from a pipe or stdin (`… \| sh`, `bash -s`, a bare `bash` after a pipe); nesting deeper than 3 | ask |
| **Secrets and data egress** |||
| S1 | protected paths, resolved through symlinks: `.env` and `.env.*` (except `.env.example`), `*.pem`, `*.key`, `*.p12`, `*.p8`, `*.jks`, `*.keystore`, `keystore.properties`, `.npmrc`, any `.ssh`/`.aws`/`.gnupg`/`.kube` path segment, `~/.appstoreconnect/`, `~/.gradle/gradle.properties`, `~/.netrc`, `~/.git-credentials`, `~/.config/gh/`, `~/.docker/config.json`. Bash tokens are also split on `= : ' " ( ) , ; < >` and whitespace. Commit-message values are exempt. | deny |
| S2 | secret-looking content: `gh[opsru]_[A-Za-z0-9]{36}`, `github_pat_\w{22,}`, `npm_[A-Za-z0-9]{36}`, `glpat-[A-Za-z0-9_-]{20,}`, `(sk\|rk)_live_[A-Za-z0-9]{20,}`, `xox[baprs]-[A-Za-z0-9-]{10,}`, `hooks\.slack\.com/(services\|workflows\|triggers)/\S+`, `sk-[A-Za-z0-9_-]*T3BlbkFJ[A-Za-z0-9_-]+`, `sk-ant-[A-Za-z0-9_-]{20,}`, `ATATT3[A-Za-z0-9_=-]{50,}`, `SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}`, `(AKIA\|ASIA)[A-Z2-7]{16}` (unless it contains `EXAMPLE`), and a private key **with a body**: `-----BEGIN [A-Z ]*PRIVATE KEY-----` followed by 64 or more base64 characters | deny |
| S3 | credential-read commands: `security find-generic-password\|find-internet-password\|dump-keychain`, `gh auth token`, `git credential fill` | deny |
| S4 | Maestro egress: `maestro cloud`; `maestro login`; `maestro record` without `--local`; `--analyze`; `--api-key`; a `MAESTRO_CLOUD_API_KEY=` prefix; `maestro test <flow>` where the flow file contains `WithAI`/`WithAi` (AI commands); any `maestro` command without an inline `MAESTRO_CLI_NO_ANALYTICS=true` prefix | deny |
| **Scope** |||
| C1 | Write/Edit/MultiEdit/NotebookEdit outside the repo root, its dcs worktrees, `$TMPDIR`, `/tmp`, `/private/tmp` and `~/.claude/projects/*/memory/` | ask |

**Commit message** (checked by G2 and G3). The message is the full raw command, including heredoc bodies, plus the contents of the file named by `-F` or `--file` when it can be read. A commit that opens an editor can't be inspected, so G1 still asks.

**Guard log.** Every deny and every ask appends one JSON line to `~/.dcs/guard/<YYYY-MM>.jsonl` (override the folder with `DCS_GUARD_LOG_DIR`). The line is `{ts, session_id, agent_type, permission_mode, tool, cwd, decision, rules, detail}`:
- `detail` is the command or path, with S2 matches replaced by `[redacted]` and cut to 300 characters.
- Logging never changes a decision, and a logging failure is ignored.

**Known ceilings** (documented, not fixed):
- scripts the model writes and then runs (`bash x.sh`, `npm run`, `make`, git hooks);
- interpreter one-liners, which only the S1 path scan sees into;
- obfuscation beyond the dynamic-command-word check (base64, or variables set in an earlier call);
- indirect secret reads (`grep -r KEY .`, `printenv`, the inherited environment);
- `cp`, `mv`, `sed -i` and `rsync` targets, which C1 doesn't check;
- remote execution (`ssh`, `docker exec`, `npx`);
- hooks switched off in settings, or skipped because of a timeout.

Server-side branch protection and push protection remain the real backstop. Claude Code's sandbox is optional hardening that dcs does not turn on.

## 7. Repo settings

`.claude/dcs/settings.json`:
```json
{
  "base": "main",
  "verify": ["npm run typecheck", "npm test", "npm run lint"],
  "worktreeSetup": ["cmp -s \"$DCS_MAIN_ROOT/package-lock.json\" package-lock.json && cp -c -R \"$DCS_MAIN_ROOT/node_modules\" . || npm ci"],
  "verifyConcurrency": 1,
  "requireFixesTrailer": true,
  "repoRules": ["component-patterns", "accessibility", "code-style-guards", "loading-skeletons", "tap-debounce-guard", "image-handling"],
  "visualQa": { "agent": "visual-qa" },
  "maestro": [
    { "name": "rn", "paths": ["packages/fluidity-react-native", "apps/example-rn"],
      "ios": { "appId": "<bundle id>", "deepLink": "<scheme>://demo/{route}?theme={brand}" },
      "android": { "appId": "<applicationId>", "deepLink": "<scheme>://demo/{route}?theme={brand}" } },
    { "name": "swiftui", "paths": ["packages/fluidity-ios", "apps/example-ios"], "ios": { "appId": "<bundle id>" } },
    { "name": "compose", "paths": ["packages/fluidity-android", "apps/example-android"], "android": { "appId": "<applicationId>" } }
  ],
  "specs": { "dir": "specs/components", "template": "specs/templates/component-spec.template.md", "contracts": ["specs/contracts/accessibility.md", "specs/contracts/states.md", "specs/contracts/theming.md"] },
  "pr": { "githubTreeBase": "https://github.com/<owner>/<repo>/tree/", "jiraBase": "https://jira.rccl.com/browse/", "figmaFile": { "name": "Fluidity UI Kit", "key": "<file key>" }, "titleFormat": "<TICKET> | DS | <Area> | <Feature>" }
}
```
**Validation**

| Field | Rule |
|---|---|
| `base` | non-empty string |
| `verify` | non-empty array of strings |
| `prChecks` | optional; `false` or a non-empty array of non-empty strings (the PR CI steps run by `dcs prcheck`) |
| `worktreeSetup` | array of strings |
| `verifyConcurrency` | optional; integer ≥ 1 |
| `requireFixesTrailer` | boolean |
| `repoRules` | array of strings |
| `visualQa` | `{agent}`, `{skill}` or `false` |
| `maestro` | `false`, or a non-empty list of apps `{name, paths?, ios?, android?}`: `name` a unique non-empty string; `paths` a non-empty list of repo-relative paths (no `..`, not absolute); optional `brandSwitcher` (non-empty string: the label of an in-app control that switches brand); at least one platform, each `{appId: non-empty string, deepLink?: string, knownIssues?: ["openLink-noop" \| "back-noop" \| "metro-banner"]}`; no other keys at either level |
| `specs` | `false`, or `{dir, template, contracts[]}` where every path exists |
| `pr` | optional object |

## 8. Weekly task board

Unchanged from v1:
- **Scope.** One board for every project.
- **Rows.** A row is a Jira ticket (`key` set) or an untracked item (`key: null`). A ticket that spans several repos is one row.
- **Storage.** ISO-week files `~/.dcs/board/<YYYY>-W<WW>.json`, each with a rendered `.md`. Writes are atomic and locked, and skills never edit these files.
- **Row fields.** `{id, key, component, title, status, repos, prs, source, reason, history}`, where `status` is `todo`, `in_progress`, `undergoing_pr`, `done` or `blocked`.
  - `blocked` requires a `reason`.
  - `source` is only for untracked rows.
  - Row ids are unique across weeks.
- **Carry-over.** The first board command of a new week copies over every row that isn't `done`, keeping its status.
- **Merged check.** When a row's last PR merged in an earlier week, the row becomes `done` in that week and is removed from later weeks.
- **CLI.** `dcs board [--week] [--json] [--offline] [--report]`.
  - The merged check runs unless `--offline` is given.
  - `--report` exits 3 when a component or title is missing.
  - Sub-commands: `dcs board add|set|pr|edit`.
- **Automatic updates.**
  - `dcs start` moves the row to `in_progress`.
  - `/dcs:plan` adds rows.
  - `/dcs:pr` attaches the PR.
  - The merged check runs `gh pr view <url> --json state,mergedAt` and marks a row `done` once all its PRs are merged. If `gh` fails, it warns and changes nothing. There's no background polling.
- **`/dcs:status`** drafts the report and prints it in chat. It never sends it anywhere. The report contains:
  - Ticketed lines: `<KEY> — <Component> | <Title>`, with the suffix `(Undergoing PR)`, `(In progress)` or `(Blocked: <reason>)`. Done has no suffix, and `todo` rows are left out.
  - One `Other shipped work (no ticket - issues pointed out by <source>):` section per source, listing done untracked rows as `<Component> — <Title>`.
  - No housekeeping section.
  - Ordering: done, then undergoing PR, then in progress, then blocked, then by key.

### 8b. Local stats (`dcs stats`)
`dcs stats` computes these from the `tasks.json` history and reviews, plus the review evidence files, and prints them as a table (or as JSON with `--json`). Nothing is sent anywhere.
- tasks by status
- **first-pass rate:** done tasks whose history never returned to `doing` after `verified`
- **mean review rounds to approval**
- **blocked rate:** tasks that were ever `blocked`, over started tasks
- **per-pass blocking findings:** total, refuted and downgraded
- **decisions recorded**

## 9. Agents

**worker.md**
- **Tools:** Read, Write, Edit, Bash, Grep, Glob, Skill, and the Figma MCP read tools (`get_design_context`, `get_screenshot`, `get_metadata`, `get_variable_defs`).
- **Rules:**
  - Follow the repo rule skills.
  - Test first: write a failing test for each AC item before implementing.
  - Run `dcs verify` with a Bash timeout of 600000, at most 3 times per dispatch.
  - Never commit, push or run a dcs state command. R1 enforces this.
  - **Never start Metro, simulators or emulators.**
  - Never delete, skip or weaken tests, add suppressions, or edit verify config unless an AC or a decision says so. If it seems necessary, return `needs_input`.
  - Report anything out of scope in `discovered`.
  - Figma, `refs` and spec kinds work as in v1.
- **Replies:**
  - `{status: done|failed, summary, files, verify, concerns?, discovered?}`;
  - `needs_input`, where every question carries a recommended option;
  - `{status: blocked, reason}`.

**reviewer.md**
- **Tools:** Read, Grep, Glob, Bash (read-only, enforced by R2), Skill.
- **One pass per dispatch:** `ac`, `security`, `performance`, `quality`, `a11y` or `refute`.
- **Rules:**
  - Judge only against the AC, `refs`, the repo rule skills and the decisions.
  - Don't re-report what verify or lint already checks.
  - Don't report pre-existing issues or lines outside the diff.
  - Every critical or major finding needs an exact `quote` from the file and a concrete `scenario` (the input or state and the wrong result). `fix` is optional.
- **Severity rubric:**
  - **critical:** data loss, a security hole, a crash, or an AC that is plainly unmet;
  - **major:** wrong behavior in a reachable state, or a breach of a repo rule;
  - **minor:** everything else.
- **`ac` pass:** returns `acResults` for every AC, and rules on each integrity flag. A flag explained by an AC or a decision is fine; otherwise it's a major finding.
- **`refute` pass:** receives only the blocking findings, tries to disprove each against the code, and returns `{id, upheld, reason}`. It never adds new findings.
- **Replies:** findings JSON (§3), or `needs_input`.

## 10. Error handling summary

| Situation | Behavior |
|---|---|
| No settings | `/dcs:work` and `dcs start` refuse and point to `/dcs:setup` |
| An invalid or corrupt dcs file | the CLI refuses and never repairs it; the guard denies commits (G3) |
| A stale lock (> 30 s) or stale verify slot (> 60 min) | removed |
| All verify slots busy for 9 minutes | "verify busy", exit 1, nothing recorded |
| Baseline is red | Navin chooses: fix, narrow verify, or abort |
| Worktree setup fails | the worktree is removed and the task stays `todo` |
| `land` conflict | main is restored, the worktree is kept, and the Captain asks |
| Re-verify after land fails | `doing`, +1 failure, fixed in main |
| Main checkout dirty at `start`, `land` or `run` | refused |
| Figma MCP unavailable for a Figma task | the worker stops and reports |
| Maestro configured but not installed | QA falls back to the QA agent's own capture, and the Captain tells Navin |
| An integrity flag nobody explained | the Captain asks Navin before approval |
| `failures` reaches 3 | `blocked`, and the Captain asks |
| `gh` not authenticated | `/dcs:pr` stops and asks; the merged check warns |
| Guard exception, or node missing | the call is blocked (fail closed) |
| Guard times out | the call goes ahead (Claude Code's behavior; the 10 s timeout keeps this rare) |
| Session resumed or compacted mid-run | `dcs brief`, then the Captain resumes from task status; a fresh worker gets the latest handoff note |

## 11. Testing

Run with `node --test test/*.test.js`. There are no dependencies, and every test uses a throwaway `git init` repo in `os.tmpdir()`. `DCS_BOARD_DIR` and `DCS_GUARD_LOG_DIR` always point at temp dirs.

**v1 coverage (unchanged)**
- every transition and every refusal
- `add` validation and `#n` references
- the failure cap and the fingerprint refusal
- dirty-checkout refusals
- decisions and evidence files
- spec kinds
- worktrees
- land: clean, with a binary file, with spaces in the path, and with a conflict
- board: ISO weeks, carry-over, the merged check, the report and concurrency
- every guard rule, each with a near-miss

**New in v2**
- `add`: lint warnings; `--dry-run` writes nothing; `discoveredFrom` validation.
- `history` records every status change.
- Integrity flags: one fixture per kind, and `.spec.md` isn't treated as a test.
- Verify slots:
  - busy, then wait, then acquire;
  - on timeout, "verify busy" and nothing is recorded (tests use a short wait through an env override).
- A lockfile change re-runs setup, and the `DCS_*` env vars are passed through.
- Re-verify after land: `qa` and `done` are refused until it passes, and a failure moves the task to `doing`.
- `run`: the baseline is recorded; red exits 1; a dirty checkout is refused.
- Review verdicts:
  - an unmet AC blocks;
  - a missing `acResults` is refused;
  - a quote that isn't found is downgraded and doesn't block;
  - a refuted finding doesn't block;
  - minor findings alone approve.
- `note` and `brief`: `brief` is silent when nothing is in flight, and lists the in-flight tasks when there are some.
- `stats` returns the correct numbers for a fixture history.
- Guard, coverage and modes:
  - Monitor, NotebookEdit and Grep are covered;
  - B1 in bypass mode;
  - R1 and R2 by `agent_type`.
- Guard, parsing:
  - keywords and wrappers;
  - `\sudo` and `s""udo`;
  - `for` and `if` loops;
  - `sh -c`, `eval`, and `find -exec` / `-delete`;
  - a heredoc fed into a shell;
  - git alias expansion (stubbed);
  - nesting deeper than 3.
- Guard, rules:
  - the D6 cases, and the new D3, D4, D5 and G7 cases;
  - the new S1 paths and symlinks;
  - the new S2 patterns, with a key body required and `EXAMPLE` exempt;
  - S3 and S4;
  - `cat<.env`.
- Guard, log and hooks:
  - a log line is written and masked, and a logging failure doesn't change the decision;
  - `hooks.json` has both hooks and the 10 s timeout.
- Test fixtures that look like secrets are built by string concatenation, so the guard never blocks edits to its own tests.

**Manual smoke test (Task 12).** After installing:
1. In a throwaway repo, run `/dcs:setup`, then `/dcs:plan`, then `/dcs:work --solo`, and approve the commit prompt.
2. Check that the guard denies `sudo ls` (D1), `git push origin main` (D4) and `maestro cloud` (S4).
3. After `/compact`, check that `dcs brief` appears.
4. Run `dcs board --offline`.

## 12. Decisions deferred to implementation time (ask Navin)

1. Installing the plugin at user scope changes Claude Code's settings. Confirm before running it.
2. Once the dcs versions are verified, should the originals (`~/.claude/commands/pr.md`, `~/.claude/skills/raising-prs`, `~/.claude/skills/visual-qa`) be removed? Default: keep them.
3. ~~Commit trailer in dcs-harness~~ Resolved: no trailer and no Co-Authored-By.
4. Once `/dcs:status` is verified, should the "weekly status report format" memory be retired? Default: keep it.
5. **Installing Maestro.** Navin installs it, if and when the org's tooling policy allows. Until then `settings.maestro` stays `false`.

## 13. Research-round changes (v2)

These come from the five research reports of 2026-09-30. The claims that matter most were checked against the primary docs and tool schemas (§2, "Verified platform facts").

**Tier 1**
- guard coverage for Monitor, NotebookEdit and Grep
- B1: in bypass mode, approvals become denials
- a 10-second hook timeout
- roles R1 and R2 by `agent_type`
- re-verify after land
- integrity (test-tampering) flags

**Tier 2**
- `dcs brief` at SessionStart, plus handoff notes
- per-AC verdicts
- AC lint and light-EARS AC
- findings backed by a quote, and one refuter per round
- a recommended option on every question, at most 5 clarifying questions, and checking decisions before asking
- parsing hardening: keywords, wrappers, nesting, D6
- git and gh coverage: extensions to D3, D4 and D5, plus G7
- secrets: new S1 paths, new S2 patterns, S3
- QA: crops, points, checklist, confirm before failing, repeatable captures, state check

**Tier 3 (chosen)**
- Figma values in QA (tokenChecks)
- faster worktrees: `DCS_*` env vars, the APFS clone suggestion, `verifyConcurrency`, re-running setup when a lockfile changes
- baseline verify
- discovered work
- guard log
- `dcs stats`

**Not chosen**
- merging review passes: 5 passes remain

**Added by Navin**
- Maestro for QA navigation and PR evidence on iOS and Android: throwaway flows, local only, analytics off, enforced by S4

**Navin's choices**
- `gh pr create` also prompts (G7).
- Verdicts are worked out from the findings.
- A red baseline offers fix, narrow verify or abort.
- Verify slots wait up to 9 minutes.
