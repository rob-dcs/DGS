'use strict';
const path = require('node:path');
const { DcsError } = require('./store');

const STATUSES = ['todo', 'doing', 'verified', 'approved', 'done', 'blocked'];
const KINDS = ['work', 'spec', 'spec-sync'];
const JIRA_RE = /^[A-Z][A-Z0-9]+-\d+$/;
const INPUT_KEYS = ['kind', 'title', 'jira', 'figma', 'refs', 'ui', 'ac', 'depends', 'specPath', 'discoveredFrom'];
const VAGUE = /\b(correctly|properly|appropriately|as expected|as designed|matches (?:the )?design|looks? (?:good|right|nice)|works(?: fine)?|user-friendly|intuitive|seamless(?:ly)?|clean|nice)\b/i;

const need = (cond, msg) => {
  if (!cond) throw new DcsError(msg);
};
const num = (id) => Number(String(id).slice(1));
const isStr = (s) => typeof s === 'string' && s.trim() !== '';

function get(state, id) {
  const t = state.tasks.find((x) => x.id === id);
  need(t, `unknown task: ${id}`);
  return t;
}

function isFigmaUrl(u) {
  try {
    const host = new URL(u).hostname;
    return host === 'www.figma.com' || host === 'figma.com';
  } catch {
    return false;
  }
}

function isUnder(rel, dir) {
  const r = path.posix.normalize(String(rel));
  const d = path.posix.normalize(String(dir)).replace(/\/+$/, '');
  return !r.startsWith('..') && !path.posix.isAbsolute(r) && r.startsWith(`${d}/`);
}

function findCycle(list) {
  const byId = new Map(list.map((t) => [t.id, t]));
  const mark = new Map();
  const visit = (id, trail) => {
    if (mark.get(id) === 'done') return null;
    if (mark.get(id) === 'open') return [...trail, id];
    mark.set(id, 'open');
    for (const dep of (byId.get(id) && byId.get(id).depends) || []) {
      const cycle = visit(dep, [...trail, id]);
      if (cycle) return cycle;
    }
    mark.set(id, 'done');
    return null;
  };
  for (const t of list) {
    const cycle = visit(t.id, []);
    if (cycle) return cycle;
  }
  return null;
}

function validate(state, { specsDir }) {
  if (!state || state.version !== 1 || !Array.isArray(state.tasks)) return ['tasks file must be {"version": 1, "tasks": [...]}'];
  const p = [];
  const ids = new Set();
  for (const t of state.tasks) {
    const at = `task ${t && t.id !== undefined ? t.id : '?'}`;
    if (!t || typeof t !== 'object') {
      p.push(`${at}: must be an object`);
      continue;
    }
    if (!/^t\d+$/.test(String(t.id))) p.push(`${at}: id must look like t<n>`);
    if (ids.has(t.id)) p.push(`${at}: duplicate id`);
    ids.add(t.id);
    if (!KINDS.includes(t.kind)) p.push(`${at}: kind must be one of ${KINDS.join(', ')}`);
    if (!isStr(t.title)) p.push(`${at}: title is required`);
    if (!Array.isArray(t.ac) || t.ac.length === 0 || !t.ac.every(isStr)) p.push(`${at}: ac needs at least one non-empty string`);
    if (t.jira !== null && !JIRA_RE.test(String(t.jira))) p.push(`${at}: jira must be null or like APP2X-123`);
    if (!Array.isArray(t.figma) || !t.figma.every(isFigmaUrl)) p.push(`${at}: figma must be an array of figma.com URLs`);
    if (!Array.isArray(t.refs) || !t.refs.every(isStr)) p.push(`${at}: refs must be an array of paths`);
    if (!Array.isArray(t.depends)) p.push(`${at}: depends must be an array`);
    if (typeof t.ui !== 'boolean') p.push(`${at}: ui must be true or false`);
    if (!STATUSES.includes(t.status)) p.push(`${at}: invalid status ${t.status}`);
    if (!Array.isArray(t.history)) p.push(`${at}: history must be an array`);
    if (t.kind === 'work' && t.specPath !== null) p.push(`${at}: work tasks must have specPath null`);
    if (t.kind === 'spec' || t.kind === 'spec-sync') {
      if (t.ui !== false) p.push(`${at}: ${t.kind} tasks must have ui false`);
      if (!specsDir) p.push(`${at}: ${t.kind} tasks need settings.specs`);
      else if (!isStr(t.specPath) || !t.specPath.endsWith('.spec.md') || !isUnder(t.specPath, specsDir)) {
        p.push(`${at}: specPath must be a .spec.md file under ${specsDir}`);
      }
    }
  }
  for (const t of state.tasks) {
    if (!t || typeof t !== 'object') continue;
    for (const dep of (Array.isArray(t.depends) && t.depends) || []) {
      if (!ids.has(dep)) p.push(`task ${t.id}: unknown dependency ${dep}`);
    }
    if (t.discoveredFrom !== null && t.discoveredFrom !== undefined && !ids.has(t.discoveredFrom)) {
      p.push(`task ${t.id}: discoveredFrom ${t.discoveredFrom} is not a task`);
    }
  }
  const cycle = findCycle(state.tasks.filter((t) => t && Array.isArray(t.depends)));
  if (cycle) p.push(`dependency cycle: ${cycle.join(' -> ')}`);
  return p;
}

