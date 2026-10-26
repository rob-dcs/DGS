# dcs-harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `dcs`, a thin local Claude Code plugin: a Captain-led Plan → Work → Review loop backed by a Node CLI state machine, runtime guardrail hooks, repo spec-file support, and a weekly cross-project task board.

**Architecture:** A zero-dependency Node CLI (`dcs/bin/dcs`) owns all state: per-repo `.claude/dcs/tasks.json` (a validated state machine), git worktrees, landing, evidence, and the global `~/.dcs/board/` weekly files. A PreToolUse hook calls `dcs guard`, which fails closed. Skills (markdown) make the main session the Captain. They dispatch two plugin agents (worker, reviewer) and change state only through the CLI.

**Tech Stack:** Node ≥ 22 stdlib (`node:test`, `node:util` parseArgs, `child_process`, `crypto`), git ≥ 2.31, `gh` CLI (board merged check, PRs), Claude Code plugin format.

**Spec:** `docs/spec.md` (approved 2026-09-30). Read it alongside this plan; the plan argues from it.

## Global Constraints

- Node ≥ 22 standard library only. **Zero npm dependencies**, no `package.json`. CommonJS (`'use strict';` + `require`).
- Tests: `node --test test/` from the repo root. Tests create throwaway git repos in `os.tmpdir()` and **never touch the real `~/.dcs`**: `test/helpers.js` always sets `DCS_BOARD_DIR`.
- Plugin name `dcs`, marketplace `dcs-local`, installed locally from `~/Downloads/dcs-harness`. **Never add a git remote or push.**
- `docs/` (spec + this plan) is **never committed**. It is already listed in `.git/info/exclude`.
- Commits: after `git add`, show `git diff --cached --stat` and **wait for Navin's explicit yes**. The message is `<type>(<scope>): <summary>`, ASCII only, **no `Fixes:` trailer, no `Co-Authored-By`**.
- Names are exact: task statuses `todo|doing|verified|approved|done|blocked`; kinds `work|spec|spec-sync`; board statuses `todo|in_progress|undergoing_pr|done|blocked`; guard rule ids `G1–G6, D1–D5, S1–S2, C1`.
- Never assume. If a step conflicts with the spec or with what you observe, stop and ask Navin.

**Additions beyond the spec** (made while planning; Navin reviews them with this plan):
1. Extra files: `dcs/lib/store.js` (the lock and atomic write shared by tasks and board), `dcs/references/captain.md` (the protocol shared by three skills), and `test/helpers.js`, `test/store.test.js`, `test/plugin.test.js`.
2. Internal task fields: `verifyFailStreak` and `reviewRound`.
3. `dcs add` accepts `#n` in `depends` to mean "the n-th task in this batch", since new tasks have no ids yet.
4. `dcs board edit` (fix a row's component, title or source) and `dcs board --report` (renders the weekly report in code, so it can be tested).
5. A `pr.titleFormat` setting (the `<TICKET> | DS | …` title format is Fluidity-specific).
6. D2 also denies `+refspec` force pushes; D5 also asks on `git checkout .` without `--`.
7. S1 protects **any** `.ssh` or `.aws` path segment, not only those under `~`.
8. If the dcs files the guard reads are unreadable, only commits are denied (G3), rather than blocking every tool.
9. Three consecutive failed `dcs verify` runs count as one failure. This enforces the spec's "at most 3 verify runs per dispatch" in code.
10. `dcs board pr` records the current repo's directory name, falling back to the repo name in the URL when run outside a repo.

## Review Focus

1. **A repo path containing spaces** (e.g. `~/Developer/my repos/app`): worktree start, verify and land must work. Test in Task 5.
2. **Commit commands whose quoted message contains `;`, `&&`, `|` or `.env`, or whose message is a heredoc body**: the guard must only ask (G1), never misfire D- or S- rules. Test in Task 7.
3. **Two sessions in different repos writing the board at the same moment**: no row may be lost. Test in Task 6.
4. **Hook payloads with missing fields, or tools the guard doesn't know**: `evaluate` must return no decision. A crash would fail closed and block every tool call. Test in Task 7.
5. **Verify commands that print huge output** (100k lines): no buffer crash, and `tail` is exactly the last 40 lines. Test in Task 4.

## File map

| File | Responsibility | Task |
|---|---|---|
| `.claude-plugin/marketplace.json` | local marketplace `dcs-local` → `./dcs` | 1 |
| `dcs/.claude-plugin/plugin.json` | plugin manifest | 1 |
| `dcs/lib/store.js` | `DcsError`, `readJson`, `writeJsonAtomic`, `withLock` | 1 |
| `dcs/bin/dcs` | CLI entry: argument parsing, command dispatch, error → exit codes | 1, grown in 2–7 |
| `dcs/lib/repo.js` | git helpers, paths, settings, init/exclude, fingerprint, diff, worktrees, verify runner, land | 2, 4, 5 |
| `dcs/lib/tasks.js` | pure task state machine + validation | 3, 4, 5 |
| `dcs/lib/board.js` | ISO weeks, week files, carry-over, rows, merged check, markdown + report renderers | 6 |
| `dcs/lib/guard.js` | guardrail rule evaluation (pure except path realpath) | 7 |
| `dcs/hooks/hooks.json` | PreToolUse → `dcs guard`, fail closed | 7 |
| `dcs/references/captain.md` | Captain protocol + dispatch templates | 8 |
| `dcs/agents/{worker,reviewer}.md` | crew agents | 8 |
| `dcs/skills/{setup,plan}/SKILL.md` | setup and planning | 9 |
| `dcs/skills/{work,review}/SKILL.md` | execution loop and standalone review | 10 |
| `dcs/skills/{pr,visual-qa,status}/SKILL.md` + `dcs/skills/pr/references/example-pr.md` | absorbed PR / QA tooling and weekly report | 11 |
| `test/*.test.js`, `test/helpers.js` | node:test suites | every task |

---

### Task 1: Plugin skeleton, store, CLI dispatcher, test helpers

**Files:**
- Create: `.claude-plugin/marketplace.json`
- Create: `dcs/.claude-plugin/plugin.json`
- Create: `dcs/lib/store.js`
- Create: `dcs/bin/dcs` (executable)
- Create: `test/helpers.js`
- Test: `test/store.test.js`

**Interfaces:**
- Produces: `store.DcsError` (class), `store.readJson(file, fallback) → any`, `store.writeJsonAtomic(file, data) → void`, `store.withLock(lockFile, fn, {waitMs=5000, staleMs=30000}) → fn()`, `store.sleep(ms)`.
- Produces (bin): module-level `now()`, `iso()`, `out(x)`, `stdinJson()`, and an object `commands` that later tasks add entries to. Unknown command → usage on stderr listing `Object.keys(commands)`, exit 1. `DcsError` or `ERR_PARSE_ARGS*` → `dcs: <message>` on stderr, exit 1.
- Produces (tests): `helpers.{BIN, tmpDir, sh, dcs, baseSettings, tmpRepo, specRepo}`. `dcs(args, {cwd, input, env})` returns `{code, stdout, stderr, ok(), json()}`.

- [ ] **Step 1: Write the manifests**

`.claude-plugin/marketplace.json`:
```json
{
  "name": "dcs-local",
  "owner": { "name": "Navin (Digital Creative Studio)" },
  "plugins": [
    {
      "name": "dcs",
      "source": "./dcs",
      "description": "Digital Creative Studio harness: Captain-led plan, work and review with guardrails, repo spec files and a weekly board."
    }
  ]
}
```

`dcs/.claude-plugin/plugin.json`:
```json
{
  "name": "dcs",
  "version": "0.1.0",
  "description": "Digital Creative Studio harness: Captain-led plan, work and review with guardrails, repo spec files and a weekly board.",
  "author": { "name": "Navin" }
}
```

- [ ] **Step 2: Write the test helpers**

`test/helpers.js`:
```js
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const BIN = path.join(__dirname, '..', 'dcs', 'bin', 'dcs');
// Every CLI call in tests uses this board dir unless a test passes its own: the real ~/.dcs is never touched.
const TEST_BOARD = path.join(os.tmpdir(), `dcs-test-board-${process.pid}`);

const tmpDir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dcs-')));
const sh = (cmd, cwd) => execFileSync('/bin/sh', ['-c', cmd], { cwd, encoding: 'utf8' });

function dcs(args, { cwd, input = '', env = {} } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, DCS_BOARD_DIR: TEST_BOARD, ...env },
  });
  return {
    code: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    ok() {
      if (r.status !== 0) throw new Error(`dcs ${args.join(' ')} exited ${r.status}\n${r.stderr}`);
      return this;
    },
    json() {
      return JSON.parse(r.stdout);
    },
  };
}

const baseSettings = (over = {}) => ({
  base: 'main',
  verify: ['true'],
  worktreeSetup: [],
  requireFixesTrailer: false,
  repoRules: [],
  visualQa: false,
  specs: false,
  pr: {},
  ...over,
});

function tmpRepo({ settings, files = {}, parent } = {}) {
  const root = parent || tmpDir();
  fs.mkdirSync(root, { recursive: true });
  const dir = path.join(root, 'app');
  for (const [rel, content] of Object.entries({ 'README.md': 'hi\n', ...files })) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  sh(
    'git init -q -b main && git config user.email t@example.com && git config user.name Test' +
      ' && git config commit.gpgsign false && git config core.hooksPath /dev/null' +
      ' && git add -A && git commit -qm init',
    dir,
  );
  if (settings !== false) dcs(['init'], { cwd: dir, input: JSON.stringify(settings || baseSettings()) }).ok();
  return dir;
}

const SPECS = {
  dir: 'specs/components',
  template: 'specs/templates/component-spec.template.md',
  contracts: ['specs/contracts/accessibility.md'],
};
const SPEC_FILES = {
  'specs/components/Tag.spec.md': '# Tag\n',
  'specs/templates/component-spec.template.md': '# <Name>\n',
  'specs/contracts/accessibility.md': '# Accessibility\n',
};
const specRepo = (over = {}) => tmpRepo({ files: SPEC_FILES, settings: baseSettings({ specs: SPECS, ...over }) });

module.exports = { BIN, tmpDir, sh, dcs, baseSettings, tmpRepo, specRepo };
```

- [ ] **Step 3: Write the failing tests**

`test/store.test.js`:
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { tmpDir, dcs } = require('./helpers');
const { readJson, writeJsonAtomic, withLock, DcsError } = require('../dcs/lib/store');

test('writeJsonAtomic writes JSON and leaves no temp file behind', () => {
  const file = path.join(tmpDir(), 'a', 'b.json');
  writeJsonAtomic(file, { x: 1 });
  assert.deepEqual(readJson(file, null), { x: 1 });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['b.json']);
});

test('readJson returns the fallback for a missing file and refuses invalid JSON', () => {
  const dir = tmpDir();
  assert.equal(readJson(path.join(dir, 'nope.json'), 'fallback'), 'fallback');
  fs.writeFileSync(path.join(dir, 'bad.json'), '{oops');
  assert.throws(() => readJson(path.join(dir, 'bad.json'), null), DcsError);
});

test('withLock returns fn() and releases the lock', () => {
  const lock = path.join(tmpDir(), 'x.lock');
  assert.equal(withLock(lock, () => 42), 42);
  assert.equal(fs.existsSync(lock), false);
});

test('withLock releases the lock when fn throws', () => {
  const lock = path.join(tmpDir(), 'x.lock');
  assert.throws(() => withLock(lock, () => { throw new Error('boom'); }), /boom/);
  assert.equal(fs.existsSync(lock), false);
});

test('withLock gives up on a fresh busy lock after waitMs', () => {
  const lock = path.join(tmpDir(), 'x.lock');
  fs.writeFileSync(lock, '');
  assert.throws(() => withLock(lock, () => 1, { waitMs: 200 }), /lock busy/);
  assert.equal(fs.existsSync(lock), true);
});

test('withLock removes a stale lock', () => {
  const lock = path.join(tmpDir(), 'x.lock');
  fs.writeFileSync(lock, '');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  assert.equal(withLock(lock, () => 'ok', { waitMs: 200 }), 'ok');
});

test('withLock waits until another process releases the lock', async () => {
  const lock = path.join(tmpDir(), 'x.lock');
  fs.writeFileSync(lock, '');
  const child = spawn(process.execPath, ['-e', `setTimeout(() => require('fs').rmSync(${JSON.stringify(lock)}), 300)`]);
  assert.equal(withLock(lock, () => 'got it', { waitMs: 3000 }), 'got it');
  await new Promise((resolve) => child.on('exit', resolve));
});

test('the CLI prints usage and exits 1 for an unknown command', () => {
  const r = dcs(['nope'], { cwd: tmpDir() });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /usage: dcs </);
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `node --test test/store.test.js`
Expected: FAIL with `Cannot find module '../dcs/lib/store'`.

- [ ] **Step 5: Implement the store**

`dcs/lib/store.js`:
```js
'use strict';
const fs = require('node:fs');
const path = require('node:path');

class DcsError extends Error {}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new DcsError(`${file} is not valid JSON (${e.message}); fix it by hand, dcs never auto-repairs`);
  }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

// ponytail: staleness is judged by lock mtime only (no pid check); fine for one person on one machine
function withLock(lockFile, fn, { waitMs = 5000, staleMs = 30000 } = {}) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lockFile, 'wx'));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age;
      try {
        age = Date.now() - fs.statSync(lockFile).mtimeMs;
      } catch {
        continue; // released between our open and stat
      }
      if (age > staleMs) {
        fs.rmSync(lockFile, { force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new DcsError(`lock busy for ${waitMs}ms: ${lockFile}`);
      sleep(50);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lockFile, { force: true });
  }
}

module.exports = { DcsError, sleep, readJson, writeJsonAtomic, withLock };
```

- [ ] **Step 6: Implement the CLI dispatcher**

`dcs/bin/dcs`:
```js
#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { DcsError } = require('../lib/store');

const now = () => (process.env.DCS_NOW ? new Date(process.env.DCS_NOW) : new Date());
const iso = () => now().toISOString();
const out = (x) => process.stdout.write(typeof x === 'string' ? `${x}\n` : `${JSON.stringify(x, null, 2)}\n`);

function stdinJson() {
  const text = fs.readFileSync(0, 'utf8');
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new DcsError(`stdin is not valid JSON: ${e.message}`);
  }
}

// ---- helpers (later tasks add here) ----

const commands = {
  // ---- commands (later tasks add here) ----
};

function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  const fn = Object.hasOwn(commands, cmd) ? commands[cmd] : null;
  if (!fn) {
    process.stderr.write(`usage: dcs <${Object.keys(commands).join('|') || 'command'}> [args]\n`);
    process.exit(1);
  }
  try {
    fn(argv);
  } catch (e) {
    if (e instanceof DcsError || String(e.code || '').startsWith('ERR_PARSE_ARGS')) {
      process.stderr.write(`dcs: ${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
}

main();
```

Then run: `chmod +x dcs/bin/dcs`

(`os`, `path` and `parseArgs` are unused until later tasks. Leave them in.)

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test test/store.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 8: Commit (after Navin's yes)**

```bash
git add .claude-plugin dcs test
git diff --cached --stat
git commit -m "feat(store): plugin skeleton, atomic store, CLI dispatcher"
```

---

### Task 2: Repo paths, settings validation, `dcs init`

**Files:**
- Create: `dcs/lib/repo.js`
- Modify: `dcs/bin/dcs` (add `repo` import, helpers `ctxFor`, `requireSettings`, command `init`)
- Test: `test/repo.test.js`

**Interfaces:**
- Consumes: `store.{DcsError, readJson, writeJsonAtomic}`.
- Produces: `repo.git(args, cwd, {allowCodes}) → Buffer`, `repo.gitText(args, cwd, opts) → string (trimmed)`, `repo.paths(cwd) → P` where `P = {top, mainRoot, gitCommonDir, dcsDir, settingsFile, tasksFile, lockFile, evidenceDir, worktreesDir}`, `repo.validateSettings(s, mainRoot) → string[]`, `repo.loadSettings(P) → settings | null` (throws `DcsError` when invalid), `repo.init(P, settings)`, `repo.isDirty(cwd) → bool`, `repo.currentBranch(cwd) → string`, `repo.tail(text, n) → string`.
- Produces (bin): `ctxFor(cwd = process.cwd()) → {P, settings}`, `requireSettings(settings) → settings`.

- [ ] **Step 1: Write the failing tests**

`test/repo.test.js`:
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, tmpRepo, dcs, sh, baseSettings } = require('./helpers');

test('init writes settings and an empty tasks file, and excludes .claude/dcs/ exactly once', () => {
  const dir = tmpRepo();
  dcs(['init'], { cwd: dir, input: JSON.stringify(baseSettings()) }).ok(); // run it a second time
  const exclude = fs.readFileSync(path.join(dir, '.git/info/exclude'), 'utf8');
  assert.equal(exclude.split('\n').filter((l) => l === '.claude/dcs/').length, 1);
  const tasksFile = JSON.parse(fs.readFileSync(path.join(dir, '.claude/dcs/tasks.json'), 'utf8'));
  assert.deepEqual(tasksFile, { version: 1, runStartedAt: null, tasks: [] });
  assert.equal(sh('git status --porcelain', dir), '');
});

test('init refuses invalid settings, names every problem, and writes nothing', () => {
  const dir = tmpRepo({ settings: false });
  const bad = baseSettings({ verify: [], visualQa: 'visual-qa', requireFixesTrailer: 'yes' });
  const r = dcs(['init'], { cwd: dir, input: JSON.stringify(bad) });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /verify must be a non-empty array/);
  assert.match(r.stderr, /visualQa must be false/);
  assert.match(r.stderr, /requireFixesTrailer must be true or false/);
  assert.equal(fs.existsSync(path.join(dir, '.claude/dcs/settings.json')), false);
});

test('init refuses specs paths that do not exist', () => {
  const dir = tmpRepo({ settings: false });
  const specs = { dir: 'specs/components', template: 'specs/t.md', contracts: [] };
  const r = dcs(['init'], { cwd: dir, input: JSON.stringify(baseSettings({ specs })) });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /specs path does not exist: specs\/components/);
});

test('init outside a git repo fails cleanly', () => {
  const r = dcs(['init'], { cwd: tmpDir(), input: JSON.stringify(baseSettings()) });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not inside a git repository/);
});

test('init rejects stdin that is not JSON', () => {
  const dir = tmpRepo({ settings: false });
  const r = dcs(['init'], { cwd: dir, input: 'nope' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /stdin is not valid JSON/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/repo.test.js`
Expected: FAIL. `tmpRepo` calls `dcs init`, which prints `usage: dcs <command>`.

- [ ] **Step 3: Implement `dcs/lib/repo.js`**

```js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DcsError, readJson, writeJsonAtomic } = require('./store');

const BIG = 256 * 1024 * 1024;

function git(args, cwd, { allowCodes = [0] } = {}) {
  const r = spawnSync('git', args, { cwd, maxBuffer: BIG });
  if (r.error) throw r.error;
  if (!allowCodes.includes(r.status)) {
    throw new DcsError(`git ${args.join(' ')} failed (exit ${r.status}): ${String(r.stderr).trim()}`);
  }
  return r.stdout;
}

const gitText = (args, cwd, opts) => git(args, cwd, opts).toString('utf8').trim();

function paths(cwd) {
  let top;
  let common;
  try {
    top = gitText(['rev-parse', '--show-toplevel'], cwd);
    common = gitText(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  } catch {
    throw new DcsError('not inside a git repository');
  }
  // ponytail: assumes the .git dir sits at the main repo root (no --separate-git-dir); upgrade if a repo needs it
  const mainRoot = path.dirname(common);
  const dcsDir = path.join(mainRoot, '.claude', 'dcs');
  return {
    top,
    mainRoot,
    gitCommonDir: common,
    dcsDir,
    settingsFile: path.join(dcsDir, 'settings.json'),
    tasksFile: path.join(dcsDir, 'tasks.json'),
    lockFile: path.join(dcsDir, 'tasks.lock'),
    evidenceDir: path.join(dcsDir, 'evidence'),
    worktreesDir: path.join(path.dirname(mainRoot), `${path.basename(mainRoot)}.dcs-worktrees`),
  };
}

const isStrList = (a) => Array.isArray(a) && a.every((x) => typeof x === 'string' && x.trim() !== '');

function validateSettings(s, mainRoot) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return ['settings must be a JSON object'];
  const p = [];
  if (typeof s.base !== 'string' || !s.base.trim()) p.push('base must be a non-empty string');
  if (!isStrList(s.verify) || s.verify.length === 0) p.push('verify must be a non-empty array of commands');
  if (!isStrList(s.worktreeSetup)) p.push('worktreeSetup must be an array of commands (may be empty)');
  if (typeof s.requireFixesTrailer !== 'boolean') p.push('requireFixesTrailer must be true or false');
  if (!isStrList(s.repoRules)) p.push('repoRules must be an array of skill names');
  const qa = s.visualQa;
  const qaOk =
    qa === false ||
    (qa && typeof qa === 'object' && Object.keys(qa).length === 1 &&
      ((typeof qa.agent === 'string' && qa.agent.trim()) || (typeof qa.skill === 'string' && qa.skill.trim())));
  if (!qaOk) p.push('visualQa must be false, {"agent": "<name>"} or {"skill": "<name>"}');
  if (s.specs !== false) {
    const sp = s.specs;
    if (!sp || typeof sp !== 'object' || typeof sp.dir !== 'string' || typeof sp.template !== 'string' || !isStrList(sp.contracts)) {
      p.push('specs must be false or {"dir": "...", "template": "...", "contracts": ["..."]}');
    } else {
      for (const rel of [sp.dir, sp.template, ...sp.contracts]) {
        if (!fs.existsSync(path.join(mainRoot, rel))) p.push(`specs path does not exist: ${rel}`);
      }
    }
  }
  if (s.pr !== undefined && (!s.pr || typeof s.pr !== 'object' || Array.isArray(s.pr))) p.push('pr must be an object');
  return p;
}

function loadSettings(P) {
  const s = readJson(P.settingsFile, null);
  if (s === null) return null;
  const problems = validateSettings(s, P.mainRoot);
  if (problems.length) throw new DcsError(`settings.json invalid:\n- ${problems.join('\n- ')}`);
  return s;
}

function init(P, settings) {
  const problems = validateSettings(settings, P.mainRoot);
  if (problems.length) throw new DcsError(`settings invalid:\n- ${problems.join('\n- ')}`);
  const exclude = path.join(P.gitCommonDir, 'info', 'exclude');
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  if (!current.split('\n').includes('.claude/dcs/')) {
    fs.appendFileSync(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}.claude/dcs/\n`);
  }
  writeJsonAtomic(P.settingsFile, settings);
  if (!fs.existsSync(P.tasksFile)) writeJsonAtomic(P.tasksFile, { version: 1, runStartedAt: null, tasks: [] });
}

