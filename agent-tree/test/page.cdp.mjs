/* Browser test for the live page. Needs Google Chrome. Run by hand: node test/page.cdp.mjs
   A scripted feed drives the real server and the real page. It checks live updates, cost marks, a card the user moved,
   the end of a run, replay, the demo fallback and the disconnect label. Exit code 1 if a check fails. */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { startServer } from "../server.mjs";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let T0 = Date.now();   // reset when the page opens, so the feed's seconds match the checks
const secs = () => (Date.now() - T0) / 1000;

/* The feed: what the adapter would return at each second of the run. */
function feed() {
  let seq = 0, lastBody = "";
  const A = (id, parentId, role, name, model, task, status, startS, endS, cost, costFinal, taskId = null) =>
    ({ id, parentId, taskId, role, name, model, task, status, start: T0 + startS * 1000, end: endS == null ? null : T0 + endS * 1000, cost, costFinal });
  return { poll() {
    const t = secs(), agents = [];
    const ended = t >= 9;
    agents.push(A("cap", null, "captain", "Captain", "Opus 5.5", "Run the plan", ended ? "done" : "running", 0, ended ? 9 : null, 0.5 + t / 10, ended, null));
    if (t >= 1) agents.push(A("w1", "cap", "worker", "Worker", "Sonnet 5.5", "Spec the pricing screen", t >= 6 ? "done" : "running", 1, t >= 6 ? 6 : null, 0.1 + t / 20, t >= 6, "t1"));
    if (t >= 3) agents.push(A("w2", "cap", "worker", "Worker", "Sonnet 5.5", "Build the plan cards", t >= 8 ? "done" : "running", 3, t >= 8 ? 8 : null, 0.2, t >= 8, "t2"));
    if (t >= 4) agents.push(A("w3", "cap", "worker", "Worker", "Mystery 1", "Unpriced model", t >= 7 ? "failed" : "running", 4, t >= 7 ? 7 : null, null, false, "t3"));
    const w3 = agents.find((a) => a.id === "w3"); if (w3 && w3.status === "failed") w3.note = "verify failed 3 times: check:design";
    if (t >= 6) agents.push(A("r1", "cap", "reviewer", "Reviewer", "Haiku 5.5", "Pass: ac", t >= 8 ? "done" : "running", 6, t >= 8 ? 8 : null, 0.01, t >= 8, "t1"));
    const body = JSON.stringify(agents);
    if (body !== lastBody) { seq += 1; lastBody = body; }
    return { v: 1, seq, ts: Date.now(), run: "r-test-0001", live: !ended, captainId: "cap", agents, warnings: [] };
  } };
}