function lint(list) {
  const warnings = [];
  list.forEach((raw, idx) => {
    if (!raw || typeof raw !== 'object') return;
    const i = idx + 1;
    if (Array.isArray(raw.ac)) {
      raw.ac.forEach((ac, j) => {
        const m = typeof ac === 'string' ? VAGUE.exec(ac) : null;
        if (m) warnings.push(`warning: task #${i} ac ${j + 1} uses vague wording "${m[0]}"`);
      });
      if (raw.ac.length > 5) warnings.push(`warning: task #${i} has ${raw.ac.length} AC items (keep it to 5 or fewer)`);
    }
    if (typeof raw.title === 'string') {
      const words = raw.title.trim().split(/\s+/).filter(Boolean).length;
      if (words > 6) warnings.push(`warning: task #${i} title has ${words} words (keep it to 6 or fewer)`);
    }
  });
  return warnings;
}

function resolveDep(dep, ids, i) {
  const m = /^#(\d+)$/.exec(String(dep));
  if (!m) return dep;
  const k = Number(m[1]) - 1;
  need(k >= 0 && k < ids.length, `task #${i + 1}: depends ${dep} is outside this batch`);
  return ids[k];
}

function add(state, input, ctx) {
  const list = Array.isArray(input) ? input : [input];
  need(list.length > 0, 'no tasks given');
  let n = Math.max(0, ...state.tasks.map((t) => num(t.id)));
  const ids = list.map(() => `t${(n += 1)}`);
  const created = list.map((raw, i) => {
    need(raw && typeof raw === 'object' && !Array.isArray(raw), `task #${i + 1} must be a JSON object`);
    const unknown = Object.keys(raw).filter((k) => !INPUT_KEYS.includes(k));
    need(unknown.length === 0, `task #${i + 1}: unknown field(s): ${unknown.join(', ')}`);
    const kind = raw.kind === undefined ? 'work' : raw.kind;
    let depends = raw.depends === undefined ? [] : raw.depends;
    if (Array.isArray(depends)) depends = depends.map((d) => resolveDep(d, ids, i));
    return {
      id: ids[i],
      kind,
      title: raw.title,
      jira: raw.jira === undefined ? null : raw.jira,
      figma: raw.figma === undefined ? [] : raw.figma,
      refs: raw.refs === undefined ? [] : raw.refs,
      ui: kind === 'work' || raw.ui !== undefined ? raw.ui : false,
      ac: raw.ac,
      depends,
      discoveredFrom: raw.discoveredFrom === undefined ? null : raw.discoveredFrom,
      status: 'todo',
      failures: 0,
      verifyFailStreak: 0,
      reviewRound: 1,
      branch: null,
      baseSha: null,
      worktree: null,
      landed: false,
      landedOn: null,
      reverified: false,
      setupLockHash: null,
      commit: null,
      verify: null,
      qa: null,
      reviews: [],
      decisions: [],
      specPath: raw.specPath === undefined ? null : raw.specPath,
      specApproval: null,
      history: [{ status: 'todo', at: ctx.at }],
    };
  });
  const problems = validate({ ...state, tasks: [...state.tasks, ...created] }, ctx);
  for (const t of created) {
    for (const ref of Array.isArray(t.refs) ? t.refs : []) {
      if (isStr(ref) && !ctx.refExists(ref)) problems.push(`task ${t.id}: refs path does not exist: ${ref}`);
    }
  }
  need(problems.length === 0, `nothing added:\n- ${problems.join('\n- ')}`);
  if (!ctx.dryRun) state.tasks.push(...created);
  return { ids, warnings: lint(list) };
}

