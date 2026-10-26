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

test('settings: verifyConcurrency must be a positive integer; maestro is a list of named apps, each with a platform appId', () => {
  const dir = tmpRepo({ settings: false });
  const init = (maestro, extra = {}) => dcs(['init'], { cwd: dir, input: JSON.stringify(baseSettings({ maestro, ...extra })) });
  const r = init([{ name: 'rn', ios: { deepLink: 'x://' } }], { verifyConcurrency: 0 });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /verifyConcurrency must be an integer >= 1/);
  assert.match(r.stderr, /maestro\[0\]\.ios\.appId must be a non-empty string/);
  assert.match(init({ ios: { appId: 'x' } }).stderr, /maestro must be false or a non-empty list of apps/);
  assert.match(init([]).stderr, /maestro must be false or a non-empty list of apps/);
  assert.match(init([{ name: 'rn' }]).stderr, /maestro\[0\] needs ios and\/or android/);
  assert.match(init([{ name: 'rn', web: { appId: 'x' } }]).stderr, /maestro\[0\] has unknown key: web/);
  assert.match(init([{ ios: { appId: 'x' } }]).stderr, /maestro\[0\]\.name must be a non-empty string/);
  assert.match(init([{ name: 'a', ios: { appId: 'x' } }, { name: 'a', android: { appId: 'y' } }]).stderr, /maestro app names must be unique: a/);
  for (const bad of [['/abs'], ['../up'], ['a/../../b'], [''], 'packages/']) {
    assert.match(init([{ name: 'a', paths: bad, ios: { appId: 'x' } }]).stderr, /maestro\[0\]\.paths must be a list of repo-relative paths/);
  }
  assert.match(init([{ name: 'a', ios: { appId: 'x', deepLink: 3 } }]).stderr, /maestro\[0\]\.ios\.deepLink must be a string/);
  assert.match(init([{ name: 'a', ios: { appId: 'x', knownIssues: ['openLink-noop', 'nope'] } }]).stderr,
    /maestro\[0\]\.ios\.knownIssues: unknown value nope \(known: openLink-noop, back-noop, metro-banner\)/);
  assert.match(init([{ name: 'a', ios: { appId: 'x', knownIssues: 'openLink-noop' } }]).stderr, /maestro\[0\]\.ios\.knownIssues must be a list/);
  assert.match(init([{ name: 'a', android: { appId: 'x', knownIssue: [] } }]).stderr, /maestro\[0\]\.android has unknown key: knownIssue/);
  assert.match(init([{ name: 'a', brandSwitcher: '', ios: { appId: 'x' } }]).stderr, /maestro\[0\]\.brandSwitcher must be a non-empty string/);
  assert.match(init([{ name: 'a', openLinkBroken: true, ios: { appId: 'x' } }]).stderr, /maestro\[0\] has unknown key: openLinkBroken/);
  init([{ name: 'rn', paths: ['packages/rn/', 'apps/example-rn'], brandSwitcher: 'Switch brand theme', ios: { appId: 'com.x', deepLink: 'x://demo/{route}', knownIssues: ['openLink-noop', 'back-noop', 'metro-banner'] }, android: { appId: 'com.x' } }],
    { verifyConcurrency: 1 }).ok();
});

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

test('start refuses a Jira task when the current branch does not name its key, unless --branch-ok', () => {
  const dir = tmpRepo();
  addOne(dir, { jira: 'APP2X-12' });
  const r = dcs(['start', 't1'], { cwd: dir });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /t1 is APP2X-12 but the current branch is main; switch to the ticket's branch, or run dcs start t1 --branch-ok \(needs Navin's approval\)/);
  sh('git checkout -qb feat/APP2X-123-other', dir);
  assert.match(dcs(['start', 't1'], { cwd: dir }).stderr, /current branch is feat\/APP2X-123-other/, 'APP2X-12 is not APP2X-123');
  sh('git checkout -q --detach', dir);
  assert.match(dcs(['start', 't1'], { cwd: dir }).stderr, /current branch is \(detached HEAD\)/);
  sh('git checkout -qb feature/app2x-12-header', dir);
  dcs(['start', 't1'], { cwd: dir }).ok();
  assert.equal(taskOf(dir, 't1').branch, 'feature/app2x-12-header');
  const other = tmpRepo();
  addOne(other, { jira: 'APP2X-7' });
  dcs(['start', 't1', '--branch-ok'], { cwd: other }).ok();
  const plain = tmpRepo();
  addOne(plain);
  dcs(['start', 't1'], { cwd: plain }).ok();
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

