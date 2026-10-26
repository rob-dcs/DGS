import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdapter, parseReply, prettyModel, priceFor, usageCost } from "../adapter.mjs";
import { snapshot as monitorSnapshot } from "../vendor/agent-monitor/lib/agent-monitor.mjs";

const prices = JSON.parse(readFileSync(new URL("../prices.json", import.meta.url), "utf8"));
const iso = (ms) => new Date(ms).toISOString();
const T0 = Date.UTC(2026, 9, 25, 16, 0, 0);

/* A fake Claude config folder and repo folder, written the way Claude Code writes them. */
function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-tree-")));
  const repo = join(root, "repo"), claude = join(root, "claude");
  mkdirSync(repo, { recursive: true });
  const project = join(claude, "projects", "-repo");
  mkdirSync(project, { recursive: true });
  const w = { root, repo, claude, project, tasksFile: join(root, "tasks.json"), processes: [{ pid: 1, command: "claude", cwd: repo }] };
  w.session = (id, rows) => writeFileSync(join(project, `${id}.jsonl`), rows.map((r) => JSON.stringify({ cwd: repo, sessionId: id, ...r })).join("\n") + "\n");
  w.sub = (session, id, meta, rows) => {
    const dir = join(project, session, "subagents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `agent-${id}.meta.json`), JSON.stringify(meta));
    writeFileSync(join(dir, `agent-${id}.jsonl`), rows.map((r) => JSON.stringify({ cwd: repo, agentId: id, ...r })).join("\n") + "\n");
  };
  w.tasks = (tasks) => writeFileSync(w.tasksFile, JSON.stringify({ tasks }));
  w.adapter = (extra = {}) => createAdapter({ repo, claudeDirs: [claude], tasksFile: w.tasksFile, prices, snapshotOptions: { dirs: { codex: [], "claude-code": [claude] }, processes: w.processes }, ...extra });
  return w;
}
const user = (ms, text = "go") => ({ type: "user", message: { role: "user", content: text }, timestamp: iso(ms) });
const reply = (ms, id, usage, model = "claude-sonnet-5-5", extra = {}) => ({ type: "assistant", message: { id, model, role: "assistant", content: [], usage, ...extra }, timestamp: iso(ms) });
const say = (ms, id, text) => ({ type: "assistant", message: { id, model: "claude-sonnet-5-5", role: "assistant", content: [{ type: "text", text }], usage: { input_tokens: 1, output_tokens: 1 } }, timestamp: iso(ms) });
const task = (id, status, extra = {}) => ({ id, title: `Title of ${id}`, status, failures: 0, ...extra });

test("prettyModel, priceFor and usageCost", () => {
  assert.equal(prettyModel("claude-sonnet-5-5"), "Sonnet 5.5");
  assert.equal(prettyModel("claude-opus-5"), "Opus 5");
  assert.equal(prettyModel("claude-haiku-5-5-20261001"), "Haiku 5.5");
  assert.equal(prettyModel("gpt-x"), "gpt-x");
  assert.equal(prettyModel(null), "unknown");
  assert.equal(priceFor(prices, "claude-opus-5-5-20261001").input, 4);
  assert.equal(priceFor(prices, "claude-unknown-1"), null);
  // 1M input at $2 + 1M output at $10 + 1M 5-minute cache write at $2 + 1M cache read at $0.20
  const u = { input_tokens: 1e6, output_tokens: 1e6, cache_creation_input_tokens: 1e6, cache_creation: { ephemeral_5m_input_tokens: 1e6, ephemeral_1h_input_tokens: 0 }, cache_read_input_tokens: 1e6 };
  assert.equal(usageCost(prices.models["claude-sonnet-5-5"], u).toFixed(2), "14.20");
  // a one-hour cache write costs 2x the input price
  assert.equal(usageCost(prices.models["claude-sonnet-5-5"], { cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1e6 } }).toFixed(2), "4.00");
});

