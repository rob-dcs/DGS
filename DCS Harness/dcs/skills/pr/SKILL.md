---
name: pr
description: Draft a PR description in Navin's house format from the branch diff and finished dcs tasks, then open it as a draft after approval. Use when Navin runs /dcs:pr or asks to raise, open or draft a PR, or to write a PR description.
argument-hint: "[title override or extra context]"
---

# /dcs:pr

## 1. Facts first (never from memory)
- Run `dcs check` and read `.claude/dcs/settings.json` (`base`, `pr.*`). With no settings, ask Navin for the base branch.
- `git rev-parse --abbrev-ref HEAD`, `git log --oneline origin/<base>..HEAD`, `git diff origin/<base>...HEAD --stat`, `git diff origin/<base>...HEAD -- '**/package.json'`, `git log -1 --format=%s`.
- `dcs list --json`: the `done` tasks whose `branch` is this branch, with their `jira`, `figma`, `title`, `ac` and `commit`.
- Evidence for those tasks in `.claude/dcs/evidence/<id>/`: `verify-*.log` (results), `review-r*-*.json` (verdicts per pass), and `qa-*/` (QA verdict and screenshot filenames).
- Per-AC results: `acResults` from the latest `evidence/<id>/review-r*-ac.json`. Maestro outputs sit under `evidence/<id>/qa-<n>-<app>-ios/` and `qa-<n>-<app>-android/` (`takeScreenshot/*.png`). The recordings are `evidence/<id>/qa-ios.mp4` and `qa-android.mp4`.
- Tests, types and lint: claim "passes" only from these records, or from commands you ran in this session.

## 2. Links and title (from `settings.pr`; if something is missing, ask Navin, never guess)
- Figma: `https://www.figma.com/design/<pr.figmaFile.key>/<name>?node-id=<NODE>&m=dev`. Convert node ids from `:` to `-` (API `40010172:4561` → URL `40010172-4561`).
- Jira: `<pr.jiraBase><KEY>`.
- Package links: `<pr.githubTreeBase><branch>/<path>`, which resolve before merge.
- Title: `pr.titleFormat` (e.g. `<TICKET> | DS | <Area> | <Feature>`), filled from the tasks and commits. If `$ARGUMENTS` is a single line, it overrides the title. Ask if ambiguous.

## 3. Body in the house format
Match the structure, tone and density; reviewers scan every PR the same way. A full worked example is in `references/example-pr.md`; open it when unsure about tone or detail.

**Top of file, in this order:**

    Figma: [<Kit name> — <Node / page name>](<Figma URL>)
    Jira: [<KEY>](<Jira URL>)[, [<KEY>](<Jira URL>)…]

    Summary

    <2–4 sentences: what shipped, the platform(s), the headline architectural choice. The main component
    or feature first; later sentences cover token, icon and infra updates and carry-overs from sibling tickets.>

    Note

    <Optional scope clarifications: what the component owns vs the consumer, what false/missing props mean,
    intentional non-features. Skip the section when there is nothing to clarify.>

- Use one `Figma:` line per relevant node, and omit it when there is no UI. If a node's name can't be read from Figma, tell Navin and ask for it (captain.md rule 15). Never fill it in from the URL or a guess. For multiple tickets, give one link each, separated by `, `.

