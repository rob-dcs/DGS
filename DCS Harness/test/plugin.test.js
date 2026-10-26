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
  for (const s of ['setup', 'plan', 'work', 'review', 'pr', 'pr-review', 'pr-fix', 'visual-qa', 'status']) assert.ok(skills.has(s), `missing skill ${s}`);
});
