/* Agent Tree adapter: turns Agent Monitor output plus the dcs task store into one snapshot for the page.
   Read-only. It never writes to a transcript, to the dcs store or to a Claude config folder.
   Snapshot: { v, seq, ts, run, live, captainId, agents: [{ id, parentId, taskId, role, name, model, task,
   status, start, end, cost, costFinal }], warnings }. See integration-plan.md, section 7. */
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { configDirs, snapshot as monitorSnapshot } from "./vendor/agent-monitor/lib/agent-monitor.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TASK_ID = /^t-?0*(\d+)\b[\s:\-–]*(.*)$/is;   // dcs task ids are t1, t2 ... The Captain starts each agent with "<id> <title>". "t-01" is read as t1.
const IDLE_END_MS = 60000;                      // all subagents stopped this long = the run is over (no dcs store)
const GONE_MS = 15000;                          // the Captain has no live process this long and every agent has stopped = the run is over
const OPEN_TASK = ["todo", "doing", "verified", "approved"];

const readJson = (path, fallback = null) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; } };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/* "claude-sonnet-5-5" -> "Sonnet 5.5". Anything else stays as it is. */
export function prettyModel(id) {
  const m = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id || "");
  return m ? `${cap(m[1])} ${m[2]}${m[3] ? "." + m[3] : ""}` : id || "unknown";
}