function ready(state, n) {
  const done = new Set(state.tasks.filter((t) => t.status === 'done').map((t) => t.id));
  return state.tasks
    .filter((t) => t.status === 'todo' && t.depends.every((d) => done.has(d)))
    .sort((a, b) => num(a.id) - num(b.id))
    .slice(0, n);
}

function setRunStart(state, at) {
  state.runStartedAt = at;
  return at;
}

function decide(state, id, q, a, at, why) {
  const t = get(state, id);
  need(isStr(q) && isStr(a), 'decide needs a non-empty --q and --a');
  t.decisions.push({ q: q.trim(), a: a.trim(), why: isStr(why) ? why.trim() : null, at });
  return t;
}

function listDecisions(state, { run }) {
  need(!run || state.runStartedAt, 'no run started yet (the Captain runs "dcs run" when /dcs:work starts)');
  return state.tasks
    .flatMap((t) => t.decisions.map((d) => ({ task: t.id, ...d })))
    .filter((d) => !run || d.at >= state.runStartedAt)
    .sort((x, y) => x.at.localeCompare(y.at));
}

function recordHistory(before, state, at) {
  for (const t of state.tasks) {
    if (before.has(t.id) && before.get(t.id) !== t.status) t.history.push({ status: t.status, at });
  }
}

const FAILURE_CAP = 3;
const VERIFY_STREAK = 3;

function addFailure(t) {
  t.failures += 1;
  t.status = t.failures >= FAILURE_CAP ? 'blocked' : 'doing';
}

function assertStartable(state, id) {
  const t = get(state, id);
  need(t.status === 'todo', `${id} is ${t.status}, not todo`);
  const waiting = t.depends.filter((d) => get(state, d).status !== 'done');
  need(waiting.length === 0, `${id} waits on: ${waiting.join(', ')}`);
  return t;
}

function start(state, id, { branch, baseSha, worktree, setupLockHash }) {
  const t = assertStartable(state, id);
  Object.assign(t, { status: 'doing', branch, baseSha, worktree: worktree || null, setupLockHash: setupLockHash || null });
  return t;
}

const canVerify = (t) => t.status === 'doing' || t.status === 'verified' || (t.status === 'approved' && t.landed);

// ponytail: "at most 3 verify runs per dispatch" is enforced as "3 consecutive failed verifies = 1 failure"
function applyVerify(state, id, record) {
  const t = get(state, id);
  need(canVerify(t), `${id} is ${t.status}; verify needs doing or verified`);
  t.verify = record;
  if (record.setupLockHash !== undefined) t.setupLockHash = record.setupLockHash;
  const wasApproved = t.status === 'approved';
  if (record.skipped || record.results.every((r) => r.exit === 0)) {
    t.status = wasApproved ? 'approved' : 'verified';
    t.verifyFailStreak = 0;
    if (t.landed) t.reverified = true;
    return t;
  }
  if (wasApproved) {
    // a failed re-verify after land counts as a failure straight away (spec §3 failure cap)
    t.verifyFailStreak = 0;
    t.reverified = false;
    addFailure(t);
    return t;
  }
  t.status = 'doing';
  t.verifyFailStreak += 1;
  if (t.verifyFailStreak >= VERIFY_STREAK) {
    t.verifyFailStreak = 0;
    addFailure(t);
  }
  return t;
}

const MAX_INVALID_QA = 2;
const SEVERITIES = ['critical', 'major', 'minor'];

function requiredPasses(t) {
  if (t.kind === 'spec') return ['ac', 'a11y'];
  if (t.kind === 'spec-sync') return ['ac'];
  return ['ac', 'security', 'performance', 'quality', ...(t.ui ? ['a11y'] : [])];
}

