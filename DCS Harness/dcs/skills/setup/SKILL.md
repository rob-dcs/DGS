---
name: setup
description: Create or edit the dcs settings for the current repo (verify commands, worktree setup, verify concurrency, Fixes trailer, repo rule skills, visual QA, Maestro, spec files, PR link bases). Use when Navin runs /dcs:setup, or when another dcs command reports missing settings.
---

# /dcs:setup

Write `.claude/dcs/settings.json` containing **only values Navin confirmed**. Never guess: if you can't detect a value, ask for it with no default.

## 1. Where
Run `git rev-parse --show-toplevel`. If this isn't a git repo, stop and say so. If `.claude/dcs/settings.json` already exists, use its values as your defaults.

## 2. Detect (read-only)
| setting | where to look |
|---|---|
| `base` | `git symbolic-ref --short refs/remotes/origin/HEAD`, dropping `origin/` |
| `verify` | `package.json` scripts (typecheck, test, lint), `./gradlew` tasks, `xcodebuild` / `swift test`, and the commands CI runs (`bitrise.yml`, `Jenkinsfile`, `.github/workflows/*`). If the repo has deterministic snapshot tests or accessibility audits (swift-snapshot-testing, Paparazzi/Roborazzi, `performAccessibilityAudit`, RNTL a11y queries), offer to include their commands. |
| `prChecks` | The CI workflow that runs on pull requests (Bitrise: the workflow whose `triggers` include `pull_request`, with its `before_run` chain; also GitHub Actions `on: pull_request`, Jenkinsfile). Propose its script steps' commands in order. Leave out clone, cache, tool-install (`nvm`) and registry or credential steps (anything using a token such as `$AUTH_TOKEN`, or writing `.npmrc`). Keep non-blocking steps only if Navin wants them. `/dcs:pr` runs these through `dcs prcheck`, and the guard blocks `gh pr create` until they pass on HEAD. If the CI file changes later, tell Navin these may be out of date. |
| `worktreeSetup` | Lockfiles: `package-lock.json` → `npm ci`; `pnpm-lock.yaml` → `pnpm install --frozen-lockfile`; `yarn.lock` → `yarn install --frozen-lockfile`; `Podfile.lock` → `pod install`, run in its folder. For npm repos on macOS, recommend the APFS clone form shown below the table. |
| `verifyConcurrency` | 1 when any verify command runs `xcodebuild`, `./gradlew` or `gradle`. Otherwise leave it unset. |
| `requireFixesTrailer` | `git log -30 --format=%B`: are `Fixes: <KEY>` lines the norm? |
| `repoRules` | `.claude/skills/*/SKILL.md` (names and one-line descriptions) |
| `visualQa` | `.claude/agents/*.md` and `.claude/skills/*` about visual QA |
| `maestro` | One entry per runnable example app (folders like `apps/*`, `example*/`, or the repo itself); web apps such as Storybook don't count. For each app: `name` (short, e.g. `rn`, `swiftui`, `compose`), `paths` (the app folder plus the package it demos; leave it out only when a single app covers the whole repo). iOS `appId`: `PRODUCT_BUNDLE_IDENTIFIER` in `*.xcodeproj/project.pbxproj` (when a project lists several, confirm which is the app target's), or `app.json` → `ios.bundleIdentifier`. Android `appId`: `applicationId` in `build.gradle*`. `deepLink` scheme: `CFBundleURLSchemes`, or AndroidManifest `<data android:scheme>`. Ask Navin for the route and brand template (e.g. `<scheme>://demo/{route}?theme={brand}`). If the app has an in-UI control that switches brand/theme without navigating away (e.g. a header logo tap), ask Navin for its accessibility label/text and record it as `brandSwitcher` — this lets one Maestro flow cover every brand via `tapOn` instead of relaunching per brand. For each platform, ask Navin which Maestro quirks apply, and record them as `knownIssues`:
- `openLink-noop`: `openLink` doesn't navigate in this environment, so captures deep-link from the shell instead (`xcrun simctl openurl` / `adb shell am start`).
- `back-noop`: `back` does nothing.
- `metro-banner`: a React Native dev build shows Metro's "Refreshing…" banner after a cold launch. `maestro --version` must work; if it doesn't, tell Navin Maestro isn't installed. Never install it yourself. `false` is fine. |
| `specs` | A folder of `*.spec.md` files plus a template and contract docs (e.g. `specs/components`, `specs/templates/*.template.md`, `specs/contracts/*.md`) |
| `pr.githubTreeBase` | `git remote get-url origin` → `https://github.com/<owner>/<repo>/tree/` |
| `pr.jiraBase`, `pr.figmaFile`, `pr.titleFormat` | Recent PRs (`gh pr list --state merged --limit 5 --json title,body`), repo docs, `.claude/skills` |

