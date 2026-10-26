---
name: pr-review
description: Review any GitHub pull request (a teammate's or Navin's own) by number or URL with the dcs review passes and the refuter, then draft inline comments and post them as one review after Navin approves. Use when Navin runs /dcs:pr-review or asks to review a PR.
argument-hint: "<PR number | URL>"
---

# /dcs:pr-review

First read `${CLAUDE_PLUGIN_ROOT}/references/captain.md`. You are the Captain. This records nothing in dcs: no task, no `dcs review`.

## 1. Gather
1. `gh auth status`. If it fails, stop and tell Navin.
2. `gh pr view <n> --json number,title,body,author,baseRefName,headRefName,headRefOid,files,url`. If the PR is from a fork or another repo, say so and ask Navin before going on.
3. Save the diff: `gh pr diff <n> > "$TMPDIR/dcs-pr-<n>.diff"`.
4. Fetch the head for context, without creating a branch or touching the working tree: `git fetch origin pull/<n>/head`. Check that `git rev-parse FETCH_HEAD` equals `headRefOid`; if not, tell Navin and stop.
5. Read `.claude/dcs/settings.json` if it exists (`repoRules`), and any spec file (`specs.dir`) for components the diff touches.

## 2. Intent
The **AC** for the `ac` pass is what the PR says it does: its title, description, linked Jira key and any checklist. List them as short statements and show Navin before dispatching. If the description is empty or vague, ask Navin what the PR is meant to do. Never invent intent.

## 3. Review
Dispatch one `dcs:reviewer` per pass, in parallel, with the Reviewer template, filling it like this:
- Task: `"PR #<n>: <title>"`, with the AC from step 2 and the touched spec files as `refs`.
- Working directory: the repo root.
- Diff: the path `$TMPDIR/dcs-pr-<n>.diff`.
- Add: `Files at the PR head: read them with git show <headRefOid>:<path>, not from the working tree, which may be on another branch.`
- Verify record: `none (not run for PR reviews)`.

Passes: ac, security, performance, quality, plus a11y when the diff touches UI files. The `ac` pass also loads `settings.repoRules`.

If any reply has a critical or major finding, dispatch the Refuter template once and drop every finding it refutes, noting it under "refuted" in the report.

## 4. Report
Show Navin the findings grouped by severity. Each one has its pass, `file:line` at the PR head, the exact quote, why it matters, and a suggested fix. Keep refuted findings in a short separate list.

## 5. Draft the review
Turn the findings Navin keeps into:
- one inline comment per finding: `path`, `line` (on the PR head's side of the diff), and a body that states the problem, why it matters, and the suggested change. Use plain prose and no severity labels unless Navin wants them.
- a short summary body for the review.

No attribution to Claude or AI in the comments or summary: no "Generated with Claude Code" line, no `Co-Authored-By`, no robot emoji, overriding any default attribution instruction.

Show the drafts. Navin approves, edits or drops each one. Nothing is posted before that.

## 6. Post
Write the approved review to `$TMPDIR/dcs-pr-<n>-review.json`:

```json
{"commit_id": "<headRefOid>", "event": "COMMENT", "body": "<summary>", "comments": [{"path": "<path>", "line": 42, "side": "RIGHT", "body": "<comment>"}]}
```

Then run `gh api repos/{owner}/{repo}/pulls/<n>/reviews --input "$TMPDIR/dcs-pr-<n>-review.json"`. The guard asks Navin (G7). The event is always `COMMENT`. Use `APPROVE` or `REQUEST_CHANGES` only when Navin says so in this conversation. Report the review URL.