function normalizeFindings(t, pass, raw, quoteOk) {
  need(raw && typeof raw === 'object' && !Array.isArray(raw) && Array.isArray(raw.findings), 'findings file needs a "findings" array');
  const findings = raw.findings.map((f, n) => {
    need(f && typeof f === 'object' && !Array.isArray(f), `finding #${n + 1} must be an object`);
    need(SEVERITIES.includes(f.severity), `finding ${isStr(f.id) ? f.id : `#${n + 1}`}: severity must be critical, major or minor`);
    const out = { ...f };
    if (f.severity !== 'minor' && !f.refuted && !quoteOk(f.file, f.quote)) out.downgraded = 'quote not found';
    return out;
  });
  let blocking = findings.filter((f) => f.severity !== 'minor' && !f.refuted && !f.downgraded).length;
  const refuted = findings.filter((f) => f.refuted === true).length;
  const downgraded = findings.filter((f) => f.downgraded).length;
  let acResults;
  if (pass === 'ac') {
    const n = t.ac.length;
    const r = raw.acResults;
    const ok = Array.isArray(r) && r.length === n && r.every((x) => x && Number.isInteger(x.i) && typeof x.met === 'boolean') &&
      new Set(r.map((x) => x.i)).size === n && r.every((x) => x.i >= 1 && x.i <= n);
    need(ok, `ac pass needs acResults covering AC 1..${n} exactly once`);
    acResults = r;
    blocking += r.filter((x) => !x.met).length;
  }
  return { findings, acResults, blocking, refuted, downgraded };
}

function applyReview(state, id, { pass, blocking, refuted, downgraded, fingerprint, findings, at }) {
  const t = get(state, id);
  need(t.status === 'verified', `${id} is ${t.status}; review needs verified`);
  const passes = requiredPasses(t);
  need(passes.includes(pass), `${id} does not take a ${pass} pass (it needs: ${passes.join(', ')})`);
  need(t.verify && t.verify.fingerprint === fingerprint, `${id} changed since verify; run dcs verify ${id} again`);
  const round = t.reviewRound;
  const verdict = blocking > 0 ? 'changes' : 'approve';
  t.reviews = t.reviews.filter((r) => !(r.round === round && r.pass === pass));
  t.reviews.push({ round, pass, verdict, blocking, refuted, downgraded, fingerprint, findings: findings || null, at });
  const current = t.reviews.filter((r) => r.round === round && r.fingerprint === t.verify.fingerprint);
  if (!passes.every((p) => current.some((r) => r.pass === p))) return { task: t, complete: false, verdict };
  t.reviewRound += 1;
  if (current.every((r) => r.verdict === 'approve')) t.status = 'approved';
  else addFailure(t);
  return { task: t, complete: true, verdict };
}

function markLanded(state, id, landedOn) {
  const t = get(state, id);
  need(t.status === 'approved', `${id} is ${t.status}; land needs approved`);
  need(t.worktree, `${id} has no worktree to land`);
  t.worktree = null;
  t.landed = true;
  t.landedOn = landedOn || null;
  t.reverified = false;
  return t;
}

const needReverify = (t) => need(!(t.landed && !t.reverified), `${t.id} needs dcs verify ${t.id} after landing`);

function applyQa(state, id, { result, dir, at }) {
  const t = get(state, id);
  need(t.status === 'approved', `${id} is ${t.status}; QA needs approved`);
  need(!t.worktree, `${id} is still in a worktree; run dcs land ${id} first`);
  needReverify(t);
  const invalid = (t.qa && t.qa.invalid) || 0;
  if (result === 'invalid') {
    need(invalid < MAX_INVALID_QA, `${id} already had ${MAX_INVALID_QA} invalid captures; the Captain must ask Navin`);
    t.qa = { result: (t.qa && t.qa.result) || null, invalid: invalid + 1, dir, at };
    return t;
  }
  t.qa = { result, invalid: 0, dir, at };
  if (result === 'fail') addFailure(t);
  return t;
}

function approveSpec(state, id, at) {
  const t = get(state, id);
  need(t.kind === 'spec', `${id} is a ${t.kind} task; only spec tasks are approved with approve-spec`);
  need(t.status === 'approved', `${id} is ${t.status}; approve-spec needs approved`);
  t.specApproval = { at };
  return t;
}

function applyDone(state, id, { commit, noChanges, diffEmpty, visualQa }) {
  const t = get(state, id);
  need(t.status === 'approved', `${id} is ${t.status}; done needs approved`);
  need(!t.worktree, `${id} is still in a worktree; run dcs land ${id} first`);
  needReverify(t);
  need(!noChanges || t.kind === 'spec-sync', '--no-changes is only for spec-sync tasks');
  if (t.ui && visualQa !== false) need(t.qa && t.qa.result === 'pass', `${id} needs a passing visual QA first (dcs qa)`);
  if (t.kind === 'spec') need(t.specApproval, `${id} needs dcs approve-spec first`);
  if (noChanges) {
    need(diffEmpty, `${id} has changes; commit them and use --commit instead`);
    t.commit = null;
  } else {
    need(/^[0-9a-f]{7,40}$/.test(String(commit || '')), 'done needs --commit <sha> or --no-changes');
    t.commit = commit;
  }
  t.status = 'done';
  return t;
}

function unblock(state, id) {
  const t = get(state, id);
  need(t.status === 'blocked', `${id} is ${t.status}, not blocked`);
  Object.assign(t, { status: 'doing', failures: 0, verifyFailStreak: 0 });
  return t;
}

function setBaseline(state, baseline) {
  state.baseline = baseline;
  return baseline;
}

const round2 = (x) => Math.round(x * 100) / 100;
const has = (t, status) => t.history.some((h) => h.status === status);

function stats(state) {
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const t of state.tasks) byStatus[t.status] += 1;
  const started = state.tasks.filter((t) => has(t, 'doing'));
  const done = state.tasks.filter((t) => t.status === 'done');
  const firstPass = done.filter((t) => {
    const i = t.history.findIndex((h) => h.status === 'verified');
    return i === -1 || !t.history.slice(i + 1).some((h) => h.status === 'doing');
  });
  const approved = state.tasks.filter((t) => has(t, 'approved'));
  const passes = {};
  for (const r of state.tasks.flatMap((t) => t.reviews)) {
    const p = (passes[r.pass] = passes[r.pass] || { rounds: 0, blocking: 0, refuted: 0, downgraded: 0 });
    p.rounds += 1;
    p.blocking += r.blocking || 0;
    p.refuted += r.refuted || 0;
    p.downgraded += r.downgraded || 0;
  }
  return {
    tasks: state.tasks.length,
    byStatus,
    firstPassRate: done.length ? round2(firstPass.length / done.length) : 0,
    meanReviewRounds: approved.length ? round2(approved.reduce((n, t) => n + t.reviewRound - 1, 0) / approved.length) : 0,
    blockedRate: started.length ? round2(state.tasks.filter((t) => has(t, 'blocked')).length / started.length) : 0,
    passes,
    decisions: state.tasks.reduce((n, t) => n + t.decisions.length, 0),
  };
}

