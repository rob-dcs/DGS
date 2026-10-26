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
