---
name: plan
description: Turn a request (optional Jira key, Figma URLs, acceptance criteria) into approved dcs tasks. Use when Navin runs /dcs:plan or asks to plan work with dcs.
argument-hint: "<what to build> [APP2X-123] [figma URL]"
---

# /dcs:plan

First read `${CLAUDE_PLUGIN_ROOT}/references/captain.md`. You are the Captain.

## Steps
1. **Check settings.** Run `dcs check`. If there are no settings, stop and suggest `/dcs:setup`. Otherwise read `.claude/dcs/settings.json`.
2. **Collect inputs.** Gather Navin's description, Jira key(s), Figma URL(s) and any pasted AC. Never infer a Jira key or a Figma node. Read each Figma URL (metadata and a screenshot) now. If any read fails, alert Navin per captain.md rule 15 before drafting.
3. **Look before proposing.** Search the repo for existing components, utilities and tests that already cover part of the request, and say what you found.
4. **Clarify.**
   - Ask one question at a time (AskUserQuestion).
   - Every question gets a **recommended option** with a one-line reason.
   - Before asking, check `dcs decisions` and the relevant spec file; if they already answer it, cite them instead.
   - Ask at most **5** questions before showing a draft, and list any remaining open questions with it.
5. **Draft the tasks** as a table: `# | kind | title | ui | depends | jira | figma | refs | AC`.
   - **Skeleton first.** Split UI work into small ordered tasks: skeleton, then sections, then states (loading, error, empty…). Each task depends on the previous one.
   - **Short titles.** 6 words at most; the detail goes in the AC.
   - **AC:**
     - Use light EARS form: "WHEN/WHILE/IF <condition> the <component> shall <observable outcome>".
     - At most 5 per task.
     - No vague words ("correctly", "looks good", "works").
   - **Repo spec files** (only when `settings.specs` is set). For each component touched, look for `<specs.dir>/<Name>.spec.md`:
     - If the work creates the component or changes its documented API, states or visuals, add a `spec` task **first**. Its `specPath` is that file, created from `specs.template` or updated. Make the component's work tasks depend on it, and add a closing `spec-sync` task that depends on all of them.
     - Otherwise, add the existing spec to each work task's `refs`.
     - If you're unsure whether documented behavior changes, ask Navin.
     - Every state or variant listed in a touched spec file must be covered by some task.
   - **Reference as spec.** When the work ports or mirrors existing code (e.g. RN → SwiftUI or Compose), put that code in `refs` instead of restating it. Confirm the reference with Navin; never pick one silently.
6. **Dry run.** Pipe the draft to `dcs add --dry-run`. Fix every problem and lint warning, or tell Navin why a warning should stay. Then show the table again.
7. **Board rows.** Run `dcs board --json --offline`. For each Jira key that has no row this week, ask Navin for the **Component** and **Title** exactly as they should read in the weekly report.
8. **Approval.** Ask Navin to approve the table and the board rows, and revise until they do. Nothing is written before approval.
9. **Write.**
   ```bash
   dcs add <<'EOF'
   [{"title": "...", "ac": ["WHEN ... the X shall ..."], "ui": true}, {"title": "...", "ac": ["..."], "ui": true, "depends": ["#1"]}]
   EOF
   ```
   For each new key, run `dcs board add --key <KEY> --component "<Component>" --title "<Title>" --repo <repo directory name>`. If `dcs add` refuses, show its message and fix the tasks with Navin.
10. **Report** the new ids (`dcs list`) and suggest `/dcs:work`.

## Task JSON (input to `dcs add`)
| field | required | value |
|---|---|---|
| `title` | yes | 6 words at most |
| `ac` | yes | array of testable EARS-style statements, at most 5 |
| `ui` | yes for `work` | `true` when anything visible changes |
| `kind` | no | `work` (default), `spec`, `spec-sync` |
| `jira` | no | `APP2X-123`, or leave it out |
| `figma` | no | array of figma.com URLs |
| `refs` | no | array of repo-relative paths that exist |
| `depends` | no | existing ids (`t4`), or `#n` for the n-th task in this batch |
| `specPath` | spec kinds only | `<specs.dir>/<Name>.spec.md` |
| `discoveredFrom` | no | the task id this was discovered in |