const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + detail}`); };

async function browser(port) {
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, "--window-size=1400,900", "--user-data-dir=" + mkdtempSync(join(tmpdir(), "chrome-")), "about:blank"], { stdio: "ignore" });
  let tabs; for (let i = 0; i < 60; i++) { try { tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (tabs.length) break; } catch {} await sleep(200); }
  const ws = new WebSocket(tabs.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) pend.get(d.id)(d); };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  return {
    go: async (url) => { await send("Page.navigate", { url }); await sleep(700); },
    ev: async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300)); return r.result.result.value; },
    close: () => { ws.close(); chrome.kill(); },
  };
}

const runsDir = mkdtempSync(join(tmpdir(), "agent-tree-e2e-"));
const b = await browser(9444);   // start Chrome first: its launch must not eat into the feed's timeline
T0 = Date.now();
const retryCalls = [];
const fakeRetry = { info: () => ({ enabled: true, budget: 5, model: "sonnet" }), start(task) { retryCalls.push(task); return { ok: true, code: 202, message: "Started a new run for " + task + "." }; } };
const srv = await startServer({ adapter: feed(), port: 0, runsDir, every: 400, retry: fakeRetry });
const state = () => b.ev(`(() => ({
  mode: document.querySelector("#mode").textContent,
  ids: agents.map(a => a.id),
  lis: document.querySelectorAll("#tree li.n").length,
  card: (id) => null,
}))()`);
const text = (id, sel) => b.ev(`(() => { const li = document.querySelector('[data-id="${id}"]'); const e = li && li.querySelector(":scope > .shell ${sel}"); return e ? e.textContent : null; })()`);

try {
  await b.go(`http://127.0.0.1:${srv.port}/`);
  await sleep(300);
  let s = await state();
  check("live mode starts and shows the Captain", /^Live/.test(s.mode) && s.ids.includes("cap"), JSON.stringify(s));

  while (secs() < 2.0) await sleep(100);
  check("a running agent's cost carries the ~ mark", /^~\$/.test(await text("w1", "[data-cost]")), await text("w1", "[data-cost]"));

  while (secs() < 4.4) await sleep(100);
  s = await state();
  check("a card for t2 appears when its worker starts", s.ids.includes("w2"), JSON.stringify(s.ids));
  check("no stale card stays in the DOM", s.lis === s.ids.length, `${s.lis} cards for ${s.ids.length} agents`);
  check("a model without a price shows a dash", (await text("w3", "[data-cost]")) === "—", await text("w3", "[data-cost]"));
  check("the task id and text show on the card", /t2/.test(await text("w2", ".task")) && /Build the plan cards/.test(await text("w2", ".task")), await text("w2", ".task"));

  // The wires of running tasks are lit.
  const lit = () => b.ev(`[...document.querySelectorAll('#wires path.is-run:not(.flow)')].map(p => p.dataset.to).sort()`);
  while (secs() < 5.0) await sleep(100);
  const litRun = await lit();
  check("a wire into each running task is lit", JSON.stringify(litRun) === JSON.stringify(["w1", "w2", "w3"]), JSON.stringify(litRun));
  const shine = await b.ev(`(() => {
    const css = (e, p) => getComputedStyle(e)[p];
    const core = document.querySelector('#wires .flow.core.is-run'), glow = document.querySelector('#wires .flow.glow.is-run');
    const card = document.querySelector('.card');   // the card's own shine color, from the same variable
    const line = getComputedStyle(card).getPropertyValue('--shine-line').trim();
    const probe = document.createElement('i'); probe.style.color = line; document.body.appendChild(probe); const want = getComputedStyle(probe).color; probe.remove();
    return JSON.stringify({ coreColor: css(core, 'stroke'), want, coreFilter: css(core.parentNode, 'filter'), glowFilter: css(glow.parentNode, 'filter'),
      coreLayers: document.querySelectorAll('#wires .flow.core[data-to="w1"]').length, glowLayers: document.querySelectorAll('#wires .flow.glow[data-to="w1"]').length });
  })()`);
  const sh = JSON.parse(shine);
  check("the pulse line has the card's shine color", sh.coreColor === sh.want, shine);
  check("the pulse has the card's grain and glow filters", /wire-grain-ring/.test(sh.coreFilter) && /drop-shadow/.test(sh.coreFilter) && /wire-grain-glow/.test(sh.glowFilter), shine);
  check("the pulse is a stack of layers that fade in and out", sh.coreLayers >= 10 && sh.glowLayers >= 4 && sh.coreLayers > sh.glowLayers, shine);
  check("a lit wire carries a travelling pulse", (await b.ev(`(() => { const f = document.querySelector('#wires .flow.is-run'); return f ? getComputedStyle(f).animationName + '/' + getComputedStyle(f).display : null; })()`)) === "wire-flow/block");

  // A reviewer card appears on a rail: its wire must not jump, and the wires must not be rebuilt (a rebuild flickers).
  while (secs() < 5.8) await sleep(100);
  await b.ev(`window.__w1 = document.querySelector('#wires > path[data-to="w1"]'); window.__glow = document.querySelector('#wires .flows--glow'); 0`);
  const sampled = JSON.parse(await b.ev(`new Promise(res => { const ends = [], cards = []; let n = 0; (function f() {
    const p = document.querySelector('#wires > path[data-to="r1"]');
    if (p) { const m = p.getAttribute('d').match(/-?[\\d.]+/g).map(Number); ends.push([m[m.length - 2], m[m.length - 1]]); }
    const sh = document.querySelector('[data-id="r1"] > .shell'), ps = document.querySelector('[data-id="w1"] > .shell');
    if (sh && ps) {
      const cs = getComputedStyle(sh), r = sh.getBoundingClientRect(), pr = ps.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      cards.push({ op: +cs.opacity, sc: new DOMMatrix(cs.transform).a, inParent: cx >= pr.left && cx <= pr.right && cy >= pr.top && cy <= pr.bottom, z: cs.zIndex, zp: getComputedStyle(ps).zIndex });
    }
    if (++n < 100) requestAnimationFrame(f); else res(JSON.stringify({ ends, cards })); })(); })`));
  const rail = sampled.ends, cards = sampled.cards;
  const last = rail.at(-1) || [0, 0], dev = Math.max(0, ...rail.map(([x, y]) => Math.max(Math.abs(x - last[0]), Math.abs(y - last[1]))));
  check("the wire of a new reviewer card does not move once it is drawn", rail.length > 10 && dev < 0.6, `${rail.length} samples, largest move ${dev.toFixed(1)}px`);
  // The card comes out from behind its parent: it starts hidden behind it, at scale 0 and opacity 0, and ends whole, in place, level with the other cards.
  const first = cards[0] || {}, end = cards.at(-1) || {};
  check("a new child card starts hidden behind its parent, at scale 0 and opacity 0", cards.length > 20 && first.op < 0.3 && first.sc < 0.3 && first.inParent === true, JSON.stringify(first));
  check("a new child card is under its parent while it comes out", first.z === "1" && first.zp === "2", JSON.stringify(first));
  check("the card grows and fades in without going back", cards.every((c, i) => i === 0 || (c.op >= cards[i - 1].op - 0.02 && c.sc >= cards[i - 1].sc - 0.02)), "went back at some frame");
  check("the card ends at full size and opacity, level with the other cards", end.op === 1 && Math.abs(end.sc - 1) < 0.01 && end.z === "2", JSON.stringify(end));
  check("the wires are updated in place, not rebuilt, when a card appears", await b.ev(`document.querySelector('#wires > path[data-to="w1"]') === window.__w1 && document.querySelector('#wires .flows--glow') === window.__glow`));

  // A card the user moved keeps its place while updates arrive.
  await b.ev(`(() => { const li = document.querySelector('[data-id="w1"]'); setOff(li, { x: 48, y: 24 }); })()`);
  while (secs() < 6.4) await sleep(100);
  const moved = await b.ev(`document.querySelector('[data-id="w1"]').style.transform`);
  check("a moved card keeps its offset during live updates", /^translate\(48px, ?24px\)$/.test(moved), moved);
  const litMix = await lit();
  check("a finished head stays lit while a reviewer under it runs", litMix.includes("w1") && litMix.includes("r1"), JSON.stringify(litMix));
  check("a branch with a running agent keeps the ~ mark", /^~\$/.test(await text("w1", "[data-cost]")), await text("w1", "[data-cost]"));

  while (secs() < 8.6) await sleep(100);
  const litEnd = await lit();
  check("no wire is lit once every task has finished", litEnd.length === 0, JSON.stringify(litEnd));
  check("a finished branch shows its final cost without ~", /^\$/.test(await text("w1", "[data-cost]")), await text("w1", "[data-cost]"));
  check("the reason of a failed agent shows as its tooltip", (await b.ev(`document.querySelector('[data-id="w3"] > .shell .task').title`)) === "verify failed 3 times: check:design", await b.ev(`document.querySelector('[data-id="w3"] > .shell .task').title`));
  check("a failed agent shows Failed", (await text("w3", "[data-pill]")) === "Failed", await text("w3", "[data-pill]"));
  check("the offset is still there after the whole run", /^translate\(48px, ?24px\)$/.test(await b.ev(`document.querySelector('[data-id="w1"]').style.transform`)));

  // The failed count opens a list of the failed agents.
  const fp = (js) => b.ev(`(() => { ${js} })()`);
  const chip = JSON.parse(await fp(`const c = document.querySelector("#failChip"), p = document.querySelector("#failPop"); const probe = document.createElement("i"); probe.style.color = "var(--fail)"; document.body.appendChild(probe); const want = getComputedStyle(probe).color; probe.remove(); return JSON.stringify({ tag: c && c.tagName, text: c && c.textContent.trim(), exp: c && c.getAttribute("aria-expanded"), hidden: p.hidden, color: c && getComputedStyle(c).color, want });`));
  check("the failed count is a button, closed at first", chip.tag === "BUTTON" && /^1 failed/.test(chip.text) && chip.exp === "false" && chip.hidden === true, JSON.stringify(chip));
  check("the failed count keeps the failed color", chip.color === chip.want, JSON.stringify(chip));
  const rot = (js) => fp(`const t = getComputedStyle(document.querySelector("#failChip svg")).transform; if (t === "none") return 0; const m = t.match(/matrix\\(([^)]+)\\)/)[1].split(",").map(Number); return Math.round(Math.atan2(m[1], m[0]) * 180 / Math.PI);`);
  // A click is a press and a release. The count must be the same element between them, or the browser drops the click.
  await fp(`window.__chip = document.querySelector("#failChip");`); await sleep(1200);
  check("the failed count stays the same element while the page updates", await fp(`return document.querySelector("#failChip") === window.__chip && document.body.contains(window.__chip);`) === true);
  const closedRot = await rot();
  await fp(`document.querySelector("#failChip").click();`); await sleep(150);
  await sleep(300);
  const openRot = await rot();
  check("the chevron points down when closed and up when open", Math.abs(closedRot) === 0 && Math.abs(openRot) === 180, closedRot + " then " + openRot);
  const open = JSON.parse(await fp(`const p = document.querySelector("#failPop"), r = p.querySelector(".failrow"); return JSON.stringify({ hidden: p.hidden, exp: document.querySelector("#failChip").getAttribute("aria-expanded"), rows: p.querySelectorAll(".failrow").length, name: r && r.querySelector(".failrow__name").textContent, task: r && r.querySelector(".failrow__task").textContent, why: r && r.querySelector(".failrow__why").textContent, btns: r && [...r.querySelectorAll(".failrow__acts button")].map(x => x.textContent) });`));
  check("the count opens a row for the failed agent", open.hidden === false && open.exp === "true" && open.rows === 1 && open.name === "Worker" && /t3/.test(open.task) && /Unpriced model/.test(open.task), JSON.stringify(open));
  check("the row shows the reason and the Dismiss and Retry buttons", open.why === "verify failed 3 times: check:design" && JSON.stringify(open.btns) === JSON.stringify(["Dismiss", "Retry"]), JSON.stringify(open));
  const gap = await fp(`const c = document.querySelector("#failChip").getBoundingClientRect(), p = document.querySelector("#failPop").getBoundingClientRect(); return Math.round(p.top - c.bottom);`);
  check("the list hangs close under the failed count", gap >= 0 && gap <= 10, String(gap));
  check("the hint text is gone", await fp(`return !document.querySelector(".at__hint");`) === true);
  await fp(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));`); await sleep(100);
  check("Escape closes the list", await fp(`return document.querySelector("#failPop").hidden;`) === true);
  await fp(`document.querySelector("#failChip").click();`); await sleep(100);
  await fp(`view.x += 700; view.y += 400; applyView();`);
  await fp(`document.querySelector('#failPop .failrow__head').click();`); await sleep(100);
  const off = await fp(`const r = document.querySelector('[data-id="w3"] > .shell').getBoundingClientRect(), v = document.querySelector(".canvas").getBoundingClientRect(); return Math.round(Math.hypot((r.left + r.width / 2) - (v.left + v.width / 2), (r.top + r.height / 2) - (v.top + v.height / 2)));`);
  check("a click on the agent name centers the failed card on the canvas", off <= 2, String(off));
  // Retry: the first click arms it, the second click asks the server to start a run.
  const rb = () => fp(`const b = document.querySelector('#failPop button[data-act="retry"]'); return JSON.stringify({ text: b.textContent, disabled: b.disabled, msg: (document.querySelector("#failPop .failrow__msg") || {}).textContent || "" });`);
  const r0 = JSON.parse(await rb());
  check("Retry is ready to press on a live run", r0.text === "Retry" && r0.disabled === false, JSON.stringify(r0));
  await fp(`document.querySelector('#failPop button[data-act="retry"]').click();`); await sleep(150);
  const r1 = JSON.parse(await rb());
  check("the first click arms Retry and states the budget, and starts nothing", /^Confirm · up to \$5$/.test(r1.text) && retryCalls.length === 0, JSON.stringify(r1) + " calls " + retryCalls.length);
  await fp(`document.querySelector('#failPop button[data-act="retry"]').click();`); await sleep(500);
  const r2 = JSON.parse(await rb());
  check("the second click asks the server to retry the task of the failed agent", JSON.stringify(retryCalls) === JSON.stringify(["t3"]), JSON.stringify(retryCalls));
  check("the row shows that the retry started and cannot be pressed twice", r2.text === "Retry started" && r2.disabled === true && /Started a new run for t3/.test(r2.msg), JSON.stringify(r2));
  await fp(`document.querySelector('#failPop button[data-act="dismiss"]').click();`); await sleep(150);
  const gone = await fp(`return JSON.stringify({ chip: !!document.querySelector("#failChip") && getComputedStyle(document.querySelector("#failChip")).display !== "none", hidden: document.querySelector("#failPop").hidden, sum: document.querySelector("#sum").textContent });`);
  check("Dismiss removes the entry and the count", !JSON.parse(gone).chip && JSON.parse(gone).hidden, gone);

  while (secs() < 10) await sleep(100);
  s = await state();
  check("the run ends and the label says so", /ended/.test(s.mode), s.mode);
  const t1 = await text("cap", "[data-time]"); await sleep(1300); const t2 = await text("cap", "[data-time]");
  check("the clock stops when the run has ended", t1 === t2, `${t1} then ${t2}`);

  // Replay of the recorded run.
  const runs = await (await fetch(`http://127.0.0.1:${srv.port}/runs`)).json();
  check("the run was recorded", runs.length === 1 && runs[0].id === "r-test-0001" && runs[0].ended === true, JSON.stringify(runs));
  await b.go(`http://127.0.0.1:${srv.port}/?replay=r-test-0001&instant=1`);
  await sleep(500);
  s = await state();
  check("instant replay opens the finished run", /^Replay/.test(s.mode) && s.ids.length === 5, JSON.stringify(s));
  await b.ev(`document.querySelector("#failChip").click()`); await sleep(150);
  const rr = JSON.parse(await b.ev(`(() => { const x = document.querySelector('#failPop button[data-act="retry"]'); return JSON.stringify({ disabled: x.disabled, title: x.title }); })()`));
  check("in a replay the Retry button is off and says why", rr.disabled === true && /live run only/.test(rr.title), JSON.stringify(rr));
  await b.go(`http://127.0.0.1:${srv.port}/?replay=r-test-0001`);
  await sleep(400);
  const early = (await state()).ids.length;
  await sleep(3000);
  const later = (await state()).ids.length;
  check("normal replay builds the tree over time", early < later, `${early} then ${later}`);
  await b.go(`http://127.0.0.1:${srv.port}/?replay=r-nope`);
  await sleep(300);
  check("an unknown run says so", /not found/.test((await state()).mode), (await state()).mode);

  // The demo still runs from a file.
  await b.go(pathToFileURL(join(import.meta.dirname, "..", "agent-tree.html")).href);
  await sleep(1500);
  s = await state();
  check("the page opened from a file runs the demo", s.mode === "Demo" && s.ids.length >= 1, JSON.stringify(s));

  // Disconnect.
  await b.go(`http://127.0.0.1:${srv.port}/`);
  await sleep(800);
  await srv.close();
  await sleep(3500);
  check("the label says Disconnected when the server stops", /Disconnected/.test((await state()).mode), (await state()).mode);
} catch (e) {
  check("the test ran without an error", false, e.message);
} finally {
  b.close(); await srv.close().catch(() => {});
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed} of ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