const isDirty = (cwd) => gitText(['status', '--porcelain'], cwd) !== '';
const currentBranch = (cwd) => gitText(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
const tail = (text, n) => String(text).trimEnd().split('\n').slice(-n).join('\n');

module.exports = { git, gitText, paths, validateSettings, loadSettings, init, isDirty, currentBranch, tail };
```

- [ ] **Step 4: Wire `init` into the CLI**

In `dcs/bin/dcs`, below `const { DcsError } = require('../lib/store');`, add:
```js
const repo = require('../lib/repo');
```

Under `// ---- helpers (later tasks add here) ----`, add:
```js
function ctxFor(cwd = process.cwd()) {
  const P = repo.paths(cwd);
  return { P, settings: repo.loadSettings(P) };
}

function requireSettings(settings) {
  if (!settings) throw new DcsError('no dcs settings in this repo; run /dcs:setup');
  return settings;
}
```

Inside `const commands = {`, under the marker comment, add:
```js
  init() {
    const P = repo.paths(process.cwd());
    repo.init(P, stdinJson());
    out(`dcs initialised in ${P.mainRoot} (.claude/dcs/ is excluded from git)`);
  },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/`
Expected: PASS (store: 8, repo: 5).

- [ ] **Step 6: Commit (after Navin's yes)**

```bash
git add dcs test
git diff --cached --stat
git commit -m "feat(repo): repo paths, settings validation and dcs init"
```

---

### Task 3: Task file core: validation, `add`, `list`, `show`, `next`, `run`, `decide`, `decisions`, `check`

**Files:**
- Create: `dcs/lib/tasks.js`
- Modify: `dcs/bin/dcs` (imports, helpers `specsDirOf`, `loadState`, `mutate`, `taskArg`, commands)
- Test: `test/tasks.test.js`

**Interfaces:**
- Consumes: `store.{DcsError, readJson, writeJsonAtomic, withLock}`, `repo.paths`, bin `ctxFor`.
- Produces: `tasks.validate(state, {specsDir}) → string[]`, `tasks.get(state, id) → task`, `tasks.add(state, input, {specsDir, refExists(rel) → bool}) → string[] ids`, `tasks.ready(state, n) → task[]`, `tasks.setRunStart(state, at) → at`, `tasks.decide(state, id, q, a, at)`, `tasks.listDecisions(state, {run}) → [{task, q, a, at}]`.
- Produces (bin): `loadState(P, settings) → state` (throws when missing or invalid), `mutate(P, settings, fn) → fn(state)` (lock → load → fn → validate → atomic write), `taskArg(argv) → id`, `specsDirOf(settings)`.
- The task object shape is exactly the spec §3 example, plus `verifyFailStreak: 0` and `reviewRound: 1`.

- [ ] **Step 1: Write the failing tests**

`test/tasks.test.js`:
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpRepo, specRepo, dcs, tmpDir, sh } = require('./helpers');

const work = (over = {}) => ({ title: 'Do thing', ac: ['it works'], ui: false, ...over });
const specTask = (over = {}) => ({ kind: 'spec', title: 'Spec: Tag', ac: ['all sections filled'], specPath: 'specs/components/Tag.spec.md', ...over });
const add = (dir, input) => dcs(['add'], { cwd: dir, input: JSON.stringify(input) });
const state = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.claude/dcs/tasks.json'), 'utf8'));
const task = (dir, id) => state(dir).tasks.find((t) => t.id === id);
const headSha = (dir) => sh('git rev-parse HEAD', dir).trim();

test('add assigns ids and defaults, and resolves #n batch references', () => {
  const dir = tmpRepo();
  const r = add(dir, [work({ title: 'Skeleton' }), work({ title: 'Section', depends: ['#1'] })]).ok();
  assert.equal(r.stdout.trim(), 't1\nt2');
  const t2 = task(dir, 't2');
  assert.deepEqual(t2.depends, ['t1']);
  assert.equal(t2.kind, 'work');
  assert.equal(t2.status, 'todo');
  assert.equal(t2.failures, 0);
  assert.equal(t2.reviewRound, 1);
  assert.equal(t2.specPath, null);
  add(dir, work({ title: 'Third', depends: ['t2'] })).ok();
  assert.deepEqual(task(dir, 't3').depends, ['t2']);
});

test('add is all-or-nothing and names every problem', () => {
  const dir = tmpRepo();
  const r = add(dir, [work(), { title: '', ac: [], jira: 'app2x-1', figma: ['https://example.com/x'], ui: true }]);
  assert.equal(r.code, 1);
  for (const re of [/title is required/, /ac needs at least one/, /jira must be null or like/, /figma must be an array of figma.com URLs/]) {
    assert.match(r.stderr, re);
  }
  assert.equal(state(dir).tasks.length, 0);
});

test('add requires ui on work tasks and rejects unknown fields', () => {
  const dir = tmpRepo();
  assert.match(add(dir, { title: 'A', ac: ['x'] }).stderr, /ui must be true or false/);
  assert.match(add(dir, work({ colour: 'red' })).stderr, /unknown field\(s\): colour/);
});

test('add rejects unknown dependencies and cycles', () => {
  const dir = tmpRepo();
  assert.match(add(dir, work({ depends: ['t9'] })).stderr, /unknown dependency t9/);
  assert.match(add(dir, [work({ depends: ['#2'] }), work({ depends: ['#1'] })]).stderr, /dependency cycle/);
  assert.match(add(dir, work({ depends: ['#5'] })).stderr, /outside this batch/);
});

test('add rejects refs that do not exist and accepts ones that do', () => {
  const dir = tmpRepo();
  assert.match(add(dir, work({ refs: ['src/Nope.tsx'] })).stderr, /refs path does not exist: src\/Nope.tsx/);
  add(dir, work({ refs: ['README.md'] })).ok();
});

test('spec tasks need settings.specs, a specPath under specs.dir, and ui false', () => {
  assert.match(add(tmpRepo(), specTask()).stderr, /spec tasks need settings.specs/);
  const dir = specRepo();
  assert.match(add(dir, specTask({ specPath: 'docs/Tag.spec.md' })).stderr, /specPath must be a .spec.md file under specs\/components/);
  assert.match(add(dir, specTask({ ui: true })).stderr, /spec tasks must have ui false/);
  assert.match(add(dir, work({ specPath: 'specs/components/Tag.spec.md' })).stderr, /work tasks must have specPath null/);
  add(dir, specTask()).ok();
  assert.equal(task(dir, 't1').ui, false);
});

test('next lists ready tasks in id order and respects dependencies', () => {
  const dir = tmpRepo();
  add(dir, [work({ title: 'A' }), work({ title: 'B', depends: ['#1'] }), work({ title: 'C' })]).ok();
  const ready = dcs(['next', '--n', '3', '--json'], { cwd: dir }).ok().json();
  assert.deepEqual(ready.map((t) => t.id), ['t1', 't3']);
  assert.match(dcs(['next', '--n', '0'], { cwd: dir }).stderr, /--n must be a positive integer/);
});

test('decide appends and rejects empty values; decisions --run filters by the run start', () => {
  const dir = tmpRepo();
  add(dir, [work(), work()]).ok();
  assert.match(dcs(['decisions', '--run'], { cwd: dir }).stderr, /no run started yet/);
  dcs(['decide', 't1', '--q', 'Old?', '--a', 'yes'], { cwd: dir, env: { DCS_NOW: '2026-09-29T10:00:00.000Z' } }).ok();
  dcs(['run'], { cwd: dir, env: { DCS_NOW: '2026-09-30T09:00:00.000Z' } }).ok();
  dcs(['decide', 't2', '--q', 'Size?', '--a', 'medium'], { cwd: dir, env: { DCS_NOW: '2026-09-30T10:00:00.000Z' } }).ok();
  assert.equal(dcs(['decide', 't1', '--q', ' ', '--a', 'x'], { cwd: dir }).code, 1);
  assert.equal(dcs(['decisions'], { cwd: dir }).ok().json().length, 2);
  const run = dcs(['decisions', '--run'], { cwd: dir }).ok().json();
  assert.deepEqual(run.map((d) => [d.task, d.q, d.a]), [['t2', 'Size?', 'medium']]);
});

test('list and show print tasks; unknown ids are refused', () => {
  const dir = tmpRepo();
  add(dir, work({ title: 'Alpha' })).ok();
  assert.match(dcs(['list'], { cwd: dir }).ok().stdout, /t1\twork\ttodo\tfailures:0\t-\tAlpha/);
  assert.equal(dcs(['show', 't1'], { cwd: dir }).ok().json().title, 'Alpha');
  assert.match(dcs(['show', 't7'], { cwd: dir }).stderr, /unknown task: t7/);
});

test('a hand-corrupted tasks.json is refused and never repaired; check reports it', () => {
  const dir = tmpRepo();
  add(dir, work()).ok();
  assert.match(dcs(['check'], { cwd: dir }).ok().stdout, /^ok/);
  const file = path.join(dir, '.claude/dcs/tasks.json');
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  s.tasks[0].status = 'weird';
  fs.writeFileSync(file, JSON.stringify(s));
  for (const args of [['list'], ['check']]) {
    const r = dcs(args, { cwd: dir });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /invalid status weird/);
  }
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).tasks[0].status, 'weird');
});

module.exports = { work, specTask, add, state, task, headSha };
```

(Tasks 4 and 5 append more tests to this file. The `module.exports` line stays last.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/tasks.test.js`
Expected: FAIL with `usage: dcs <init>` (no `add` command yet).

- [ ] **Step 3: Implement `dcs/lib/tasks.js`**

```js
'use strict';
const path = require('node:path');
const { DcsError } = require('./store');

const STATUSES = ['todo', 'doing', 'verified', 'approved', 'done', 'blocked'];
const KINDS = ['work', 'spec', 'spec-sync'];
const JIRA_RE = /^[A-Z][A-Z0-9]+-\d+$/;
const INPUT_KEYS = ['kind', 'title', 'jira', 'figma', 'refs', 'ui', 'ac', 'depends', 'specPath'];

const need = (cond, msg) => {
  if (!cond) throw new DcsError(msg);
};
const num = (id) => Number(String(id).slice(1));
const isStr = (s) => typeof s === 'string' && s.trim() !== '';

function get(state, id) {
  const t = state.tasks.find((x) => x.id === id);
  need(t, `unknown task: ${id}`);
  return t;
}

function isFigmaUrl(u) {
  try {
    const host = new URL(u).hostname;
    return host === 'www.figma.com' || host === 'figma.com';
  } catch {
    return false;
  }
}

function isUnder(rel, dir) {
  const r = path.posix.normalize(String(rel));
  const d = path.posix.normalize(String(dir)).replace(/\/+$/, '');
  return !r.startsWith('..') && !path.posix.isAbsolute(r) && r.startsWith(`${d}/`);
}

function findCycle(list) {
  const byId = new Map(list.map((t) => [t.id, t]));
  const mark = new Map();
  const visit = (id, trail) => {
    if (mark.get(id) === 'done') return null;
    if (mark.get(id) === 'open') return [...trail, id];
    mark.set(id, 'open');
    for (const dep of (byId.get(id) && byId.get(id).depends) || []) {
      const cycle = visit(dep, [...trail, id]);
      if (cycle) return cycle;
    }
    mark.set(id, 'done');
    return null;
  };
  for (const t of list) {
    const cycle = visit(t.id, []);
    if (cycle) return cycle;
  }
  return null;
}

function validate(state, { specsDir }) {
  if (!state || state.version !== 1 || !Array.isArray(state.tasks)) return ['tasks file must be {"version": 1, "tasks": [...]}'];
  const p = [];
  const ids = new Set();
  for (const t of state.tasks) {
    const at = `task ${t && t.id !== undefined ? t.id : '?'}`;
    if (!t || typeof t !== 'object') {
      p.push(`${at}: must be an object`);
      continue;
    }
    if (!/^t\d+$/.test(String(t.id))) p.push(`${at}: id must look like t<n>`);
    if (ids.has(t.id)) p.push(`${at}: duplicate id`);
    ids.add(t.id);
    if (!KINDS.includes(t.kind)) p.push(`${at}: kind must be one of ${KINDS.join(', ')}`);
    if (!isStr(t.title)) p.push(`${at}: title is required`);
    if (!Array.isArray(t.ac) || t.ac.length === 0 || !t.ac.every(isStr)) p.push(`${at}: ac needs at least one non-empty string`);
    if (t.jira !== null && !JIRA_RE.test(String(t.jira))) p.push(`${at}: jira must be null or like APP2X-123`);
    if (!Array.isArray(t.figma) || !t.figma.every(isFigmaUrl)) p.push(`${at}: figma must be an array of figma.com URLs`);
    if (!Array.isArray(t.refs) || !t.refs.every(isStr)) p.push(`${at}: refs must be an array of paths`);
    if (!Array.isArray(t.depends)) p.push(`${at}: depends must be an array`);
    if (typeof t.ui !== 'boolean') p.push(`${at}: ui must be true or false`);
    if (!STATUSES.includes(t.status)) p.push(`${at}: invalid status ${t.status}`);
    if (t.kind === 'work' && t.specPath !== null) p.push(`${at}: work tasks must have specPath null`);
    if (t.kind === 'spec' || t.kind === 'spec-sync') {
      if (t.ui !== false) p.push(`${at}: ${t.kind} tasks must have ui false`);
      if (!specsDir) p.push(`${at}: ${t.kind} tasks need settings.specs`);
      else if (!isStr(t.specPath) || !t.specPath.endsWith('.spec.md') || !isUnder(t.specPath, specsDir)) {
        p.push(`${at}: specPath must be a .spec.md file under ${specsDir}`);
      }
    }
  }
  for (const t of state.tasks) {
    for (const dep of (t && Array.isArray(t.depends) && t.depends) || []) {
      if (!ids.has(dep)) p.push(`task ${t.id}: unknown dependency ${dep}`);
    }
  }
  const cycle = findCycle(state.tasks.filter((t) => t && Array.isArray(t.depends)));
  if (cycle) p.push(`dependency cycle: ${cycle.join(' -> ')}`);
  return p;
}

function resolveDep(dep, ids, i) {
  const m = /^#(\d+)$/.exec(String(dep));
  if (!m) return dep;
  const k = Number(m[1]) - 1;
  need(k >= 0 && k < ids.length, `task #${i + 1}: depends ${dep} is outside this batch`);
  return ids[k];
}

function add(state, input, ctx) {
  const list = Array.isArray(input) ? input : [input];
  need(list.length > 0, 'no tasks given');
  let n = Math.max(0, ...state.tasks.map((t) => num(t.id)));
  const ids = list.map(() => `t${(n += 1)}`);
  const created = list.map((raw, i) => {
    need(raw && typeof raw === 'object' && !Array.isArray(raw), `task #${i + 1} must be a JSON object`);
    const unknown = Object.keys(raw).filter((k) => !INPUT_KEYS.includes(k));
    need(unknown.length === 0, `task #${i + 1}: unknown field(s): ${unknown.join(', ')}`);
    const kind = raw.kind === undefined ? 'work' : raw.kind;
    let depends = raw.depends === undefined ? [] : raw.depends;
    if (Array.isArray(depends)) depends = depends.map((d) => resolveDep(d, ids, i));
    return {
      id: ids[i],
      kind,
      title: raw.title,
      jira: raw.jira === undefined ? null : raw.jira,
      figma: raw.figma === undefined ? [] : raw.figma,
      refs: raw.refs === undefined ? [] : raw.refs,
      ui: kind === 'work' || raw.ui !== undefined ? raw.ui : false,
      ac: raw.ac,
      depends,
      status: 'todo',
      failures: 0,
      verifyFailStreak: 0,
      reviewRound: 1,
      branch: null,
      baseSha: null,
      worktree: null,
      landed: false,
      commit: null,
      verify: null,
      qa: null,
      reviews: [],
      decisions: [],
      specPath: raw.specPath === undefined ? null : raw.specPath,
      specApproval: null,
    };
  });
  const problems = validate({ ...state, tasks: [...state.tasks, ...created] }, ctx);
  for (const t of created) {
    for (const ref of Array.isArray(t.refs) ? t.refs : []) {
      if (isStr(ref) && !ctx.refExists(ref)) problems.push(`task ${t.id}: refs path does not exist: ${ref}`);
    }
  }
  need(problems.length === 0, `nothing added:\n- ${problems.join('\n- ')}`);
  state.tasks.push(...created);
  return ids;
}

function ready(state, n) {
  const done = new Set(state.tasks.filter((t) => t.status === 'done').map((t) => t.id));
  return state.tasks
    .filter((t) => t.status === 'todo' && t.depends.every((d) => done.has(d)))
    .sort((a, b) => num(a.id) - num(b.id))
    .slice(0, n);
}

function setRunStart(state, at) {
  state.runStartedAt = at;
  return at;
}

function decide(state, id, q, a, at) {
  const t = get(state, id);
  need(isStr(q) && isStr(a), 'decide needs a non-empty --q and --a');
  t.decisions.push({ q: q.trim(), a: a.trim(), at });
  return t;
}

function listDecisions(state, { run }) {
  need(!run || state.runStartedAt, 'no run started yet (the Captain runs "dcs run" when /dcs:work starts)');
  return state.tasks
    .flatMap((t) => t.decisions.map((d) => ({ task: t.id, ...d })))
    .filter((d) => !run || d.at >= state.runStartedAt)
    .sort((x, y) => x.at.localeCompare(y.at));
}

module.exports = { STATUSES, KINDS, validate, get, add, ready, setRunStart, decide, listDecisions };
```

- [ ] **Step 4: Wire the commands into the CLI**

In `dcs/bin/dcs`, replace `const { DcsError } = require('../lib/store');` with:
```js
const { DcsError, readJson, writeJsonAtomic, withLock } = require('../lib/store');
```
and below `const repo = require('../lib/repo');` add:
```js
const tasks = require('../lib/tasks');
```

Under the helpers marker, after `requireSettings`, add:
```js
const specsDirOf = (settings) => (settings && settings.specs ? settings.specs.dir : null);

function loadState(P, settings) {
  const state = readJson(P.tasksFile, null);
  if (!state) throw new DcsError('no .claude/dcs/tasks.json in this repo; run /dcs:setup');
  const problems = tasks.validate(state, { specsDir: specsDirOf(settings) });
  if (problems.length) throw new DcsError(`tasks.json invalid (fix it by hand; dcs never repairs it):\n- ${problems.join('\n- ')}`);
  return state;
}

function mutate(P, settings, fn) {
  return withLock(P.lockFile, () => {
    const state = loadState(P, settings);
    const result = fn(state);
    const problems = tasks.validate(state, { specsDir: specsDirOf(settings) });
    if (problems.length) throw new DcsError(`refusing to write an invalid tasks.json:\n- ${problems.join('\n- ')}`);
    writeJsonAtomic(P.tasksFile, state);
    return result;
  });
}