const IN_FLIGHT = ['doing', 'verified', 'approved', 'blocked'];

function brief(state, { repoName, pluginRoot, notes }) {
  const flying = state.tasks.filter((t) => IN_FLIGHT.includes(t.status));
  if (!flying.length) return '';
  const since = state.runStartedAt;
  const decisions = since ? state.tasks.flatMap((t) => t.decisions).filter((d) => d.at >= since).length : 0;
  const lines = [`dcs: work in flight in ${repoName}`, `run started ${since || 'not recorded'}`];
  for (const t of flying) {
    let line = `- ${t.id} ${t.status} · failures ${t.failures} · "${t.title}" · last note: ${notes(t.id) || 'none'}`;
    if (t.worktree) line += ` · worktree ${t.worktree}`;
    if (t.landed && !t.reverified) line += ' · needs re-verify';
    lines.push(line);
  }
  lines.push(`decisions this run: ${decisions}`);
  lines.push(`Captain: re-read ${pluginRoot}/references/captain.md, then run dcs list and dcs decisions --run before continuing. Crew agents from before may be gone: re-dispatch with the last note.`);
  return `${lines.join('\n')}\n`;
}

module.exports = {
  setBaseline, stats, brief,
  STATUSES, KINDS, validate, lint, get, add, ready, setRunStart, decide, listDecisions, recordHistory,
  addFailure, assertStartable, start, canVerify, applyVerify,
  requiredPasses, normalizeFindings, applyReview, markLanded, applyQa, approveSpec, applyDone, unblock,
};
