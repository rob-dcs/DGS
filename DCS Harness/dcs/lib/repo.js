'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { DcsError, readJson, writeJsonAtomic, sleep } = require('./store');

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
    prcheckFile: path.join(dcsDir, 'prcheck.json'),
    tasksFile: path.join(dcsDir, 'tasks.json'),
    lockFile: path.join(dcsDir, 'tasks.lock'),
    evidenceDir: path.join(dcsDir, 'evidence'),
    worktreesDir: path.join(path.dirname(mainRoot), `${path.basename(mainRoot)}.dcs-worktrees`),
  };
}

const isStrList = (a) => Array.isArray(a) && a.every((x) => typeof x === 'string' && x.trim() !== '');

// Maestro quirks the Captain's flow template knows how to work around (captain.md, Maestro capture)
const KNOWN_ISSUES = ['openLink-noop', 'back-noop', 'metro-banner'];
const relPath = (x) => typeof x === 'string' && x.trim() !== '' && !path.isAbsolute(x) && !x.split('/').includes('..');

function validateMaestro(m, p) {
  if (!Array.isArray(m) || !m.length) {
    p.push('maestro must be false or a non-empty list of apps: [{"name": "...", "paths": [...], "ios": {...}, "android": {...}}]');
    return;
  }
  const seen = new Set();
  m.forEach((app, i) => {
    const at = `maestro[${i}]`;
    if (!app || typeof app !== 'object' || Array.isArray(app)) {
      p.push(`${at} must be an object`);
      return;
    }
    const keys = Object.keys(app);
    for (const k of keys.filter((x) => !['name', 'paths', 'brandSwitcher', 'ios', 'android'].includes(x))) p.push(`${at} has unknown key: ${k}`);
    if (app.brandSwitcher !== undefined && (typeof app.brandSwitcher !== 'string' || !app.brandSwitcher.trim())) p.push(`${at}.brandSwitcher must be a non-empty string`);
    if (typeof app.name !== 'string' || !app.name.trim()) p.push(`${at}.name must be a non-empty string`);
    else if (seen.has(app.name)) p.push(`maestro app names must be unique: ${app.name}`);
    else seen.add(app.name);
    if (app.paths !== undefined && !(Array.isArray(app.paths) && app.paths.length && app.paths.every(relPath))) {
      p.push(`${at}.paths must be a list of repo-relative paths`);
    }
    const plats = ['ios', 'android'].filter((x) => keys.includes(x));
    if (!plats.length) p.push(`${at} needs ios and/or android`);
    for (const k of plats) {
      const pl = app[k];
      if (!pl || typeof pl.appId !== 'string' || !pl.appId.trim()) p.push(`${at}.${k}.appId must be a non-empty string`);
      if (!pl || typeof pl !== 'object') continue;
      for (const x of Object.keys(pl).filter((y) => !['appId', 'deepLink', 'knownIssues'].includes(y))) p.push(`${at}.${k} has unknown key: ${x}`);
      if (pl.deepLink !== undefined && typeof pl.deepLink !== 'string') p.push(`${at}.${k}.deepLink must be a string`);
      if (pl.knownIssues !== undefined && !Array.isArray(pl.knownIssues)) p.push(`${at}.${k}.knownIssues must be a list`);
      for (const x of (Array.isArray(pl.knownIssues) ? pl.knownIssues : []).filter((y) => !KNOWN_ISSUES.includes(y))) {
        p.push(`${at}.${k}.knownIssues: unknown value ${x} (known: ${KNOWN_ISSUES.join(', ')})`);
      }
    }
  });
}

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
  if (s.verifyConcurrency !== undefined && !(Number.isInteger(s.verifyConcurrency) && s.verifyConcurrency >= 1)) {
    p.push('verifyConcurrency must be an integer >= 1');
  }
  if (s.maestro !== undefined && s.maestro !== false) validateMaestro(s.maestro, p);
  if (s.prChecks !== undefined && s.prChecks !== false && !(isStrList(s.prChecks) && s.prChecks.length)) p.push('prChecks must be false or a non-empty list of commands');
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

function untracked(cwd) {
  return git(['ls-files', '--others', '--exclude-standard', '-z'], cwd).toString('utf8').split('\0').filter(Boolean).sort();
}

// committed + uncommitted changes since baseSha, plus untracked files
function changedFiles(cwd, baseSha) {
  const tracked = git(['diff', '--name-only', '-z', baseSha], cwd).toString('utf8').split('\0').filter(Boolean);
  return [...new Set([...tracked, ...untracked(cwd)])];
}

