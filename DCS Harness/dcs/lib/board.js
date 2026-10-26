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

// ponytail: gh is queried outside the board lock (network calls can take seconds); results apply under a fresh lock
function mergedCheck(dir, week, view, at) {
  const warnings = [];
  const snapshot = withBoardLock(dir, () => {
    const d = ensureWeek(dir, week);
    saveWeek(dir, d);
    return d;
  });
  const results = new Map();
  for (const r of snapshot.rows.filter((x) => x.status === 'undergoing_pr' && x.prs.length)) {
    try {
      results.set(r.id, { prs: [...r.prs], states: r.prs.map(view) });
    } catch (e) {
      warnings.push(`merged check skipped for ${r.key || r.id}: ${e.message}`);
    }
  }
  withBoardLock(dir, () => {
    const cur = ensureWeek(dir, week);
    for (const r of cur.rows.filter((x) => x.status === 'undergoing_pr' && results.has(x.id))) {
      const { prs, states } = results.get(r.id);
      if (prs.join('\n') !== r.prs.join('\n')) continue; // PRs changed meanwhile; the next check sees them
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