test('apps lists the Maestro apps whose paths the task diff touches; apps without paths always count', () => {
  const maestro = [
    { name: 'rn', paths: ['packages/rn/', 'apps/example-rn'], ios: { appId: 'com.rn', deepLink: 'rn://demo/{route}' }, android: { appId: 'com.rn' } },
    { name: 'swiftui', paths: ['packages/ios'], ios: { appId: 'com.swiftui' } },
    { name: 'any', android: { appId: 'com.any' } },
  ];
  const dir = tmpRepo({ settings: baseSettings({ maestro }) });
  addOne(dir);
  assert.match(dcs(['apps', 't1'], { cwd: dir }).stderr, /t1 has not started/);
  dcs(['start', 't1'], { cwd: dir }).ok();
  const names = () => dcs(['apps', 't1'], { cwd: dir }).ok().json().map((a) => a.name);
  assert.deepEqual(names(), ['any']);
  fs.mkdirSync(path.join(dir, 'packages/iosx'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'packages/iosx/A.swift'), 'x\n');
  assert.deepEqual(names(), ['any'], 'a sibling folder sharing the prefix does not count');
  fs.mkdirSync(path.join(dir, 'packages/ios/Sources'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'packages/ios/Sources/A.swift'), 'x\n');
  assert.deepEqual(names(), ['swiftui', 'any']);
  fs.mkdirSync(path.join(dir, 'apps/example-rn'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'apps/example-rn/App.tsx'), 'x\n');
  sh('git add -A && git commit -qm wip', dir);
  const all = dcs(['apps', 't1'], { cwd: dir }).ok().json();
  assert.deepEqual(all.map((a) => a.name), ['rn', 'swiftui', 'any'], 'committed changes count too');
  assert.deepEqual(all[1], { name: 'swiftui', ios: { appId: 'com.swiftui' } });
  const plain = tmpRepo();
  addOne(plain);
  dcs(['start', 't1'], { cwd: plain }).ok();
  assert.deepEqual(dcs(['apps', 't1'], { cwd: plain }).ok().json(), []);
});

test('fingerprint changes when an untracked file changes', () => {
  const dir = tmpRepo();
  fs.writeFileSync(path.join(dir, 'u.txt'), 'a');
  const before = repo.fingerprint(dir);
  fs.writeFileSync(path.join(dir, 'u.txt'), 'b');
  assert.notEqual(repo.fingerprint(dir), before);
});

test('worktreeSetup and verify get DCS_* variables; setup re-runs only when a lockfile changes', () => {
  const dir = tmpRepo({
    files: { 'package-lock.json': '{}\n' },
    settings: baseSettings({ worktreeSetup: ['echo "$DCS_MAIN_ROOT|$DCS_TASK_ID" >> "$DCS_WORKTREE.setup-log"'], verify: ['echo "$DCS_WORKTREE"'] }),
  });
  addOne(dir);
  dcs(['start', 't1', '--worktree'], { cwd: dir }).ok();
  const wt = wtPath(dir, 't1');
  const log = `${wt}.setup-log`;
  const runs = () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length;
  assert.equal(fs.readFileSync(log, 'utf8'), `${dir}|t1\n`);
  dcs(['verify', 't1'], { cwd: wt }).ok();
  assert.equal(taskOf(dir, 't1').verify.results[0].tail, wt);
  assert.equal(runs(), 1);
  fs.writeFileSync(path.join(wt, 'package-lock.json'), '{"lockfileVersion":3}\n');
  dcs(['verify', 't1'], { cwd: wt }).ok();
  assert.equal(runs(), 2);
  dcs(['verify', 't1'], { cwd: wt }).ok();
  assert.equal(runs(), 2);
});