function taskArg(argv) {
  const id = argv.find((a) => !a.startsWith('-'));
  if (!id) throw new DcsError('missing task id');
  return id;
}
```

Inside `commands`, after `init`, add:
```js
  check() {
    const { P, settings } = ctxFor();
    loadState(P, settings);
    out(`ok: ${settings ? 'settings valid' : 'no settings yet (run /dcs:setup)'}, tasks valid`);
  },

  add() {
    const { P, settings } = ctxFor();
    const input = stdinJson();
    const ctx = { specsDir: specsDirOf(settings), refExists: (rel) => fs.existsSync(path.join(P.mainRoot, rel)) };
    out(mutate(P, settings, (s) => tasks.add(s, input, ctx)).join('\n'));
  },

  list(argv) {
    const { values } = parseArgs({ args: argv, options: { json: { type: 'boolean' } } });
    const { P, settings } = ctxFor();
    const state = loadState(P, settings);
    if (values.json) return out(state.tasks);
    const rows = state.tasks.map((t) => [t.id, t.kind, t.status, `failures:${t.failures}`, t.jira || '-', t.title].join('\t'));
    out(rows.join('\n') || '(no tasks)');
  },

  show(argv) {
    const { P, settings } = ctxFor();
    out(tasks.get(loadState(P, settings), taskArg(argv)));
  },

  next(argv) {
    const { values } = parseArgs({ args: argv, options: { n: { type: 'string', default: '1' }, json: { type: 'boolean' } } });
    const n = Number(values.n);
    if (!Number.isInteger(n) || n < 1) throw new DcsError('--n must be a positive integer');
    const { P, settings } = ctxFor();
    const list = tasks.ready(loadState(P, settings), n);
    if (values.json) return out(list);
    out(list.map((t) => `${t.id}\t${t.kind}\t${t.title}`).join('\n') || '(no ready tasks)');
  },

  run() {
    const { P, settings } = ctxFor();
    out(`run started ${mutate(P, settings, (s) => tasks.setRunStart(s, iso()))}`);
  },

  decide(argv) {
    const { values, positionals } = parseArgs({ args: argv, options: { q: { type: 'string' }, a: { type: 'string' } }, allowPositionals: true });
    const { P, settings } = ctxFor();
    mutate(P, settings, (s) => tasks.decide(s, positionals[0], values.q, values.a, iso()));
    out(`recorded decision on ${positionals[0]}`);
  },

  decisions(argv) {
    const { values } = parseArgs({ args: argv, options: { run: { type: 'boolean' } } });
    const { P, settings } = ctxFor();
    out(tasks.listDecisions(loadState(P, settings), { run: !!values.run }));
  },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/`
Expected: PASS (store 8, repo 5, tasks 10).

- [ ] **Step 6: Commit (after Navin's yes)**

```bash
git add dcs test
git diff --cached --stat
git commit -m "feat(tasks): validated task file with add, list, next and decisions"
```

---

### Task 4: `start`, worktrees, fingerprint, `verify`, `diff`

**Files:**
- Modify: `dcs/lib/tasks.js` (add `FAILURE_CAP`, `addFailure`, `assertStartable`, `start`, `applyVerify`)
- Modify: `dcs/lib/repo.js` (add `untracked`, `fingerprint`, `diffSince`, `createWorktree`, `removeWorktree`, `runVerify`)
- Modify: `dcs/bin/dcs` (helpers `nextIndex`, `taskCwd`; commands `start`, `verify`, `diff`)
- Test: append to `test/tasks.test.js` and `test/repo.test.js`

**Interfaces:**
- Consumes: Task 3 `loadState`, `mutate`, `tasks.get`.
- Produces: `tasks.assertStartable(state, id) → task`, `tasks.start(state, id, {branch, baseSha, worktree}) → task`, `tasks.applyVerify(state, id, record) → task`, `tasks.addFailure(task)` (failures+1; at 3 → `blocked`, else `doing`).
- Produces: `repo.fingerprint(cwd) → sha1 hex`, `repo.diffSince(cwd, baseSha) → Buffer`, `repo.createWorktree(P, id, setupCmds) → {dir, branch}`, `repo.removeWorktree(P, id)`, `repo.runVerify(cwd, cmds, logFile) → [{cmd, exit, tail}]`.
- Produces (bin): `taskCwd(P, task) → task.worktree || P.mainRoot`, `nextIndex(dir, prefix) → count+1`.
- Verify record: `{fingerprint, results, at, log}` for work tasks, `{fingerprint, skipped: true, at}` for spec kinds. The `dcs verify` stdout is JSON `{id, status, failures, results}`; it exits 1 when not verified.

- [ ] **Step 1: Write the failing tests**

Append to `test/tasks.test.js`, **above** the final `module.exports` line:
```js
const { baseSettings } = require('./helpers');

test('start refuses unfinished dependencies, a dirty checkout, and repos without settings', () => {
  const dir = tmpRepo();
  add(dir, [work(), work({ depends: ['#1'] })]).ok();
  assert.match(dcs(['start', 't2'], { cwd: dir }).stderr, /t2 waits on: t1/);
  fs.writeFileSync(path.join(dir, 'dirty.txt'), 'x');
  assert.match(dcs(['start', 't1'], { cwd: dir }).stderr, /uncommitted changes/);
  fs.rmSync(path.join(dir, 'dirty.txt'));
  fs.rmSync(path.join(dir, '.claude/dcs/settings.json'));
  assert.match(dcs(['start', 't1'], { cwd: dir }).stderr, /run \/dcs:setup/);
});

test('start records the branch and base sha; a second start is refused', () => {
  const dir = tmpRepo();
  add(dir, work()).ok();
  dcs(['start', 't1'], { cwd: dir }).ok();
  const t = task(dir, 't1');
  assert.deepEqual([t.status, t.branch, t.baseSha, t.worktree], ['doing', 'main', headSha(dir), null]);
  assert.match(dcs(['start', 't1'], { cwd: dir }).stderr, /t1 is doing, not todo/);
});

test('verify: passing commands → verified, full log saved as evidence', () => {
  const dir = tmpRepo({ settings: baseSettings({ verify: ['echo checking', 'true'] }) });
  add(dir, work()).ok();
  dcs(['start', 't1'], { cwd: dir }).ok();
  assert.equal(dcs(['verify', 't1'], { cwd: dir }).ok().json().status, 'verified');
  const t = task(dir, 't1');
  assert.deepEqual(t.verify.results.map((x) => [x.cmd, x.exit]), [['echo checking', 0], ['true', 0]]);
  assert.match(t.verify.fingerprint, /^[0-9a-f]{40}$/);
  assert.match(fs.readFileSync(path.join(dir, '.claude/dcs/evidence/t1/verify-1.log'), 'utf8'), /\$ echo checking\nchecking/);
});

test('three failed verifies count as one failure; the third failure blocks the task', () => {
  const dir = tmpRepo({ settings: baseSettings({ verify: ['echo nope; exit 1'] }) });
  add(dir, work()).ok();
  dcs(['start', 't1'], { cwd: dir }).ok();
  const runs = Array.from({ length: 9 }, () => dcs(['verify', 't1'], { cwd: dir }));
  assert.ok(runs.every((r) => r.code === 1));
  assert.deepEqual(runs.map((r) => r.json().failures), [0, 0, 1, 1, 1, 2, 2, 2, 3]);
  assert.equal(task(dir, 't1').status, 'blocked');
  assert.match(dcs(['verify', 't1'], { cwd: dir }).stderr, /blocked; verify needs doing or verified/);
});

test('verify keeps exactly the last 40 lines of huge output', () => {
  const dir = tmpRepo({ settings: baseSettings({ verify: [`node -e "for (let i = 0; i < 100000; i++) console.log('line ' + i)"`] }) });
  add(dir, work()).ok();
  dcs(['start', 't1'], { cwd: dir }).ok();
  dcs(['verify', 't1'], { cwd: dir }).ok();
  const lines = task(dir, 't1').verify.results[0].tail.split('\n');
  assert.equal(lines.length, 40);
  assert.equal(lines.at(-1), 'line 99999');
});

test('spec-kind verify skips the commands but still records a fingerprint', () => {
  const dir = specRepo({ verify: ['exit 1'] });
  add(dir, specTask()).ok();
  dcs(['start', 't1'], { cwd: dir }).ok();
  assert.equal(dcs(['verify', 't1'], { cwd: dir }).ok().json().status, 'verified');
  const t = task(dir, 't1');
  assert.equal(t.verify.skipped, true);
  assert.match(t.verify.fingerprint, /^[0-9a-f]{40}$/);
});
```

Append to `test/repo.test.js`:
```js
const repo = require('../dcs/lib/repo');

const taskOf = (dir, id) => JSON.parse(fs.readFileSync(path.join(dir, '.claude/dcs/tasks.json'), 'utf8')).tasks.find((t) => t.id === id);
const addOne = (dir, over = {}) => dcs(['add'], { cwd: dir, input: JSON.stringify({ title: 'A', ac: ['x'], ui: false, ...over }) }).ok();
const wtPath = (dir, id) => path.join(path.dirname(dir), `${path.basename(dir)}.dcs-worktrees`, id);

test('start --worktree creates a sibling worktree on dcs/<id> and runs worktreeSetup there', () => {
  const dir = tmpRepo({ settings: baseSettings({ worktreeSetup: ['touch .setup-ran'] }) });
  addOne(dir);
  dcs(['start', 't1', '--worktree'], { cwd: dir }).ok();
  const wt = wtPath(dir, 't1');
  assert.equal(taskOf(dir, 't1').worktree, wt);
  assert.equal(taskOf(dir, 't1').branch, 'main');
  assert.ok(fs.existsSync(path.join(wt, '.setup-ran')));
  assert.equal(sh('git rev-parse --abbrev-ref HEAD', wt).trim(), 'dcs/t1');
});

test('dcs verify run from inside the worktree updates the main tasks file', () => {
  const dir = tmpRepo();
  addOne(dir);
  dcs(['start', 't1', '--worktree'], { cwd: dir }).ok();
  dcs(['verify', 't1'], { cwd: wtPath(dir, 't1') }).ok();
  assert.equal(taskOf(dir, 't1').status, 'verified');
});

test('a failing worktreeSetup removes the worktree and branch and leaves the task todo', () => {
  const dir = tmpRepo({ settings: baseSettings({ worktreeSetup: ['echo broken >&2; exit 3'] }) });
  addOne(dir);
  const r = dcs(['start', 't1', '--worktree'], { cwd: dir });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /worktreeSetup failed: echo broken >&2; exit 3 \(exit 3\)/);
  assert.match(r.stderr, /broken/);
  assert.equal(fs.existsSync(wtPath(dir, 't1')), false);
  assert.equal(sh('git branch --list dcs/t1', dir).trim(), '');
  assert.equal(taskOf(dir, 't1').status, 'todo');
});

test('diff includes untracked files and never touches the index', () => {
  const dir = tmpRepo();
  addOne(dir);
  dcs(['start', 't1'], { cwd: dir }).ok();
  fs.appendFileSync(path.join(dir, 'README.md'), 'more\n');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'brand new\n');
  const d = dcs(['diff', 't1'], { cwd: dir }).ok().stdout;
  assert.match(d, /\+more/);
  assert.match(d, /new\.txt/);
  assert.match(d, /\+brand new/);
  assert.equal(sh('git diff --cached --name-only', dir), '');
});

test('fingerprint changes when an untracked file changes', () => {
  const dir = tmpRepo();
  fs.writeFileSync(path.join(dir, 'u.txt'), 'a');
  const before = repo.fingerprint(dir);
  fs.writeFileSync(path.join(dir, 'u.txt'), 'b');
  assert.notEqual(repo.fingerprint(dir), before);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/`
Expected: the new tests FAIL with `usage: dcs <...>` (no `start` command) and `repo.fingerprint is not a function`.

- [ ] **Step 3: Add the state transitions to `dcs/lib/tasks.js`**

Above `module.exports`, add:
```js
const FAILURE_CAP = 3;
const VERIFY_STREAK = 3;

function addFailure(t) {
  t.failures += 1;
  t.status = t.failures >= FAILURE_CAP ? 'blocked' : 'doing';
}

function assertStartable(state, id) {
  const t = get(state, id);
  need(t.status === 'todo', `${id} is ${t.status}, not todo`);
  const waiting = t.depends.filter((d) => get(state, d).status !== 'done');
  need(waiting.length === 0, `${id} waits on: ${waiting.join(', ')}`);
  return t;
}

function start(state, id, { branch, baseSha, worktree }) {
  const t = assertStartable(state, id);
  Object.assign(t, { status: 'doing', branch, baseSha, worktree: worktree || null });
  return t;
}

// ponytail: "at most 3 verify runs per dispatch" is enforced as "3 consecutive failed verifies = 1 failure"
function applyVerify(state, id, record) {
  const t = get(state, id);
  need(t.status === 'doing' || t.status === 'verified', `${id} is ${t.status}; verify needs doing or verified`);
  t.verify = record;
  if (record.skipped || record.results.every((r) => r.exit === 0)) {
    t.status = 'verified';
    t.verifyFailStreak = 0;
    return t;
  }
  t.status = 'doing';
  t.verifyFailStreak += 1;
  if (t.verifyFailStreak >= VERIFY_STREAK) {
    t.verifyFailStreak = 0;
    addFailure(t);
  }
  return t;
}
```
Replace the `module.exports` line with:
```js
module.exports = { STATUSES, KINDS, validate, get, add, ready, setRunStart, decide, listDecisions, addFailure, assertStartable, start, applyVerify };
```

- [ ] **Step 4: Add git operations to `dcs/lib/repo.js`**

Add `const crypto = require('node:crypto');` under the `path` import. Above `module.exports`, add:
```js
function untracked(cwd) {
  return git(['ls-files', '--others', '--exclude-standard', '-z'], cwd).toString('utf8').split('\0').filter(Boolean).sort();
}

function fingerprint(cwd) {
  const h = crypto.createHash('sha1');
  h.update(gitText(['rev-parse', 'HEAD'], cwd));
  h.update(git(['diff', 'HEAD', '--binary'], cwd));
  for (const f of untracked(cwd)) {
    h.update(`\0${f}\0`);
    h.update(fs.readFileSync(path.join(cwd, f)));
  }
  return h.digest('hex');
}

function diffSince(cwd, baseSha) {
  const parts = [git(['diff', baseSha, '--binary'], cwd)];
  for (const f of untracked(cwd)) {
    parts.push(git(['diff', '--no-index', '--binary', '--', '/dev/null', f], cwd, { allowCodes: [0, 1] }));
  }
  return Buffer.concat(parts);
}

function removeWorktree(P, id) {
  git(['worktree', 'remove', '--force', path.join(P.worktreesDir, id)], P.mainRoot, { allowCodes: [0, 128] });
  git(['branch', '-D', `dcs/${id}`], P.mainRoot, { allowCodes: [0, 1] });
}

function createWorktree(P, id, setupCmds) {
  const dir = path.join(P.worktreesDir, id);
  const branch = `dcs/${id}`;
  fs.mkdirSync(P.worktreesDir, { recursive: true });
  git(['worktree', 'add', '-q', '-b', branch, dir, 'HEAD'], P.mainRoot);
  for (const cmd of setupCmds) {
    const r = spawnSync(cmd, { cwd: dir, shell: true, encoding: 'utf8', maxBuffer: BIG });
    if (r.status !== 0) {
      removeWorktree(P, id);
      throw new DcsError(`worktreeSetup failed: ${cmd} (exit ${r.status})\n${tail(`${r.stdout || ''}${r.stderr || ''}`, 40)}`);
    }
  }
  return { dir, branch };
}

function runVerify(cwd, cmds, logFile) {
  let log = '';
  const results = cmds.map((cmd) => {
    const r = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', maxBuffer: BIG });
    const output = `${r.stdout || ''}${r.stderr || ''}`;
    const exit = r.status === null ? 1 : r.status;
    log += `$ ${cmd}\n${output}\n[exit ${exit}]\n\n`;
    return { cmd, exit, tail: tail(output, 40) };
  });
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, log);
  return results;
}
```
Replace the `module.exports` line with:
```js
module.exports = { git, gitText, paths, validateSettings, loadSettings, init, isDirty, currentBranch, tail, untracked, fingerprint, diffSince, createWorktree, removeWorktree, runVerify };
```

- [ ] **Step 5: Add the commands to `dcs/bin/dcs`**

Under the helpers marker, after `taskArg`, add:
```js
const taskCwd = (P, t) => t.worktree || P.mainRoot;
const nextIndex = (dir, prefix) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith(prefix)).length : 0) + 1;
```

Inside `commands`, add:
```js
  start(argv) {
    const { values, positionals } = parseArgs({ args: argv, options: { worktree: { type: 'boolean' } }, allowPositionals: true });
    const id = positionals[0];
    const { P, settings } = ctxFor();
    requireSettings(settings);
    tasks.assertStartable(loadState(P, settings), id);
    if (repo.isDirty(P.mainRoot)) throw new DcsError('main checkout has uncommitted changes; commit or stash first');
    const baseSha = repo.gitText(['rev-parse', 'HEAD'], P.mainRoot);
    const branch = repo.currentBranch(P.mainRoot);
    const wt = values.worktree ? repo.createWorktree(P, id, settings.worktreeSetup) : null;
    let t;
    try {
      t = mutate(P, settings, (s) => tasks.start(s, id, { branch, baseSha, worktree: wt && wt.dir }));
    } catch (e) {
      if (wt) repo.removeWorktree(P, id);
      throw e;
    }
    // ---- board touch (Task 6) ----
    out(wt ? `${id} started in worktree ${wt.dir}` : `${id} started on ${t.branch}`);
  },

  verify(argv) {
    const id = taskArg(argv);
    const { P, settings } = ctxFor();
    requireSettings(settings);
    const t0 = tasks.get(loadState(P, settings), id);
    if (t0.status !== 'doing' && t0.status !== 'verified') throw new DcsError(`${id} is ${t0.status}; verify needs doing or verified`);
    const cwd = taskCwd(P, t0);
    let record;
    if (t0.kind !== 'work') {
      record = { fingerprint: repo.fingerprint(cwd), skipped: true, at: iso() };
    } else {
      const dir = path.join(P.evidenceDir, id);
      const log = path.join(dir, `verify-${nextIndex(dir, 'verify-')}.log`);
      const results = repo.runVerify(cwd, settings.verify, log);
      record = { fingerprint: repo.fingerprint(cwd), results, at: iso(), log };
    }
    const t = mutate(P, settings, (s) => tasks.applyVerify(s, id, record));
    out({ id, status: t.status, failures: t.failures, results: record.results || 'skipped' });
    if (t.status !== 'verified') process.exitCode = 1;
  },

  diff(argv) {
    const id = taskArg(argv);
    const { P, settings } = ctxFor();
    const t = tasks.get(loadState(P, settings), id);
    if (t.status === 'todo') throw new DcsError(`${id} has not started`);
    process.stdout.write(repo.diffSince(taskCwd(P, t), t.baseSha));
  },
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/`
Expected: PASS (store 8, repo 10, tasks 16).

- [ ] **Step 7: Commit (after Navin's yes)**

```bash
git add dcs test
git diff --cached --stat
git commit -m "feat(tasks): start, worktrees, verify with evidence, diff"
```

---

### Task 5: `review`, `land`, `qa`, `approve-spec`, `done`, `unblock`

**Files:**
- Modify: `dcs/lib/tasks.js` (add `requiredPasses`, `applyReview`, `markLanded`, `applyQa`, `approveSpec`, `applyDone`, `unblock`)
- Modify: `dcs/lib/repo.js` (add `land`, `commitExists`)
- Modify: `dcs/bin/dcs` (commands `review`, `land`, `qa`, `approve-spec`, `done`, `unblock`)
- Test: append to `test/tasks.test.js` and `test/repo.test.js`

**Interfaces:**
- Consumes: Task 4 `tasks.addFailure`, `repo.fingerprint`, `repo.diffSince`, `repo.removeWorktree`, `repo.isDirty`, bin `taskCwd`, `nextIndex`.
- Produces: `tasks.requiredPasses(task) → string[]`; `tasks.applyReview(state, id, {pass, approve, fingerprint, findings, at}) → {task, complete}`; `tasks.markLanded(state, id)`; `tasks.applyQa(state, id, {result: 'pass'|'fail'|'invalid', dir, at})`; `tasks.approveSpec(state, id, at)`; `tasks.applyDone(state, id, {commit, noChanges, diffEmpty, visualQa})`; `tasks.unblock(state, id)`.
- Produces: `repo.land(P, task)` (throws `DcsError` on a dirty main checkout or a conflict; on a conflict the main checkout is restored and the worktree kept); `repo.commitExists(cwd, sha) → bool`.
- Evidence paths: `evidence/<id>/review-r<round>-<pass>.json`, `evidence/<id>/qa-<n>/<files>` and `qa-<n>/findings.json`.

- [ ] **Step 1: Write the failing tests**

Append to `test/tasks.test.js`, above `module.exports`:
```js
const PASSES = ['ac', 'security', 'performance', 'quality'];
const approve = (dir, id, passes = PASSES) => {
  for (const p of passes) dcs(['review', id, '--pass', p, '--approve'], { cwd: dir }).ok();
};
const toVerified = (dir, id) => {
  dcs(['start', id], { cwd: dir }).ok();
  dcs(['verify', id], { cwd: dir }).ok();
};
const file = (name, content) => {
  const f = path.join(tmpDir(), name);
  fs.writeFileSync(f, content);
  return f;
};

test('review: every required pass approving → approved; findings saved as evidence', () => {
  const dir = tmpRepo();
  add(dir, work()).ok();
  toVerified(dir, 't1');
  const first = dcs(['review', 't1', '--pass', 'ac', '--approve', '--findings', file('f.json', '{"findings":[]}')], { cwd: dir }).ok().json();
  assert.equal(first.roundComplete, false);
  approve(dir, 't1', ['security', 'performance', 'quality']);
  assert.equal(task(dir, 't1').status, 'approved');
  assert.ok(fs.existsSync(path.join(dir, '.claude/dcs/evidence/t1/review-r1-ac.json')));
});

test('review requires a11y for ui tasks, refuses passes that do not apply, and needs one verdict', () => {
  const dir = tmpRepo();
  add(dir, work({ ui: true })).ok();
  toVerified(dir, 't1');
  approve(dir, 't1');
  assert.equal(task(dir, 't1').status, 'verified');
  approve(dir, 't1', ['a11y']);
  assert.equal(task(dir, 't1').status, 'approved');
  const spec = specRepo();
  add(spec, specTask()).ok();
  toVerified(spec, 't1');
  assert.match(dcs(['review', 't1', '--pass', 'security', '--approve'], { cwd: spec }).stderr, /does not take a security pass \(it needs: ac, a11y\)/);
  assert.match(dcs(['review', 't1', '--pass', 'ac', '--approve', '--changes'], { cwd: spec }).stderr, /exactly one of --approve \/ --changes/);
});

test('a changes round sends the task back; three rounds block it; unblock resets', () => {
  const dir = tmpRepo();
  add(dir, work()).ok();
  toVerified(dir, 't1');
  for (let round = 1; round <= 3; round += 1) {
    dcs(['review', 't1', '--pass', 'ac', '--changes'], { cwd: dir }).ok();
    approve(dir, 't1', ['security', 'performance', 'quality']);
    const t = task(dir, 't1');
    assert.equal(t.failures, round);
    assert.equal(t.reviewRound, round + 1);
    assert.equal(t.status, round < 3 ? 'doing' : 'blocked');
    if (round < 3) dcs(['verify', 't1'], { cwd: dir }).ok();
  }
  dcs(['unblock', 't1'], { cwd: dir }).ok();
  assert.deepEqual([task(dir, 't1').status, task(dir, 't1').failures], ['doing', 0]);
  assert.match(dcs(['unblock', 't1'], { cwd: dir }).stderr, /not blocked/);
});

test('review is refused when the code changed after verify', () => {
  const dir = tmpRepo();
  add(dir, work()).ok();
  toVerified(dir, 't1');
  fs.appendFileSync(path.join(dir, 'README.md'), 'edit\n');
  assert.match(dcs(['review', 't1', '--pass', 'ac', '--approve'], { cwd: dir }).stderr, /changed since verify; run dcs verify t1 again/);
});

