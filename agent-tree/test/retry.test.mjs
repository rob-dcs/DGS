import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRetry } from "../retry.mjs";

/* A fake dcs folder, a fake task store, and fake spawn and exec: no real process starts. */
function setup(tasks, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), "agent-tree-retry-"));
  const dcsDir = join(root, "dcs"); mkdirSync(join(dcsDir, "bin"), { recursive: true }); writeFileSync(join(dcsDir, "bin", "dcs"), "");
  const tasksFile = join(root, "tasks.json"); writeFileSync(tasksFile, JSON.stringify({ tasks }));
  const calls = { exec: [], spawn: [] };
  const children = [];
  const execFn = (cmd, args, opts) => { calls.exec.push({ cmd, args, opts }); };
  const spawnFn = (cmd, args, opts) => { calls.spawn.push({ cmd, args, opts }); const c = { pid: 4242, handlers: {}, on(e, f) { this.handlers[e] = f; }, unref() {} }; children.push(c); return c; };
  const retry = createRetry({ repo: "/repo", dcsDir, tasksFile, logDir: join(root, "logs"), spawnFn, execFn, ...extra });
  return { retry, calls, children, root };
}

test("a blocked task is unblocked, then a headless run starts with a budget cap", () => {
  const { retry, calls } = setup([{ id: "t2", status: "blocked" }]);
  const r = retry.start("t2", []);
  assert.deepEqual([r.ok, r.code], [true, 202]);
  assert.equal(calls.exec.length, 1);
  assert.deepEqual(calls.exec[0].args.slice(1), ["unblock", "t2"]);
  assert.equal(calls.exec[0].opts.cwd, "/repo");
  const s = calls.spawn[0];
  assert.equal(s.cmd, "claude");
  assert.deepEqual(s.args.slice(0, 2), ["-p", "/dcs:work t2"]);
  assert.ok(s.args.includes("--permission-mode") && s.args[s.args.indexOf("--permission-mode") + 1] === "dontAsk");
  assert.equal(s.args[s.args.indexOf("--max-budget-usd") + 1], "5");
  assert.equal(s.opts.cwd, "/repo");
});

test("a doing task starts without unblock", () => {
  const { retry, calls } = setup([{ id: "t1", status: "doing" }]);
  assert.equal(retry.start("t1", []).ok, true);
  assert.equal(calls.exec.length, 0);
  assert.equal(calls.spawn.length, 1);
});

test("a run log is written under the log folder", () => {
  const { retry, root } = setup([{ id: "t1", status: "todo" }]);
  retry.start("t1", []);
  assert.ok(readdirSync(join(root, "logs")).some((n) => /^retry-t1-\d+\.log$/.test(n)));
});

test("the task id is checked, so no argument can be injected", () => {
  const { retry, calls } = setup([{ id: "t2", status: "blocked" }]);
  for (const bad of ["t2 --dangerously-skip-permissions", "../t2", "T2", "", undefined, 2, "t2;ls"]) assert.equal(retry.start(bad, []).code, 400, String(bad));
  assert.equal(calls.spawn.length + calls.exec.length, 0);
});

test("refuses an unknown task, a finished task, a running agent and a second retry", () => {
  const { retry, calls } = setup([{ id: "t1", status: "done" }, { id: "t2", status: "doing" }, { id: "t3", status: "blocked" }]);
  assert.equal(retry.start("t9", []).code, 404);
  assert.equal(retry.start("t1", []).code, 409);
  assert.equal(retry.start("t2", [{ taskId: "t2", status: "running" }]).code, 409);
  assert.equal(retry.start("t3", []).ok, true);
  assert.equal(retry.start("t3", []).code, 409);   // the first run has not exited
  assert.equal(calls.spawn.length, 1);
});

test("a task can retry again after its run has exited", () => {
  const { retry, children } = setup([{ id: "t3", status: "blocked" }]);
  assert.equal(retry.start("t3", []).ok, true);
  children[0].handlers.exit();
  assert.equal(retry.start("t3", []).ok, true);
});

test("without a dcs folder, retry is off", () => {
  const retry = createRetry({ repo: "/repo", dcsDir: "/no/such/folder", tasksFile: "/x" });
  assert.equal(retry.info().enabled, false);
  assert.equal(retry.start("t1", []).code, 404);
});

test("a failed unblock reports an error and starts no run", () => {
  const { retry, calls } = setup([{ id: "t2", status: "blocked" }], { execFn: () => { throw new Error("dcs: boom"); } });
  const r = retry.start("t2", []);
  assert.deepEqual([r.ok, r.code], [false, 500]);
  assert.equal(calls.spawn.length, 0);
});