function fingerprint(cwd) {
  const h = crypto.createHash('sha1');
  h.update(gitText(['rev-parse', 'HEAD'], cwd));
  h.update(git(['diff', 'HEAD', '--binary'], cwd));
  for (const f of untracked(cwd)) {
    h.update(`\0${f}\0`);
    h.update(fileBytes(path.join(cwd, f)));
  }
  return h.digest('hex');
}

// symlinks hash their target path, directories and unreadable entries hash as empty (never throw)
function fileBytes(p) {
  try {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) return Buffer.from(`symlink:${fs.readlinkSync(p)}`);
    return st.isFile() ? fs.readFileSync(p) : Buffer.alloc(0);
  } catch {
    return Buffer.alloc(0);
  }
}

function diffSince(cwd, baseSha) {
  const parts = [git(['diff', baseSha, '--binary'], cwd)];
  for (const f of untracked(cwd)) {
    parts.push(git(['diff', '--no-index', '--binary', '--', '/dev/null', f], cwd, { allowCodes: [0, 1] }));
  }
  return Buffer.concat(parts);
}

const dcsEnv = (P, t) => ({ DCS_MAIN_ROOT: P.mainRoot, DCS_TASK_ID: t.id, DCS_WORKTREE: t.worktree || '' });

function runSetup(cwd, cmds, env) {
  for (const cmd of cmds) {
    const r = spawnSync(`exec 2>&1\n${cmd}`, { cwd, shell: true, encoding: 'utf8', maxBuffer: BIG, env: { ...process.env, ...env } });
    if (r.status !== 0) {
      throw new DcsError(`worktreeSetup failed: ${cmd} (exit ${r.status})\n${tail(`${r.stdout || ''}${r.stderr || ''}`, 40)}`);
    }
  }
}

const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'Podfile.lock', 'Gemfile.lock', 'Package.resolved'];

function lockHash(cwd) {
  const tracked = git(['ls-files', '-z'], cwd).toString('utf8').split('\0').filter(Boolean);
  const files = [...new Set([...tracked, ...untracked(cwd)])]
    .filter((f) => LOCKFILES.includes(path.basename(f)) && fs.existsSync(path.join(cwd, f)))
    .sort();
  if (!files.length) return null;
  const h = crypto.createHash('sha1');
  for (const f of files) h.update(`${f}\0${fs.readFileSync(path.join(cwd, f))}\0`);
  return h.digest('hex');
}

function removeWorktree(P, id) {
  git(['worktree', 'remove', '--force', path.join(P.worktreesDir, id)], P.mainRoot, { allowCodes: [0, 128] });
  git(['branch', '-D', `dcs/${id}`], P.mainRoot, { allowCodes: [0, 1] });
}

function createWorktree(P, id, setupCmds) {
  const dir = path.join(P.worktreesDir, id);
  const branch = `dcs/${id}`;
  fs.mkdirSync(P.worktreesDir, { recursive: true });
  // a killed earlier start can leave dcs's own worktree/branch behind; the caller checked the task is still todo
  const leftoverBranch = git(['branch', '--list', branch], P.mainRoot).toString('utf8').trim() !== '';
  if (fs.existsSync(dir) || leftoverBranch) {
    removeWorktree(P, id);
    fs.rmSync(dir, { recursive: true, force: true });
    git(['worktree', 'prune'], P.mainRoot);
  }
  git(['worktree', 'add', '-q', '-b', branch, dir, 'HEAD'], P.mainRoot);
  try {
    runSetup(dir, setupCmds, { DCS_MAIN_ROOT: P.mainRoot, DCS_TASK_ID: id, DCS_WORKTREE: dir });
  } catch (e) {
    removeWorktree(P, id);
    throw e;
  }
  return { dir, branch, setupLockHash: lockHash(dir) };
}

function runVerify(cwd, cmds, logFile, env = {}) {
  let log = '';
  const results = cmds.map((cmd) => {
    // exec 2>&1 keeps stdout and stderr interleaved in their real order
    const r = spawnSync(`exec 2>&1\n${cmd}`, { cwd, shell: true, encoding: 'utf8', maxBuffer: BIG, env: { ...process.env, ...env } });
    const output = `${r.stdout || ''}${r.stderr || ''}`;
    const exit = r.status === null ? 1 : r.status;
    log += `$ ${cmd}\n${output}\n[exit ${exit}]\n\n`;
    return { cmd, exit, tail: tail(output, 40) };
  });
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, log);
  return results;
}

const isTest = (f) =>
  /(^|\/)__tests__\//.test(f) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(f) || /Tests?\.(swift|kt)$/.test(f) ||
  /(^|\/)src\/(test|androidTest)\//.test(f) || /(^|\/)Tests\//.test(f);