function approveAll(dir, id) {
  for (const pass of ['ac', 'security', 'performance', 'quality']) {
    const body = { pass, findings: [], ...(pass === 'ac' ? { acResults: [{ i: 1, met: true }] } : {}) };
    const f = path.join(tmpDir(), `${pass}.json`);
    fs.writeFileSync(f, JSON.stringify(body));
    dcs(['review', id, '--pass', pass, '--findings', f], { cwd: dir }).ok();
  }
}
function approvedInWorktree(dir, edit) {
  addOne(dir);
  dcs(['start', 't1', '--worktree'], { cwd: dir }).ok();
  const wt = wtPath(dir, 't1');
  edit(wt);
  dcs(['verify', 't1'], { cwd: wt }).ok();
  approveAll(dir, 't1');
  return wt;
}
const headOf = (dir) => sh('git rev-parse HEAD', dir).trim();

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
  const dir = tmpRepo({ parent: path.join(tmpDir(), 'my repos'), settings: baseSettings({ verify: ['echo "$DCS_WORKTREE"'] }) });
  approvedInWorktree(dir, (w) => fs.writeFileSync(path.join(w, 'spaced.txt'), 'ok\n'));
  assert.match(taskOf(dir, 't1').verify.results[0].tail, /my repos\/app\.dcs-worktrees\/t1$/);
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

test('after land the task must re-verify in main before QA or done', () => {
  const dir = tmpRepo({ settings: baseSettings({ verify: ['test ! -f broken.txt'] }) });
  approvedInWorktree(dir, (w) => fs.writeFileSync(path.join(w, 'x.txt'), 'x\n'));
  dcs(['land', 't1'], { cwd: dir }).ok();
  assert.equal(taskOf(dir, 't1').reverified, false);
  const shot = path.join(tmpDir(), 's.png');
  fs.writeFileSync(shot, 'x');
  assert.match(dcs(['qa', 't1', '--pass', '--evidence', shot], { cwd: dir }).stderr, /needs dcs verify t1 after landing/);
  assert.match(dcs(['done', 't1', '--commit', headOf(dir)], { cwd: dir }).stderr, /needs dcs verify t1 after landing/);
  dcs(['verify', 't1'], { cwd: dir }).ok();
  assert.deepEqual([taskOf(dir, 't1').status, taskOf(dir, 't1').reverified], ['approved', true]);
  dcs(['done', 't1', '--commit', headOf(dir)], { cwd: dir }).ok();
});

test('a failed re-verify after land sends the task back with a failure', () => {
  const dir = tmpRepo({ settings: baseSettings({ verify: ['test ! -f broken.txt'] }) });
  approvedInWorktree(dir, (w) => fs.writeFileSync(path.join(w, 'x.txt'), 'x\n'));
  dcs(['land', 't1'], { cwd: dir }).ok();
  fs.writeFileSync(path.join(dir, 'broken.txt'), 'x');
  assert.equal(dcs(['verify', 't1'], { cwd: dir }).code, 1);
  assert.deepEqual([taskOf(dir, 't1').status, taskOf(dir, 't1').failures], ['doing', 1]);
});

test('review fix: a verify slot left by a dead process is reclaimed at once', () => {
  const dir = tmpRepo({ settings: baseSettings({ verifyConcurrency: 1 }) });
  addOne(dir);
  dcs(['start', 't1'], { cwd: dir }).ok();
  fs.writeFileSync(path.join(dir, '.claude/dcs/verify-slot-0.lock'), '999999');
  dcs(['verify', 't1'], { cwd: dir, env: { DCS_VERIFY_SLOT_WAIT_MS: '300' } }).ok();
});

test('review fix: start --worktree clears a leftover worktree from a killed start', () => {
  const dir = tmpRepo();
  addOne(dir);
  sh(`git worktree add -q -b dcs/t1 "${wtPath(dir, 't1')}" HEAD`, dir);
  dcs(['start', 't1', '--worktree'], { cwd: dir }).ok();
  assert.equal(taskOf(dir, 't1').worktree, wtPath(dir, 't1'));
});

