'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const BIN = path.join(__dirname, '..', 'dcs', 'bin', 'dcs');
// Every CLI call in tests uses these dirs unless a test passes its own: the real ~/.dcs and ~/.Trash are never touched.
const TEST_BOARD = path.join(os.tmpdir(), `dcs-test-board-${process.pid}`);
const TEST_GUARD_LOG = path.join(os.tmpdir(), `dcs-test-guardlog-${process.pid}`);
const TEST_REPOS = path.join(os.tmpdir(), `dcs-test-repos-${process.pid}.json`);
const TEST_TRASH = path.join(os.tmpdir(), `dcs-test-trash-${process.pid}`);

const tmpDir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dcs-')));
const sh = (cmd, cwd) => execFileSync('/bin/sh', ['-c', cmd], { cwd, encoding: 'utf8' });

function dcs(args, { cwd, input = '', env = {} } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, DCS_BOARD_DIR: TEST_BOARD, DCS_GUARD_LOG_DIR: TEST_GUARD_LOG, DCS_REPOS_FILE: TEST_REPOS, DCS_TRASH_DIR: TEST_TRASH, ...env },
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
