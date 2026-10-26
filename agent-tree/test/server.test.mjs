import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server.mjs";

const snap = (seq, extra = {}) => ({ v: 1, seq, ts: 1000 + seq, run: "r-20261025-abc123", live: true, captainId: "cap", agents: [{ id: "cap", parentId: null, role: "captain", status: "running" }], warnings: [], ...extra });

/* A stub adapter: the test sets `next` and the server polls it. */
function stub() {
  const s = { next: snap(1), poll() { return this.next; } };
  return s;
}
const get = (port, path, headers = {}) => new Promise((ok, fail) => {
  const req = request({ host: "127.0.0.1", port, path, headers }, (res) => { let body = ""; res.on("data", (c) => (body += c)); res.on("end", () => ok({ status: res.statusCode, headers: res.headers, body })); });
  req.on("error", fail); req.end();
});
/* Read an SSE stream until `done(got)` says enough messages arrived. */
const stream = (port, done) => new Promise((ok, fail) => {
  const got = []; let buf = "";
  const req = request({ host: "127.0.0.1", port, path: "/stream" }, (res) => {
    res.on("data", (c) => {
      buf += c;
      for (let i; (i = buf.indexOf("\n\n")) !== -1;) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = block.split("\n").find((l) => l.startsWith("data: "));
        if (data) got.push(JSON.parse(data.slice(6)));
        if (done(got)) { req.destroy(); ok(got); }
      }
    });
  });
  req.on("error", (e) => { if (!done(got)) fail(e); }); req.end();
});
const boot = async (adapter = stub(), extra = {}) => {
  const runsDir = mkdtempSync(join(tmpdir(), "agent-tree-runs-"));
  const s = await startServer({ adapter, port: 0, runsDir, every: 50, ...extra });
  return { ...s, runsDir, adapter };
};

test("serves the page and refuses a foreign Host header", async () => {
  const s = await boot();
  try {
    const page = await get(s.port, "/");
    assert.equal(page.status, 200);
    assert.match(page.headers["content-type"], /text\/html/);
    assert.match(page.body, /id="tree"/);
    assert.equal((await get(s.port, "/", { Host: "evil.example" })).status, 403);
    assert.equal((await get(s.port, "/", { Host: `localhost:${s.port}` })).status, 200);
    assert.equal((await get(s.port, "/nope")).status, 404);
  } finally { await s.close(); }
});

test("streams the latest snapshot at once and each later poll", async () => {
  const s = await boot();
  try {
    const first = stream(s.port, (got) => got.some((g) => g.seq === 2));
    setTimeout(() => { s.adapter.next = snap(2); }, 120);
    const got = await first;
    assert.equal(got[0].seq, 1);   // sent when the client connected
    assert.ok(got.length >= 2, "an unchanged poll is sent too, so the page can show how fresh the data is");
  } finally { await s.close(); }
});

test("records a snapshot only when the agents change, and replays the run", async () => {
  const s = await boot();
  try {
    await new Promise((r) => setTimeout(r, 250));   // several polls with seq 1
    s.adapter.next = snap(2);
    await new Promise((r) => setTimeout(r, 250));
    const file = join(s.runsDir, "r-20261025-abc123.jsonl");
    assert.ok(existsSync(file));
    const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(rows.map((r) => r.seq), [1, 2]);
    const list = JSON.parse((await get(s.port, "/runs")).body);
    assert.deepEqual([list[0].id, list[0].snapshots, list[0].ended], ["r-20261025-abc123", 2, false]);
    const run = JSON.parse((await get(s.port, "/runs/r-20261025-abc123")).body);
    assert.equal(run.length, 2);
  } finally { await s.close(); }
});

test("run ids cannot leave the runs folder", async () => {
  const s = await boot();
  try {
    for (const id of ["..%2Fpackage", "..%2F..%2Fetc%2Fpasswd", "x.jsonl", "nope"]) assert.equal((await get(s.port, `/runs/${id}`)).status, 404, id);
  } finally { await s.close(); }
});

test("a snapshot with no run is streamed but not recorded", async () => {
  const empty = stub();
  empty.next = { v: 1, seq: 0, ts: 5, run: null, live: false, captainId: null, agents: [], warnings: ["no Claude Code session in this repo"] };
  const s = await boot(empty);
  try {
    const [first] = await stream(s.port, (got) => got.length >= 1);
    assert.equal(first.captainId, null);
    assert.deepEqual(JSON.parse((await get(s.port, "/runs")).body), []);
  } finally { await s.close(); }
});

test("an adapter error does not stop the server", async () => {
  const s = await boot({ poll() { throw new Error("boom"); } });
  try {
    await new Promise((r) => setTimeout(r, 150));
    assert.equal((await get(s.port, "/")).status, 200);
  } finally { await s.close(); }
});

/* POST /retry */
const post = (port, path, body, headers = {}) => new Promise((ok, fail) => {
  const data = typeof body === "string" ? body : JSON.stringify(body);
  const req = request({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", "x-agent-tree": "retry", ...headers } }, (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => ok({ status: res.statusCode, body: b })); });
  req.on("error", fail); req.end(data);
});
const fakeRetry = () => { const calls = []; return { calls, info: () => ({ enabled: true, budget: 5, model: "sonnet" }), start(task, agents) { calls.push({ task, agents }); return { ok: true, code: 202, message: "started " + task }; } }; };

test("POST /retry passes the task and the live agents to retry", async () => {
  const retry = fakeRetry(), s = await boot(stub(), { retry });
  try {
    await new Promise((r) => setTimeout(r, 120));
    const r = await post(s.port, "/retry", { task: "t2" });
    assert.equal(r.status, 202);
    assert.deepEqual(JSON.parse(r.body), { ok: true, message: "started t2" });
    assert.equal(retry.calls[0].task, "t2");
    assert.equal(retry.calls[0].agents[0].id, "cap");
  } finally { await s.close(); }
});

test("POST /retry refuses a request without the header, from another origin, or without JSON", async () => {
  const retry = fakeRetry(), s = await boot(stub(), { retry });
  try {
    assert.equal((await post(s.port, "/retry", { task: "t2" }, { "x-agent-tree": "" })).status, 403);
    assert.equal((await post(s.port, "/retry", { task: "t2" }, { origin: "http://evil.example" })).status, 403);
    assert.equal((await post(s.port, "/retry", { task: "t2" }, { "content-type": "text/plain" })).status, 403);
    assert.equal((await post(s.port, "/retry", "not json")).status, 400);
    assert.equal((await post(s.port, "/retry", { task: "t2" }, { host: "evil.example" })).status, 403);
    assert.equal(retry.calls.length, 0);
    assert.equal((await post(s.port, "/retry", { task: "t2" }, { origin: `http://127.0.0.1:${s.port}` })).status, 202);
  } finally { await s.close(); }
});

test("GET /capabilities tells the page whether retry is on", async () => {
  const on = await boot(stub(), { retry: fakeRetry() }), off = await boot(stub(), { retry: null });
  try {
    assert.deepEqual(JSON.parse((await get(on.port, "/capabilities")).body).retry, { enabled: true, budget: 5, model: "sonnet" });
    assert.deepEqual(JSON.parse((await get(off.port, "/capabilities")).body).retry, { enabled: false });
    assert.equal((await post(off.port, "/retry", { task: "t2" })).status, 404);
  } finally { await on.close(); await off.close(); }
});
