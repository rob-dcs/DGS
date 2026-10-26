'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpRepo, tmpDir, dcs, sh, baseSettings } = require('./helpers');

const state = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.claude/dcs/tasks.json'), 'utf8'));
const add = (dir, input) => dcs(['add'], { cwd: dir, input: JSON.stringify(input) });

test('run records a green baseline and the run start', () => {
  const dir = tmpRepo({ settings: baseSettings({ verify: ['echo base-ok'] }) });
  dcs(['run'], { cwd: dir, env: { DCS_NOW: '2026-09-30T09:00:00.000Z' } }).ok();
  const s = state(dir);
  assert.equal(s.runStartedAt, '2026-09-30T09:00:00.000Z');
  assert.deepEqual([s.baseline.ok, s.baseline.sha], [true, sh('git rev-parse HEAD', dir).trim()]);
  assert.ok(fs.existsSync(path.join(dir, '.claude/dcs/evidence/_baseline/verify-1.log')));
});

test('a red baseline exits 1 with the failing tail; --skip-baseline skips it; a dirty checkout is refused', () => {
  const dir = tmpRepo({ settings: baseSettings({ verify: ['echo broken-main; exit 1'] }) });
  const r = dcs(['run'], { cwd: dir });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /baseline verify failed on main/);
  assert.match(r.stderr, /broken-main/);
  assert.equal(state(dir).baseline.ok, false);
  dcs(['run', '--skip-baseline'], { cwd: dir, env: { DCS_NOW: '2026-10-01T09:00:00.000Z' } }).ok();
  assert.equal(state(dir).runStartedAt, '2026-10-01T09:00:00.000Z');
  fs.writeFileSync(path.join(dir, 'dirty.txt'), 'x');
  assert.match(dcs(['run'], { cwd: dir }).stderr, /uncommitted changes/);
});

test('note stores numbered handoff notes and rejects non-JSON', () => {
  const dir = tmpRepo();
  add(dir, { title: 'A', ac: ['WHEN a the X shall b'], ui: false }).ok();
  const f = path.join(tmpDir(), 'reply.json');
  fs.writeFileSync(f, '{"status":"done","summary":"s"}');
  dcs(['note', 't1', f], { cwd: dir }).ok();
  dcs(['note', 't1', f], { cwd: dir }).ok();
  assert.deepEqual(fs.readdirSync(path.join(dir, '.claude/dcs/evidence/t1')).sort(), ['worker-1.json', 'worker-2.json']);
  fs.writeFileSync(f, 'not json');
  assert.match(dcs(['note', 't1', f], { cwd: dir }).stderr, /note must be a JSON file/);
  assert.match(dcs(['note', 't9', f], { cwd: dir }).stderr, /unknown task: t9/);
});

test('brief is silent with nothing in flight and summarizes in-flight work', () => {
  const dir = tmpRepo();
  assert.equal(dcs(['brief'], { cwd: dir }).ok().stdout, '');
  assert.equal(dcs(['brief'], { cwd: tmpDir() }).ok().stdout, '');
  add(dir, { title: 'Header skeleton', ac: ['WHEN a the Header shall b'], ui: true }).ok();
  dcs(['start', 't1'], { cwd: dir }).ok();
  const f = path.join(tmpDir(), 'reply.json');
  fs.writeFileSync(f, '{"status":"done"}');
  dcs(['note', 't1', f], { cwd: dir }).ok();
  const out = dcs(['brief'], { cwd: dir }).ok().stdout;
  assert.match(out, /^dcs: work in flight in app/m);
  assert.match(out, /- t1 doing · failures 0 · "Header skeleton" · last note: \.claude\/dcs\/evidence\/t1\/worker-1\.json/);
  assert.match(out, /references\/captain\.md/);
});

test('brief never fails loudly, even on a corrupt tasks file', () => {
  const dir = tmpRepo();
  fs.writeFileSync(path.join(dir, '.claude/dcs/tasks.json'), '{oops');
  const r = dcs(['brief'], { cwd: dir });
  assert.deepEqual([r.code, r.stdout], [0, '']);
});

test('stats computes rates from history and review records', () => {
  const dir = tmpRepo();
  const t = (id, sts, extra = {}) => ({
    id, kind: 'work', title: id, jira: null, figma: [], refs: [], ui: false, ac: ['WHEN a the X shall b'], depends: [],
    discoveredFrom: null, status: sts.at(-1), failures: 0, verifyFailStreak: 0, reviewRound: 1, branch: null, baseSha: null,
    worktree: null, landed: false, reverified: false, setupLockHash: null, commit: null, verify: null, qa: null, reviews: [],
    decisions: [], specPath: null, specApproval: null,
    history: sts.map((s, i) => ({ status: s, at: `2026-09-30T10:0${i}:00.000Z` })), ...extra,
  });
  const s = {
    version: 1, runStartedAt: null, baseline: null,
    tasks: [
      t('t1', ['todo', 'doing', 'verified', 'approved', 'done'], {
        reviewRound: 2,
        reviews: [{ round: 1, pass: 'ac', verdict: 'approve', blocking: 0, refuted: 1, downgraded: 0 }],
        decisions: [{ q: 'a', a: 'b', why: null, at: 'x' }],
      }),
      t('t2', ['todo', 'doing', 'verified', 'doing', 'verified', 'approved', 'done'], {
        reviewRound: 3,
        reviews: [{ round: 1, pass: 'ac', verdict: 'changes', blocking: 2, refuted: 0, downgraded: 1 }],
      }),
      t('t3', ['todo', 'doing', 'blocked']),
      t('t4', ['todo']),
    ],
  };
  fs.writeFileSync(path.join(dir, '.claude/dcs/tasks.json'), JSON.stringify(s));
  const r = dcs(['stats', '--json'], { cwd: dir }).ok().json();
  assert.deepEqual(r.byStatus, { todo: 1, doing: 0, verified: 0, approved: 0, done: 2, blocked: 1 });
  assert.deepEqual([r.tasks, r.firstPassRate, r.meanReviewRounds, r.blockedRate, r.decisions], [4, 0.5, 1.5, 0.33, 1]);
  assert.deepEqual(r.passes.ac, { rounds: 2, blocking: 2, refuted: 1, downgraded: 1 });
  assert.match(dcs(['stats'], { cwd: dir }).ok().stdout, /first-pass rate\s+50%/);
});
