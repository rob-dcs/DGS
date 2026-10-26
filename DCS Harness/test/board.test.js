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
  dcs(['start', 't1', '--branch-ok'], { cwd: dir, env: env(boardDirPath, '2026-09-30') }).ok();
  assert.equal(week(boardDirPath, '2026-W40').rows[0].status, 'in_progress');
  const r = dcs(['start', 't2', '--branch-ok'], { cwd: dir, env: env(boardDirPath, '2026-09-30') }).ok();
  assert.match(r.stderr, /no board row for APP2X-2/);
});

test('review fix: board writes are not blocked while the merged check waits on gh', async () => {
  const dir = tmpDir();
  b(dir, '2026-09-30', ['add', '--key', 'APP2X-1', '--title', 'A']).ok();
  b(dir, '2026-09-30', ['pr', 'APP2X-1', 'https://github.com/o/r/pull/1']).ok();
  const slowGh = path.join(tmpDir(), 'gh');
  fs.writeFileSync(slowGh, '#!/bin/sh\nsleep 8\necho \'{"state":"OPEN","mergedAt":null}\'\n');
  fs.chmodSync(slowGh, 0o755);
  const check = spawn(process.execPath, [BIN, 'board'], { env: { ...process.env, ...env(dir, '2026-09-30', { DCS_GH: slowGh }) } });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  b(dir, '2026-09-30', ['add', '--key', 'APP2X-2', '--title', 'B']).ok();
  assert.equal(await new Promise((resolve) => check.on('exit', resolve)), 0);
  assert.deepEqual(week(dir, '2026-W40').rows.map((r) => r.key), ['APP2X-1', 'APP2X-2']);
});

test('review fix: a board error never fails dcs start', () => {
  const boardDirPath = tmpDir();
  const dir = tmpRepo();
  dcs(['add'], { cwd: dir, input: JSON.stringify({ title: 'A', ac: ['x'], ui: false, jira: 'APP2X-1' }) }).ok();
  fs.writeFileSync(path.join(boardDirPath, '2026-W40.json'), '{oops');
  const r = dcs(['start', 't1', '--branch-ok'], { cwd: dir, env: env(boardDirPath, '2026-09-30') });
  assert.equal(r.code, 0);
  assert.match(r.stderr, /board not updated/);
});
