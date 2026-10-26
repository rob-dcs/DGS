'use strict';
const fs = require('node:fs');
const path = require('node:path');

// ponytail: Bash rules are quote-aware token matches, not a shell parser (spec §6 known ceilings)
const SECRETS = [
  'gh[opsru]_[A-Za-z0-9]{36}',
  'github_pat_\\w{22,}',
  'npm_[A-Za-z0-9]{36}',
  'glpat-[A-Za-z0-9_-]{20,}',
  '(?:sk|rk)_live_[A-Za-z0-9]{20,}',
  'xox[baprs]-[A-Za-z0-9-]{10,}',
  'hooks\\.slack\\.com/(?:services|workflows|triggers)/\\S+',
  'sk-[A-Za-z0-9_-]*T3BlbkFJ[A-Za-z0-9_-]+',
  'sk-ant-[A-Za-z0-9_-]{20,}',
  'ATATT3[A-Za-z0-9_=-]{50,}',
  'SG\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}',
  '\\b(?:AKIA|ASIA)[A-Z2-7]{16}\\b',
  // 64 base64 chars after the header, allowing whitespace or escaped \\n (PEM, indented literals, JSON strings); prose never has 64 in a row
  '-----BEGIN [A-Z ]*PRIVATE KEY-----(?:\\s|\\\\n)*[A-Za-z0-9+/=]{64}',
].map((src) => new RegExp(src, 'g'));

const SHELLS = ['sh', 'bash', 'zsh', 'dash'];
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '!', '{', '}']);
const SKIP_HEADS = new Set(['for', 'case', 'select']);
const WRAP_SIMPLE = new Set(['command', 'builtin', 'nohup', 'time', 'exec', 'noglob']);
const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
const APPROVALS = ['G1', 'G4', 'G5', 'G6', 'G7', 'G8', 'G10'];
// the live hook sends "dcs:worker" (smoke test 2026-09-30); the docs describe "plugin:dcs:worker"; accept both
const roleOf = (agent) => (/^(?:plugin:)?dcs:(worker|reviewer)$/.exec(agent || '') || [])[1] || null;
const WORKER_DCS = ['verify', 'show', 'diff', 'list', 'next', 'decisions', 'check', 'brief', 'stats'];
const REVIEWER_DCS = ['diff', 'show', 'list', 'decisions'];
const WORKER_GIT_DENY = ['commit', 'push', 'merge', 'rebase', 'reset', 'tag', 'cherry-pick', 'revert'];
const REVIEWER_GIT = ['diff', 'log', 'show', 'status', 'blame', 'rev-parse', 'ls-files'];
const KNOWN_GIT = new Set(('add am apply bisect blame branch cat-file checkout cherry-pick clean clone commit config credential describe diff fetch ' +
  'for-each-ref format-patch gc grep hash-object help init log ls-files ls-remote merge mv notes pull push read-tree rebase reflog remote ' +
  'reset restore rev-parse revert rm shortlog show stash status submodule switch symbolic-ref tag update-index version worktree write-tree').split(' '));
const GH_WRITES = {
  pr: ['create', 'merge', 'close', 'reopen', 'comment', 'review', 'edit', 'ready'],
  issue: ['create', 'close', 'comment', 'edit'],
  release: ['create', 'delete', 'edit', 'upload'],
  repo: ['create', 'delete', 'edit', 'rename', 'archive'],
  workflow: ['run', 'enable', 'disable'],
  gist: ['create', 'edit', 'delete'],
  secret: ['set', 'delete'],
  variable: ['set', 'delete'],
};

function secretMatches(text) {
  const found = [];
  for (const re of SECRETS) {
    for (const m of String(text).matchAll(re)) if (!m[0].includes('EXAMPLE')) found.push(m[0]);
  }
  return found;
}
const hasSecret = (text) => secretMatches(text).length > 0;

function mask(text) {
  let t = String(text);
  for (const m of secretMatches(t)) t = t.split(m).join('[redacted]');
  return t;
}

// ---- tokenizing ----

const HEREDOC_RE = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\n|$)/g;

function extractHeredocs(text) {
  const found = [];
  for (const m of text.matchAll(HEREDOC_RE)) {
    const lineStart = text.lastIndexOf('\n', m.index) + 1;
    found.push({ opener: text.slice(lineStart, m.index), body: m[3] });
  }
  return found;
}

const stripHeredocs = (text) => text.replace(HEREDOC_RE, (m) => m.split('\n')[0]);