const SKIP_RE = /\.(skip|only)\(|\bx(it|describe)\(|\bf(it|describe)\(|@Ignore\b|@Disabled\b|XCTSkip/;
const ASSERT_RE = /\bexpect\(|\bassert|XCTAssert|#expect\(|assertThat\(|\bverify\(/;
const SUPPRESS_RE = /eslint-disable|@ts-ignore|@ts-expect-error|@ts-nocheck|swiftlint:disable|@Suppress(Lint)?\b/;
const CONFIG_RE = /^(package\.json|jest\.config\..+|babel\.config\..+|\.eslintrc.*|eslint\.config\..+|tsconfig.*\.json|\.swiftlint\.yml|detekt\.yml)$/;
const SNAPSHOT_RE = /(^|\/)(__snapshots__|__Snapshots__)\/|\.snap$|(^|\/)src\/test\/snapshots\//;

function integrity(cwd, baseSha) {
  const changes = git(['diff', '--name-status', '--no-renames', baseSha], cwd).toString('utf8').split('\n').filter(Boolean)
    .map((l) => { const [status, ...rest] = l.split('\t'); return { status: status[0], file: rest.join('\t') }; });
  for (const f of untracked(cwd)) changes.push({ status: 'A', file: f });
  const flags = [];
  const seen = new Set();
  const flag = (kind, file, detail) => {
    const key = `${kind}\0${file}`;
    if (seen.has(key)) return;
    seen.add(key);
    flags.push(detail ? { kind, file, detail } : { kind, file });
  };
  for (const { status, file } of changes) {
    if (file.endsWith('.spec.md')) continue;
    let added = [];
    let removed = [];
    if (status === 'M' || status === 'A') {
      const tracked = git(['ls-files', '--error-unmatch', '--', file], cwd, { allowCodes: [0, 1] }).length > 0;
      if (tracked) {
        const lines = git(['diff', baseSha, '--', file], cwd).toString('utf8').split('\n');
        added = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1));
        removed = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).map((l) => l.slice(1));
      } else {
        added = fileBytes(path.join(cwd, file)).toString('utf8').split('\n');
      }
    }
    if (status === 'D' && isTest(file)) flag('test-deleted', file);
    const skip = added.find((l) => SKIP_RE.test(l));
    if (skip) flag('test-skip', file, skip.trim());
    if (status === 'M' && isTest(file) && removed.filter((l) => ASSERT_RE.test(l)).length > added.filter((l) => ASSERT_RE.test(l)).length) {
      flag('assertions-removed', file);
    }
    const sup = added.find((l) => SUPPRESS_RE.test(l));
    if (sup) flag('suppression', file, sup.trim());
    if (CONFIG_RE.test(path.basename(file)) || /\.gradle(\.kts)?$/.test(file)) flag('verify-config', file);
    if ((status === 'M' || status === 'D') && SNAPSHOT_RE.test(file)) flag('snapshot-changed', file);
  }
  return flags;
}

// a slot whose recorded pid is gone (e.g. verify killed by the Bash timeout) is free; no pid means unknown owner
function ownerAlive(file) {
  const pid = Number.parseInt(fs.readFileSync(file, 'utf8'), 10);
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function acquireVerifySlot(P, n, waitMs) {
  fs.mkdirSync(P.dcsDir, { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    for (let k = 0; k < n; k += 1) {
      const slot = path.join(P.dcsDir, `verify-slot-${k}.lock`);
      try {
        const fd = fs.openSync(slot, 'wx');
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        return () => fs.rmSync(slot, { force: true });
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try {
          if (!ownerAlive(slot) || Date.now() - fs.statSync(slot).mtimeMs > 60 * 60 * 1000) {
            fs.rmSync(slot, { force: true });
            k -= 1; // retry this slot
          }
        } catch {
          k -= 1; // released between open and stat
        }
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new DcsError(`verify busy: all ${n} verify slot(s) in use; try again later`);
    sleep(Math.min(1000, remaining));
  }
}

function land(P, task) {
  if (isDirty(P.mainRoot)) throw new DcsError('main checkout has uncommitted changes; commit or stash first');
  const landedOn = gitText(['rev-parse', 'HEAD'], P.mainRoot);
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
  return landedOn;
}

const commitExists = (cwd, sha) => spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd }).status === 0;

module.exports = {
  land, commitExists,
  git, gitText, paths, validateSettings, loadSettings, init, isDirty, currentBranch, tail,
  untracked, changedFiles, fingerprint, diffSince, dcsEnv, runSetup, lockHash, removeWorktree, createWorktree, runVerify, integrity, acquireVerifySlot,
};