test('qa: needs approved; two invalid captures then refused; pass unlocks done', () => {
  const dir = tmpRepo({ settings: baseSettings({ visualQa: { skill: 'dcs:visual-qa' } }) });
  add(dir, work({ ui: true })).ok();
  toVerified(dir, 't1');
  const shot = file('shot.png', 'png');
  assert.match(dcs(['qa', 't1', '--pass', '--evidence', shot], { cwd: dir }).stderr, /QA needs approved/);
  approve(dir, 't1', [...PASSES, 'a11y']);
  dcs(['qa', 't1', '--invalid', '--evidence', shot], { cwd: dir }).ok();
  dcs(['qa', 't1', '--invalid', '--evidence', shot], { cwd: dir }).ok();
  assert.match(dcs(['qa', 't1', '--invalid', '--evidence', shot], { cwd: dir }).stderr, /already had 2 invalid captures/);
  assert.equal(task(dir, 't1').status, 'approved');
  assert.match(dcs(['done', 't1', '--commit', headSha(dir)], { cwd: dir }).stderr, /needs a passing visual QA/);
  dcs(['qa', 't1', '--pass', '--evidence', shot], { cwd: dir }).ok();
  assert.ok(fs.existsSync(path.join(dir, '.claude/dcs/evidence/t1/qa-3/shot.png')));
  dcs(['done', 't1', '--commit', headSha(dir)], { cwd: dir }).ok();
  assert.equal(task(dir, 't1').status, 'done');
  assert.equal(task(dir, 't1').commit, headSha(dir));
});

test('qa fail sends the task back with a failure and keeps the findings', () => {
  const dir = tmpRepo({ settings: baseSettings({ visualQa: { agent: 'visual-qa' } }) });
  add(dir, work({ ui: true })).ok();
  toVerified(dir, 't1');
  approve(dir, 't1', [...PASSES, 'a11y']);
  const findings = file('qa.json', '{"findings":[{"severity":"major"}]}');
  dcs(['qa', 't1', '--fail', '--evidence', file('s.png', 'x'), '--findings', findings], { cwd: dir }).ok();
  assert.deepEqual([task(dir, 't1').status, task(dir, 't1').failures], ['doing', 1]);
  assert.ok(fs.existsSync(path.join(dir, '.claude/dcs/evidence/t1/qa-1/findings.json')));
});

test('done: the commit must exist; spec tasks need approve-spec; --no-changes only for an unchanged spec-sync', () => {
  const dir = specRepo();
  add(dir, [specTask(), work({ depends: ['#1'] }), specTask({ kind: 'spec-sync', title: 'Sync Tag spec', depends: ['#2'] })]).ok();
  toVerified(dir, 't1');
  approve(dir, 't1', ['ac', 'a11y']);
  assert.match(dcs(['done', 't1', '--commit', 'deadbeef'], { cwd: dir }).stderr, /commit not found: deadbeef/);
  assert.match(dcs(['done', 't1', '--no-changes'], { cwd: dir }).stderr, /only for spec-sync tasks/);
  assert.match(dcs(['done', 't1', '--commit', headSha(dir)], { cwd: dir }).stderr, /needs dcs approve-spec first/);
  dcs(['approve-spec', 't1'], { cwd: dir }).ok();
  dcs(['done', 't1', '--commit', headSha(dir)], { cwd: dir }).ok();
  toVerified(dir, 't2');
  approve(dir, 't2');
  assert.match(dcs(['approve-spec', 't2'], { cwd: dir }).stderr, /only spec tasks/);
  dcs(['done', 't2', '--commit', headSha(dir)], { cwd: dir }).ok();
  toVerified(dir, 't3');
  approve(dir, 't3', ['ac']);
  fs.appendFileSync(path.join(dir, 'specs/components/Tag.spec.md'), 'synced\n');
  assert.match(dcs(['done', 't3', '--no-changes'], { cwd: dir }).stderr, /t3 has changes/);
  sh('git checkout -- specs', dir);
  dcs(['done', 't3', '--no-changes'], { cwd: dir }).ok();
  assert.equal(task(dir, 't3').commit, null);
});
```

Append to `test/repo.test.js`:
```js
function approvedInWorktree(dir, edit) {
  addOne(dir);
  dcs(['start', 't1', '--worktree'], { cwd: dir }).ok();
  const wt = wtPath(dir, 't1');
  edit(wt);
  dcs(['verify', 't1'], { cwd: wt }).ok();
  for (const p of ['ac', 'security', 'performance', 'quality']) dcs(['review', 't1', '--pass', p, '--approve'], { cwd: dir }).ok();
  return wt;
}

test('land applies text and binary changes to the main checkout and removes the worktree', () => {
  const dir = tmpRepo();
  const bytes = [0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255];
  const wt = approvedInWorktree(dir, (w) => {
    fs.appendFileSync(path.join(w, 'README.md'), 'from worktree\n');
    fs.writeFileSync(path.join(w, 'logo.png'), Buffer.from(bytes));
  });
  dcs(['land', 't1'], { cwd: dir }).ok();
  assert.match(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), /from worktree/);
  assert.deepEqual([...fs.readFileSync(path.join(dir, 'logo.png'))], bytes);
  assert.equal(fs.existsSync(wt), false);
  assert.equal(sh('git branch --list dcs/t1', dir).trim(), '');
  assert.deepEqual([taskOf(dir, 't1').landed, taskOf(dir, 't1').worktree], [true, null]);
});

test('start, verify and land work when the repo path contains spaces', () => {
  const dir = tmpRepo({ parent: path.join(tmpDir(), 'my repos') });
  approvedInWorktree(dir, (w) => fs.writeFileSync(path.join(w, 'spaced.txt'), 'ok\n'));
  dcs(['land', 't1'], { cwd: dir }).ok();
  assert.equal(fs.readFileSync(path.join(dir, 'spaced.txt'), 'utf8'), 'ok\n');
});

test('a land conflict restores the main checkout and keeps the worktree', () => {
  const dir = tmpRepo();
  const wt = approvedInWorktree(dir, (w) => fs.writeFileSync(path.join(w, 'README.md'), 'worktree version\n'));
  fs.writeFileSync(path.join(dir, 'README.md'), 'main version\n');
  sh('git commit -qam "main moved"', dir);
  const r = dcs(['land', 't1'], { cwd: dir });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /land conflict for t1; main checkout restored, worktree kept/);
  assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), 'main version\n');
  assert.equal(sh('git status --porcelain', dir), '');
  assert.ok(fs.existsSync(wt));
  assert.equal(taskOf(dir, 't1').status, 'approved');
});

test('land refuses a dirty main checkout; qa refuses a task still in its worktree', () => {
  const dir = tmpRepo();
  approvedInWorktree(dir, (w) => fs.writeFileSync(path.join(w, 'x.txt'), 'x\n'));
  const shot = path.join(tmpDir(), 's.png');
  fs.writeFileSync(shot, 'x');
  assert.match(dcs(['qa', 't1', '--pass', '--evidence', shot], { cwd: dir }).stderr, /still in a worktree; run dcs land t1 first/);
  fs.writeFileSync(path.join(dir, 'dirty.txt'), 'x');
  assert.match(dcs(['land', 't1'], { cwd: dir }).stderr, /uncommitted changes/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/`
Expected: the new tests FAIL (`review`, `land`, `qa`, `done` are not commands yet).

- [ ] **Step 3: Add the transitions to `dcs/lib/tasks.js`**

Above `module.exports`, add:
```js
const MAX_INVALID_QA = 2;

function requiredPasses(t) {
  if (t.kind === 'spec') return ['ac', 'a11y'];
  if (t.kind === 'spec-sync') return ['ac'];
  return ['ac', 'security', 'performance', 'quality', ...(t.ui ? ['a11y'] : [])];
}

function applyReview(state, id, { pass, approve, fingerprint, findings, at }) {
  const t = get(state, id);
  need(t.status === 'verified', `${id} is ${t.status}; review needs verified`);
  const passes = requiredPasses(t);
  need(passes.includes(pass), `${id} does not take a ${pass} pass (it needs: ${passes.join(', ')})`);
  need(t.verify && t.verify.fingerprint === fingerprint, `${id} changed since verify; run dcs verify ${id} again`);
  const round = t.reviewRound;
  t.reviews = t.reviews.filter((r) => !(r.round === round && r.pass === pass));
  t.reviews.push({ round, pass, verdict: approve ? 'approve' : 'changes', fingerprint, findings: findings || null, at });
  const current = t.reviews.filter((r) => r.round === round && r.fingerprint === t.verify.fingerprint);
  if (!passes.every((p) => current.some((r) => r.pass === p))) return { task: t, complete: false };
  t.reviewRound += 1;
  if (current.every((r) => r.verdict === 'approve')) t.status = 'approved';
  else addFailure(t);
  return { task: t, complete: true };
}

function markLanded(state, id) {
  const t = get(state, id);
  need(t.status === 'approved', `${id} is ${t.status}; land needs approved`);
  need(t.worktree, `${id} has no worktree to land`);
  t.worktree = null;
  t.landed = true;
  return t;
}

function applyQa(state, id, { result, dir, at }) {
  const t = get(state, id);
  need(t.status === 'approved', `${id} is ${t.status}; QA needs approved`);
  need(!t.worktree, `${id} is still in a worktree; run dcs land ${id} first`);
  const invalid = (t.qa && t.qa.invalid) || 0;
  if (result === 'invalid') {
    need(invalid < MAX_INVALID_QA, `${id} already had ${MAX_INVALID_QA} invalid captures; the Captain must ask Navin`);
    t.qa = { result: (t.qa && t.qa.result) || null, invalid: invalid + 1, dir, at };
    return t;
  }
  t.qa = { result, invalid: 0, dir, at };
  if (result === 'fail') addFailure(t);
  return t;
}

function approveSpec(state, id, at) {
  const t = get(state, id);
  need(t.kind === 'spec', `${id} is a ${t.kind} task; only spec tasks are approved with approve-spec`);
  need(t.status === 'approved', `${id} is ${t.status}; approve-spec needs approved`);
  t.specApproval = { at };
  return t;
}

function applyDone(state, id, { commit, noChanges, diffEmpty, visualQa }) {
  const t = get(state, id);
  need(t.status === 'approved', `${id} is ${t.status}; done needs approved`);
  need(!t.worktree, `${id} is still in a worktree; run dcs land ${id} first`);
  need(!noChanges || t.kind === 'spec-sync', '--no-changes is only for spec-sync tasks');
  if (t.ui && visualQa !== false) need(t.qa && t.qa.result === 'pass', `${id} needs a passing visual QA first (dcs qa)`);
  if (t.kind === 'spec') need(t.specApproval, `${id} needs dcs approve-spec first`);
  if (noChanges) {
    need(diffEmpty, `${id} has changes; commit them and use --commit instead`);
    t.commit = null;
  } else {
    need(/^[0-9a-f]{7,40}$/.test(String(commit || '')), 'done needs --commit <sha> or --no-changes');
    t.commit = commit;
  }
  t.status = 'done';
  return t;
}

function unblock(state, id) {
  const t = get(state, id);
  need(t.status === 'blocked', `${id} is ${t.status}, not blocked`);
  Object.assign(t, { status: 'doing', failures: 0, verifyFailStreak: 0 });
  return t;
}
```
Replace the `module.exports` line with:
```js
module.exports = {
  STATUSES, KINDS, validate, get, add, ready, setRunStart, decide, listDecisions, addFailure, assertStartable, start, applyVerify,
  requiredPasses, applyReview, markLanded, applyQa, approveSpec, applyDone, unblock,
};
```

- [ ] **Step 4: Add `land` and `commitExists` to `dcs/lib/repo.js`**

Above `module.exports`, add:
```js
function land(P, task) {
  if (isDirty(P.mainRoot)) throw new DcsError('main checkout has uncommitted changes; commit or stash first');
  git(['add', '-A'], task.worktree);
  const patch = git(['diff', '--cached', task.baseSha, '--binary'], task.worktree);
  if (patch.length) {
    const patchFile = path.join(P.dcsDir, `land-${task.id}.patch`);
    fs.writeFileSync(patchFile, patch);
    try {
      const clean = spawnSync('git', ['apply', '--check', patchFile], { cwd: P.mainRoot }).status === 0;
      const r = spawnSync('git', clean ? ['apply', patchFile] : ['apply', '--3way', patchFile], { cwd: P.mainRoot, encoding: 'utf8' });
      if (r.status !== 0) {
        // ponytail: main was verified clean above, so reset --hard + clean restores it exactly
        git(['reset', '--hard', '-q', 'HEAD'], P.mainRoot);
        git(['clean', '-fdq'], P.mainRoot);
        throw new DcsError(`land conflict for ${task.id}; main checkout restored, worktree kept at ${task.worktree}\n${r.stderr.trim()}`);
      }
    } finally {
      fs.rmSync(patchFile, { force: true });
    }
  }
  removeWorktree(P, task.id);
}

const commitExists = (cwd, sha) => spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd }).status === 0;
```
Replace the `module.exports` line with:
```js
module.exports = {
  git, gitText, paths, validateSettings, loadSettings, init, isDirty, currentBranch, tail,
  untracked, fingerprint, diffSince, createWorktree, removeWorktree, runVerify, land, commitExists,
};
```

- [ ] **Step 5: Add the commands to `dcs/bin/dcs`**

Inside `commands`, add:
```js
  review(argv) {
    const { values, positionals } = parseArgs({
      args: argv,
      options: { pass: { type: 'string' }, approve: { type: 'boolean' }, changes: { type: 'boolean' }, findings: { type: 'string' } },
      allowPositionals: true,
    });
    const id = positionals[0];
    if (!values.pass || !!values.approve === !!values.changes) throw new DcsError('review needs --pass <name> and exactly one of --approve / --changes');
    if (values.findings && !fs.existsSync(values.findings)) throw new DcsError(`findings file not found: ${values.findings}`);
    const { P, settings } = ctxFor();
    const t0 = tasks.get(loadState(P, settings), id);
    const fingerprint = repo.fingerprint(taskCwd(P, t0));
    const saved = values.findings ? path.join(P.evidenceDir, id, `review-r${t0.reviewRound}-${values.pass}.json`) : null;
    const { task, complete } = mutate(P, settings, (s) => tasks.applyReview(s, id, { pass: values.pass, approve: !!values.approve, fingerprint, findings: saved, at: iso() }));
    if (saved) {
      fs.mkdirSync(path.dirname(saved), { recursive: true });
      fs.copyFileSync(values.findings, saved);
    }
    out({ id, status: task.status, roundComplete: complete, failures: task.failures });
  },

  land(argv) {
    const id = taskArg(argv);
    const { P, settings } = ctxFor();
    const t = tasks.get(loadState(P, settings), id);
    if (t.status !== 'approved') throw new DcsError(`${id} is ${t.status}; land needs approved`);
    if (!t.worktree) throw new DcsError(`${id} has no worktree to land`);
    repo.land(P, t);
    mutate(P, settings, (s) => tasks.markLanded(s, id));
    out(`${id} landed into ${P.mainRoot}`);
  },

  qa(argv) {
    const { values, positionals } = parseArgs({
      args: argv,
      options: { pass: { type: 'boolean' }, fail: { type: 'boolean' }, invalid: { type: 'boolean' }, evidence: { type: 'string', multiple: true }, findings: { type: 'string' } },
      allowPositionals: true,
    });
    const [id, ...rest] = positionals;
    const picked = ['pass', 'fail', 'invalid'].filter((k) => values[k]);
    if (picked.length !== 1) throw new DcsError('qa needs exactly one of --pass / --fail / --invalid');
    const evidence = [...(values.evidence || []), ...rest];
    if (!evidence.length) throw new DcsError('qa needs --evidence <paths...>');
    for (const e of [...evidence, ...(values.findings ? [values.findings] : [])]) {
      if (!fs.existsSync(e)) throw new DcsError(`file not found: ${e}`);
    }
    const { P, settings } = ctxFor();
    const base = path.join(P.evidenceDir, id);
    const dir = path.join(base, `qa-${nextIndex(base, 'qa-')}`);
    const t = mutate(P, settings, (s) => tasks.applyQa(s, id, { result: picked[0], dir, at: iso() }));
    fs.mkdirSync(dir, { recursive: true });
    for (const e of evidence) fs.cpSync(e, path.join(dir, path.basename(e)), { recursive: true });
    if (values.findings) fs.copyFileSync(values.findings, path.join(dir, 'findings.json'));
    out({ id, status: t.status, qa: t.qa, failures: t.failures });
  },

  'approve-spec'(argv) {
    const id = taskArg(argv);
    const { P, settings } = ctxFor();
    mutate(P, settings, (s) => tasks.approveSpec(s, id, iso()));
    out(`${id} spec approved`);
  },

  done(argv) {
    const { values, positionals } = parseArgs({ args: argv, options: { commit: { type: 'string' }, 'no-changes': { type: 'boolean' } }, allowPositionals: true });
    const id = positionals[0];
    const noChanges = !!values['no-changes'];
    const { P, settings } = ctxFor();
    requireSettings(settings);
    const t0 = tasks.get(loadState(P, settings), id);
    if (!noChanges && values.commit && !repo.commitExists(P.mainRoot, values.commit)) throw new DcsError(`commit not found: ${values.commit}`);
    const diffEmpty = noChanges && t0.baseSha ? repo.diffSince(taskCwd(P, t0), t0.baseSha).length === 0 : false;
    const t = mutate(P, settings, (s) => tasks.applyDone(s, id, { commit: values.commit, noChanges, diffEmpty, visualQa: settings.visualQa }));
    out(`${id} done${t.commit ? ` (${t.commit})` : ' (no changes)'}`);
  },

  unblock(argv) {
    const id = taskArg(argv);
    const { P, settings } = ctxFor();
    mutate(P, settings, (s) => tasks.unblock(s, id));
    out(`${id} unblocked (failures reset)`);
  },
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/`
Expected: PASS (store 8, repo 14, tasks 23).

- [ ] **Step 7: Commit (after Navin's yes)**

```bash
git add dcs test
git diff --cached --stat
git commit -m "feat(tasks): review rounds, land, visual QA, spec approval, done"
```

---

### Task 6: Weekly task board

**Files:**
- Create: `dcs/lib/board.js`
- Modify: `dcs/bin/dcs` (import `board`; command `board`; board touch inside `start`)
- Test: `test/board.test.js`

**Interfaces:**
- Consumes: `store.{DcsError, readJson, writeJsonAtomic, withLock}`, `repo.paths`.
- Produces: `board.boardDir() → DCS_BOARD_DIR || ~/.dcs/board`, `board.isoWeek(date) → 'YYYY-Www'` (local calendar date), `board.loadWeek(dir, week) → data | null`, `board.mutateWeek(dir, week, fn) → fn(data)` (lock, ensure the week with carry-over, fn, save json + md), `board.addRow(dir, data, {title, key, component, repo, source}, at) → row`, `board.setStatus(data, ref, status, reason, at)`, `board.attachPr(data, ref, url, repoName, at)`, `board.editRow(data, ref, {title, component, source})`, `board.touchInProgress(dir, week, key, at) → warning | null`, `board.ghView(url) → {state, mergedAt}` (runs `DCS_GH || gh`), `board.mergedCheck(dir, week, view, at) → warnings[]`, `board.renderMarkdown(data) → string`, `board.renderReport(data) → {text, missing}`.
- Week file: `{version: 1, week, rows: [row]}`, with rows exactly as spec §8. Row ids `b<n>` are unique across all week files.
- CLI: `dcs board [--week W] [--json] [--offline] [--report]`, `dcs board add|set|pr|edit …`. `--report` exits 3 when a reported row is missing its component or title.

- [ ] **Step 1: Write the failing tests**

`test/board.test.js`:
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const board = require('../dcs/lib/board');
const { BIN, dcs, tmpDir, tmpRepo } = require('./helpers');

const at = (day) => `${day}T12:00:00`; // local noon: no timezone edge cases
const env = (dir, day, extra = {}) => ({ DCS_BOARD_DIR: dir, DCS_NOW: at(day), ...extra });
const b = (dir, day, args, extra) => dcs(['board', ...args], { cwd: tmpDir(), env: env(dir, day, extra) });
const week = (dir, w) => JSON.parse(fs.readFileSync(path.join(dir, `${w}.json`), 'utf8'));

function ghStub(responses) {
  const file = path.join(tmpDir(), 'gh');
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node\nconst r = ${JSON.stringify(responses)}[process.argv[4]];\n` +
      `if (!r) { console.error('gh: offline'); process.exit(1); }\nconsole.log(JSON.stringify(r));\n`,
  );
  fs.chmodSync(file, 0o755);
  return file;
}

const row = (id, key, component, title, status, extra = {}) => ({
  id, key, component, title, status, repos: [], prs: [], source: null, reason: null, history: [], ...extra,
});

test('isoWeek follows ISO 8601: Monday weeks, the Thursday decides the year', () => {
  const w = (d) => board.isoWeek(new Date(at(d)));
  assert.equal(w('2026-09-30'), '2026-W40');
  assert.equal(w('2026-12-31'), '2026-W53');
  assert.equal(w('2027-01-01'), '2026-W53');
  assert.equal(w('2025-12-29'), '2026-W01');
  assert.equal(w('2026-10-04'), '2026-W40');
  assert.equal(w('2026-10-05'), '2026-W41');
});