// One quote-aware pass, the way the shell reads words: adjacent quoted/unquoted parts join into one word,
// backslash-newline continues a line, `#` at a word start begins a comment, and $(…)/`…` bodies (also inside
// double quotes) are collected so they can be analysed too.
function readParen(src, open) {
  let depth = 0;
  let q = null;
  for (let j = open; j < src.length; j += 1) {
    const c = src[j];
    if (q) {
      if (c === '\\' && q === '"') j += 1;
      else if (c === q) q = null;
      continue;
    }
    if (c === "'" || c === '"') q = c;
    else if (c === '(') depth += 1;
    else if (c === ')' && --depth === 0) return [src.slice(open + 1, j), j];
  }
  return [src.slice(open + 1), src.length];
}

function readTick(src, open) {
  const j = src.indexOf('`', open + 1);
  return j < 0 ? [src.slice(open + 1), src.length] : [src.slice(open + 1, j), j];
}

function scan(text) {
  const src = stripHeredocs(text);
  const segs = [];
  const subs = [];
  let words = [];
  let word = '';
  let inWord = false;
  let utext = '';
  let afterPipe = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endSeg = (nextPipe) => {
    endWord();
    if (words.length) segs.push({ words, afterPipe, utext });
    words = [];
    utext = '';
    afterPipe = nextPipe;
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '#' && !inWord) {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl;
    } else if (c === '\\') {
      if (src[i + 1] !== '\n') {
        word += src[i + 1] === undefined ? '' : src[i + 1];
        inWord = true;
        utext += 'x';
      }
      i += 2;
    } else if (c === "'") {
      const j = src.indexOf("'", i + 1);
      const stop = j < 0 ? src.length : j;
      word += src.slice(i + 1, stop);
      inWord = true;
      utext += "''";
      i = stop + 1;
    } else if (c === '"') {
      let j = i + 1;
      inWord = true;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          word += src[j + 1];
          j += 2;
        } else if (src[j] === '$' && src[j + 1] === '(') {
          const [body, stop] = readParen(src, j + 1);
          subs.push(body);
          word += '$(…)';
          j = stop + 1;
        } else if (src[j] === '`') {
          const [body, stop] = readTick(src, j);
          subs.push(body);
          word += '`…`';
          j = stop + 1;
        } else {
          word += src[j];
          j += 1;
        }
      }
      utext += '""';
      i = j + 1;
    } else if (c === '$' && src[i + 1] === '(') {
      const [body, stop] = readParen(src, i + 1);
      subs.push(body);
      word += '$(…)';
      inWord = true;
      utext += '$()';
      i = stop + 1;
    } else if (c === '`') {
      const [body, stop] = readTick(src, i);
      subs.push(body);
      word += '`…`';
      inWord = true;
      utext += '``';
      i = stop + 1;
    } else if (src.startsWith('&&', i) || src.startsWith('||', i)) {
      endSeg(false);
      i += 2;
    } else if (c === '|') {
      endSeg(true);
      i += 1;
    } else if (c === '&' && (src[i - 1] === '>' || src[i + 1] === '>')) {
      word += c;
      inWord = true;
      utext += c;
      i += 1;
    } else if (';&\n()'.includes(c)) {
      endSeg(false);
      i += 1;
    } else if (/\s/.test(c)) {
      endWord();
      utext += ' ';
      i += 1;
    } else {
      word += c;
      inWord = true;
      utext += c;
      i += 1;
    }
  }
  endSeg(false);
  return { segs, subs };
}

const normWord = (w) => path.basename(String(w).replace(/^\\/, '').replace(/""|''/g, ''));

function prep(tk) {
  const assign = {};
  let t = tk.slice();
  const dropFlags = (valued = []) => {
    while (t.length && t[0].startsWith('-')) {
      const f = t.shift();
      if (valued.includes(f)) t.shift();
    }
  };
  while (t.length) {
    const w = normWord(t[0]);
    if (KEYWORDS.has(t[0])) {
      t = t.slice(1);
    } else if (/^[A-Za-z_]\w*=/.test(t[0])) {
      const eq = t[0].indexOf('=');
      assign[t[0].slice(0, eq)] = t[0].slice(eq + 1);
      t = t.slice(1);
    } else if (WRAP_SIMPLE.has(w)) {
      t = t.slice(1);
    } else if (w === 'env') {
      t = t.slice(1);
      dropFlags(['-u']);
    } else if (w === 'nice') {
      t = t.slice(1);
      dropFlags(['-n']);
    } else if (w === 'timeout') {
      t = t.slice(1);
      dropFlags(['-s', '-k']);
      if (t.length && /^\d+(\.\d+)?[smhd]?$/.test(t[0])) t.shift();
    } else if (w === 'stdbuf') {
      t = t.slice(1);
      dropFlags();
    } else if (w === 'xargs') {
      t = t.slice(1);
      dropFlags(['-I', '-n', '-P', '-L', '-d', '-E', '-s']);
    } else break;
  }
  if (t.length && SKIP_HEADS.has(t[0])) return null;
  return { tk: t, assign };
}

