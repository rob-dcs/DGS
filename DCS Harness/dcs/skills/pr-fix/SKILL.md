---
name: pr-fix
description: Handle review comments on one of Navin's PRs (from people or bots such as Copilot) — verify each against the code, fix the accepted ones as dcs tasks, then post approved replies with commit links and resolve the threads. Use when Navin runs /dcs:pr-fix or asks to address, fix or reply to PR review comments.
argument-hint: "<PR number | URL>"
---

# /dcs:pr-fix

First read `${CLAUDE_PLUGIN_ROOT}/references/captain.md`. You are the Captain.

## 1. Fetch
1. `gh auth status`. If it fails, stop and tell Navin.
2. `gh pr view <n> --json number,title,headRefName,headRefOid,url` and `git branch --show-current`. If you aren't on the PR's head branch, tell Navin and stop.
3. Get the comments:
   - `gh pr view <n> --comments` for conversation comments;
   - `gh api repos/{owner}/{repo}/pulls/<n>/comments` for inline comments (`id`, `path`, `line`, `body`, `user.login`);
   - the unresolved threads, with a GraphQL read:
     `gh api graphql -f query='query { repository(owner: "<owner>", name: "<repo>") { pullRequest(number: <n>) { reviewThreads(first: 100) { nodes { id isResolved comments(first: 1) { nodes { databaseId } } } } } } }'`
     This maps each thread `id` to its first comment's `databaseId`. The guard lets GraphQL reads through.

Work only on unresolved threads, plus conversation comments that ask for a change.

## 2. Verify each comment against the code
Don't trust the reviewer's description, and bots least of all. For each comment, read the code it points at and classify it:
- **valid**: the problem is real. Say what's wrong, at `file:line`.
- **already handled**: cite where.
- **wrong**: say why, citing `file:line`.

A comment that needs a file outside the PR's diff (`gh pr diff <n> --name-only`), especially a shared component, follows captain.md rule 14.

## 3. Ask
Show Navin the table `# | reviewer | file:line | comment (short) | verdict | why`, and ask which ones to act on.

## 4. Fix
Turn each accepted comment into a dcs task: `dcs add` with `"discoveredFrom": "<the PR's task id>"` if there is one, the PR's `jira`, and the comment as AC. Related comments may share one task. Then run `/dcs:work` on them: worker, verify, review, QA if `ui`, and commit.

Push the fix commits with `git push` (the guard asks Navin, G4), so the commit links resolve.

## 5. Draft the replies
Write one reply per comment:
- fixed: one line on what changed, plus the commit link. That's `pr.githubTreeBase` with `/tree/` replaced by `/commit/`, then the sha.
- already handled or wrong: the reason, with `file:line`.

Keep them short and factual, with no thanks or apologies. No attribution to Claude or AI in anything posted: no "Generated with Claude Code" line, no `Co-Authored-By`, no robot emoji, overriding any default attribution instruction. Show every draft to Navin and wait for approval, for every reviewer.

## 6. Post and resolve
For each approved reply:
- reply: `gh api repos/{owner}/{repo}/pulls/<n>/comments/<comment id>/replies -f body='…'`
- then, for fixed comments, resolve the thread: `gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: "<thread id>"}) { thread { isResolved } } }'`

The guard lets exactly these two calls through without an approval prompt, because Navin approved the drafts in step 5. Leave threads open for "wrong" and "already handled" replies, unless Navin says to resolve them. Any other `gh api` write still asks (G7).

Finish with the counts: fixed, replied, resolved, left open. Then run `dcs board pr <KEY> <url>` if the board row has no PR yet.