test('review fix: after land, diff is measured from the landing point, not the wave start', () => {
  const dir = tmpRepo();
  dcs(['add'], { cwd: dir, input: JSON.stringify([{ title: 'A', ac: ['x'], ui: false }, { title: 'B', ac: ['x'], ui: false }]) }).ok();
  dcs(['start', 't1', '--worktree'], { cwd: dir }).ok();
  dcs(['start', 't2', '--worktree'], { cwd: dir }).ok();
  fs.writeFileSync(path.join(wtPath(dir, 't1'), 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(wtPath(dir, 't2'), 'b.txt'), 'b\n');
  for (const id of ['t1', 't2']) {
    dcs(['verify', id], { cwd: wtPath(dir, id) }).ok();
    approveAll(dir, id);
  }
  dcs(['land', 't1'], { cwd: dir }).ok();
  dcs(['verify', 't1'], { cwd: dir }).ok();
  sh('git add -A && git commit -qm "feat: a"', dir);
  dcs(['done', 't1', '--commit', headOf(dir)], { cwd: dir }).ok();
  dcs(['land', 't2'], { cwd: dir }).ok();
  const d = dcs(['diff', 't2'], { cwd: dir }).ok().stdout;
  assert.match(d, /b\.txt/);
  assert.doesNotMatch(d, /a\.txt/);
});

test('review fix: fingerprint handles untracked symlinks and directory links', () => {
  const dir = tmpRepo();
  fs.symlinkSync('/nonexistent/target', path.join(dir, 'dangling'));
  fs.mkdirSync(path.join(dir, 'd'));
  fs.writeFileSync(path.join(dir, 'd', 'f.txt'), 'x');
  fs.symlinkSync(path.join(dir, 'd'), path.join(dir, 'dirlink'));
  assert.match(repo.fingerprint(dir), /^[0-9a-f]{40}$/);
});

test('review fix: verify tails keep stdout and stderr in order', () => {
  const dir = tmpRepo({ settings: baseSettings({ verify: ['echo first; echo second >&2; echo third'] }) });
  addOne(dir);
  dcs(['start', 't1'], { cwd: dir }).ok();
  dcs(['verify', 't1'], { cwd: dir }).ok();
  assert.equal(taskOf(dir, 't1').verify.results[0].tail, 'first\nsecond\nthird');
});

test('prChecks must be false or a non-empty list of commands', () => {
  const dir = tmpRepo({ settings: false });
  const init = (prChecks) => dcs(['init'], { cwd: dir, input: JSON.stringify(baseSettings({ prChecks })) });
  for (const bad of [[], [''], 'npm test', [3]]) assert.match(init(bad).stderr, /prChecks must be false or a non-empty list of commands/);
  init(false).ok();
  init(['npm run lint', 'npm test']).ok();
});

test('prcheck runs the PR checks in order, stops at the first failure, and records the result against HEAD', () => {
  const none = tmpRepo();
  assert.match(dcs(['prcheck'], { cwd: none }).stderr, /no prChecks in settings; run \/dcs:setup/);
  const dir = tmpRepo({ settings: baseSettings({ prChecks: ['echo one', 'echo two; exit 3', 'touch never-ran'] }) });
  const head = sh('git rev-parse HEAD', dir).trim();
  const record = () => JSON.parse(fs.readFileSync(path.join(dir, '.claude/dcs/prcheck.json'), 'utf8'));
  const r = dcs(['prcheck'], { cwd: dir });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /prcheck failed at step 2\/3: echo two; exit 3/);
  assert.match(r.stderr, /two/);
  assert.equal(fs.existsSync(path.join(dir, 'never-ran')), false);
  assert.deepEqual([record().ok, record().sha, record().results.length], [false, head, 2]);
  fs.writeFileSync(path.join(dir, 'dirty.txt'), 'x');
  assert.match(dcs(['prcheck'], { cwd: dir }).stderr, /uncommitted changes/);
  fs.rmSync(path.join(dir, 'dirty.txt'));
  const green = tmpRepo({ settings: baseSettings({ prChecks: ['echo all-good'] }) });
  const g = dcs(['prcheck'], { cwd: green }).ok().json();
  assert.deepEqual([g.ok, g.sha], [true, sh('git rev-parse HEAD', green).trim()]);
  assert.match(fs.readFileSync(path.join(green, g.results[0].log), 'utf8'), /all-good/);
});