APFS clone form for `worktreeSetup` (npm repos on macOS). It clones `node_modules` from main when the lockfile matches, and otherwise falls back to `npm ci`:
```bash
cmp -s "$DCS_MAIN_ROOT/package-lock.json" package-lock.json && cp -c -R "$DCS_MAIN_ROOT/node_modules" . || npm ci
```

## 3. Confirm one at a time
Ask about each setting with AskUserQuestion, in this order: base, verify, prChecks, worktreeSetup, verifyConcurrency, requireFixesTrailer, repoRules, visualQa, maestro, specs, pr.githubTreeBase, pr.jiraBase, pr.figmaFile, pr.titleFormat.
- Give one line on what the setting controls. Put the detected value first, marked **(Recommended)** with a one-line reason, and offer "Other" for edits.
- `verify`: each command must finish within **10 minutes** (the Bash tool limit). Prefer scoped commands to a whole-monorepo run.
- `repoRules`: multi-select from the repo's skills.
- `maestro`: confirm one app at a time: its name, paths, `brandSwitcher` if it applies, and each platform's `appId`, `deepLink` and `knownIssues`.

## 4. Write
Show the final JSON and get one last yes. Then:
```bash
dcs init <<'EOF'
<confirmed JSON>
EOF
```
If `dcs init` refuses, show its message and fix only the value it names, with Navin.

## 5. Report
Tell Navin the settings are written, and that `.claude/dcs/` is excluded from git locally (`.git/info/exclude`), so nothing gets committed. Next step: `/dcs:plan`.

## Shape
```json
{
  "base": "main",
  "verify": ["npm run typecheck", "npm test"],
  "prChecks": ["npm ci", "npm run lint -- --parallel=1", "npm run typecheck", "npm run test", "npm run build -- --parallel=1"],
  "worktreeSetup": ["npm ci"],
  "verifyConcurrency": 1,
  "requireFixesTrailer": true,
  "repoRules": ["component-patterns", "accessibility"],
  "visualQa": {"agent": "visual-qa"},
  "maestro": [{"name": "rn", "paths": ["packages/rn", "apps/example-rn"], "brandSwitcher": "Switch brand theme", "ios": {"appId": "<bundle id>", "deepLink": "<scheme>://demo/{route}?theme={brand}", "knownIssues": ["openLink-noop", "metro-banner"]}, "android": {"appId": "<applicationId>"}}],
  "specs": {"dir": "specs/components", "template": "specs/templates/component-spec.template.md", "contracts": ["specs/contracts/accessibility.md"]},
  "pr": {"githubTreeBase": "https://github.com/<owner>/<repo>/tree/", "jiraBase": "https://jira.rccl.com/browse/", "figmaFile": {"name": "<file name>", "key": "<file key>"}, "titleFormat": "<TICKET> | DS | <Area> | <Feature>"}
}
```
Other allowed values:
- `visualQa`: `{"skill": "dcs:visual-qa"}` or `false`.
- `maestro` and `specs`: `false`.
- `maestro[].brandSwitcher` and each platform's `knownIssues`: both optional. Leave them out when they don't apply.
- `verifyConcurrency`: may be left out.