test("maps the Captain and its subagents, parses task ids, reads times from the transcript", () => {
  const w = world();
  w.tasks([task("t1", "doing"), task("t2", "doing")]);
  w.session("cap1", [user(T0), reply(T0 + 1000, "m1", { input_tokens: 10, output_tokens: 10 }, "claude-opus-5-5")]);
  w.sub("cap1", "aaaa1111", { agentType: "dcs:worker", description: "t1 Spec the pricing screen" }, [user(T0 + 2000), reply(T0 + 9000, "m2", { input_tokens: 5, output_tokens: 5 })]);
  w.sub("cap1", "bbbb2222", { agentType: "dcs:reviewer", description: "t1: Pass ac" }, [user(T0 + 3000), reply(T0 + 4000, "m3", { input_tokens: 5, output_tokens: 5 }, "claude-haiku-5-5")]);
  const out = w.adapter().poll();
  assert.equal(out.captainId, "cap1");
  const by = Object.fromEntries(out.agents.map((a) => [a.id, a]));
  assert.deepEqual([by.cap1.role, by.cap1.name, by.cap1.parentId, by.cap1.model], ["captain", "Captain", null, "Opus 5.5"]);
  assert.deepEqual([by.aaaa1111.role, by.aaaa1111.name, by.aaaa1111.taskId, by.aaaa1111.task, by.aaaa1111.model, by.aaaa1111.parentId], ["worker", "Worker", "t1", "Spec the pricing screen", "Sonnet 5.5", "cap1"]);
  assert.deepEqual([by.bbbb2222.role, by.bbbb2222.name, by.bbbb2222.task, by.bbbb2222.model], ["reviewer", "Reviewer", "Pass ac", "Haiku 5.5"]);
  assert.equal(by.aaaa1111.start, T0 + 2000);
  assert.equal(by.aaaa1111.status, "running");
  assert.equal(by.aaaa1111.end, null);
  assert.equal(out.live, true);
  assert.equal(out.agents[0].id, "cap1");   // the Captain comes first
});

test("t-01 and T01 are read as the dcs id t1", () => {
  const w = world();
  w.tasks([task("t1", "doing")]);
  w.session("cap1", [user(T0)]);
  w.sub("cap1", "aaaa1111", { agentType: "dcs:worker", description: "t-01 Spec the pricing screen" }, [user(T0 + 1000)]);
  w.sub("cap1", "bbbb2222", { agentType: "dcs:worker", description: "T01: Second" }, [user(T0 + 2000)]);
  w.sub("cap1", "cccc3333", { agentType: "dcs:worker", description: "Tidy the docs" }, [user(T0 + 3000)]);
  const by = Object.fromEntries(w.adapter().poll().agents.map((a) => [a.id, a]));
  assert.deepEqual([by.aaaa1111.taskId, by.aaaa1111.task], ["t1", "Spec the pricing screen"]);
  assert.equal(by.bbbb2222.taskId, "t1");
  assert.deepEqual([by.cccc3333.taskId, by.cccc3333.task], [null, "Tidy the docs"]);   // "Tidy" is not a task id
});

test("an unknown task id gives a warning and no lane", () => {
  const w = world();
  w.tasks([task("t1", "doing")]);
  w.session("cap1", [user(T0)]);
  w.sub("cap1", "aaaa1111", { agentType: "dcs:worker", description: "t9 Ghost task" }, [user(T0 + 1000)]);
  const out = w.adapter().poll();
  assert.equal(out.agents.find((a) => a.id === "aaaa1111").taskId, null);
  assert.match(out.warnings.join("\n"), /t9 is not in the dcs store/);
});

test("meta.finished marks a subagent done with the last transcript time, even when Agent Monitor says running", () => {
  const w = world();
  w.session("cap1", [user(T0)]);
  // Claude Code 2.1.310 ends a background subagent with a tool call and a tool result, never with end_turn.
  w.sub("cap1", "aaaa1111", { agentType: "general-purpose", description: "t1 Work", finished: true }, [user(T0 + 1000), reply(T0 + 5000, "m1", { input_tokens: 1, output_tokens: 1 }, "claude-sonnet-5-5", { stop_reason: "tool_use" }), user(T0 + 6000, "result")]);
  const a = w.adapter().poll().agents.find((x) => x.id === "aaaa1111");
  assert.equal(a.status, "done");
  assert.equal(a.end, T0 + 6000);
  assert.equal(a.costFinal, true);
});

