/* Agent Tree server: serves the page, polls the adapter and streams each snapshot to the page.
   node server.mjs [repo] [--port 4173] [--runs <folder>] [--every 2000]
   Local only: it binds to 127.0.0.1 and refuses any other Host header. Read-only toward the harness, except POST /retry (see retry.mjs).
   Routes: GET / (the page), GET /stream (SSE, one snapshot per poll), GET /runs, GET /runs/<id> (recorded snapshots),
           GET /capabilities (what the page may offer), POST /retry {"task": "t2"} (start a new run for a failed task).
   --dcs <dcs plugin folder>  turns Retry on. Default: ../dcs next to this folder, when it exists. --no-retry turns it off.
   --retry-budget <dollars> and --retry-model <name> set the cap and the model of a retry run (default 5 and sonnet). */
import { createServer } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAdapter, dcsTasksFile } from "./adapter.mjs";
import { createRetry } from "./retry.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_ID = /^[A-Za-z0-9-]{1,80}$/;

export function startServer(options = {}) {
  const repoDir = resolve(options.repo || process.cwd());
  const adapter = options.adapter || createAdapter({ repo: repoDir });
  const runsDir = options.runsDir || join(HERE, "runs");
  const retry = options.retry !== undefined ? options.retry : (options.dcsDir === false ? null : createRetry({
    repo: repoDir, dcsDir: options.dcsDir || join(HERE, "..", "dcs"), tasksFile: dcsTasksFile(repoDir), logDir: join(runsDir, "retry-logs"), budget: options.retryBudget, model: options.retryModel }));
  const every = options.every || 2000;
  const record = options.record !== false;
  const clients = new Set();
  let latest = null, lastSeq = -1, lastRun = null;

  const lines = (id) => readFileSync(join(runsDir, `${id}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    .map((snap) => ({ ...snap, agents: snap.agents.filter((a) => a.status !== "queued") }));   // runs recorded before 2026-10-25 hold queued placeholders; a task has no card until an agent starts
  const send = (res, snap) => res.write(`id: ${snap.seq}\ndata: ${JSON.stringify(snap)}\n\n`);

  /* One poll: always tell the page (it shows "Ns ago"), and write to the run file only when the agents changed. */
  function poll() {
    let snap;
    try { snap = adapter.poll(); } catch (e) { console.error("adapter:", e.message); return; }
    latest = snap;
    if (record && snap.run && (snap.seq !== lastSeq || snap.run !== lastRun)) {
      try { mkdirSync(runsDir, { recursive: true }); appendFileSync(join(runsDir, `${snap.run}.jsonl`), JSON.stringify(snap) + "\n"); }
      catch (e) { console.error("record:", e.message); }
    }
    lastSeq = snap.seq; lastRun = snap.run;
    for (const res of clients) send(res, snap);
  }

  const server = createServer((req, res) => {
    const host = (req.headers.host || "").replace(/:\d+$/, "");
    if (host !== "127.0.0.1" && host !== "localhost") { res.writeHead(403).end("forbidden"); return; }   // blocks DNS rebinding
    const url = new URL(req.url, "http://localhost");
    const json = (code, body) => res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
    if (req.method === "POST" && url.pathname === "/retry") {
      /* A page on another origin must not start a run. A custom header forces a CORS preflight, which this server never answers,
         and an Origin that is not this server is refused. */
      const origin = req.headers.origin;
      if (req.headers["x-agent-tree"] !== "retry" || (origin && origin !== `http://${req.headers.host}`) || !/^application\/json/.test(req.headers["content-type"] || "")) { json(403, { ok: false, message: "forbidden" }); return; }
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 1024) req.destroy(); });
      req.on("end", () => {
        let task; try { task = JSON.parse(body).task; } catch { json(400, { ok: false, message: "The body must be JSON like {\"task\": \"t2\"}." }); return; }
        const r = retry ? retry.start(task, latest?.agents || []) : { ok: false, code: 404, message: "Retry is off." };
        json(r.code, { ok: r.ok, message: r.message });
      });
      return;
    }
    if (req.method !== "GET") { res.writeHead(405).end(); return; }

    if (url.pathname === "/" || url.pathname === "/agent-tree.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(readFileSync(join(HERE, "agent-tree.html")));
    } else if (url.pathname === "/stream") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write("retry: 2000\n\n");
      if (latest) send(res, latest);
      clients.add(res);
      req.on("close", () => clients.delete(res));
    } else if (url.pathname === "/capabilities") {
      json(200, { retry: retry ? retry.info() : { enabled: false } });
    } else if (url.pathname === "/runs") {
      const out = [];
      try {
        for (const name of readdirSync(runsDir).filter((n) => n.endsWith(".jsonl"))) {
          const id = name.slice(0, -6), snaps = lines(id), last = snaps.at(-1);
          out.push({ id, snapshots: snaps.length, first: snaps[0]?.ts ?? null, last: last?.ts ?? null, ended: last ? !last.live : null });
        }
      } catch { /* no runs folder yet */ }
      json(200, out.sort((a, b) => (b.first || 0) - (a.first || 0)));
    } else if (url.pathname.startsWith("/runs/")) {
      const id = decodeURIComponent(url.pathname.slice(6));
      if (!RUN_ID.test(id) || !existsSync(join(runsDir, `${id}.jsonl`))) { json(404, { error: "no such run" }); return; }
      json(200, lines(id));
    } else {
      res.writeHead(404).end("not found");
    }
  });

  poll();
  const timer = setInterval(poll, every);
  return new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(options.port ?? 4173, "127.0.0.1", () => ok({
      server, port: server.address().port, poll,
      close: () => new Promise((done) => { clearInterval(timer); for (const r of clients) r.end(); server.close(() => done()); server.closeAllConnections?.(); }),
    }));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const flag = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args.splice(i, 2)[1]; };
  const noRetry = args.includes("--no-retry"); if (noRetry) args.splice(args.indexOf("--no-retry"), 1);
  const port = flag("--port"), runsDir = flag("--runs"), every = flag("--every"), dcsDir = flag("--dcs"), budget = flag("--retry-budget"), retryModel = flag("--retry-model");
  const repo = args[0] || process.cwd();
  startServer({ repo, port: port === undefined ? 4173 : Number(port), runsDir, every: every && Number(every), dcsDir: noRetry ? false : dcsDir && resolve(dcsDir), retryBudget: budget && Number(budget), retryModel }).then(({ port: p }) => {
    console.log(`Agent Tree for ${resolve(repo)}\nhttp://127.0.0.1:${p}/`);
  }, (e) => { console.error(e.code === "EADDRINUSE" ? `port ${port ?? 4173} is in use; pass --port <n>` : e.message); process.exit(1); });
}
