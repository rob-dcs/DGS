'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpRepo, specRepo, dcs, tmpDir, sh, baseSettings } = require('./helpers');

const work = (over = {}) => ({ title: 'Do thing', ac: ['WHEN tapped the Button shall call onPress'], ui: false, ...over });
const specTask = (over = {}) => ({ kind: 'spec', title: 'Spec: Tag', ac: ['WHEN read the spec shall list every Tag state'], specPath: 'specs/components/Tag.spec.md', ...over });
const add = (dir, input, args = []) => dcs(['add', ...args], { cwd: dir, input: JSON.stringify(input) });
const state = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.claude/dcs/tasks.json'), 'utf8'));
const task = (dir, id) => state(dir).tasks.find((t) => t.id === id);
const statuses = (dir, id) => task(dir, id).history.map((h) => h.status);
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

test('add --dry-run validates and lints without writing', () => {
  const dir = tmpRepo();
  const vague = work({ title: 'Make the header look good and work', ac: ['The header looks good', 'It works correctly', 'a', 'b', 'c', 'd'] });
  const r = add(dir, [vague], ['--dry-run']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /ok: 1 task\(s\) would be added/);
  assert.match(r.stderr, /warning: task #1 ac 1 uses vague wording "looks good"/);
  assert.match(r.stderr, /warning: task #1 ac 2 uses vague wording "works"/);
  assert.match(r.stderr, /warning: task #1 has 6 AC items \(keep it to 5 or fewer\)/);
  assert.match(r.stderr, /warning: task #1 title has 7 words \(keep it to 6 or fewer\)/);
  assert.equal(state(dir).tasks.length, 0);
  const bad = add(dir, { title: 'x', ac: [], ui: false }, ['--dry-run']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /ac needs at least one/);
});

test('add prints lint warnings but still adds', () => {
  const dir = tmpRepo();
  const r = add(dir, work({ ac: ['It renders properly'] })).ok();
  assert.match(r.stderr, /warning: task #1 ac 1 uses vague wording "properly"/);
  assert.equal(state(dir).tasks.length, 1);
});

test('discoveredFrom must name an existing task', () => {
  const dir = tmpRepo();
  add(dir, work()).ok();
  assert.match(add(dir, work({ discoveredFrom: 't9' })).stderr, /discoveredFrom t9 is not a task/);
  add(dir, work({ discoveredFrom: 't1' })).ok();
  assert.equal(task(dir, 't2').discoveredFrom, 't1');
});

test('new tasks start with a todo history entry; decide stores why', () => {
  const dir = tmpRepo();
  add(dir, work()).ok();
  assert.deepEqual(statuses(dir, 't1'), ['todo']);
  dcs(['decide', 't1', '--q', 'Size?', '--a', 'medium', '--why', 'matches Figma'], { cwd: dir }).ok();
  dcs(['decide', 't1', '--q', 'Color?', '--a', 'brand'], { cwd: dir }).ok();
  assert.deepEqual(task(dir, 't1').decisions.map((d) => [d.q, d.a, d.why]), [['Size?', 'medium', 'matches Figma'], ['Color?', 'brand', null]]);
});

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
  assert.deepEqual(statuses(dir, 't1'), ['todo', 'doing']);
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

test('verify passes DCS_* variables to the commands (solo: DCS_WORKTREE empty)', () => {
  const dir = tmpRepo({ settings: baseSettings({ verify: ['echo "$DCS_MAIN_ROOT|$DCS_TASK_ID|$DCS_WORKTREE"'] }) });
  add(dir, work()).ok();
  dcs(['start', 't1'], { cwd: dir }).ok();
  dcs(['verify', 't1'], { cwd: dir }).ok();
  assert.equal(task(dir, 't1').verify.results[0].tail, `${dir}|t1|`);
});

test('integrity flags: one per kind, never for .spec.md files', () => {
  const dir = tmpRepo({
    files: {
      'src/__tests__/a.test.ts': "it('a', () => {\n  expect(1).toBe(1);\n  expect(2).toBe(2);\n});\n",
      'src/b.test.ts': "it('b', () => {});\n",
      'src/c.ts': 'export const c = 1;\n',
      'package.json': '{"scripts":{"test":"jest"}}\n',
      'src/__snapshots__/a.test.ts.snap': 'exports[`a`] = `x`;\n',
      'specs/components/X.spec.md': '# X\n',
    },
  });
  add(dir, work()).ok();
  dcs(['start', 't1'], { cwd: dir }).ok();
  fs.rmSync(path.join(dir, 'src/b.test.ts'));
  fs.writeFileSync(path.join(dir, 'src/__tests__/a.test.ts'), "it('a', () => {\n  expect(1).toBe(1);\n});\nit.skip('later', () => {});\n");
  fs.writeFileSync(path.join(dir, 'src/c.ts'), '// eslint-disable-next-line no-console\nexport const c = 1;\n');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"scripts":{"test":"true"}}\n');
  fs.writeFileSync(path.join(dir, 'src/__snapshots__/a.test.ts.snap'), 'exports[`a`] = `y`;\n');
  fs.writeFileSync(path.join(dir, 'specs/components/X.spec.md'), '# X\nit.skip(\n');
  const out = dcs(['verify', 't1'], { cwd: dir }).ok().json();
  const kinds = [...new Set(out.integrity.map((f) => f.kind))].sort();
  assert.deepEqual(kinds, ['assertions-removed', 'snapshot-changed', 'suppression', 'test-deleted', 'test-skip', 'verify-config']);
  assert.ok(out.integrity.every((f) => !f.file.endsWith('.spec.md')), JSON.stringify(out.integrity));
  assert.deepEqual(task(dir, 't1').verify.integrity, out.integrity);
});

test('verify slots: a busy slot → "verify busy" with nothing recorded; a stale slot is reclaimed and released', () => {
  const dir = tmpRepo({ settings: baseSettings({ verifyConcurrency: 1 }) });
  add(dir, work()).ok();
  dcs(['start', 't1'], { cwd: dir }).ok();
  const slot = path.join(dir, '.claude/dcs/verify-slot-0.lock');
  fs.writeFileSync(slot, '');
  const busy = dcs(['verify', 't1'], { cwd: dir, env: { DCS_VERIFY_SLOT_WAIT_MS: '300' } });
  assert.equal(busy.code, 1);
  assert.match(busy.stderr, /verify busy/);
  assert.deepEqual([task(dir, 't1').verify, task(dir, 't1').status], [null, 'doing']);
  const old = new Date(Date.now() - 2 * 3600e3);
  fs.utimesSync(slot, old, old);
  dcs(['verify', 't1'], { cwd: dir, env: { DCS_VERIFY_SLOT_WAIT_MS: '300' } }).ok();
  assert.equal(fs.existsSync(slot), false);
});

const PASSES = ['ac', 'security', 'performance', 'quality'];
const findingsFile = (obj) => {
  const f = path.join(tmpDir(), 'findings.json');
  fs.writeFileSync(f, JSON.stringify(obj));
  return f;
};
const allMet = (dir, id) => task(dir, id).ac.map((_, i) => ({ i: i + 1, met: true, evidence: 'a test' }));
function review(dir, id, pass, { findings = [], acResults } = {}) {
  const body = { pass, findings, ...(pass === 'ac' ? { acResults: acResults || allMet(dir, id) } : {}) };
  return dcs(['review', id, '--pass', pass, '--findings', findingsFile(body)], { cwd: dir });
}
const approve = (dir, id, passes = PASSES) => {
  for (const p of passes) review(dir, id, p).ok();
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

test('review: every required pass clean → approved; normalized findings saved; history recorded', () => {
  const dir = tmpRepo();
  add(dir, work()).ok();
  toVerified(dir, 't1');
  const first = review(dir, 't1', 'ac').ok().json();
  assert.deepEqual([first.verdict, first.roundComplete], ['approve', false]);
  approve(dir, 't1', ['security', 'performance', 'quality']);
  assert.equal(task(dir, 't1').status, 'approved');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, '.claude/dcs/evidence/t1/review-r1-ac.json'), 'utf8'));
  assert.equal(saved.acResults.length, 1);
  assert.deepEqual(statuses(dir, 't1'), ['todo', 'doing', 'verified', 'approved']);
});

test('the ac pass needs acResults covering every AC exactly once; an unmet AC blocks', () => {
  const dir = tmpRepo();
  add(dir, work({ ac: ['WHEN a the X shall b', 'WHEN c the X shall d'] })).ok();
  toVerified(dir, 't1');
  const missing = dcs(['review', 't1', '--pass', 'ac', '--findings', findingsFile({ pass: 'ac', findings: [] })], { cwd: dir });
  assert.match(missing.stderr, /ac pass needs acResults covering AC 1\.\.2 exactly once/);
  assert.match(review(dir, 't1', 'ac', { acResults: [{ i: 1, met: true }] }).stderr, /covering AC 1\.\.2 exactly once/);
  assert.match(review(dir, 't1', 'ac', { acResults: [{ i: 1, met: true }, { i: 1, met: true }] }).stderr, /exactly once/);
  const r = review(dir, 't1', 'ac', { acResults: [{ i: 1, met: true }, { i: 2, met: false, evidence: 'no test covers it' }] }).ok().json();
  assert.equal(r.verdict, 'changes');
  approve(dir, 't1', ['security', 'performance', 'quality']);
  assert.deepEqual([task(dir, 't1').status, task(dir, 't1').failures], ['doing', 1]);
});

test('blocking needs an exact quote and no refutation; minor findings never block', () => {
  const dir = tmpRepo({ files: { 'src/a.ts': 'export const total = price * qty;\n' } });
  add(dir, work()).ok();
  toVerified(dir, 't1');
  const f = (over) => ({ id: 'f1', severity: 'major', file: 'src/a.ts', line: 1, quote: 'price * qty', issue: 'overflow', scenario: 'qty=1e9 → wraps', ...over });
  assert.equal(review(dir, 't1', 'security', { findings: [f({ quote: 'price + qty' })] }).ok().json().verdict, 'approve');
  assert.equal(review(dir, 't1', 'performance', { findings: [f({ refuted: true, refuteReason: 'qty is capped upstream' })] }).ok().json().verdict, 'approve');
  assert.equal(review(dir, 't1', 'quality', { findings: [f({ severity: 'minor', quote: '' })] }).ok().json().verdict, 'approve');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, '.claude/dcs/evidence/t1/review-r1-security.json'), 'utf8'));
  assert.equal(saved.findings[0].downgraded, 'quote not found');
  assert.equal(review(dir, 't1', 'ac', { findings: [f()] }).ok().json().verdict, 'changes');
  assert.deepEqual([task(dir, 't1').status, task(dir, 't1').failures], ['doing', 1]);
  const r1 = (pass) => task(dir, 't1').reviews.find((x) => x.round === 1 && x.pass === pass);
  assert.deepEqual([r1('security').blocking, r1('security').downgraded, r1('performance').refuted, r1('ac').blocking], [0, 1, 1, 1]);
});