// ---- paths ----

const expandHome = (p, home) => String(p).replace(/^~(?=\/|$)/, home).replace(/^\$\{?HOME\}?(?=\/|$)/, home);

function isProtected(p, home) {
  if (!p) return false;
  const e = expandHome(p, home);
  const base = path.basename(e);
  if (base === '.env.example') return false;
  if (base === '.env' || base.startsWith('.env.')) return true;
  if (/\.(pem|key|p12|p8|jks|keystore)$/i.test(base)) return true;
  if (['keystore.properties', '.npmrc', '.netrc', '.git-credentials'].includes(base)) return true;
  if (/(^|\/)\.(ssh|aws|gnupg|kube|appstoreconnect)(\/|$)/.test(e)) return true;
  return e === `${home}/.gradle/gradle.properties` || e === `${home}/.docker/config.json` || e === `${home}/.config/gh` || e.startsWith(`${home}/.config/gh/`);
}

function isProtectedGlob(glob, home) {
  const base = path.basename(String(glob));
  if (/\.env\.example$/.test(base)) return false;
  if (/\.env/.test(base)) return true;
  if (/\.(pem|key|p12|p8|jks|keystore)\b/i.test(base)) return true;
  return ['keystore.properties', '.npmrc', '.netrc', '.git-credentials'].some((n) => base.includes(n)) || isProtected(glob, home);
}

function realish(p) {
  let cur = p;
  const rest = [];
  while (cur !== path.dirname(cur)) {
    try {
      return path.join(fs.realpathSync(cur), ...rest.reverse());
    } catch {
      rest.push(path.basename(cur));
      cur = path.dirname(cur);
    }
  }
  return p;
}

const inside = (p, root) => !!root && (p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep));