export function priceFor(prices, model) {
  const table = prices.models || {};
  if (table[model]) return table[model];
  const bare = String(model).replace(/-\d{8}$/, "");
  if (table[bare]) return table[bare];
  const key = Object.keys(table).filter((k) => bare.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  return key ? table[key] : null;
}

/* Dollars for one usage block. Cache writes are priced by their time to live when the row says which one. */
export function usageCost(price, u) {
  const w5 = u.cache_creation?.ephemeral_5m_input_tokens, w1 = u.cache_creation?.ephemeral_1h_input_tokens;
  const write5 = w5 === undefined && w1 === undefined ? u.cache_creation_input_tokens || 0 : w5 || 0;
  const write1 = w1 || 0;
  return ((u.input_tokens || 0) * price.input + (u.output_tokens || 0) * price.output + write5 * price.cacheWrite5m
    + write1 * price.cacheWrite1h + (u.cache_read_input_tokens || 0) * price.cacheRead) / 1e6;
}

/* One transcript, read once and then only from the last byte: first and last time, the last model, and the usage of every reply.
   A reply can appear in several rows, so the usage is kept by message id and the last row wins. */
class Transcript {
  constructor(path) { this.path = path; this.offset = 0; this.first = null; this.last = null; this.model = null; this.lastText = ""; this.replies = new Map(); this.tail = ""; }
  read() {
    let size; try { size = statSync(this.path).size; } catch { return this; }
    if (size < this.offset) Object.assign(this, new Transcript(this.path));   // the file was replaced: start again
    if (size === this.offset) return this;
    const fd = openSync(this.path, "r"), buf = Buffer.alloc(size - this.offset);
    try { readSync(fd, buf, 0, buf.length, this.offset); } finally { closeSync(fd); }
    this.offset = size;
    const lines = (this.tail + buf.toString("utf8")).split("\n");
    this.tail = lines.pop();   // a half-written last line waits for the next read
    for (const line of lines) {
      if (!line) continue;
      let row; try { row = JSON.parse(line); } catch { continue; }
      const t = Date.parse(row.timestamp);
      if (!Number.isNaN(t)) { if (this.first === null) this.first = t; this.last = t; }
      const m = row.type === "assistant" ? row.message : null;
      if (m && Array.isArray(m.content)) {   // the agent's last words: a dcs worker or reviewer ends with a JSON reply that carries its status
        const text = m.content.filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
        if (text) this.lastText = text;
      }
      if (m?.usage) { this.replies.set(m.id || row.uuid, { model: m.model, usage: m.usage }); if (m.model) this.model = m.model; }
    }
    return this;
  }
  /* -> { cost, unknown } where unknown names the models that have no price. */
  cost(prices) {
    let cost = 0; const unknown = new Set();
    for (const { model, usage } of this.replies.values()) {
      const price = priceFor(prices, model);
      if (price) cost += usageCost(price, usage); else unknown.add(model);
    }
    return { cost, unknown };
  }
}

/* A dcs worker or reviewer ends with {"status": "done" | "failed" | "blocked" | "needs_input", ...}. Returns that object, or null. */
export function parseReply(text) {
  if (!text) return null;
  for (const candidate of [text, text.slice(Math.max(0, text.indexOf("{")))]) {
    try { const v = JSON.parse(candidate); if (v && typeof v === "object" && typeof v.status === "string") return v; } catch { /* not JSON */ }
  }
  return null;
}
const REPLY_STATUS = { done: "done", failed: "failed", blocked: "failed", needs_input: "needs_input" };   // the tree has no "blocked": it is a failure with a reason
const replyNote = (r) => r.reason || r.summary || (Array.isArray(r.questions) && r.questions[0] && r.questions[0].question) || null;

function flatten(nodes, out = []) {
  for (const n of nodes) { out.push(n); flatten(n.children || [], out); }
  return out;
}

/* Where the transcripts live: <config>/projects/<project>/<session>.jsonl and <session>/subagents/agent-<id>.jsonl. */
function findTranscript(dirs, sessionId, agentId) {
  for (const dir of dirs) {
    const projects = join(dir, "projects");
    let names; try { names = readdirSync(projects); } catch { continue; }
    for (const name of names) {
      const path = agentId ? join(projects, name, sessionId, "subagents", `agent-${agentId}.jsonl`) : join(projects, name, `${sessionId}.jsonl`);
      if (existsSync(path)) return path;
    }
  }
  return null;
}

export function dcsTasksFile(repo) {
  try {
    const common = execFileSync("git", ["-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return join(dirname(common), ".claude", "dcs", "tasks.json");
  } catch { return join(repo, ".claude", "dcs", "tasks.json"); }
}

/* options: repo (required), captainId, claudeDirs, tasksFile, prices, snapshotFn, snapshotOptions, now */
export function createAdapter(options) {
  const { repo } = options;
  const now = options.now || Date.now;
  const prices = options.prices || readJson(join(HERE, "prices.json"), { models: {} });
  const takeSnapshot = options.snapshotFn || monitorSnapshot;
  const tasksFile = options.tasksFile || dcsTasksFile(repo);
  const known = new Map();         // every agent ever seen in this run. Agent Monitor drops a stopped agent at the next poll.
  const files = new Map();         // agent id -> Transcript
  let last = null, seq = 0, lastBody = "", lastAllStopped = null, goneSince = null;

  const transcript = (dirs, sessionId, agentId) => {
    const key = agentId || sessionId;
    let t = files.get(key);
    if (!t) { const path = findTranscript(dirs, sessionId, agentId); if (!path) return null; t = new Transcript(path); files.set(key, t); }
    return t.read();
  };

  function poll() {
    const warnings = [];
    let data;
    try { data = takeSnapshot(repo, "claude-code", options.snapshotOptions); }
    catch (e) { return last ? { ...last, warnings: [`Agent Monitor failed: ${e.message}`, ...last.warnings] } : { v: 1, seq, ts: now(), run: null, live: false, captainId: null, agents: [], warnings: [`Agent Monitor failed: ${e.message}`] }; }

    const dirs = options.claudeDirs || configDirs()["claude-code"];
    const tasks = readJson(tasksFile)?.tasks;
    const task = (id) => tasks?.find((t) => t.id === id);
    const nodes = flatten(data.worktrees.flatMap((w) => w.agents));
    const sessions = nodes.filter((n) => n.type === "session" && n.source === "event");
    const captain = (options.captainId && sessions.find((n) => n.id === options.captainId))
      || sessions.sort((a, b) => b.lastAt - a.lastAt)[0]
      || (options.captainId && known.get(options.captainId) && { id: options.captainId, gone: true });
    if (!captain) return finish(warnings, null);
    const t0 = now();

    // Captain
    const ct = transcript(dirs, captain.id, null);
    const prev = known.get(captain.id);
    const rec = prev || { id: captain.id, parentId: null, taskId: null, role: "captain", name: "Captain", task: "Run the plan" };
    rec.model = prettyModel(ct?.model || (captain.model ? `claude-${captain.model}` : null));
    rec.start = ct?.first ?? rec.start ?? t0;
    known.set(captain.id, rec);

    // Agent Monitor drops a stopped agent. A server that starts in the middle of a run would miss it, so the Captain's subagent folder counts too.
    // An agent that is in the folder but not in Agent Monitor's output is not running.
    const listed = new Set(nodes.map((x) => x.id)), caught = [];
    if (ct) {
      let names = []; try { names = readdirSync(join(ct.path.replace(/\.jsonl$/, ""), "subagents")); } catch { /* no subagents yet */ }
      for (const name of names) { const m = /^agent-(.+)\.jsonl$/.exec(name); if (m && !listed.has(m[1])) caught.push({ id: m[1], type: "subagent", parent: captain.id, status: "stopped", children: [] }); }
    }

    // Subagents of the Captain
    const seen = new Set();
    for (const n of [...nodes.filter((x) => x.parent === captain.id), ...caught]) {
      seen.add(n.id);
      const tr = transcript(dirs, captain.id, n.id);
      const meta = tr ? readJson(tr.path.replace(/\.jsonl$/, ".meta.json"), {}) : {};
      const description = (meta.description || n.title || "").trim();
      const m = TASK_ID.exec(description);
      let taskId = null, text = description || "Subagent";
      if (m) {
        taskId = `t${m[1]}`; text = m[2].trim() || description;
        if (tasks && !task(taskId)) { warnings.push(`${n.id.slice(0, 8)}: task ${taskId} is not in the dcs store`); taskId = null; }
      }
      const type = meta.agentType || n.type || "subagent";
      const short = type.split(":").pop();
      const role = /review/i.test(type) ? "reviewer" : "worker";
      const a = known.get(n.id) || { id: n.id, parentId: captain.id };
      Object.assign(a, { taskId, role, name: /^(worker|reviewer)$/i.test(short) ? cap(short) : cap(short.replace(/-/g, " ")), task: text,
        model: prettyModel(tr?.model || (n.model ? `claude-${n.model}` : null)), start: tr?.first ?? a.start ?? t0 });
      a.finished = meta.finished === true || n.status === "stopped";
      a.end = a.finished ? (tr?.last ?? a.end ?? t0) : null;
      a.running = !a.finished;
      known.set(n.id, a);
    }
    // A subagent that left Agent Monitor's output has stopped. Keep it.
    for (const a of known.values()) {
      if (a.role === "captain" || seen.has(a.id) || a.finished) continue;
      const tr = files.get(a.id)?.read();
      const meta = tr ? readJson(tr.path.replace(/\.jsonl$/, ".meta.json"), {}) : {};
      a.finished = true; a.running = false; a.end = tr?.last ?? a.end ?? t0;
      if (meta.finished === undefined) warnings.push(`${a.id.slice(0, 8)}: left Agent Monitor without a finished flag`);
    }
    return finish(warnings, captain, tasks, ct);
  }

  function finish(warnings, captain, tasks, ct) {
    if (!captain) { const out = { v: 1, seq, ts: now(), run: null, live: false, captainId: null, agents: [], warnings: [...warnings, "no Claude Code session in this repo"] }; last = out; return out; }
    const t0 = now();
    const subs = [...known.values()].filter((a) => a.role !== "captain").sort((a, b) => a.start - b.start);
    const agents = subs.map((a) => {
      if (a.running) return pack(a, "running");
      // A finished agent has the status of its own last reply. A reply that is not dcs JSON counts as done.
      const reply = parseReply(files.get(a.id)?.lastText);
      const status = (reply && REPLY_STATUS[reply.status]) || "done";
      return pack(a, status, status === "done" ? null : replyNote(reply));
    });

    // A task that waits in dcs has no card. A card appears only when the Captain starts an agent for it.

    const open = tasks ? tasks.some((t) => OPEN_TASK.includes(t.status)) : null;
    const allStopped = subs.length > 0 && subs.every((a) => !a.running);
    if (allStopped && lastAllStopped === null) lastAllStopped = t0;
    if (!allStopped) lastAllStopped = null;
    const idle = allStopped && t0 - lastAllStopped >= IDLE_END_MS;
    // Agent Monitor calls a Captain "running" while its process lives, even when it waits for the user. A session that has exited
    // (a headless run, a closed terminal) has no process. Tasks left at "approved" would keep the run open for ever without this rule.
    if (captain.status === "running") goneSince = null; else if (goneSince === null) goneSince = t0;
    const gone = goneSince !== null && t0 - goneSince >= GONE_MS && subs.every((a) => !a.running);
    const ended = captain.status === "stopped" || gone || (subs.length > 0 && (open === false || (open === null && idle)) && allStopped);
    const rec = known.get(captain.id);
    rec.end = ended ? (ct?.last ?? t0) : null;
    const root = pack(rec, ended ? "done" : "running");

    const all = [root, ...agents];
    const body = JSON.stringify(all);
    if (body !== lastBody) { seq += 1; lastBody = body; }
    const out = { v: 1, seq, ts: t0, run: `r-${new Date(rec.start).toISOString().slice(0, 10).replace(/-/g, "")}-${captain.id.slice(0, 6)}`, live: !ended, captainId: captain.id, agents: all, warnings };
    last = out;
    return out;
  }

  function pack(a, status, note = null) {
    const tr = files.get(a.id);
    let cost = 0, costFinal = status !== "running";
    if (tr) {
      const c = tr.cost(prices);
      cost = c.cost;
      if (c.unknown.size) { cost = null; costFinal = false; }
    }
    return { id: a.id, parentId: a.parentId, taskId: a.taskId, role: a.role, name: a.name, model: a.model, task: a.task, status,
      start: a.start, end: a.end, cost: cost === null ? null : Math.round(cost * 1e4) / 1e4, costFinal, note };
  }

  return { poll };
}

/* node adapter.mjs <repo>  prints one snapshot. Handy to check a live run from a terminal. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repo = process.argv[2] || process.cwd();
  const adapter = createAdapter({ repo });
  console.log(JSON.stringify(adapter.poll(), null, 2));
}