test('purge lists, then moves every registered repo\'s evidence and the guard logs to the Trash, keeping tasks, settings, status and board', () => {
  const base = tmpDir();
  const env = { DCS_REPOS_FILE: path.join(base, 'repos.json'), DCS_TRASH_DIR: path.join(base, 'Trash'), DCS_GUARD_LOG_DIR: path.join(base, 'guard'), DCS_BOARD_DIR: path.join(base, 'board') };
  const run = (args, cwd) => dcs(args, { cwd, env });
  const a = tmpRepo({ settings: false });
  const b = tmpRepo({ settings: false });
  for (const d of [a, b]) {
    dcs(['init'], { cwd: d, env, input: JSON.stringify(baseSettings({ prChecks: ['true'] })) }).ok();
    dcs(['add'], { cwd: d, env, input: JSON.stringify({ title: 'A', ac: ['x'], ui: false }) }).ok();
    fs.mkdirSync(path.join(d, '.claude/dcs/evidence/t1'), { recursive: true });
    fs.writeFileSync(path.join(d, '.claude/dcs/evidence/t1/shot_ios.png'), 'x'.repeat(100));
    run(['prcheck'], d);
  }
  dcs(['init'], { cwd: a, env, input: JSON.stringify(baseSettings({ prChecks: ['true'] })) }).ok(); // re-init must not duplicate
  const gone = tmpRepo({ settings: false });
  dcs(['init'], { cwd: gone, env, input: JSON.stringify(baseSettings()) }).ok();
  fs.rmSync(gone, { recursive: true });
  fs.mkdirSync(env.DCS_GUARD_LOG_DIR, { recursive: true });
  fs.writeFileSync(path.join(env.DCS_GUARD_LOG_DIR, '2026-10.jsonl'), '{}\n');
  fs.mkdirSync(env.DCS_BOARD_DIR, { recursive: true });
  fs.writeFileSync(path.join(env.DCS_BOARD_DIR, '2026-W40.json'), '{}');
  assert.equal(JSON.parse(fs.readFileSync(env.DCS_REPOS_FILE, 'utf8')).filter((r) => r === a).length, 1);

  const dry = run(['purge'], a).ok().stdout;
  assert.match(dry, new RegExp(`${a.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}: \\d+ files`));
  assert.match(dry, /guard logs: 1 files/);
  assert.match(dry, /dcs purge --yes/);
  assert.ok(fs.existsSync(path.join(a, '.claude/dcs/evidence/t1/shot_ios.png')), 'dry run moves nothing');

  const done = run(['purge', '--yes'], a).ok().stdout;
  assert.match(done, /moved to .*Trash/);
  for (const d of [a, b]) {
    assert.equal(fs.existsSync(path.join(d, '.claude/dcs/evidence')), false);
    for (const keep of ['tasks.json', 'settings.json', 'prcheck.json']) assert.ok(fs.existsSync(path.join(d, '.claude/dcs', keep)), keep);
  }
  assert.equal(fs.readdirSync(env.DCS_GUARD_LOG_DIR).length, 0);
  assert.ok(fs.existsSync(path.join(env.DCS_BOARD_DIR, '2026-W40.json')));
  const trashed = fs.readdirSync(env.DCS_TRASH_DIR);
  assert.equal(trashed.length, 1);
  assert.ok(fs.readdirSync(path.join(env.DCS_TRASH_DIR, trashed[0])).some((n) => n === 'guard'));
  assert.match(run(['purge'], a).ok().stdout, /nothing to purge/);
});
