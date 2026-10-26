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