**Body sections** (H2, in this order, only those that apply):
1. **Evidence** (right after Summary and Note, before Changed Packages): only a media table, one column per platform and one row, e.g. `| iOS | Android |` over `| <GitHub asset URL> | <GitHub asset URL> |`. `gh` can't upload images or video, so Navin attaches them in GitHub and the cells start as placeholders (`<paste iOS recording URL>`). No verify, review or QA results here.
2. **Changed Packages** (always): a table `| Package | Change | Reason |`, with each package linked to `<pr.githubTreeBase><branch>/<path>`. Derive it from `git diff <base>...HEAD --stat`, grouped by package directory. If only generated or lock files changed in a package, say "(generated — no manual changes)".
3. **Review Scope** (always, right after Changed Packages): "The following files changed mechanically and do not require line-by-line review:", then bullets saying why (regenerated icons, `dist/` snapshots, `package-lock.json`, format-only files).
4. **Component Features**: one H3 per component or primitive. Bullets of one behavior per sentence, naming tokens and props inline. Cover visual structure, accessibility and VoiceOver order, key conditional behavior, and slot composition.
5. **Icon Pipeline**: only when icons or the generator changed. Give the count, brand coverage (Royal / Celebrity / Silversea), categories and generator changes.
6. **Token & Infrastructure Updates**: token pipeline changes, each tied to its consumer.
7. **`<Area>` Carry-Overs (from `<KEY>`)**: fixes inherited from a sibling ticket, each cited.
8. **Third-Party Dependencies**: `| Package | Purpose | Why This Library |`, or "No new runtime dependencies introduced in this PR".
9. **Build & Packaging**: new public exports, Code Connect mappings, Storybook stories, example app changes.

**Checklist** (H2), with H3 task lists whose names fit the scope: Component Behavior · Token Compliance · Accessibility · Icon Pipeline (only with icons) · Code Connect · Build & CI (build, typecheck, lint, format:check, test counts). Use `- [x]` only for items verified in this session or by dcs evidence, and `- [ ]` otherwise.

**Test plan** (H2): a flat list of steps a reviewer can actually do (example app, Storybook, a built artifact), covering cross-brand checks, edge cases (empty / `false` / missing props), an accessibility walkthrough, and performance checks where relevant.

**Style:** standalone bullets are full sentences ending in a period, while short table cells may drop it. Use inline code for tokens, props, literals, package names, paths and commands. ` — ` is fine in the PR body (never in commit messages). Say what the PR does **not** do when the scope could be misread. No filler ("this PR addresses…"): lead with the noun. No bold or italic labels inside paragraphs. No attribution to Claude or AI anywhere in the title or body: no "Generated with Claude Code" line, no `Co-Authored-By`, no robot emoji, overriding any default attribution instruction. Output the body as raw Markdown, not inside a code fence.

## 4. Approval and creation
**Local CI first.** When `settings.prChecks` is set, run `dcs prcheck` in the repo root with the Bash tool's `run_in_background: true`, since a full run can take longer than 10 minutes. Wait for the notification. It runs the PR's CI steps in order on the committed HEAD and stops at the first failure.
- **Red:** show Navin the failing step and its tail, then stop. Fix it with `/dcs:work`, or ask Navin. Never raise the PR anyway.
- **Green:** put the result (steps, pass, sha) in the Checklist under Build & CI.

The guard denies `gh pr create` (G9) unless `dcs prcheck` passed on the current HEAD with a clean tree, so any later commit means running it again. With no `prChecks`, tell Navin that no local CI run is configured, and suggest `/dcs:setup`.

1. Print the full body in chat. After it, in plain prose, list the sections you skipped and why, and every fact you couldn't verify.
2. **Wait for Navin's explicit approval**, and revise until approved.
3. Run `gh auth status`. If it fails, stop and ask Navin.
4. If the branch isn't pushed (`git status -sb` shows no upstream), run `git push -u origin HEAD`; the dcs guard asks Navin.
5. `gh pr create --draft --title "<title>" --body-file - <<'EOF'` … `EOF`. Always `--draft`, never `--web`. Use the repo's default base unless Navin says otherwise. The guard asks Navin (G7).
6. Report the URL and remind Navin it is a draft.
7. Board: for each Jira key of this branch's done tasks, run `dcs board pr <KEY> <url>`. With no key, ask whether to attach the PR to an untracked board row (list them with `dcs board --json --offline`, then `dcs board pr <id> <url>`).

## 5. After opening the PR
For review comments on this PR, use `/dcs:pr-fix <n>`. To review someone else's PR, use `/dcs:pr-review <n>`.