test("cost: tokens times price, one count per reply id, final only when the agent has stopped", () => {
  const w = world();
  const usage = { input_tokens: 1e6, output_tokens: 1e5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  w.session("cap1", [user(T0)]);
  w.sub("cap1", "aaaa1111", { agentType: "dcs:worker", description: "t1 Work" }, [user(T0 + 1000), reply(T0 + 2000, "m1", usage), reply(T0 + 2100, "m1", usage), reply(T0 + 3000, "m2", { input_tokens: 0, output_tokens: 1e5 })]);
  const adapter = w.adapter();
  let a = adapter.poll().agents.find((x) => x.id === "aaaa1111");
  // m1 counted once: 1M x $2 + 0.1M x $10 = $3. m2: 0.1M x $10 = $1.
  assert.equal(a.cost, 4);
  assert.equal(a.costFinal, false);
  // The transcript grows. Only the new bytes are read, and the new reply is added.
  appendFileSync(join(w.project, "cap1", "subagents", "agent-aaaa1111.jsonl"), JSON.stringify({ cwd: w.repo, agentId: "aaaa1111", ...reply(T0 + 4000, "m3", { input_tokens: 0, output_tokens: 1e5 }) }) + "\n");
  writeFileSync(join(w.project, "cap1", "subagents", "agent-aaaa1111.meta.json"), JSON.stringify({ agentType: "dcs:worker", description: "t1 Work", finished: true }));
  a = adapter.poll().agents.find((x) => x.id === "aaaa1111");
  assert.equal(a.cost, 5);
  assert.equal(a.costFinal, true);
});

test("a model without a price gives null cost, not a wrong number", () => {
  const w = world();
  w.session("cap1", [user(T0)]);
  w.sub("cap1", "aaaa1111", { agentType: "dcs:worker", description: "t1 Work" }, [user(T0 + 1000), reply(T0 + 2000, "m1", { input_tokens: 5, output_tokens: 5 }, "claude-mystery-9")]);
  const a = w.adapter().poll().agents.find((x) => x.id === "aaaa1111");
  assert.equal(a.cost, null);
  assert.equal(a.costFinal, false);
});

test("a stopped agent stays in the list after Agent Monitor drops it", () => {
  const w = world();
  w.session("cap1", [user(T0)]);
  w.sub("cap1", "aaaa1111", { agentType: "dcs:worker", description: "t1 Work", finished: true }, [user(T0 + 1000), reply(T0 + 2000, "m1", { input_tokens: 1, output_tokens: 1 })]);
  let n = 0;
  // From the second poll on, Agent Monitor shows the Captain only, as it does for a stopped agent.
  const adapter = w.adapter({ snapshotFn: (cwd, only, opts) => {
    const data = monitorSnapshot(cwd, only, opts);
    if (++n > 1) for (const wt of data.worktrees) for (const a of wt.agents) a.children = [];
    return data;
  } });
  assert.ok(adapter.poll().agents.some((a) => a.id === "aaaa1111"));
  const a = adapter.poll().agents.find((x) => x.id === "aaaa1111");
  assert.ok(a, "the agent is still listed");
  assert.equal(a.status, "done");
  assert.equal(a.end, T0 + 2000);
});

test("a server that starts mid-run still lists the agents that already stopped", () => {
  const w = world();
  w.tasks([task("t1", "doing")]);
  w.session("cap1", [user(T0)]);
  w.sub("cap1", "aaaa1111", { agentType: "dcs:worker", description: "t1 Spec", finished: true }, [user(T0 + 1000), reply(T0 + 2000, "m1", { input_tokens: 1, output_tokens: 1 })]);
  w.sub("cap1", "bbbb2222", { agentType: "dcs:worker", description: "t1 Build" }, [user(T0 + 3000), reply(T0 + 4000, "m2", { input_tokens: 1, output_tokens: 1 })]);
  // Agent Monitor shows the Captain and the agent that is still working. The finished one is gone from its output.
  const adapter = w.adapter({ snapshotFn: (cwd, only, opts) => {
    const data = monitorSnapshot(cwd, only, opts);
    for (const wt of data.worktrees) for (const a of wt.agents) a.children = a.children.filter((c) => c.id !== "aaaa1111");
    return data;
  } });
  const by = Object.fromEntries(adapter.poll().agents.map((a) => [a.id, a]));
  assert.equal(by.aaaa1111.status, "done");
  assert.equal(by.aaaa1111.end, T0 + 2000);
  assert.equal(by.bbbb2222.status, "running");
});

test("a task that no agent has started shows no card", () => {
  const w = world();
  w.tasks([task("t1", "doing"), task("t2", "todo", { title: "Build the plan cards" })]);
  w.session("cap1", [user(T0)]);
  w.sub("cap1", "aaaa1111", { agentType: "dcs:worker", description: "t1 Work" }, [user(T0 + 1000)]);
  const agents = w.adapter().poll().agents;
  assert.deepEqual(agents.map((a) => a.id).sort(), ["aaaa1111", "cap1"]);
  assert.ok(!agents.some((a) => a.status === "queued"));
});

test("the worker's own reply decides done, failed, blocked and needs_input", () => {
  const w = world();
  w.tasks([task("t1", "doing"), task("t2", "doing"), task("t3", "doing"), task("t4", "doing"), task("t5", "doing")]);
  w.session("cap1", [user(T0)]);
  const reply1 = (n, text) => w.sub("cap1", `agent000${n}`, { agentType: "dcs:worker", description: `t${n} Work`, finished: true }, [user(T0 + n * 1000), say(T0 + n * 1000 + 500, `m${n}`, text)]);
  reply1(1, '{"status": "done", "summary": "All good."}');
  reply1(2, '{"status": "failed", "reason": "verify failed three times: check:design"}');
  reply1(3, '{"status": "blocked", "reason": "Figma read failed: permission denied"}');
  reply1(4, '{"status": "needs_input", "questions": [{"question": "Which plan name wins: Pro or Plus?", "why": "copy"}]}');
  reply1(5, "I finished, here is a plain sentence and not JSON.");
  const by = Object.fromEntries(w.adapter().poll().agents.map((a) => [a.taskId, a]));
  assert.deepEqual([by.t1.status, by.t1.note], ["done", null]);
  assert.deepEqual([by.t2.status, by.t2.note], ["failed", "verify failed three times: check:design"]);
  assert.deepEqual([by.t3.status, by.t3.note], ["failed", "Figma read failed: permission denied"]);   // blocked is a failure with a reason
  assert.deepEqual([by.t4.status, by.t4.note], ["needs_input", "Which plan name wins: Pro or Plus?"]);
  assert.deepEqual([by.t5.status, by.t5.note], ["done", null]);   // no dcs JSON counts as done
});

test("a worker that failed and was resumed shows its latest reply", () => {
  const w = world();
  w.tasks([task("t1", "doing")]);
  w.session("cap1", [user(T0)]);
  w.sub("cap1", "aaaa1111", { agentType: "dcs:worker", description: "t1 Work", finished: true }, [user(T0 + 1000), say(T0 + 2000, "m1", '{"status": "failed", "reason": "first try"}'), user(T0 + 3000, "verify tails"), say(T0 + 4000, "m2", '{"status": "done", "summary": "fixed"}')]);
  const a = w.adapter().poll().agents.find((x) => x.id === "aaaa1111");
  assert.deepEqual([a.status, a.note], ["done", null]);
});

test("a failed worker and its retry: the first is failed, the retry is done", () => {
  const w = world();
  w.tasks([task("t3", "doing", { failures: 1 })]);
  w.session("cap1", [user(T0)]);
  w.sub("cap1", "aaaa1111", { agentType: "dcs:worker", description: "t3 Wire up checkout", finished: true }, [user(T0 + 1000), say(T0 + 2000, "m1", '{"status": "failed", "reason": "checkout test"}')]);
  w.sub("cap1", "bbbb2222", { agentType: "dcs:worker", description: "t3 Retry: wire up checkout", finished: true }, [user(T0 + 3000), say(T0 + 4000, "m2", '{"status": "done"}')]);
  const by = Object.fromEntries(w.adapter().poll().agents.map((a) => [a.id, a]));
  assert.equal(by.aaaa1111.status, "failed");
  assert.equal(by.bbbb2222.status, "done");
});

test("dcs failures alone do not mark a worker failed when its reply says done", () => {
  const w = world();
  w.tasks([task("t1", "doing", { failures: 2 })]);   // verify failed twice inside the worker's own runs, then passed
  w.session("cap1", [user(T0)]);
  w.sub("cap1", "aaaa1111", { agentType: "dcs:worker", description: "t1 Work", finished: true }, [user(T0 + 1000), say(T0 + 2000, "m1", '{"status": "done", "summary": "verified"}')]);
  assert.equal(w.adapter().poll().agents.find((x) => x.id === "aaaa1111").status, "done");
});

test("parseReply reads dcs JSON, also after a sentence, and nothing else", () => {
  assert.equal(parseReply('{"status": "done"}').status, "done");
  assert.equal(parseReply('Here is my report: {"status": "failed", "reason": "x"}').status, "failed");
  assert.equal(parseReply('{"summary": "no status"}'), null);
  assert.equal(parseReply("plain words"), null);
  assert.equal(parseReply(""), null);
});

test("the run ends when every dcs task is closed and every subagent has stopped", () => {
  const w = world();
  w.tasks([task("t1", "done")]);
  w.session("cap1", [user(T0), reply(T0 + 100, "m0", { input_tokens: 1, output_tokens: 1 })]);
  w.sub("cap1", "aaaa1111", { agentType: "dcs:worker", description: "t1 Work", finished: true }, [user(T0 + 1000), reply(T0 + 2000, "m1", { input_tokens: 1, output_tokens: 1 })]);
  const out = w.adapter().poll();
  assert.equal(out.live, false);
  assert.equal(out.agents[0].status, "done");
  assert.ok(out.agents[0].end > 0);
});

test("a Captain whose process has gone ends the run once every agent has stopped, even with tasks at approved", () => {
  const w = world();
  w.tasks([task("t1", "approved")]);   // dcs counts approved as open, so the task store alone would keep the run live
  w.session("cap1", [user(T0), reply(T0 + 100, "m0", { input_tokens: 1, output_tokens: 1 })]);
  w.sub("cap1", "aaaa1111", { agentType: "dcs:worker", description: "t1 Work", finished: true }, [user(T0 + 1000), reply(T0 + 2000, "m1", { input_tokens: 1, output_tokens: 1 })]);
  w.processes = [];   // the session has exited
  let clock = 1000;
  const adapter = w.adapter({ now: () => clock });
  assert.equal(adapter.poll().live, true, "not yet: the process may only be missing for a moment");
  clock += 16000;
  const out = adapter.poll();
  assert.equal(out.live, false);
  assert.equal(out.agents[0].status, "done");
  // a Captain whose process lives stays live however long it waits
  const w2 = world();
  w2.tasks([task("t1", "approved")]);
  w2.session("cap1", [user(T0)]);
  w2.sub("cap1", "aaaa1111", { agentType: "dcs:worker", description: "t1 Work", finished: true }, [user(T0 + 1000), reply(T0 + 2000, "m1", { input_tokens: 1, output_tokens: 1 })]);
  let c2 = 1000;
  const live = w2.adapter({ now: () => c2 });
  live.poll(); c2 += 60000;
  assert.equal(live.poll().live, true);
});

test("seq changes only when the agents change", () => {
  const w = world();
  w.tasks([task("t1", "doing")]);
  w.session("cap1", [user(T0)]);
  w.sub("cap1", "aaaa1111", { agentType: "dcs:worker", description: "t1 Work" }, [user(T0 + 1000)]);
  const adapter = w.adapter();
  const one = adapter.poll(), two = adapter.poll();
  assert.equal(two.seq, one.seq);
  appendFileSync(join(w.project, "cap1", "subagents", "agent-aaaa1111.jsonl"), JSON.stringify({ cwd: w.repo, agentId: "aaaa1111", ...reply(T0 + 5000, "m9", { input_tokens: 100, output_tokens: 100 }) }) + "\n");
  assert.equal(adapter.poll().seq, one.seq + 1);
});

test("an Agent Monitor failure returns the last good snapshot with a warning", () => {
  const w = world();
  w.session("cap1", [user(T0)]);
  let n = 0;
  const adapter = w.adapter({ snapshotFn: (cwd, only, opts) => { if (++n > 1) throw new Error("boom"); return monitorSnapshot(cwd, only, opts); } });
  assert.equal(adapter.poll().captainId, "cap1");
  const out = adapter.poll();
  assert.equal(out.captainId, "cap1");
  assert.match(out.warnings[0], /Agent Monitor failed: boom/);
  // With no earlier snapshot, the result is empty and still carries the warning.
  const first = w.adapter({ snapshotFn: () => { throw new Error("boom"); } }).poll();
  assert.deepEqual(first.agents, []);
  assert.match(first.warnings[0], /Agent Monitor failed: boom/);
});

test("no Claude Code session in the repo gives an empty snapshot", () => {
  const w = world();
  const out = w.adapter().poll();
  assert.equal(out.captainId, null);
  assert.deepEqual(out.agents, []);
});