test('add, set and pr update the current week and render markdown', () => {
  const dir = tmpDir();
  const url = 'https://github.com/rcg-digital-mobile/fluidity-design-system/pull/208';
  b(dir, '2026-09-30', ['add', '--key', 'APP2X-1075', '--component', 'Header', '--title', 'iOS header', '--repo', 'fluidity-design-system']).ok();
  b(dir, '2026-09-30', ['set', 'APP2X-1075', 'in_progress']).ok();
  b(dir, '2026-09-30', ['pr', 'APP2X-1075', url]).ok();
  const r = week(dir, '2026-W40').rows[0];
  assert.equal(r.id, 'b1');
  assert.equal(r.status, 'undergoing_pr');
  assert.deepEqual(r.prs, [url]);
  assert.deepEqual(r.repos, ['fluidity-design-system']);
  assert.deepEqual(r.history.map((h) => h.status), ['todo', 'in_progress', 'undergoing_pr']);
  assert.match(fs.readFileSync(path.join(dir, '2026-W40.md'), 'utf8'), /\| b1 \| APP2X-1075 \| Header \| iOS header \| Undergoing PR \|/);
});

test('board refuses duplicate keys, bad keys, blocked without a reason, --source with a key, and non-GitHub PR urls', () => {
  const dir = tmpDir();
  b(dir, '2026-09-30', ['add', '--key', 'APP2X-1', '--title', 'A']).ok();
  assert.match(b(dir, '2026-09-30', ['add', '--key', 'APP2X-1', '--title', 'Again']).stderr, /APP2X-1 is already on the 2026-W40 board/);
  assert.match(b(dir, '2026-09-30', ['add', '--key', 'app2x-2', '--title', 'B']).stderr, /invalid key: app2x-2/);
  assert.match(b(dir, '2026-09-30', ['set', 'APP2X-1', 'blocked']).stderr, /blocked needs --reason/);
  assert.match(b(dir, '2026-09-30', ['add', '--key', 'APP2X-3', '--title', 'C', '--source', 'RNHost Eng']).stderr, /--source is only for untracked rows/);
  assert.match(b(dir, '2026-09-30', ['pr', 'APP2X-1', 'https://gitlab.com/x/y/-/merge_requests/1']).stderr, /not a GitHub PR URL/);
  assert.match(b(dir, '2026-09-30', ['set', 'APP2X-9', 'done']).stderr, /no row APP2X-9 on the 2026-W40 board/);
});

test('a new week carries over every non-done row with its status; ids stay unique across weeks', () => {
  const dir = tmpDir();
  b(dir, '2026-09-30', ['add', '--key', 'APP2X-1', '--title', 'A']).ok();
  b(dir, '2026-09-30', ['add', '--key', 'APP2X-2', '--title', 'B']).ok();
  b(dir, '2026-09-30', ['set', 'APP2X-2', 'done']).ok();
  b(dir, '2026-09-30', ['add', '--title', 'Untracked fix', '--component', 'Chip', '--source', 'RNHost Eng']).ok();
  b(dir, '2026-09-30', ['set', 'b3', 'blocked', '--reason', 'waiting']).ok();
  b(dir, '2026-10-06', ['--offline']).ok();
  assert.deepEqual(week(dir, '2026-W41').rows.map((r) => [r.id, r.status]), [['b1', 'todo'], ['b3', 'blocked']]);
  b(dir, '2026-10-06', ['add', '--key', 'APP2X-9', '--title', 'New']).ok();
  assert.equal(week(dir, '2026-W41').rows.at(-1).id, 'b4');
});

test('merged check: done in the week the last PR merged; earlier weeks stay frozen', () => {
  const dir = tmpDir();
  const pr1 = 'https://github.com/o/r/pull/1';
  const pr2 = 'https://github.com/o/r/pull/2';
  b(dir, '2026-09-30', ['add', '--key', 'APP2X-1', '--title', 'A']).ok();
  b(dir, '2026-09-30', ['pr', 'APP2X-1', pr1]).ok();
  b(dir, '2026-09-30', ['add', '--key', 'APP2X-2', '--title', 'B']).ok();
  b(dir, '2026-09-30', ['pr', 'APP2X-2', pr2]).ok();
  const gh = ghStub({
    [pr1]: { state: 'MERGED', mergedAt: '2026-10-03T15:00:00Z' }, // Saturday of W40
    [pr2]: { state: 'MERGED', mergedAt: '2026-10-06T15:00:00Z' }, // Tuesday of W41
  });
  b(dir, '2026-10-06', [], { DCS_GH: gh }).ok();
  const w40 = week(dir, '2026-W40').rows;
  const w41 = week(dir, '2026-W41').rows;
  assert.equal(w40.find((r) => r.key === 'APP2X-1').status, 'done');
  assert.equal(w41.find((r) => r.key === 'APP2X-1'), undefined);
  assert.equal(w41.find((r) => r.key === 'APP2X-2').status, 'done');
  assert.equal(w40.find((r) => r.key === 'APP2X-2').status, 'undergoing_pr');
});

test('merged check waits until every PR of a row is merged', () => {
  const dir = tmpDir();
  const pr1 = 'https://github.com/o/r/pull/1';
  const pr2 = 'https://github.com/o/r2/pull/9';
  b(dir, '2026-09-30', ['add', '--key', 'APP2X-1', '--title', 'A']).ok();
  b(dir, '2026-09-30', ['pr', 'APP2X-1', pr1]).ok();
  b(dir, '2026-09-30', ['pr', 'APP2X-1', pr2]).ok();
  const gh = ghStub({ [pr1]: { state: 'MERGED', mergedAt: '2026-09-30T10:00:00Z' }, [pr2]: { state: 'OPEN', mergedAt: null } });
  b(dir, '2026-09-30', [], { DCS_GH: gh }).ok();
  assert.equal(week(dir, '2026-W40').rows[0].status, 'undergoing_pr');
  assert.deepEqual(week(dir, '2026-W40').rows[0].repos, ['r', 'r2']);
});

test('gh failures leave statuses unchanged and print a warning', () => {
  const dir = tmpDir();
  b(dir, '2026-09-30', ['add', '--key', 'APP2X-1', '--title', 'A']).ok();
  b(dir, '2026-09-30', ['pr', 'APP2X-1', 'https://github.com/o/r/pull/1']).ok();
  const r = b(dir, '2026-09-30', [], { DCS_GH: ghStub({}) }).ok();
  assert.match(r.stderr, /merged check skipped for APP2X-1: gh: offline/);
  assert.equal(week(dir, '2026-W40').rows[0].status, 'undergoing_pr');
});

test('the report follows the saved weekly format', () => {
  const data = {
    week: '2026-W40',
    rows: [
      row('b1', 'APP2X-1080', 'Carousel', 'Stack mode', 'in_progress'),
      row('b2', 'APP2X-1075', 'Header', 'iOS header', 'undergoing_pr'),
      row('b3', 'APP2X-980', 'Tag', 'Skeleton', 'done'),
      row('b4', 'APP2X-990', 'Avatar', 'Fallback', 'blocked', { reason: 'waiting on RNHost 2.4' }),
      row('b5', 'APP2X-999', 'Card', 'Later', 'todo'),
      row('b6', null, 'Carousel', 'added alignEdgeItems', 'done', { source: 'RNHost Eng' }),
      row('b7', null, 'Chip', 'wip fix', 'in_progress', { source: 'RNHost Eng' }),
      row('b8', null, 'CI', 'Bitrise heap bump', 'done'),
    ],
  };
  const { text, missing } = board.renderReport(data);
  assert.deepEqual(missing, []);
  assert.equal(
    text,
    [
      'APP2X-980 — Tag | Skeleton',
      'APP2X-1075 — Header | iOS header (Undergoing PR)',
      'APP2X-1080 — Carousel | Stack mode (In progress)',
      'APP2X-990 — Avatar | Fallback (Blocked: waiting on RNHost 2.4)',
      '',
      'Other shipped work (no ticket - issues pointed out by RNHost Eng):',
      'Carousel — added alignEdgeItems',
    ].join('\n'),
  );
});

test('dcs board --report exits 3 and names rows missing a component; edit fixes them', () => {
  const dir = tmpDir();
  b(dir, '2026-09-30', ['add', '--key', 'APP2X-1', '--title', 'A']).ok();
  b(dir, '2026-09-30', ['set', 'APP2X-1', 'in_progress']).ok();
  const r = b(dir, '2026-09-30', ['--report', '--offline']);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /missing component\/title for: APP2X-1/);
  b(dir, '2026-09-30', ['edit', 'APP2X-1', '--component', 'Tag']).ok();
  assert.equal(b(dir, '2026-09-30', ['--report', '--offline']).ok().stdout.trim(), 'APP2X-1 — Tag | A (In progress)');
});

test('concurrent writers never lose a row', async () => {
  const dir = tmpDir();
  const codes = await Promise.all(
    Array.from({ length: 6 }, (_, i) => new Promise((resolve) => {
      const child = spawn(process.execPath, [BIN, 'board', 'add', '--key', `APP2X-${i + 1}`, '--title', `T${i}`], {
        env: { ...process.env, ...env(dir, '2026-09-30') },
      });
      child.on('exit', resolve);
    })),
  );
  assert.deepEqual(codes, [0, 0, 0, 0, 0, 0]);
  assert.equal(week(dir, '2026-W40').rows.length, 6);
  assert.equal(new Set(week(dir, '2026-W40').rows.map((r) => r.id)).size, 6);
});

test('dcs start moves the ticket row to in progress, and warns when the key has no row', () => {
  const boardDirPath = tmpDir();
  const dir = tmpRepo();
  const input = [{ title: 'A', ac: ['x'], ui: false, jira: 'APP2X-1' }, { title: 'B', ac: ['x'], ui: false, jira: 'APP2X-2' }];
  dcs(['add'], { cwd: dir, input: JSON.stringify(input) }).ok();
  b(boardDirPath, '2026-09-30', ['add', '--key', 'APP2X-1', '--title', 'A']).ok();
  dcs(['start', 't1'], { cwd: dir, env: env(boardDirPath, '2026-09-30') }).ok();
  assert.equal(week(boardDirPath, '2026-W40').rows[0].status, 'in_progress');
  const r = dcs(['start', 't2'], { cwd: dir, env: env(boardDirPath, '2026-09-30') }).ok();
  assert.match(r.stderr, /no board row for APP2X-2/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/board.test.js`
Expected: FAIL with `Cannot find module '../dcs/lib/board'`.

- [ ] **Step 3: Implement `dcs/lib/board.js`**

```js
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DcsError, readJson, writeJsonAtomic, withLock } = require('./store');

const STATUSES = ['todo', 'in_progress', 'undergoing_pr', 'done', 'blocked'];
const LABELS = { todo: 'To do', in_progress: 'In progress', undergoing_pr: 'Undergoing PR', done: 'Done', blocked: 'Blocked' };
const REPORT_ORDER = ['done', 'undergoing_pr', 'in_progress', 'blocked'];
const KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;
const PR_RE = /^https:\/\/github\.com\/[^/\s]+\/([^/\s]+)\/pull\/\d+$/;

const need = (cond, msg) => {
  if (!cond) throw new DcsError(msg);
};

const boardDir = () => process.env.DCS_BOARD_DIR || path.join(os.homedir(), '.dcs', 'board');

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3); // Thursday of this week
  const year = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3);
  const week = 1 + Math.round((d - firstThursday) / (7 * 864e5));
  return `${year}-W${String(week).padStart(2, '0')}`;
}

const weekFile = (dir, week) => path.join(dir, `${week}.json`);
const loadWeek = (dir, week) => readJson(weekFile(dir, week), null);

function listWeeks(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^\d{4}-W\d{2}\.json$/.test(f)).map((f) => f.slice(0, -5)).sort();
}

function ensureWeek(dir, week) {
  const existing = loadWeek(dir, week);
  if (existing) return existing;
  const prev = listWeeks(dir).filter((w) => w < week).pop();
  const rows = prev ? loadWeek(dir, prev).rows.filter((r) => r.status !== 'done') : [];
  return { version: 1, week, rows: structuredClone(rows) };
}

const cell = (v) => String(v === null || v === undefined ? '' : v).replace(/\|/g, '\\|').replace(/\n/g, ' ');

function renderMarkdown(data) {
  const lines = [`# Board ${data.week}`, '', '| ID | Key | Component | Title | Status | Repos | PRs | Note |', '|---|---|---|---|---|---|---|---|'];
  for (const r of data.rows) {
    const note = r.status === 'blocked' ? r.reason : r.source;
    lines.push(`| ${[r.id, r.key || '—', r.component, r.title, LABELS[r.status], r.repos.join(', '), r.prs.join(' '), note].map(cell).join(' | ')} |`);
  }
  return `${lines.join('\n')}\n`;
}

function saveWeek(dir, data) {
  writeJsonAtomic(weekFile(dir, data.week), data);
  fs.writeFileSync(path.join(dir, `${data.week}.md`), renderMarkdown(data));
}

const withBoardLock = (dir, fn) => withLock(path.join(dir, '.lock'), fn);

function mutateWeek(dir, week, fn) {
  return withBoardLock(dir, () => {
    const data = ensureWeek(dir, week);
    const result = fn(data);
    saveWeek(dir, data);
    return result;
  });
}

function nextId(dir, data) {
  const all = [data, ...listWeeks(dir).map((w) => loadWeek(dir, w))];
  return `b${Math.max(0, ...all.flatMap((d) => d.rows.map((r) => Number(r.id.slice(1))))) + 1}`;
}

function findRow(data, ref) {
  const r = data.rows.find((x) => x.key === ref || x.id === ref);
  need(r, `no row ${ref} on the ${data.week} board`);
  return r;
}

function setRowStatus(r, status, at, { reason, mergedAt } = {}) {
  r.status = status;
  r.reason = status === 'blocked' ? reason : null;
  r.history.push({ at, status, ...(mergedAt ? { mergedAt } : {}) });
}

function addRow(dir, data, { title, key = null, component = null, repo = null, source = null }, at) {
  need(typeof title === 'string' && title.trim(), 'board add needs --title');
  if (key !== null) {
    need(KEY_RE.test(key), `invalid key: ${key} (expected like APP2X-123)`);
    need(!data.rows.some((r) => r.key === key), `${key} is already on the ${data.week} board`);
    need(source === null, '--source is only for untracked rows (no --key)');
  }
  const r = {
    id: nextId(dir, data), key, component, title: title.trim(), status: 'todo',
    repos: repo ? [repo] : [], prs: [], source, reason: null, history: [{ at, status: 'todo' }],
  };
  data.rows.push(r);
  return r;
}

function setStatus(data, ref, status, reason, at) {
  need(STATUSES.includes(status), `status must be one of ${STATUSES.join(', ')}`);
  need(status !== 'blocked' || (reason && reason.trim()), 'blocked needs --reason');
  const r = findRow(data, ref);
  setRowStatus(r, status, at, { reason: reason && reason.trim() });
  return r;
}

function attachPr(data, ref, url, repoName, at) {
  const m = PR_RE.exec(url || '');
  need(m, `not a GitHub PR URL: ${url}`);
  const r = findRow(data, ref);
  if (!r.prs.includes(url)) r.prs.push(url);
  const name = repoName || m[1];
  if (!r.repos.includes(name)) r.repos.push(name);
  setRowStatus(r, 'undergoing_pr', at);
  return r;
}

function editRow(data, ref, { title, component, source }) {
  const r = findRow(data, ref);
  if (title !== undefined) {
    need(title.trim(), '--title cannot be empty');
    r.title = title.trim();
  }
  if (component !== undefined) r.component = component.trim() || null;
  if (source !== undefined) {
    need(r.key === null, '--source is only for untracked rows');
    r.source = source.trim() || null;
  }
  return r;
}

function touchInProgress(dir, week, key, at) {
  return mutateWeek(dir, week, (data) => {
    const r = data.rows.find((x) => x.key === key);
    if (!r) return `no board row for ${key}; add one with: dcs board add --key ${key} --component <c> --title <t>`;
    if (r.status === 'todo' || r.status === 'blocked') setRowStatus(r, 'in_progress', at);
    return null;
  });
}