function outsideScope(filePath, ctx) {
  const abs = path.resolve(ctx.cwd, expandHome(filePath, ctx.home));
  const candidates = [abs, realish(abs)];
  const projects = path.join(ctx.home, '.claude', 'projects');
  if (candidates.some((p) => inside(p, projects) && /^[^/]+\/memory\//.test(path.relative(projects, p)))) return false;
  const roots = [ctx.repoRoot || ctx.cwd, ctx.mainRoot, ctx.worktreesDir, ctx.tmpdir, '/tmp', '/private/tmp'];
  return !candidates.some((p) => roots.some((r) => inside(p, r)));
}

// ---- rules ----

const short = (a, ch) => /^-[a-zA-Z]+$/.test(a) && a.includes(ch);

function gitCall(tk) {
  if (normWord(tk[0]) !== 'git') return null;
  const cvals = [];
  let i = 1;
  while (i < tk.length && tk[i].startsWith('-')) {
    if (tk[i] === '-c') {
      cvals.push(tk[i + 1] || '');
      i += 2;
    } else if (['-C', '--git-dir', '--work-tree', '--namespace'].includes(tk[i])) i += 2;
    else i += 1;
  }
  return { sub: tk[i], args: tk.slice(i + 1), offset: i + 1, cvals };
}

function commitRules({ args, offset }, raw, ctx, hit, skip) {
  const clusters = [];
  let attached = false;
  args.forEach((a, i) => {
    if (skip.has(offset + i)) return;
    if (a === '-m' || a === '--message' || /^-[a-zA-Z]*m$/.test(a)) skip.add(offset + i + 1);
    const m = /^-([a-zA-Z]*?)m(.+)$/s.exec(a);
    if (a.startsWith('--message=') || (m && !a.startsWith('--'))) {
      skip.add(offset + i);
      attached = true;
      if (m && m[1]) clusters.push(`-${m[1]}`);
    }
  });
  const flags = [...args.filter((_, i) => !skip.has(offset + i)), ...clusters];
  hit('ask', 'G1', 'git commit needs your approval');
  if (flags.some((a) => a === '--no-verify' || short(a, 'n'))) hit('deny', 'D3', '--no-verify is not allowed');
  const fi = args.findIndex((a) => a === '-F' || a === '--file');
  const eq = args.find((a) => a.startsWith('--file='));
  const fileArg = fi >= 0 ? args[fi + 1] || null : eq ? eq.slice(7) : null;
  const hasMsg = attached || fileArg !== null || flags.some((a) => a === '-m' || a.startsWith('--message') || short(a, 'm'));
  if (!hasMsg) return; // editor commit: message not inspectable, G1 still asks
  if (ctx.contextError) {
    hit('deny', 'G3', `dcs files unreadable (${ctx.contextError}); fix them before committing`);
    return;
  }
  const msg = raw + (fileArg && fileArg !== '-' ? `\n${ctx.readFile(fileArg)}` : '');
  if (/co-authored-by/i.test(msg)) hit('deny', 'G2', 'Co-Authored-By lines are not allowed');
  if (ctx.requireFixesTrailer && !/Fixes:\s*[A-Z][A-Z0-9]+-\d+/.test(msg)) hit('deny', 'G3', 'this repo requires a "Fixes: <KEY>-<n>" trailer');
  const keys = ctx.approvedKeys || [];
  const esc = (k) => String(k).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (keys.length && !keys.some((k) => new RegExp(`Fixes:\\s*${esc(k)}(?!\\d)`).test(msg))) {
    hit('deny', 'G3', `add a "Fixes: <key>" trailer for one of the approved tasks: ${keys.join(', ')}`);
  }
}

function pushRules({ args }, ctx, hit) {
  hit('ask', 'G4', 'git push needs your approval');
  if (args.some((a) => a === '--force' || a.startsWith('--force-with-lease') || short(a, 'f'))) {
    hit('deny', 'D2', 'force push is not allowed; run it yourself if you really need it');
  }
  if (args.includes('--no-verify')) hit('deny', 'D3', '--no-verify is not allowed');
  if (args.includes('--all') || args.includes('--mirror')) hit('deny', 'D4', 'pushing every branch (--all/--mirror) is not allowed');
  const pos = args.filter((a) => !a.startsWith('-'));
  if (pos.slice(1).some((r) => r.startsWith('+'))) hit('deny', 'D2', 'force push (+refspec) is not allowed');
  const targets = pos.length > 1 ? pos.slice(1).map((r) => r.replace(/^\+/, '').split(':').pop()) : [ctx.currentBranch];
  const resolved = targets.map((t) => String(t === 'HEAD' ? ctx.currentBranch : t || '').replace(/^refs\/heads\//, ''));
  if (resolved.some((t) => t === 'main' || t === 'master')) hit('deny', 'D4', 'pushing to main/master is not allowed');
}

function gitRules(g, raw, ctx, hit, skip, assign, agent, depth) {
  const { sub, args } = g;
  if (g.cvals.some((v) => /^alias\./i.test(v) || /^core\.hookspath=/i.test(v))) {
    hit('deny', 'D3', 'git -c alias/core.hooksPath overrides are not allowed');
  }
  if ((sub === 'commit' || sub === 'push') && ['HUSKY', 'HUSKY_SKIP_HOOKS', 'LEFTHOOK', 'SKIP'].some((k) => k in assign)) {
    hit('deny', 'D3', 'skipping git hooks is not allowed');
  }
  if (sub && !KNOWN_GIT.has(sub)) {
    const exp = ctx.gitAlias(sub);
    if (exp) {
      if (exp.startsWith('!')) analyze(exp.slice(1), ctx, hit, depth + 1, agent);
      else analyze(`git ${exp} ${args.join(' ')}`, ctx, hit, depth + 1, agent);
      return;
    }
  }
  if (sub === 'commit') commitRules(g, raw, ctx, hit, skip);
  if (sub === 'push') pushRules(g, ctx, hit);
  if (sub === 'reset' && (args.includes('--hard') || args.includes('--merge'))) hit('ask', 'D5', `git reset ${args.includes('--hard') ? '--hard' : '--merge'} discards work`);
  if (sub === 'clean' && args.some((a) => a === '--force' || short(a, 'f'))) hit('ask', 'D5', 'git clean -f deletes files');
  if (sub === 'checkout') {
    const dd = args.indexOf('--');
    if (args.includes('.') || args.includes('-f') || args.includes('--force') || (dd >= 0 && dd < args.length - 1)) {
      hit('ask', 'D5', 'git checkout discards local changes');
    }
  }
  if (sub === 'restore' && !(args.includes('--staged') && !args.includes('--worktree') && !args.includes('-W'))) {
    hit('ask', 'D5', 'git restore discards local changes');
  }
  if (sub === 'switch' && args.some((a) => a === '-f' || a === '--force' || a === '--discard-changes')) hit('ask', 'D5', 'git switch --force discards local changes');
  if (sub === 'branch' && (args.some((a) => short(a, 'D')) || (args.includes('--delete') && args.includes('--force')))) {
    hit('ask', 'D5', 'git branch -D deletes a branch');
  }
  if (sub === 'stash' && ['drop', 'clear'].includes(args[0])) hit('ask', 'D5', `git stash ${args[0]} deletes stashed work`);
  if (sub === 'credential' && args[0] === 'fill') hit('deny', 'S3', 'reading stored credentials is not allowed');
  if (roleOf(agent) === 'worker' && WORKER_GIT_DENY.includes(sub)) hit('deny', 'R1', `workers never run git ${sub}`);
  if (roleOf(agent) === 'reviewer' && sub && !REVIEWER_GIT.includes(sub)) hit('deny', 'R2', `the reviewer is read-only (git ${sub})`);
}

const API_VALUE_FLAGS = new Set(['-X', '--method', '-f', '-F', '--field', '--raw-field', '-H', '--header', '--input', '-q', '--jq', '-t', '--template',
  '--cache', '-p', '--preview', '--hostname']);
const REVIEW_REPLY = /^\/?repos\/[^/]+\/[^/]+\/pulls\/\d+\/comments\/\d+\/replies$/;

function apiCall(rest) {
  const call = { method: null, input: false, endpoint: null, fields: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const t = rest[i];
    const eq = /^(--[a-z-]+)=([\s\S]*)$/.exec(t);
    const flag = eq ? eq[1] : t;
    if (API_VALUE_FLAGS.has(flag)) {
      const v = eq ? eq[2] : rest[(i += 1)];
      if (flag === '-X' || flag === '--method') call.method = String(v || '').toUpperCase();
      if (['-f', '-F', '--field', '--raw-field'].includes(flag)) call.fields.push(v || '');
      if (flag === '--input') call.input = true;
    } else if (/^-X./.test(t)) call.method = t.slice(2).toUpperCase();
    else if (/^-[fF]./.test(t)) call.fields.push(t.slice(2));
    else if (!t.startsWith('-') && call.endpoint === null) call.endpoint = t;
  }
  return call;
}

// index just past the bracket matching s[i], skipping GraphQL strings, block strings and # comments; -1 if unbalanced
function pastBalanced(s, i, open, close) {
  let depth = 0;
  for (; i < s.length; i += 1) {
    if (s.startsWith('"""', i)) {
      const e = s.indexOf('"""', i + 3);
      if (e < 0) return -1;
      i = e + 2;
    } else if (s[i] === '"') {
      for (i += 1; i < s.length && s[i] !== '"'; i += s[i] === '\\' ? 2 : 1);
      if (i >= s.length) return -1;
    } else if (s[i] === '#') {
      const e = s.indexOf('\n', i);
      if (e < 0) return -1;
      i = e;
    } else if (s[i] === open) depth += 1;
    else if (s[i] === close && (depth -= 1) === 0) return i + 1;
  }
  return -1;
}

// the whole document is exactly `mutation [Name][(vars)] { resolveReviewThread(...) { ... } }`
function onlyResolvesThread(q) {
  const m = /^\s*mutation\b\s*\w*\s*(\([^()]*\))?\s*\{\s*resolveReviewThread\s*\(/.exec(q);
  if (!m) return false;
  let i = pastBalanced(q, m[0].length - 1, '(', ')');
  if (i < 0) return false;
  i += q.slice(i).search(/\S|$/);
  if (q[i] !== '{') return false;
  i = pastBalanced(q, i, '{', '}');
  return i > 0 && /^\s*\}\s*$/.test(q.slice(i));
}

// { what, free } for a gh call that changes GitHub (free: no approval needed, still barred for workers); null for reads
function ghWrite(tk) {
  const pos = [];
  for (let i = 1; i < tk.length; i += 1) {
    if (tk[i] === '-R' || tk[i] === '--repo') i += 1;
    else if (!tk[i].startsWith('-')) pos.push(tk[i]);
  }
  const [a, b] = pos;
  if (GH_WRITES[a] && GH_WRITES[a].includes(b)) return { what: `gh ${a} ${b}` };
  if (a !== 'api') return null;
  const { method, input, endpoint, fields } = apiCall(tk.slice(tk.indexOf('api') + 1));
  if (endpoint === 'graphql') {
    const queries = fields.filter((f) => f.startsWith('query=')).map((f) => f.slice(6));
    const inline = !input && queries.length > 0 && queries.every((q) => !q.startsWith('@'));
    if (inline && queries.every((q) => !/\bmutation\b/.test(q))) return null;
    if (inline && queries.length === 1 && onlyResolvesThread(queries[0])) return { what: 'gh api graphql resolveReviewThread', free: true };
    return { what: 'gh api graphql write' };
  }
  const posts = method === 'POST' || (!method && fields.length > 0);
  if (!input && posts && REVIEW_REPLY.test(endpoint || '')) return { what: 'gh api review-comment reply', free: true };
  if ((method && method !== 'GET') || fields.length || input) return { what: 'gh api write' };
  return null;
}

function maestroRules(tk, assign, ctx, hit) {
  const args = tk.slice(1);
  let sub = null;
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (['--device', '--udid', '-p', '--platform'].includes(a)) i += 2;
    else if (a.startsWith('-')) i += 1;
    else {
      sub = a;
      break;
    }
  }
  const after = sub ? args.slice(i + 1) : [];
  const deny = (why) => hit('deny', 'S4', why);
  if (sub === 'cloud' || sub === 'login') deny(`maestro ${sub} sends data to Maestro Cloud`);
  if (args.some((a) => a === '--analyze' || a.startsWith('--api-key') || a.startsWith('--apiKey'))) deny('Maestro AI analysis and cloud keys send data off the machine');
  if ('MAESTRO_CLOUD_API_KEY' in assign) deny('MAESTRO_CLOUD_API_KEY enables Maestro Cloud');
  if (sub === 'record' && !after.includes('--local')) deny('maestro record without --local uploads the screen capture');
  if (sub === 'test') {
    for (const f of after.filter((a) => /\.ya?ml$/.test(a))) {
      if (/WithA[Ii]\b/.test(ctx.readFile(f))) deny(`${f} uses Maestro AI commands, which run on Maestro Cloud`);
    }
  }
  if (!['true', '1'].includes(assign.MAESTRO_CLI_NO_ANALYTICS)) deny('run maestro with MAESTRO_CLI_NO_ANALYTICS=true inline');
}

// G9: in a repo with settings.prChecks, a PR needs a green `dcs prcheck` on the exact HEAD with a clean tree
function prcheckGate(ctx, hit) {
  let s;
  try {
    s = ctx.prcheck();
  } catch (e) {
    hit('deny', 'G9', `cannot read the prcheck state (${e.message}); run dcs prcheck`);
    return;
  }
  const r = s.record;
  if (s.dirty) hit('deny', 'G9', 'uncommitted changes; commit, then run dcs prcheck');
  else if (!r || r.ok !== true) hit('deny', 'G9', 'no passing dcs prcheck; run it and fix what fails');
  else if (r.sha !== s.head) hit('deny', 'G9', `dcs prcheck passed on ${String(r.sha).slice(0, 7)}, but HEAD is ${String(s.head).slice(0, 7)}; run it again`);
}

function segmentRules(seg, tk, assign, raw, ctx, hit, depth, agent) {
  const head = normWord(tk[0]);
  const skip = new Set();
  if (/^[$`]/.test(tk[0])) hit('ask', 'D6', 'dynamic command word');
  if (['sudo', 'doas', 'su', 'pkexec'].includes(head)) hit('deny', 'D1', `${head} is not allowed`);
  if (SHELLS.includes(head)) {
    const ci = tk.findIndex((a, i) => i > 0 && /^-[a-z]*c$/.test(a));
    if (ci > 0) {
      if (tk[ci + 1] !== undefined) analyze(tk[ci + 1], ctx, hit, depth + 1, agent);
    } else if (tk.slice(1).includes('-s') || (seg.afterPipe && !tk.slice(1).some((a) => !a.startsWith('-') && a !== '/dev/stdin'))) {
      hit('ask', 'D6', 'a shell reading a script from a pipe or stdin');
    }
  }
  if (head === 'eval') analyze(tk.slice(1).join(' '), ctx, hit, depth + 1, agent);
  if (head === 'find') {
    if (tk.includes('-delete')) hit('ask', 'D5', 'find -delete deletes files');
    tk.forEach((t, i) => {
      if (!['-exec', '-execdir', '-ok'].includes(t)) return;
      const inner = [];
      for (let j = i + 1; j < tk.length && ![';', '\\;', '+'].includes(tk[j]); j += 1) inner.push(tk[j]);
      if (inner.length) analyze(inner.join(' '), ctx, hit, depth + 1, agent);
    });
  }
  if (head === 'rm' && tk.slice(1).some((a) => a === '--recursive' || /^-[a-zA-Z]*[rR]/.test(a))) hit('ask', 'D5', 'recursive rm deletes files');
  const dcsArgs = head === 'dcs' ? tk.slice(1) : head === 'node' && normWord(tk[1] || '') === 'dcs' ? tk.slice(2) : null;
  if (dcsArgs) {
    const sub = dcsArgs[0];
    if (sub === 'unblock') hit('ask', 'G5', 'dcs unblock resets the failure cap');
    if (sub === 'approve-spec') hit('ask', 'G6', 'dcs approve-spec approves a spec');
    if (sub === 'purge' && dcsArgs.includes('--yes')) hit('ask', 'G10', 'dcs purge --yes moves all dcs evidence and guard logs to the Trash');
    if (sub === 'start' && dcsArgs.includes('--branch-ok')) hit('ask', 'G8', "dcs start --branch-ok starts a task off its ticket's branch");
    const boardView = sub === 'board' && (!dcsArgs[1] || dcsArgs[1].startsWith('-'));
    if (roleOf(agent) === 'worker' && !WORKER_DCS.includes(sub) && !boardView) hit('deny', 'R1', `workers only run dcs verify (and read-only dcs commands), not dcs ${sub}`);
    if (roleOf(agent) === 'reviewer' && !REVIEWER_DCS.includes(sub)) hit('deny', 'R2', `the reviewer is read-only (dcs ${sub})`);
  }
  const g = gitCall(tk);
  if (g) gitRules(g, raw, ctx, hit, skip, assign, agent, depth);
  if (head === 'gh') {
    const w = ghWrite(tk);
    if (w) {
      if (!w.free) hit('ask', 'G7', `${w.what} changes GitHub`);
      if (roleOf(agent) === 'worker') hit('deny', 'R1', `workers never run ${w.what}`);
    }
    if (tk[1] === 'auth' && tk[2] === 'token') hit('deny', 'S3', 'printing the GitHub token is not allowed');
    if (w && w.what === 'gh pr create' && ctx.prcheck) prcheckGate(ctx, hit);
  }
  if (head === 'security' && ['find-generic-password', 'find-internet-password', 'dump-keychain'].includes(tk[1])) {
    hit('deny', 'S3', `security ${tk[1]} reads the keychain`);
  }
  if (head === 'maestro') maestroRules(tk, assign, ctx, hit);
  if (roleOf(agent) === 'reviewer') {
    const sedInPlace = head === 'sed' && tk.some((a) => a.startsWith('-i') || a === '--in-place');
    if (['rm', 'mv', 'cp', 'tee', 'touch', 'mkdir'].includes(head) || sedInPlace) hit('deny', 'R2', `the reviewer is read-only (${head})`);
    for (const m of seg.utext.matchAll(/(\d*)(>>?)(?!&)\s*([^\s;&|<>]+)/g)) {
      if (m[3] !== '/dev/null') hit('deny', 'R2', `the reviewer is read-only (writes ${m[3]})`);
    }
  }
  tk.forEach((t, i) => {
    if (!skip.has(i) && t.split(/[=:'"(),;<>\s]+/).some((p) => isProtected(p, ctx.home))) hit('deny', 'S1', `command touches a protected file (${t})`);
  });
}

function analyze(text, ctx, hit, depth, agent) {
  if (depth > 3) {
    hit('ask', 'D6', 'commands nested deeper than 3 levels');
    return;
  }
  for (const { opener, body } of extractHeredocs(text)) {
    const first = scan(opener).segs[0];
    const p = first && prep(first.words);
    if (p && p.tk.length && SHELLS.includes(normWord(p.tk[0]))) analyze(body, ctx, hit, depth + 1, agent);
  }
  const { segs, subs } = scan(text);
  for (const body of subs) analyze(body, ctx, hit, depth + 1, agent);
  for (const seg of segs) {
    const p = prep(seg.words);
    // top-level hits carry their segment's literal text, so B1 can check it against native ask rules
    const tag = depth === 0 ? (d, id, why) => hit(d, id, why, seg.utext.trimStart()) : hit;
    if (p && p.tk.length) segmentRules(seg, p.tk, p.assign, text, ctx, tag, depth, agent);
  }
}

// ponytail: only `Bash(<prefix> *)` / `Bash(<prefix>:*)` rules from the user settings file count; other forms and files fail closed
function askPrefixes(ctx) {
  let rules;
  try {
    rules = ctx.askRules ? ctx.askRules() : [];
  } catch {
    return [];
  }
  return (Array.isArray(rules) ? rules : [])
    .map((r) => typeof r === 'string' && /^Bash\(([^*]+?)(?: \*|:\*)\)$/.exec(r))
    .filter(Boolean).map((m) => m[1].trim()).filter(Boolean).map((p) => `${p} `);
}

function evaluate(input, ctx) {
  const hits = [];
  const hit = (d, id, why, cover) => hits.push({ d, id, why, cover });
  const tool = input && input.tool_name;
  const ti = (input && input.tool_input) || {};
  const agent = (input && input.agent_type) || null;
  if ((tool === 'Bash' || tool === 'Monitor') && typeof ti.command === 'string') {
    analyze(ti.command, ctx, hit, 0, agent);
    if (hasSecret(ti.command)) hit('deny', 'S2', 'command contains a credential or token');
  }
  const checkPath = (p) => typeof p === 'string' && p !== '' &&
    (isProtected(p, ctx.home) || isProtected(realish(path.resolve(ctx.cwd, expandHome(p, ctx.home))), ctx.home));
  const filePath = { Read: ti.file_path, Write: ti.file_path, Edit: ti.file_path, MultiEdit: ti.file_path, NotebookEdit: ti.notebook_path }[tool];
  if (checkPath(filePath)) hit('deny', 'S1', `protected file: ${filePath}`);
  if (tool === 'Grep') {
    if (checkPath(ti.path)) hit('deny', 'S1', `protected path: ${ti.path}`);
    if (typeof ti.glob === 'string' && ti.glob && isProtectedGlob(ti.glob, ctx.home)) hit('deny', 'S1', `glob targets protected files: ${ti.glob}`);
  }
  if (WRITE_TOOLS.includes(tool)) {
    if (roleOf(agent) === 'reviewer') hit('deny', 'R2', 'the reviewer is read-only');
    if (typeof filePath === 'string' && filePath !== '') {
      if (roleOf(agent) === 'worker' && inside(path.resolve(ctx.cwd, expandHome(filePath, ctx.home)), ctx.dcsDir)) hit('deny', 'R1', 'workers never edit .claude/dcs files');
      if (outsideScope(filePath, ctx)) hit('ask', 'C1', `write outside the repo: ${filePath}`);
    }
    const edits = Array.isArray(ti.edits) ? ti.edits.map((e) => e && e.new_string) : [];
    const text = [ti.content, ti.new_string, ti.new_source, ...edits].filter((x) => typeof x === 'string').join('\n');
    if (hasSecret(text)) hit('deny', 'S2', 'content looks like a credential or token');
  }
  // hook asks don't reach Navin in bypass mode (docs) or auto mode (smoke test 2026-09-30): approvals become denies there,
  // except in auto mode when a native permissions.ask rule covers the segment (it prompts in auto mode, smoke test 2026-09-30)
  const mode = input && input.permission_mode;
  if (mode === 'bypassPermissions' || mode === 'auto') {
    const prefixes = mode === 'auto' ? askPrefixes(ctx) : [];
    for (const h of hits) {
      if (h.d === 'ask' && APPROVALS.includes(h.id) && !(h.cover && prefixes.some((p) => h.cover.startsWith(p)))) {
        const why = mode === 'auto'
          ? `${h.id}: auto mode skips hook approvals and no permissions.ask rule in your user settings covers this command; switch to Manual mode or run it yourself`
          : `${h.id}: bypass mode would skip your approval; switch to Manual mode or run it yourself`;
        Object.assign(h, { d: 'deny', why, id: 'B1' });
      }
    }
  }
  const decision = hits.some((h) => h.d === 'deny') ? 'deny' : hits.length ? 'ask' : null;
  if (!decision) return null;
  const chosen = hits.filter((h) => h.d === decision);
  return { decision, reason: chosen.map((h) => `dcs ${h.id}: ${h.why}`).join('; '), rules: [...new Set(chosen.map((h) => h.id))] };
}

module.exports = { evaluate, mask };