test('review rejects malformed findings, a missing --findings, and passes that do not apply', () => {
  const dir = tmpRepo();
  add(dir, work({ ui: true })).ok();
  toVerified(dir, 't1');
  assert.match(dcs(['review', 't1', '--pass', 'security', '--findings', findingsFile({ findings: [{ id: 'x', severity: 'huge' }] })], { cwd: dir }).stderr, /severity must be critical, major or minor/);
  assert.match(dcs(['review', 't1', '--pass', 'security', '--findings', findingsFile({ nope: 1 })], { cwd: dir }).stderr, /findings file needs a "findings" array/);
  assert.match(dcs(['review', 't1', '--pass', 'security'], { cwd: dir }).stderr, /review needs --pass <name> and --findings <file>/);
  approve(dir, 't1');
  assert.equal(task(dir, 't1').status, 'verified');
  approve(dir, 't1', ['a11y']);
  assert.equal(task(dir, 't1').status, 'approved');
  const spec = specRepo();
  add(spec, specTask()).ok();
  toVerified(spec, 't1');
  assert.match(review(spec, 't1', 'security').stderr, /does not take a security pass \(it needs: ac, a11y\)/);
});

test('three blocking rounds block the task; unblock resets', () => {
  const dir = tmpRepo();
  add(dir, work()).ok();
  toVerified(dir, 't1');
  for (let round = 1; round <= 3; round += 1) {
    review(dir, 't1', 'ac', { acResults: [{ i: 1, met: false }] }).ok();
    approve(dir, 't1', ['security', 'performance', 'quality']);
    const t = task(dir, 't1');
    assert.deepEqual([t.failures, t.reviewRound, t.status], [round, round + 1, round < 3 ? 'doing' : 'blocked']);
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
  assert.match(review(dir, 't1', 'security').stderr, /changed since verify; run dcs verify t1 again/);
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

module.exports = { work, specTask, add, state, task, statuses, headSha, tmpDir, baseSettings };