function ghView(url) {
  const r = spawnSync(process.env.DCS_GH || 'gh', ['pr', 'view', url, '--json', 'state,mergedAt'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new Error(((r.stderr || '').trim() || (r.error && r.error.message) || 'gh failed'));
  return JSON.parse(r.stdout);
}

function mergedCheck(dir, week, view, at) {
  const warnings = [];
  withBoardLock(dir, () => {
    const cur = ensureWeek(dir, week);
    for (const r of cur.rows.filter((x) => x.status === 'undergoing_pr' && x.prs.length)) {
      let states;
      try {
        states = r.prs.map(view);
      } catch (e) {
        warnings.push(`merged check skipped for ${r.key || r.id}: ${e.message}`);
        continue;
      }
      if (!states.every((s) => s.state === 'MERGED')) continue;
      const mergedAt = states.map((s) => s.mergedAt).sort().pop();
      const doneWeek = isoWeek(new Date(mergedAt));
      setRowStatus(r, 'done', at, { mergedAt });
      if (doneWeek < week) {
        const target = loadWeek(dir, doneWeek) || { version: 1, week: doneWeek, rows: [] };
        target.rows = [...target.rows.filter((x) => x.id !== r.id), structuredClone(r)];
        saveWeek(dir, target);
        for (const w of listWeeks(dir).filter((x) => x > doneWeek && x < week)) {
          const d = loadWeek(dir, w);
          d.rows = d.rows.filter((x) => x.id !== r.id);
          saveWeek(dir, d);
        }
        cur.rows = cur.rows.filter((x) => x.id !== r.id);
      }
    }
    saveWeek(dir, cur);
  });
  return warnings;
}

const SUFFIX = { done: () => '', undergoing_pr: () => ' (Undergoing PR)', in_progress: () => ' (In progress)', blocked: (r) => ` (Blocked: ${r.reason})` };

function sortForReport(rows) {
  return [...rows].sort(
    (a, b) => REPORT_ORDER.indexOf(a.status) - REPORT_ORDER.indexOf(b.status) ||
      (a.key || a.id).localeCompare(b.key || b.id, undefined, { numeric: true }),
  );
}

function renderReport(data) {
  const missing = [];
  const check = (r) => {
    if (!r.component || !r.title) missing.push(r.key || r.id);
  };
  const ticketed = sortForReport(data.rows.filter((r) => r.key && REPORT_ORDER.includes(r.status)));
  ticketed.forEach(check);
  const lines = ticketed.map((r) => `${r.key} — ${r.component} | ${r.title}${SUFFIX[r.status](r)}`);
  const feedback = data.rows.filter((r) => !r.key && r.source && r.status === 'done');
  for (const source of [...new Set(feedback.map((r) => r.source))].sort()) {
    const rows = sortForReport(feedback.filter((r) => r.source === source));
    rows.forEach(check);
    lines.push('', `Other shipped work (no ticket - issues pointed out by ${source}):`, ...rows.map((r) => `${r.component} — ${r.title}`));
  }
  return { text: lines.join('\n').replace(/^\n/, ''), missing };
}

module.exports = {
  STATUSES, boardDir, isoWeek, loadWeek, listWeeks, mutateWeek, addRow, setStatus, attachPr, editRow,
  touchInProgress, ghView, mergedCheck, renderMarkdown, renderReport,
};
```

- [ ] **Step 4: Wire the board into the CLI**

In `dcs/bin/dcs`, below `const tasks = require('../lib/tasks');`, add:
```js
const board = require('../lib/board');
```

In `commands.start`, replace the line `// ---- board touch (Task 6) ----` with:
```js
    if (t.jira) {
      const warning = board.touchInProgress(board.boardDir(), board.isoWeek(now()), t.jira, iso());
      if (warning) process.stderr.write(`dcs: ${warning}\n`);
    }
```

Inside `commands`, add:
```js
  board(argv) {
    const dir = board.boardDir();
    const week = board.isoWeek(now());
    const [sub, ...rest] = argv;
    const parse = (options) => parseArgs({ args: rest, options, allowPositionals: true });
    if (sub === 'add') {
      const { values } = parse({ title: { type: 'string' }, key: { type: 'string' }, component: { type: 'string' }, repo: { type: 'string' }, source: { type: 'string' } });
      const r = board.mutateWeek(dir, week, (data) => board.addRow(dir, data, values, iso()));
      return out(`${r.id} added to ${week}`);
    }
    if (sub === 'set') {
      const { values, positionals } = parse({ reason: { type: 'string' } });
      board.mutateWeek(dir, week, (data) => board.setStatus(data, positionals[0], positionals[1], values.reason, iso()));
      return out(`${positionals[0]} -> ${positionals[1]}`);
    }
    if (sub === 'pr') {
      const { positionals } = parse({});
      let repoName = null;
      try {
        repoName = path.basename(repo.paths(process.cwd()).mainRoot);
      } catch {
        // not inside a repo: attachPr falls back to the repo name in the URL
      }
      board.mutateWeek(dir, week, (data) => board.attachPr(data, positionals[0], positionals[1], repoName, iso()));
      return out(`${positionals[0]} -> undergoing_pr`);
    }
    if (sub === 'edit') {
      const { values, positionals } = parse({ title: { type: 'string' }, component: { type: 'string' }, source: { type: 'string' } });
      board.mutateWeek(dir, week, (data) => board.editRow(data, positionals[0], values));
      return out(`${positionals[0]} updated`);
    }
    const { values } = parseArgs({ args: argv, options: { week: { type: 'string' }, json: { type: 'boolean' }, offline: { type: 'boolean' }, report: { type: 'boolean' } } });
    const target = values.week || week;
    if (!/^\d{4}-W\d{2}$/.test(target)) throw new DcsError(`--week must look like 2026-W40, got ${target}`);
    let warnings = [];
    if (values.offline) board.mutateWeek(dir, week, () => null);
    else warnings = board.mergedCheck(dir, week, board.ghView, iso());
    for (const w of warnings) process.stderr.write(`dcs: ${w}\n`);
    const data = board.loadWeek(dir, target) || { version: 1, week: target, rows: [] };
    if (values.report) {
      const { text, missing } = board.renderReport(data);
      out(text);
      if (missing.length) {
        process.stderr.write(`dcs: missing component/title for: ${missing.join(', ')}\n`);
        process.exitCode = 3;
      }
      return;
    }
    out(values.json ? data : board.renderMarkdown(data).trimEnd());
  },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/`
Expected: PASS (all suites; board 11).

- [ ] **Step 6: Commit (after Navin's yes)**

```bash
git add dcs test
git diff --cached --stat
git commit -m "feat(board): weekly cross-project board with carry-over, merged check and report"
```

---

### Task 7: Guardrails: `dcs guard` + hooks.json

**Files:**
- Create: `dcs/lib/guard.js`
- Create: `dcs/hooks/hooks.json`
- Modify: `dcs/bin/dcs` (import `guard`; helper `guardContext`; command `guard`)
- Test: `test/guard.test.js`

**Interfaces:**
- Consumes: `repo.paths`, `repo.currentBranch`, `store.readJson`.
- Produces: `guard.evaluate(input, ctx) → null | {decision: 'deny'|'ask', reason}`, where `input` is the PreToolUse payload `{tool_name, tool_input, cwd}` and `ctx = {cwd, home, tmpdir, repoRoot, mainRoot, worktreesDir, currentBranch, requireFixesTrailer, approvedKeys: string[], contextError, readFile(path) → string}`. The reason is `dcs <RULE>: <why>` joined with `; `.
- Produces (bin): `dcs guard` reads the payload on stdin. On a match it prints `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": d, "permissionDecisionReason": reason}}`; with no match it prints nothing. Any exception → stderr + exit 2 (fail closed).

- [ ] **Step 1: Write the failing tests**

`test/guard.test.js`:
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { evaluate } = require('../dcs/lib/guard');
const { dcs, tmpRepo, baseSettings } = require('./helpers');

const HOME = '/Users/me';
const base = {
  cwd: '/work/app', home: HOME, tmpdir: '/private/var/folders/xx/T', repoRoot: '/work/app', mainRoot: '/work/app',
  worktreesDir: '/work/app.dcs-worktrees', currentBranch: 'feat/x', requireFixesTrailer: false, approvedKeys: [],
  contextError: null, readFile: () => '',
};
const bash = (command, ctx = {}) => evaluate({ tool_name: 'Bash', tool_input: { command } }, { ...base, ...ctx });
const use = (tool_name, tool_input, ctx = {}) => evaluate({ tool_name, tool_input }, { ...base, ...ctx });
const is = (res, decision, rule) => {
  assert.ok(res, `expected ${decision} ${rule}, got no decision`);
  assert.equal(res.decision, decision, res.reason);
  assert.match(res.reason, new RegExp(`dcs ${rule}:`));
};
const none = (res) => assert.equal(res, null, res && res.reason);
const onlyAsk = (res, rule) => {
  is(res, 'ask', rule);
  assert.doesNotMatch(res.reason, /;/, `expected only ${rule}: ${res.reason}`);
};

test('G1 asks on every git commit; unrelated git commands pass', () => {
  onlyAsk(bash('git commit -m "feat: x"'), 'G1');
  onlyAsk(bash('git -C /work/app commit -m "feat: x"'), 'G1');
  none(bash('git log --oneline -5'));
});

test('G2 denies Co-Authored-By anywhere in the message', () => {
  is(bash('git commit -m "feat: x" -m "Co-Authored-By: Bot <b@x.io>"'), 'deny', 'G2');
  is(bash("git commit -F - <<'EOF'\nfeat: x\n\nco-authored-by: Bot <b@x.io>\nEOF"), 'deny', 'G2');
  onlyAsk(bash('git commit -m "docs: credit the co-author later"'), 'G1');
});

test('G3 enforces Fixes trailers from settings and from approved task keys', () => {
  is(bash('git commit -m "fix: x"', { requireFixesTrailer: true }), 'deny', 'G3');
  onlyAsk(bash('git commit -m "fix: x" -m "Fixes: APP2X-12"', { requireFixesTrailer: true }), 'G1');
  const keys = { approvedKeys: ['APP2X-1', 'APP2X-2', 'APP2X-3'] };
  onlyAsk(bash('git commit -m "fix: x" -m "Fixes: APP2X-2"', keys), 'G1');
  is(bash('git commit -m "fix: x" -m "Fixes: APP2X-12"', keys), 'deny', 'G3');
  onlyAsk(bash("git commit -F - <<'EOF'\nfeat: x\n\nFixes: APP2X-3\nEOF", keys), 'G1');
  onlyAsk(bash('git commit -F msg.txt', { ...keys, readFile: () => 'feat: x\n\nFixes: APP2X-1\n' }), 'G1');
  onlyAsk(bash('git commit', { requireFixesTrailer: true }), 'G1'); // editor commit: not inspectable
  is(bash('git commit -m "x"', { contextError: 'tasks.json is not valid JSON' }), 'deny', 'G3');
});

test('G4 asks on push; G5 and G6 ask on dcs unblock / approve-spec', () => {
  onlyAsk(bash('git push origin feat/x'), 'G4');
  onlyAsk(bash('dcs unblock t3'), 'G5');
  onlyAsk(bash('node /x/dcs/bin/dcs unblock t3'), 'G5');
  onlyAsk(bash('dcs approve-spec t1'), 'G6');
  none(bash('dcs show t3'));
});

test('D1 denies sudo as a command word only', () => {
  is(bash('sudo rm x'), 'deny', 'D1');
  is(bash('FOO=1 sudo ls'), 'deny', 'D1');
  is(bash('ls && sudo ls'), 'deny', 'D1');
  none(bash('echo "use sudo carefully"'));
});

test('D2 denies force pushes', () => {
  for (const cmd of ['git push --force', 'git push -f origin feat', 'git push --force-with-lease', 'git push -uf origin feat', 'git push origin +feat']) {
    is(bash(cmd), 'deny', 'D2');
  }
  onlyAsk(bash('git push --follow-tags origin feat'), 'G4');
});

test('D3 denies --no-verify on commit and push, not push dry-runs', () => {
  is(bash('git commit --no-verify -m x'), 'deny', 'D3');
  is(bash('git commit -nm x'), 'deny', 'D3');
  is(bash('git push --no-verify origin feat'), 'deny', 'D3');
  onlyAsk(bash('git push -n origin feat'), 'G4');
  onlyAsk(bash('git commit -m "-nothing to see"'), 'G1');
});

test('D4 denies pushes that target main or master', () => {
  is(bash('git push origin main'), 'deny', 'D4');
  is(bash('git push origin HEAD:master'), 'deny', 'D4');
  is(bash('git push', { currentBranch: 'main' }), 'deny', 'D4');
  is(bash('git push -u origin HEAD', { currentBranch: 'master' }), 'deny', 'D4');
  onlyAsk(bash('git push origin feat/main-fix'), 'G4');
  onlyAsk(bash('git push -u origin HEAD'), 'G4');
});

test('D5 asks on destructive commands; safe variants pass', () => {
  for (const cmd of ['rm -rf node_modules', 'rm -R build', 'rm --recursive x', 'git reset --hard HEAD~1', 'git clean -fd', 'git checkout -- .', 'git checkout .', 'git restore .', 'git branch -D old']) {
    is(bash(cmd), 'ask', 'D5');
  }
  for (const cmd of ['rm file.txt', 'rm -f file.txt', 'git reset --soft HEAD~1', 'git clean -n', 'git branch -d merged', 'git checkout feat']) {
    none(bash(cmd));
  }
});

test('S1 denies protected files in tools and in commands', () => {
  for (const p of ['.env', 'app/.env.local', `${HOME}/.ssh/id_ed25519`, 'certs/server.pem', 'android/release.jks', '.npmrc']) {
    is(use('Read', { file_path: p }), 'deny', 'S1');
  }
  none(use('Read', { file_path: '.env.example' }));
  none(use('Read', { file_path: 'src/.envrc' }));
  is(use('Write', { file_path: '/work/app/.env', content: 'A=1' }), 'deny', 'S1');
  is(bash('cat ~/.aws/credentials'), 'deny', 'S1');
  is(bash('cp .env.example .env'), 'deny', 'S1');
  is(bash(`node -e "require('fs').readFileSync('.env')"`), 'deny', 'S1');
  none(bash('cat .env.example'));
});

test('S2 denies credential-looking content; Google API keys are allowed', () => {
  is(use('Write', { file_path: '/work/app/a.ts', content: `const t = "ghp_${'a'.repeat(36)}";` }), 'deny', 'S2');
  is(use('Edit', { file_path: '/work/app/a.ts', old_string: 'x', new_string: '-----BEGIN RSA PRIVATE KEY-----' }), 'deny', 'S2');
  is(use('MultiEdit', { file_path: '/work/app/a.ts', edits: [{ old_string: 'x', new_string: 'AKIAABCDEFGHIJKLMNOP' }] }), 'deny', 'S2');
  none(use('Write', { file_path: '/work/app/firebase.json', content: `{"apiKey": "AIza${'b'.repeat(35)}"}` }));
});

test('C1 asks before writing outside the repo, its worktrees, temp dirs and memory', () => {
  for (const p of ['/work/other/x.ts', '../sibling/x.ts', `${HOME}/.claude/settings.json`]) {
    is(use('Write', { file_path: p, content: 'x' }), 'ask', 'C1');
  }
  for (const p of ['/work/app/src/x.ts', 'src/y.ts', '/work/app.dcs-worktrees/t1/src/x.ts', '/private/var/folders/xx/T/f.json', '/tmp/x', `${HOME}/.claude/projects/p/memory/m.md`]) {
    none(use('Write', { file_path: p, content: 'x' }));
  }
});

test('quoted separators, heredoc bodies and subshells are parsed correctly', () => {
  onlyAsk(bash('git commit -m "fix: a; b && c | d, stop reading .env"'), 'G1');
  onlyAsk(bash("git commit -F - <<'EOF'\nfix: x\n\nrm -rf / ; sudo reboot\nEOF"), 'G1');
  is(bash('git status && git push --force'), 'deny', 'D2');
  is(bash('echo $(git push --force)'), 'deny', 'D2');
});

test('deny wins over ask; odd payloads never crash', () => {
  is(bash('git commit --no-verify -m x'), 'deny', 'D3');
  none(evaluate({ tool_name: 'Bash', tool_input: {} }, base));
  none(evaluate({ tool_name: 'Write', tool_input: {} }, base));
  none(evaluate({ tool_name: 'Glob', tool_input: { pattern: '**/*.env' } }, base));
  none(evaluate({}, base));
});

test('dcs guard (bin): prints a decision, stays silent when allowed, fails closed on bad input', () => {
  const dir = tmpRepo();
  const run = (input) => dcs(['guard'], { cwd: dir, input: typeof input === 'string' ? input : JSON.stringify(input) });
  const denied = run({ tool_name: 'Bash', tool_input: { command: 'sudo ls' }, cwd: dir });
  assert.equal(denied.code, 0);
  assert.equal(denied.json().hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(denied.json().hookSpecificOutput.permissionDecision, 'deny');
  const allowed = run({ tool_name: 'Read', tool_input: { file_path: path.join(dir, 'README.md') }, cwd: dir });
  assert.deepEqual([allowed.code, allowed.stdout], [0, '']);
  const broken = run('not json');
  assert.equal(broken.code, 2);
  assert.match(broken.stderr, /failed closed/);
});

test('dcs guard reads requireFixesTrailer and approved task keys from the repo', () => {
  const dir = tmpRepo({ settings: baseSettings({ requireFixesTrailer: true }) });
  const r = dcs(['guard'], { cwd: dir, input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git commit -m "feat: x"' }, cwd: dir }) });
  const outp = r.json().hookSpecificOutput;
  assert.equal(outp.permissionDecision, 'deny');
  assert.match(outp.permissionDecisionReason, /dcs G3:/);
});

test('hooks.json wires PreToolUse to dcs guard and fails closed when node is missing', () => {
  const plugin = path.join(__dirname, '..', 'dcs');
  const hooks = JSON.parse(fs.readFileSync(path.join(plugin, 'hooks/hooks.json'), 'utf8'));
  const [entry] = hooks.hooks.PreToolUse;
  assert.equal(entry.matcher, 'Bash|Read|Write|Edit|MultiEdit');
  assert.equal(entry.hooks[0].timeout, 3);
  const cmd = entry.hooks[0].command.replace('${CLAUDE_PLUGIN_ROOT}', plugin);
  const r = spawnSync('/bin/sh', ['-c', cmd], { input: '{}', env: { PATH: '/nonexistent' } });
  assert.equal(r.status, 2);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/guard.test.js`
Expected: FAIL with `Cannot find module '../dcs/lib/guard'`.

- [ ] **Step 3: Implement `dcs/lib/guard.js`**

```js
'use strict';
const fs = require('node:fs');
const path = require('node:path');

// ponytail: Bash rules are quote-aware string/token matches, not a shell parser (spec §6 known ceilings)
const SECRETS = [
  /ghp_[A-Za-z0-9]{36}/,
  /github_pat_\w{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /xox[bap]-[A-Za-z0-9-]{10,}/,
  /sk-ant-[A-Za-z0-9_-]{20,}/,
];
const WRAPPERS = ['env', 'command', 'nohup', 'time', 'exec'];

function stripHeredocs(cmd) {
  return cmd.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, (m) => m.split('\n')[0]);
}

function segments(cmd) {
  const s = stripHeredocs(cmd);
  const parts = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (c === quote && s[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    const two = s.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      parts.push(cur);
      cur = '';
      i += 1;
      continue;
    }
    const redirect = c === '&' && (s[i - 1] === '>' || s[i + 1] === '>');
    if (!redirect && ';|&\n()`'.includes(c)) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts.map((x) => x.trim()).filter(Boolean);
}

function tokens(seg) {
  const out = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(seg))) out.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  return out;
}

function isProtected(p, home) {
  if (!p) return false;
  const expanded = p.replace(/^~(?=\/|$)/, home).replace(/^\$\{?HOME\}?(?=\/|$)/, home);
  const base = path.basename(expanded);
  if (base === '.env.example') return false;
  if (base === '.env' || base.startsWith('.env.')) return true;
  if (/\.(pem|key|p12|jks|keystore)$/i.test(base)) return true;
  if (base === '.npmrc') return true;
  return /(^|\/)\.(ssh|aws)(\/|$)/.test(expanded);
}

function realish(p) {
  let cur = p;
  const rest = [];
  while (cur !== path.dirname(cur)) {
    try {
      return path.join(fs.realpathSync(cur), ...rest.reverse());
    } catch {
      rest.push(path.basename(cur));
      cur = path.dirname(cur);
    }
  }
  return p;
}

const inside = (p, root) => !!root && (p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep));

function outsideScope(filePath, ctx) {
  const abs = path.resolve(ctx.cwd, filePath.replace(/^~(?=\/)/, ctx.home));
  const candidates = [abs, realish(abs)];
  const projects = path.join(ctx.home, '.claude', 'projects');
  if (candidates.some((p) => inside(p, projects) && /^[^/]+\/memory\//.test(path.relative(projects, p)))) return false;
  const roots = [ctx.repoRoot || ctx.cwd, ctx.mainRoot, ctx.worktreesDir, ctx.tmpdir, '/tmp', '/private/tmp'];
  return !candidates.some((p) => roots.some((r) => inside(p, r)));
}

function gitCall(tk) {
  if (path.basename(tk[0]) !== 'git') return null;
  let i = 1;
  while (i < tk.length && tk[i].startsWith('-')) {
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(tk[i])) i += 1;
    i += 1;
  }
  return { sub: tk[i], args: tk.slice(i + 1), offset: i + 1 };
}

const short = (a, ch) => /^-[a-zA-Z]+$/.test(a) && a.includes(ch);

function commitRules({ args, offset }, raw, ctx, deny, ask, skip) {
  args.forEach((a, i) => {
    if (a === '-m' || a === '--message' || /^-[a-zA-Z]*m$/.test(a)) skip.add(offset + i + 1);
    if (a.startsWith('--message=')) skip.add(offset + i);
  });
  const flags = args.filter((_, i) => !skip.has(offset + i));
  ask('G1', 'git commit needs your approval');
  if (flags.some((a) => a === '--no-verify' || short(a, 'n'))) deny('D3', '--no-verify is not allowed');
  const fi = args.findIndex((a) => a === '-F' || a === '--file');
  const eq = args.find((a) => a.startsWith('--file='));
  const fileArg = fi >= 0 ? args[fi + 1] || null : eq ? eq.slice(7) : null;
  const hasMsg = fileArg !== null || flags.some((a) => a === '-m' || a.startsWith('--message') || short(a, 'm'));
  if (!hasMsg) return; // editor commit: message not inspectable, G1 still asks
  if (ctx.contextError) {
    deny('G3', `dcs files unreadable (${ctx.contextError}); fix them before committing`);
    return;
  }
  const msg = raw + (fileArg && fileArg !== '-' ? `\n${ctx.readFile(fileArg)}` : '');
  if (/co-authored-by/i.test(msg)) deny('G2', 'Co-Authored-By lines are not allowed');
  if (ctx.requireFixesTrailer && !/Fixes:\s*[A-Z][A-Z0-9]+-\d+/.test(msg)) deny('G3', 'this repo requires a "Fixes: <KEY>-<n>" trailer');
  const keys = ctx.approvedKeys || [];
  if (keys.length && !keys.some((k) => new RegExp(`Fixes:\\s*${k}(?!\\d)`).test(msg))) {
    deny('G3', `add a "Fixes: <key>" trailer for one of the approved tasks: ${keys.join(', ')}`);
  }
}

function pushRules({ args }, ctx, deny, ask) {
  ask('G4', 'git push needs your approval');
  if (args.some((a) => a === '--force' || a.startsWith('--force-with-lease') || short(a, 'f'))) deny('D2', 'force push is not allowed; run it yourself if you really need it');
  if (args.includes('--no-verify')) deny('D3', '--no-verify is not allowed');
  const pos = args.filter((a) => !a.startsWith('-'));
  if (pos.slice(1).some((r) => r.startsWith('+'))) deny('D2', 'force push (+refspec) is not allowed');
  const targets = pos.length > 1 ? pos.slice(1).map((r) => r.replace(/^\+/, '').split(':').pop()) : [ctx.currentBranch];
  const resolved = targets.map((t) => String(t === 'HEAD' ? ctx.currentBranch : t || '').replace(/^refs\/heads\//, ''));
  if (resolved.some((t) => t === 'main' || t === 'master')) deny('D4', 'pushing to main/master is not allowed');
}

function bashRules(raw, ctx, deny, ask) {
  for (const seg of segments(raw)) {
    let tk = tokens(seg);
    while (tk.length && (/^[A-Za-z_]\w*=/.test(tk[0]) || WRAPPERS.includes(tk[0]))) tk = tk.slice(1);
    if (!tk.length) continue;
    const head = path.basename(tk[0]);
    const skip = new Set();
    if (head === 'sudo') deny('D1', 'sudo is not allowed');
    if (head === 'rm' && tk.slice(1).some((a) => a === '--recursive' || /^-[a-zA-Z]*[rR]/.test(a))) ask('D5', 'recursive rm deletes files');
    const dcsSub = head === 'dcs' ? tk[1] : head === 'node' && path.basename(tk[1] || '') === 'dcs' ? tk[2] : null;
    if (dcsSub === 'unblock') ask('G5', 'dcs unblock resets the failure cap');
    if (dcsSub === 'approve-spec') ask('G6', 'dcs approve-spec approves a spec');
    const g = gitCall(tk);
    if (g && g.sub === 'commit') commitRules(g, raw, ctx, deny, ask, skip);
    if (g && g.sub === 'push') pushRules(g, ctx, deny, ask);
    if (g && g.sub === 'reset' && g.args.includes('--hard')) ask('D5', 'git reset --hard discards work');
    if (g && g.sub === 'clean' && g.args.some((a) => a === '--force' || short(a, 'f'))) ask('D5', 'git clean -f deletes files');
    if (g && (g.sub === 'checkout' || g.sub === 'restore') && g.args.includes('.')) ask('D5', `git ${g.sub} . discards changes`);
    if (g && g.sub === 'branch' && g.args.some((a) => short(a, 'D'))) ask('D5', 'git branch -D deletes a branch');
    tk.forEach((t, i) => {
      if (!skip.has(i) && t.split(/[=:'"(),;\s]+/).some((p) => isProtected(p, ctx.home))) deny('S1', `command touches a protected file (${t})`);
    });
  }
}

function evaluate(input, ctx) {
  const hits = [];
  const deny = (id, why) => hits.push({ d: 'deny', id, why });
  const ask = (id, why) => hits.push({ d: 'ask', id, why });
  const tool = input && input.tool_name;
  const ti = (input && input.tool_input) || {};
  if (tool === 'Bash' && typeof ti.command === 'string') bashRules(ti.command, ctx, deny, ask);
  if (['Read', 'Write', 'Edit', 'MultiEdit'].includes(tool) && typeof ti.file_path === 'string') {
    if (isProtected(ti.file_path, ctx.home)) deny('S1', `protected file: ${ti.file_path}`);
    if (tool !== 'Read' && outsideScope(ti.file_path, ctx)) ask('C1', `write outside the repo: ${ti.file_path}`);
  }
  if (['Write', 'Edit', 'MultiEdit'].includes(tool)) {
    const text = [ti.content, ti.new_string, ...(Array.isArray(ti.edits) ? ti.edits.map((e) => e && e.new_string) : [])]
      .filter((x) => typeof x === 'string')
      .join('\n');
    if (SECRETS.some((re) => re.test(text))) deny('S2', 'content looks like a credential or token');
  }
  const decision = hits.some((h) => h.d === 'deny') ? 'deny' : hits.length ? 'ask' : null;
  if (!decision) return null;
  const chosen = hits.filter((h) => h.d === decision);
  return { decision, reason: chosen.map((h) => `dcs ${h.id}: ${h.why}`).join('; ') };
}

module.exports = { evaluate };
```

- [ ] **Step 4: Create `dcs/hooks/hooks.json`**

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Read|Write|Edit|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/bin/dcs\" guard || { echo \"dcs guard error: disable the dcs plugin to bypass\" >&2; exit 2; }",
            "timeout": 3
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 5: Wire `guard` into the CLI**

In `dcs/bin/dcs`, below `const board = require('../lib/board');`, add:
```js
const guard = require('../lib/guard');
```

Under the helpers marker, add:
```js
function guardContext(input) {
  const cwd = input.cwd || process.cwd();
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  };
  const ctx = {
    cwd, home: os.homedir(), tmpdir: real(os.tmpdir()), repoRoot: null, mainRoot: null, worktreesDir: null,
    currentBranch: null, requireFixesTrailer: false, approvedKeys: [], contextError: null,
    readFile: (f) => {
      try {
        return fs.readFileSync(path.resolve(cwd, f), 'utf8');
      } catch {
        return '';
      }
    },
  };
  if (input.tool_name === 'Read') return ctx; // S1 needs no repo context
  let P;
  try {
    P = repo.paths(cwd);
  } catch {
    return ctx; // not a git repo: C1 falls back to cwd as the root
  }
  Object.assign(ctx, { repoRoot: P.top, mainRoot: P.mainRoot, worktreesDir: P.worktreesDir });
  try {
    ctx.currentBranch = repo.currentBranch(cwd);
  } catch {
    // unborn HEAD: no branch yet
  }
  try {
    const settings = readJson(P.settingsFile, null);
    ctx.requireFixesTrailer = !!(settings && settings.requireFixesTrailer === true);
    const state = readJson(P.tasksFile, null);
    const approved = ((state && state.tasks) || []).filter((t) => t.status === 'approved' && t.jira);
    ctx.approvedKeys = [...new Set(approved.map((t) => t.jira))];
  } catch (e) {
    ctx.contextError = e.message;
  }
  return ctx;
}
```

Inside `commands`, add:
```js
  guard() {
    try {
      const input = JSON.parse(fs.readFileSync(0, 'utf8'));
      const result = guard.evaluate(input, guardContext(input));
      if (result) {
        out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: result.decision, permissionDecisionReason: result.reason } });
      }
    } catch (e) {
      process.stderr.write(`dcs guard failed closed: ${e.message}\n`);
      process.exit(2);
    }
  },
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/`
Expected: PASS (all suites; guard 17).

- [ ] **Step 7: Commit (after Navin's yes)**

```bash
git add dcs test
git diff --cached --stat
git commit -m "feat(guard): fail-closed PreToolUse guardrails for git, destructive ops, secrets and scope"
```

---

### Task 8: Captain protocol and crew agents

**Files:**
- Create: `dcs/references/captain.md`
- Create: `dcs/agents/worker.md`
- Create: `dcs/agents/reviewer.md`
- Test: `test/plugin.test.js`

**Interfaces:**
- Consumes: every CLI command name from Tasks 2–7 (the test checks each `dcs <command>` a doc mentions against the CLI's usage list).
- Produces: agents `dcs:worker` and `dcs:reviewer`. The reply shapes (`done` / `failed` / `blocked` / `needs_input`, reviewer findings JSON) are used by the skills in Tasks 9–11. `captain.md` is read by the plan, work and review skills via `${CLAUDE_PLUGIN_ROOT}/references/captain.md`.

- [ ] **Step 1: Write the failing tests**

`test/plugin.test.js`:
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { dcs, tmpDir } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const PLUGIN = path.join(ROOT, 'dcs');
const mdFiles = (dir) =>
  fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.md')).map((f) => path.join(dir, f)) : [];

function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return null;
  const lines = m[1].split('\n').filter((l) => /^[\w-]+:/.test(l));
  return Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]));
}

const commandNames = () => /usage: dcs <([^>]+)>/.exec(dcs([], { cwd: tmpDir() }).stderr)[1].split('|');

test('the marketplace and plugin manifests point at the dcs plugin', () => {
  const market = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin/marketplace.json'), 'utf8'));
  assert.equal(market.name, 'dcs-local');
  assert.deepEqual(market.plugins.map((p) => [p.name, p.source]), [['dcs', './dcs']]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(PLUGIN, '.claude-plugin/plugin.json'), 'utf8')).name, 'dcs');
});

test('every skill and agent has name and description frontmatter', () => {
  const files = [...mdFiles(path.join(PLUGIN, 'skills')).filter((f) => f.endsWith('SKILL.md')), ...mdFiles(path.join(PLUGIN, 'agents'))];
  assert.ok(files.length > 0);
  for (const f of files) {
    const fm = frontmatter(fs.readFileSync(f, 'utf8'));
    assert.ok(fm && fm.name && fm.description, `${path.relative(ROOT, f)} needs name and description frontmatter`);
  }
});

test('every dcs command mentioned in the plugin docs exists', () => {
  const known = new Set(commandNames());
  for (const f of mdFiles(PLUGIN)) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of [...text.matchAll(/`dcs ([a-z][a-z-]*)/g), ...text.matchAll(/^\s*dcs ([a-z][a-z-]*)/gm)]) {
      assert.ok(known.has(m[1]), `${path.relative(ROOT, f)} mentions unknown command "dcs ${m[1]}"`);
    }
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/plugin.test.js`
Expected: FAIL on `files.length > 0` (no agents or skills yet).

- [ ] **Step 3: Write `dcs/references/captain.md`**

````markdown
# The Captain

You are the **Captain**: Navin's main session while running `/dcs:plan`, `/dcs:work` or `/dcs:review`. Workers, reviewers and QA are your crew. Only you talk to Navin.

## Rules

1. **Only you talk to Navin.** Mode confirmation, questions, commit and push approvals, blocked tasks and land conflicts all go through you.
2. **Nobody guesses.** When intent, scope, a value or the right reference is unclear, stop and ask. Crew members return `needs_input` instead of guessing:
   `{"status": "needs_input", "questions": [{"question": "...", "why": "what it blocks", "options": ["...", "..."]}]}`
3. **Collect, then ask.** In parallel or breezing mode, wait until every running worker in the wave has replied (finished or `needs_input`), merge identical questions, then ask Navin in one batch with AskUserQuestion (at most 4 questions per call; repeat as needed). In solo mode, ask as soon as a question arrives.
4. **Relay.** Send each answer to the **same** crew member with SendMessage (address it by the `name` you gave it); it resumes with its full context. Never start a fresh agent just to deliver an answer.
5. **Record and carry forward.** After every answer, run `dcs decide <id> --q "<question>" --a "<answer>"`. When Navin rejects a commit and gives a reason, run `dcs decide <id> --q "commit rejected" --a "<reason>"`. Every worker, reviewer and QA dispatch includes the output of `dcs decisions --run`, and crew must not contradict it.
6. **No tie-breaking.** If a reviewer and a worker disagree, or a finding conflicts with a recorded decision, ask Navin.
7. **Only you change task state:** `dcs start`, `dcs review`, `dcs land`, `dcs qa`, `dcs approve-spec`, `dcs done`, `dcs unblock`, `dcs decide`, `dcs run`. Workers only run `dcs verify`.
8. **The CLI is the source of truth.** Never edit `.claude/dcs/*` or `~/.dcs/board/*` by hand. When a `dcs` command refuses, show Navin its message; never work around it.
9. **Guard prompts belong to Navin.** A dcs guard **ask** (commit, push, unblock, approve-spec, destructive commands) is Navin deciding. A **deny** is final: say what was blocked and why, and never retry it in another form.

## Dispatch templates

Fill every `<...>`. Paste JSON outputs verbatim.

### Worker

Agent tool: `subagent_type: "dcs:worker"`, `name: "worker-<id>"`, prompt:

    Task (from `dcs show <id>`):
    <task JSON>

    Working directory: <task.worktree, or the repo root in solo mode>
    Repo rule skills to load first: <settings.repoRules, comma separated, or "none">
    Decisions so far this run (`dcs decisions --run`):
    <JSON>
    [spec / spec-sync only] Spec template: <settings.specs.template>. Contracts: <settings.specs.contracts>.
    [after a review round] Critical/major findings to fix: <findings JSON>
    [after a QA fail] Visual QA findings to fix: <findings JSON>

### Reviewer (one dispatch per required pass, all in parallel)

Agent tool: `subagent_type: "dcs:reviewer"`, `name: "review-<id>-<pass>"`, prompt:

    Pass: <ac | security | performance | quality | a11y>
    Task: <task JSON, including ac and refs>
    Working directory: <task cwd>
    Diff since the task started: <output of `dcs diff <id>`; if longer than ~2000 lines, save it with
      `dcs diff <id> > "$TMPDIR/dcs-<id>.diff"` and give the path instead>
    Verify record: <task.verify JSON>
    Decisions so far this run: <JSON>
    [ac pass only] Repo rule skills to load: <settings.repoRules>
    [spec kinds only] Template: <settings.specs.template>. Contracts: <settings.specs.contracts>.

Record each reply: save its JSON to `$TMPDIR/dcs-<id>-<pass>.json`, then run
`dcs review <id> --pass <pass> --approve --findings "$TMPDIR/dcs-<id>-<pass>.json"`,
or `--changes` instead of `--approve` when any finding is critical or major.

### Visual QA

Dispatch what `settings.visualQa` names: `{"agent": "<name>"}` via the Agent tool (`name: "qa-<id>"`), or `{"skill": "<name>"}` via the Skill tool. Prompt:

    Task: <task JSON>
    Reference: <Figma screenshots fetched via the Figma MCP for each task.figma URL | screenshots Navin supplied: <paths> | none>
    Scope: only the regions and states this task changes (its AC): <task.ac>
    Save screenshots under: $TMPDIR/dcs-qa-<id>/
    Rules: capture the same state and section as the reference; judge sizes in proportion to each
    screenshot's dimensions; every difference defaults to major, minor only if you can justify it as
    rendering noise; verdict "fail" on any blocker or major finding; verdict "invalid" when your
    screenshot shows a different state or section than the reference. With no reference, run your own
    checks and set "referenceDiff": false.
    Reply with exactly:
    {"status": "done", "verdict": "pass" | "fail" | "invalid", "referenceDiff": true | false,
     "screenshots": ["<path>"],
     "findings": [{"severity": "blocker" | "major" | "minor", "location": "<on-screen region>",
                   "difference": "...", "expected": "...", "actual": "..."}]}
````

- [ ] **Step 4: Write `dcs/agents/worker.md`**

````markdown
---
name: worker
description: Implements exactly one dcs task (work, spec or spec-sync) in a given directory and runs dcs verify. Dispatched only by the dcs Captain; not for direct use.
tools: Read, Write, Edit, Bash, Grep, Glob, Skill, mcp__plugin_figma_figma__get_design_context, mcp__plugin_figma_figma__get_screenshot, mcp__plugin_figma_figma__get_metadata
---

You implement **one** dcs task. The Captain gives you the task JSON, a working directory, repo rule skills, and the decisions made so far in this run.

## Rules
- Work only in the given working directory. Start every Bash command with `cd "<working directory>" &&`.
- Load every repo rule skill named in the prompt (Skill tool) before writing code, and follow it.
- **Never guess.** If intent, scope or a value is unclear, or the task conflicts with a decision, stop and reply with only:
  `{"status": "needs_input", "questions": [{"question": "...", "why": "...", "options": ["..."]}]}`
  The Captain sends the answer back to you.
- Never run `git commit`, `git push`, or any `dcs` command other than `dcs verify <id>`. Never edit files under `.claude/dcs/`.
- Stay inside the task's AC: no extra features, no refactors outside it.

## Inputs
- **figma** set: fetch design context and a screenshot for every URL (Figma MCP) before coding. If the Figma tools are missing or fail, stop and reply `{"status": "blocked", "reason": "Figma MCP unavailable: <error>"}`. Never implement from a guess.
- **refs** set: the referenced code **is the spec**. Read it fully and match its behavior, props and states. Any deviation must already be in the AC or the decisions; otherwise reply `needs_input`.
- **kind `spec`**: write or update the file at `specPath` from the template. Fill every template section, follow the contracts, link the task's Figma URLs, and set the template's status field (if it has one) to `Draft`. No code changes.
- **kind `spec-sync`**: compare the spec at `specPath` with the shipped code and the decisions; update props, states and the template's last-updated field to match. If nothing differs, change nothing.
- **Review or QA findings** given: fix exactly those.

## Loop
1. `work` tasks in a repo with a test setup: write a failing test for each AC item first, then implement until it passes.
2. Run `dcs verify <id>` with the Bash tool **timeout set to 600000** (10 minutes).
3. If verify fails, read the tails, fix, and run it again. **At most 3 runs per dispatch.** After a third failed run, stop and report `failed`.

## Reply
Reply with only one of:
- `{"status": "done", "summary": "...", "files": ["..."], "verify": "<status from dcs verify>"}`
- `{"status": "failed", "summary": "...", "files": ["..."], "verify": "<last failing tails>"}`
- the `needs_input` or `blocked` shapes above.
````

- [ ] **Step 5: Write `dcs/agents/reviewer.md`**

````markdown
---
name: reviewer
description: Reviews one dcs task for one pass (ac, security, performance, quality or a11y) and returns findings JSON. Dispatched only by the dcs Captain; not for direct use.
tools: Read, Grep, Glob, Bash, Skill
---

You review **one** dcs task for **one** pass. You never edit files and never change task state.
Bash is for reading only: `dcs diff <id>`, `git log`, `git show`, `git diff`. Nothing else.

## Pass focus
- **ac**: every acceptance criterion is met by the diff; the code is correct (logic errors, missing states, broken edge cases); it follows each repo rule skill named in the prompt (load them with the Skill tool); with `refs`, behavior matches the reference. For `spec` tasks: every template section is filled, it matches the Figma links, and it follows the contracts. For `spec-sync`: the spec matches the shipped code and the decisions.
- **security**: injection, secrets in code, unsafe input handling, insecure storage or transport, permission and auth mistakes.
- **performance**: needless re-renders or recomputation, heavy work on the UI thread, unbounded lists or memory, leaks (listeners, timers, subscriptions).
- **quality**: readability, naming, duplication, dead code, tests that don't test the behavior, an AC item without a test.
- **a11y**: roles, labels, focus and reading order, touch target size, contrast through tokens, Dynamic Type / font scaling. For `spec` tasks: the accessibility section meets the accessibility contract.

## Rules
- Judge only against the AC, `refs`, the repo rule skills and the decisions. Do not invent requirements.
- Never raise a finding that contradicts a recorded decision.
- **critical** or **major** only with concrete evidence (file, line, why it breaks). Style preferences are **minor**.
- If a finding depends on intent you can't determine, reply `needs_input` instead of guessing.

## Reply
Reply with only:
`{"status": "done", "pass": "<pass>", "verdict": "approve" | "changes", "findings": [{"severity": "critical" | "major" | "minor", "file": "...", "line": 0, "issue": "...", "fix": "..."}]}`
`verdict` is `changes` if and only if at least one finding is critical or major.
Or: `{"status": "needs_input", "questions": [{"question": "...", "why": "...", "options": ["..."]}]}`
````

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/`
Expected: PASS (all suites; plugin 3).

- [ ] **Step 7: Commit (after Navin's yes)**

```bash
git add dcs test
git diff --cached --stat
git commit -m "feat(agents): Captain protocol, worker and reviewer agents"
```

---

### Task 9: `/dcs:setup` and `/dcs:plan`

**Files:**
- Create: `dcs/skills/setup/SKILL.md`
- Create: `dcs/skills/plan/SKILL.md`
- Test: `test/plugin.test.js` (the existing tests now also cover these files)

**Interfaces:**
- Consumes: `dcs init`, `dcs check`, `dcs add` (task JSON input with `#n` batch refs), `dcs list`, `dcs board --json --offline`, `dcs board add`, and captain.md.
- Produces: the user-facing commands `/dcs:setup` and `/dcs:plan`.

- [ ] **Step 1: Write `dcs/skills/setup/SKILL.md`**

````markdown
---
name: setup
description: Create or edit the dcs settings for the current repo (verify commands, worktree setup, Fixes trailer, repo rule skills, visual QA, spec files, PR link bases). Use when Navin runs /dcs:setup, or when another dcs command reports missing settings.
---

# /dcs:setup

Write `.claude/dcs/settings.json` with **only values Navin confirmed**. Never guess. A value you couldn't detect is asked about with no default.

## 1. Where
Run `git rev-parse --show-toplevel`. If it's not a git repo, stop and say so. If `.claude/dcs/settings.json` exists, its values are your defaults.

## 2. Detect (read-only)
| setting | where to look |
|---|---|
| `base` | `git symbolic-ref --short refs/remotes/origin/HEAD` (drop `origin/`) |
| `verify` | `package.json` scripts (typecheck, test, lint), `./gradlew` tasks, `xcodebuild` / `swift test`, and the commands CI runs (`bitrise.yml`, `Jenkinsfile`, `.github/workflows/*`) |
| `worktreeSetup` | lockfiles: `package-lock.json` → `npm ci`; `pnpm-lock.yaml` → `pnpm install --frozen-lockfile`; `yarn.lock` → `yarn install --frozen-lockfile`; `Podfile.lock` → `pod install` (run in its folder) |
| `requireFixesTrailer` | `git log -30 --format=%B`: are `Fixes: <KEY>` lines the norm? |
| `repoRules` | `.claude/skills/*/SKILL.md`: names and one-line descriptions |
| `visualQa` | `.claude/agents/*.md` and `.claude/skills/*` about visual QA |
| `specs` | a folder of `*.spec.md` files plus a template and contract docs (e.g. `specs/components`, `specs/templates/*.template.md`, `specs/contracts/*.md`) |
| `pr.githubTreeBase` | `git remote get-url origin` → `https://github.com/<owner>/<repo>/tree/` |
| `pr.jiraBase`, `pr.figmaFile`, `pr.titleFormat` | recent PRs (`gh pr list --state merged --limit 5 --json title,body`), repo docs, `.claude/skills` |

## 3. Confirm one at a time
Use AskUserQuestion for each setting, in this order: base, verify, worktreeSetup, requireFixesTrailer, repoRules, visualQa, specs, pr.githubTreeBase, pr.jiraBase, pr.figmaFile, pr.titleFormat.
- Say in one line what the setting controls. Put the detected value first, with "Other" available for edits.
- `verify`: each command must finish within **10 minutes** (the Bash tool limit). Prefer scoped commands to a whole-monorepo run.
- `repoRules`: multi-select from the repo's skills.

## 4. Write
Show the final JSON and get a last yes. Then:
```bash
dcs init <<'EOF'
<confirmed JSON>
EOF
```
If `dcs init` refuses, show its message and fix only the value it names, with Navin.

## 5. Report
Say that settings are written, and that `.claude/dcs/` is excluded from git locally (`.git/info/exclude`), so nothing is committed. Next step: `/dcs:plan`.

## Shape
```json
{
  "base": "main",
  "verify": ["npm run typecheck", "npm test"],
  "worktreeSetup": ["npm ci"],
  "requireFixesTrailer": true,
  "repoRules": ["component-patterns", "accessibility"],
  "visualQa": {"agent": "visual-qa"},
  "specs": {"dir": "specs/components", "template": "specs/templates/component-spec.template.md", "contracts": ["specs/contracts/accessibility.md"]},
  "pr": {"githubTreeBase": "https://github.com/<owner>/<repo>/tree/", "jiraBase": "https://jira.rccl.com/browse/", "figmaFile": {"name": "<file name>", "key": "<file key>"}, "titleFormat": "<TICKET> | DS | <Area> | <Feature>"}
}
```
`visualQa` may also be `{"skill": "dcs:visual-qa"}` or `false`; `specs` may be `false`.
````

- [ ] **Step 2: Write `dcs/skills/plan/SKILL.md`**

````markdown
---
name: plan
description: Turn a request (optional Jira key, Figma URLs, acceptance criteria) into approved dcs tasks. Use when Navin runs /dcs:plan or asks to plan work with dcs.
argument-hint: "<what to build> [APP2X-123] [figma URL]"
---

# /dcs:plan

First read `${CLAUDE_PLUGIN_ROOT}/references/captain.md`. You are the Captain.

## Steps
1. **Preconditions.** Run `dcs check`. If there are no settings, stop and suggest `/dcs:setup`. Read `.claude/dcs/settings.json`.
2. **Inputs.** Collect Navin's description, Jira key(s), Figma URL(s) and any pasted AC. Never infer a Jira key or a Figma node.
3. **Look before proposing.** Search the repo for existing components, utilities and tests that already cover part of the request, and say what you found.
4. **Clarify one question at a time** (AskUserQuestion) until purpose, AC and scope are unambiguous.
5. **Draft the tasks** and show them as a table: `# | kind | title | ui | depends | jira | figma | refs | AC`.
   - **Skeleton first.** Split UI work into small ordered tasks: skeleton, then sections, then states (loading, error, empty…). Each depends on the previous one.
   - **Short titles**, at most 6 words. Detail goes in the AC.
   - **Testable AC** ("renders X when Y"), never vague ("looks good").
   - **Repo spec files** (only when `settings.specs` is set): for each component touched, look for `<specs.dir>/<Name>.spec.md`.
     - If the work creates the component or changes its documented API, states or visuals, add a `spec` task **first** (`specPath` is that file, created from `specs.template` or updated). Make the component's work tasks depend on it, and add a closing `spec-sync` task that depends on all of them.
     - Otherwise, add the existing spec to each work task's `refs`.
     - If you're unsure whether documented behavior changes, ask Navin.
   - **Reference as spec.** When the work ports or mirrors existing code (e.g. RN → SwiftUI or Compose), put that code in `refs` instead of restating it. Confirm the reference with Navin; never pick one silently.
6. **Board rows.** Run `dcs board --json --offline`. For each Jira key without a row this week, ask Navin for the **Component** and **Title** exactly as they should read in the weekly report.
7. **Approval.** Ask Navin to approve the table and the board rows, and revise until approved. Nothing is written before approval.
8. **Write.**
   ```bash
   dcs add <<'EOF'
   [{"title": "...", "ac": ["..."], "ui": true}, {"title": "...", "ac": ["..."], "ui": true, "depends": ["#1"]}]
   EOF
   ```
   For each new key: `dcs board add --key <KEY> --component "<Component>" --title "<Title>" --repo <repo directory name>`.
   If `dcs add` refuses, show its message and fix the tasks with Navin.
9. **Report** the new ids (`dcs list`) and suggest `/dcs:work`.

## Task JSON (input to `dcs add`)
| field | required | value |
|---|---|---|
| `title` | yes | at most 6 words |
| `ac` | yes | array of testable statements |
| `ui` | yes for `work` | `true` when anything visible changes |
| `kind` | no | `work` (default), `spec`, `spec-sync` |
| `jira` | no | `APP2X-123`, or omit |
| `figma` | no | array of figma.com URLs |
| `refs` | no | array of repo-relative paths that exist |
| `depends` | no | existing ids (`t4`) or `#n` for the n-th task in this batch |
| `specPath` | spec kinds only | `<specs.dir>/<Name>.spec.md` |
````

- [ ] **Step 3: Run the tests to verify they pass**

Run: `node --test test/`
Expected: PASS (all suites).

- [ ] **Step 4: Commit (after Navin's yes)**

```bash
git add dcs
git diff --cached --stat
git commit -m "feat(skills): /dcs:setup and /dcs:plan"
```

---

### Task 10: `/dcs:work` and `/dcs:review`

**Files:**
- Create: `dcs/skills/work/SKILL.md`
- Create: `dcs/skills/review/SKILL.md`
- Test: `test/plugin.test.js` (existing tests cover them)

**Interfaces:**
- Consumes: every Task 3–7 command, the Task 8 agents, and the captain.md templates.
- Produces: the user-facing commands `/dcs:work` and `/dcs:review`.

- [ ] **Step 1: Write `dcs/skills/work/SKILL.md`**

````markdown
---
name: work
description: Run approved dcs tasks through worker, reviewers, landing, visual QA and commit, with the main session as Captain. Use when Navin runs /dcs:work.
argument-hint: "[all | t1 t2 ...] [--solo | --parallel | --breezing]"
---

# /dcs:work

First read `${CLAUDE_PLUGIN_ROOT}/references/captain.md`. You are the Captain; follow it exactly.

## 0. Start
1. Run `dcs check`. If there are no settings, stop and suggest `/dcs:setup`. Read `.claude/dcs/settings.json`.
2. Pick the tasks: the ids given, or `dcs next --n 99 --json` for `all` or no argument. If none are ready, show `dcs list` and stop.
3. Pick the mode: `--solo`, `--parallel` or `--breezing` if given. Otherwise 1 ready task → solo, 2–3 → parallel, 4+ → breezing.
4. Show Navin the mode and the task list (id, kind, title), and get **one** confirmation (AskUserQuestion).
5. Run `dcs run`.

## 1. Waves
- **Solo:** one task, in the repo root, no worktree.
- **Parallel:** one wave of up to 3 ready tasks, each started with `dcs start <id> --worktree`. After the wave, stop and report.
- **Breezing:** repeat waves of up to 3 (`dcs next --n 3 --json`) until nothing is ready. Stop early on any `blocked` task or `land` conflict.

## 2. Per task
Steps a–c run concurrently across the wave.

a. **Start:** `dcs start <id>` (with `--worktree` in parallel or breezing). A refusal (dirty checkout, unfinished dependencies) → tell Navin and stop.
b. **Worker:** dispatch `dcs:worker` with the Worker template (all of the wave's workers in one message, `run_in_background: true`).
   - `needs_input` → collect and ask per captain.md rules 3–5, then SendMessage the answer to `worker-<id>`.
   - `blocked` (e.g. Figma MCP unavailable) → tell Navin and stop that task.
   - `failed` → run `dcs show <id>`. If `blocked`, go to **Blocked**. Otherwise SendMessage the verify tails to the same worker to try again (each 3 failed verifies count against the cap).
c. **Review:** when `dcs show <id>` is `verified`, dispatch one `dcs:reviewer` per required pass **in parallel**, using the Reviewer template. The passes are: work → ac, security, performance, quality, plus a11y when `ui`; spec → ac, a11y; spec-sync → ac. Record each with `dcs review`.
   - Status `doing` after the round → SendMessage the critical and major findings to `worker-<id>`; it fixes them and re-verifies; review again.
   - A worker and a reviewer disagree, or a finding contradicts a decision → ask Navin.

Steps d–f run **one task at a time**, in id order, after that task's review approves.

d. **Land** (worktree tasks): `dcs land <id>`. On a conflict the checkout is restored; tell Navin and stop.
e. **Visual QA** (when `ui` is true and `settings.visualQa` is not false): dispatch with the Visual QA template.
   - Reply missing `verdict`, or findings without `severity` or `location` → ask it to re-report once. Still incomplete → ask Navin.
   - `invalid` → `dcs qa <id> --invalid --evidence <screenshots>`, then recapture. When dcs refuses a third invalid capture, ask Navin.
   - `fail` → save the findings to `$TMPDIR/dcs-qa-<id>.json`, run `dcs qa <id> --fail --evidence <screenshots> --findings "$TMPDIR/dcs-qa-<id>.json"`, then dispatch a new `dcs:worker` in the repo root with those findings. Then verify, review and QA again.
   - `pass` → `dcs qa <id> --pass --evidence <screenshots>`.
f. **Commit** (you, in the repo root):
   1. `git add -A`, then show Navin `git diff --cached --stat`.
   2. Write the message as `<type>(<scope>): <summary>` in the style of `git log -10 --oneline`, with an optional body. **ASCII only**, since some repos' commit-msg hooks reject anything else. The last line is `Fixes: <KEY>` when the task has `jira` or `settings.requireFixesTrailer` is true; if the task has no key, ask Navin for it. **Never** add Co-Authored-By.
   3. Commit with a heredoc: `git commit -F - <<'EOF'` … `EOF`. The dcs guard asks Navin.
   4. Rejected with a reason → `dcs decide <id> --q "commit rejected" --a "<reason>"`, then do what Navin says.
   5. `dcs done <id> --commit "$(git rev-parse --short HEAD)"`.
   - **spec** tasks: before committing, show Navin the spec file and run `dcs approve-spec <id>` (the guard asks Navin). If approved, set the template's status field to `Approved`, then commit and run `dcs done`. If denied, ask Navin: make changes, commit as Draft and pause, or discard. There is no default.
   - **spec-sync** with nothing changed → `dcs done <id> --no-changes`.

## 3. Blocked
When `dcs show <id>` says `blocked` (3 failures), stop that task. Show Navin the last findings or verify tails and ask what to do. Run `dcs unblock <id>` only when Navin says to; the guard asks Navin too.

## 4. End of run
Print a table of `id | status | commit | failures`, and suggest `/dcs:pr`.
````

- [ ] **Step 2: Write `dcs/skills/review/SKILL.md`**

````markdown
---
name: review
description: Run the dcs review passes on one task (recording verdicts) or on the current branch diff (report only). Use when Navin runs /dcs:review.
argument-hint: "[<task id> | --diff]"
---

# /dcs:review

First read `${CLAUDE_PLUGIN_ROOT}/references/captain.md`. You are the Captain.

## A task: `/dcs:review <id>`
1. Run `dcs show <id>`. It must be `verified`; otherwise report its status and stop (review refuses anything else).
2. Required passes: work → ac, security, performance, quality, plus a11y when `ui`; spec → ac, a11y; spec-sync → ac.
3. Dispatch one `dcs:reviewer` per pass, in parallel, with the Reviewer template.
4. On `needs_input`, ask Navin (captain.md rules 3–5) and SendMessage the answer.
5. Record each pass: save its JSON to `$TMPDIR/dcs-<id>-<pass>.json`, then `dcs review <id> --pass <pass> --approve --findings "$TMPDIR/dcs-<id>-<pass>.json"`, using `--changes` instead when any finding is critical or major.
6. Report the resulting status: `approved`, or `doing` with the critical and major findings.

## The branch: `/dcs:review --diff`
1. The base is `settings.base`; if there are no settings, ask Navin. The diff is `git diff <base>...HEAD` plus uncommitted changes (`git diff HEAD`).
2. Dispatch these reviewer passes with the Reviewer template (Task: "branch diff, no dcs task"; AC: "the change is correct and follows the repo rule skills"): ac, security, performance, quality, plus a11y when the diff touches UI files.
3. Report the findings grouped by severity. **Nothing is recorded**: do not run `dcs review`.
````

- [ ] **Step 3: Run the tests to verify they pass**

Run: `node --test test/`
Expected: PASS (all suites).

- [ ] **Step 4: Commit (after Navin's yes)**

```bash
git add dcs
git diff --cached --stat
git commit -m "feat(skills): /dcs:work Captain loop and /dcs:review"
```

---

### Task 11: `/dcs:pr`, `/dcs:visual-qa`, `/dcs:status` + reference resolution test

**Files:**
- Create: `dcs/skills/pr/SKILL.md`
- Create: `dcs/skills/pr/references/example-pr.md` (a copy of `~/.claude/skills/raising-prs/references/example-pr.md`)
- Create: `dcs/skills/visual-qa/SKILL.md`
- Create: `dcs/skills/status/SKILL.md`
- Modify: `test/plugin.test.js` (add the reference-resolution test)

**Interfaces:**
- Consumes: `dcs check`, `dcs list --json`, the evidence folders, `dcs board pr`, `dcs board --report`, `dcs board edit`, `dcs board add`, and `settings.pr`.
- Produces: `/dcs:pr`, `/dcs:visual-qa`, `/dcs:status`. The originals in `~/.claude` stay untouched (spec §12.2).

- [ ] **Step 1: Write the failing test**

Append to `test/plugin.test.js`:
```js
test('every /dcs:<skill> and `dcs:<name>` reference resolves to a real skill or agent', () => {
  const skills = new Set(fs.readdirSync(path.join(PLUGIN, 'skills')));
  const agents = new Set(fs.readdirSync(path.join(PLUGIN, 'agents')).map((f) => f.replace(/\.md$/, '')));
  for (const f of mdFiles(PLUGIN)) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/\/dcs:([a-z][a-z-]*)/g)) assert.ok(skills.has(m[1]), `${path.relative(ROOT, f)}: no skill /dcs:${m[1]}`);
    for (const m of text.matchAll(/["`]dcs:([a-z][a-z-]*)["`]/g)) {
      assert.ok(skills.has(m[1]) || agents.has(m[1]), `${path.relative(ROOT, f)}: no skill or agent dcs:${m[1]}`);
    }
  }
  for (const s of ['setup', 'plan', 'work', 'review', 'pr', 'visual-qa', 'status']) assert.ok(skills.has(s), `missing skill ${s}`);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/plugin.test.js`
Expected: FAIL with `no skill /dcs:pr` (or `missing skill pr`).

- [ ] **Step 3: Copy the PR example and read it**

```bash
mkdir -p dcs/skills/pr/references
cp ~/.claude/skills/raising-prs/references/example-pr.md dcs/skills/pr/references/example-pr.md
```
Read the copied file fully. If it contains anything that shouldn't sit in a local plugin (credentials, personal data), stop and ask Navin.

- [ ] **Step 4: Write `dcs/skills/pr/SKILL.md`**

````markdown
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

- Use one `Figma:` line per relevant node, and omit it when there is no UI. For multiple tickets, give one link each, separated by `, `.

**Body sections** (H2, in this order, only those that apply):
1. **Changed Packages** (always): a table `| Package | Change | Reason |`, with each package linked to `<pr.githubTreeBase><branch>/<path>`. Derive it from `git diff <base>...HEAD --stat`, grouped by package directory. If only generated or lock files changed in a package, say "(generated — no manual changes)".
2. **Review Scope** (always, right after Changed Packages): "The following files changed mechanically and do not require line-by-line review:", then bullets saying why (regenerated icons, `dist/` snapshots, `package-lock.json`, format-only files).
3. **Component Features**: one H3 per component or primitive. Bullets of one behavior per sentence, naming tokens and props inline. Cover visual structure, accessibility and VoiceOver order, key conditional behavior, and slot composition.
4. **Icon Pipeline**: only when icons or the generator changed. Give the count, brand coverage (Royal / Celebrity / Silversea), categories and generator changes.
5. **Token & Infrastructure Updates**: token pipeline changes, each tied to its consumer.
6. **`<Area>` Carry-Overs (from `<KEY>`)**: fixes inherited from a sibling ticket, each cited.
7. **Third-Party Dependencies**: `| Package | Purpose | Why This Library |`, or "No new runtime dependencies introduced in this PR".
8. **Build & Packaging**: new public exports, Code Connect mappings, Storybook stories, example app changes.
9. **Evidence**: one subhead per platform (`iOS —`, `Android —`, …), built from the dcs evidence. Include verify results (commands and pass/fail), review verdicts per pass, QA verdicts, and the screenshot **filenames** from `qa-*/`; `gh` can't embed images, so Navin attaches them. Leave a placeholder and flag anything unknown.

**Checklist** (H2), with H3 task lists whose names fit the scope: Component Behavior · Token Compliance · Accessibility · Icon Pipeline (only with icons) · Code Connect · Build & CI (build, typecheck, lint, format:check, test counts). Use `- [x]` only for items verified in this session or by dcs evidence, and `- [ ]` otherwise.

**Test plan** (H2): a flat list of steps a reviewer can actually do (example app, Storybook, a built artifact), covering cross-brand checks, edge cases (empty / `false` / missing props), an accessibility walkthrough, and performance checks where relevant.

**Style:** standalone bullets are full sentences ending in a period, while short table cells may drop it. Use inline code for tokens, props, literals, package names, paths and commands. ` — ` is fine in the PR body (never in commit messages). Say what the PR does **not** do when the scope could be misread. No filler ("this PR addresses…"): lead with the noun. No bold or italic labels inside paragraphs. Output the body as raw Markdown, not inside a code fence.

## 4. Approval and creation
1. Print the full body in chat. After it, in plain prose, list the sections you skipped and why, and every fact you couldn't verify.
2. **Wait for Navin's explicit approval**, and revise until approved.
3. Run `gh auth status`. If it fails, stop and ask Navin.
4. If the branch isn't pushed (`git status -sb` shows no upstream), run `git push -u origin HEAD`; the dcs guard asks Navin.
5. `gh pr create --draft --title "<title>" --body-file - <<'EOF'` … `EOF`. Always `--draft`, never `--web`. Use the repo's default base unless Navin says otherwise.
6. Report the URL and remind Navin it is a draft.
7. Board: for each Jira key of this branch's done tasks, run `dcs board pr <KEY> <url>`. With no key, ask whether to attach the PR to an untracked board row (list them with `dcs board --json --offline`, then `dcs board pr <id> <url>`).
````

- [ ] **Step 5: Write `dcs/skills/visual-qa/SKILL.md`**

````markdown
---
name: visual-qa
description: Generic visual QA of a running React Native / iOS app on the booted simulator using agent-device, reported as a reference diff in the dcs QA format. Use when a repo's dcs settings set visualQa to the dcs:visual-qa skill, or when Navin asks for visual QA in a repo without its own QA agent.
---

# /dcs:visual-qa

This runs in the Captain's session. The Captain passes the task, a reference (Figma screenshots, Navin's screenshots, or none), the scope (the task's AC) and a screenshot folder.

## 1. Binary
`which agent-device 2>/dev/null || echo "use npx"`. If it's not on PATH, use `npx agent-device@0.17.6` for every command below. Never use `@latest`.

## 2. Workflow guide (once per session)
`agent-device help workflow` and `agent-device help react-native`.

## 3. App and session
- `agent-device apps --platform ios` to find this project's bundle ID. If you're unsure which one it is, ask Navin.
- `agent-device open <bundle-id> --platform ios`.
- Metro must be running and the app built. If not, stop and tell Navin.

## 4. Navigate
Use `agent-device snapshot -i`, then `agent-device tap @eN`, then `agent-device diff snapshot -i`, and repeat until the screen **and state** match the reference. Refs change after every navigation, so re-snapshot before acting. Prefer selectors (`label="Search"`) for repeated steps.

## 5. Capture
Take `agent-device screenshot <folder>/<screen>_<state>.png` for each state or brand the reference shows, and only for the regions and states in scope. Also run `agent-device snapshot` to check layout: clipping, content outside the safe area, header or footer overlap, scroll bounds, truncation, and missing elements.

## 6. Compare
- **With a reference:** list every difference. Judge sizes **in proportion** to each screenshot's dimensions, because scales differ. Every difference defaults to **major**; mark it **minor** only when you can justify it as rendering noise (anti-aliasing, sub-pixel). If your screenshot shows a different state or section than the reference, the verdict is **invalid**: recapture instead of comparing.
- **Without a reference:** report the layout problems from step 5, with `referenceDiff: false`.

## 7. Close
`agent-device close`. Keep all actions in one serial session; never open several.

## 8. Report with exactly this JSON
`{"status": "done", "verdict": "pass" | "fail" | "invalid", "referenceDiff": true | false, "screenshots": ["<path>"], "findings": [{"severity": "blocker" | "major" | "minor", "location": "<on-screen region>", "difference": "...", "expected": "...", "actual": "..."}]}`
The verdict is `fail` on any blocker or major finding, and `pass` otherwise.
````

- [ ] **Step 6: Write `dcs/skills/status/SKILL.md`**

````markdown
---
name: status
description: Draft Navin's weekly status report from the dcs weekly board. Use when Navin runs /dcs:status or asks for the weekly status report or status update.
argument-hint: "[--week 2026-W40]"
---

# /dcs:status

1. Run `dcs board --report` (add `--week <week>` if given; the default is this week). It runs the merged check first; show Navin any warnings, such as gh being offline or unauthenticated.
2. If it exits 3 with "missing component/title for: …", ask Navin for each missing value, run `dcs board edit <key-or-id> --component "…" --title "…"`, and repeat step 1.
3. Show the week's board (`dcs board --week <week> --offline`) and ask Navin whether anything is missing, such as work done outside dcs, or feedback fixes from RNHost Eng or another team. Add or update rows only after Navin confirms (`dcs board add …`, `dcs board set …`; untracked feedback items take `--source "<team>"`), then repeat step 1.
4. Print the report text **exactly** as dcs printed it, inside a plain code block, for Navin to copy. Never send it anywhere, and never add links or extra sections.

The format comes from the dcs renderer: one line per ticket (`KEY — Component | Title`, plus `(Undergoing PR)`, `(In progress)` or `(Blocked: reason)`), then `Other shipped work (no ticket - issues pointed out by <team>):` with that team's done items only. There is no housekeeping section.
````

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test test/`
Expected: PASS (all suites; plugin 4).

- [ ] **Step 8: Commit (after Navin's yes)**

```bash
git add dcs test
git diff --cached --stat
git commit -m "feat(skills): /dcs:pr, /dcs:visual-qa and /dcs:status"
```

---

### Task 12: Install and smoke test (every step needs Navin)

**Files:** none (this changes Claude Code's plugin configuration, spec §12.1).

- [ ] **Step 1: Full test run**

Run: `node --test test/`
Expected: PASS, every suite, zero failures. Paste the summary to Navin.

- [ ] **Step 2: Ask before installing**

Ask Navin: "Install dcs at user scope from ~/Downloads/dcs-harness? This adds the dcs-local marketplace and enables the plugin (skills, agents, and a PreToolUse hook that runs on every Bash/Read/Write/Edit call in every repo)." Continue only on an explicit yes.

- [ ] **Step 3: Install**

```bash
claude plugin marketplace add /Users/navin/Downloads/dcs-harness
```
```bash
claude plugin install dcs@dcs-local
```
If either command errors, show the error to Navin and stop; don't try alternatives unasked.

- [ ] **Step 4: Smoke test (Navin, in a new Claude Code session)**

Create a throwaway repo:
```bash
mkdir -p ~/Downloads/dcs-smoke && cd ~/Downloads/dcs-smoke && git init -b main && echo hi > README.md && git add . && git commit -m "chore: init"
```
Then in a **new** session opened in `~/Downloads/dcs-smoke`:
1. `/dcs:setup`: confirm `verify: ["true"]`, `worktreeSetup: []`, `requireFixesTrailer: false`, no repo rules, `visualQa: false`, `specs: false`.
2. `/dcs:plan add a hello.txt containing Hello`: approve one task.
3. `/dcs:work --solo`: the worker writes the file, verify passes, four review passes approve, the commit prompt appears (approve it), and `dcs done` records it.
4. Check the guard: ask Claude to run `sudo ls` (expect a deny naming D1) and `git push origin main` (expect a deny naming D4).
5. `dcs board --offline` shows the current week's (empty) board.

Report each step's result to Navin faithfully, including any failure.

- [ ] **Step 5: Deferred decisions (spec §12): ask Navin, and change nothing without a yes**
1. Remove the originals `~/.claude/commands/pr.md`, `~/.claude/skills/raising-prs` and `~/.claude/skills/visual-qa`? (Default: keep.)
2. Retire the "weekly status report format" memory now that `/dcs:status` exists? (Default: keep.)

---

## Self-review (done while writing this plan)

- **Spec coverage:** §1 goals → Tasks 1–12. §2 layout → the file map. §3 task file and every CLI row → Tasks 3–5. §4 Captain → Task 8 (`captain.md`) and Tasks 9–10. §5 flow → Tasks 9–11. §6 guardrails (G1–G6, D1–D5, S1–S2, C1, fail closed) → Task 7. §7 settings → Task 2 (validation) and Task 9 (setup). §8 board → Task 6, plus `/dcs:status` in Task 11. §9 agents → Task 8. §10 error handling → the refusal tests in Tasks 2–7. §11 testing → every task. §12 deferred decisions → Task 12.
- **Placeholders:** none. Every code step has complete code; every markdown file is written out in full.
- **Name consistency:** `ctxFor`, `requireSettings`, `loadState`, `mutate`, `taskArg`, `taskCwd`, `nextIndex`, and `guardContext` are defined before use. The `tasks.*`, `repo.*` and `board.*` names used in bin match their exports.
- **Review Focus:** all five items have tests in the owning task (spaces → Task 5; quoted separators and heredoc → Task 7; concurrent board writers → Task 6; odd hook payloads → Task 7; huge verify output → Task 4).
