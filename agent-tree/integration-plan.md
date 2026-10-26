# Agent Tree live integration plan

Status: option B chosen on 2026-10-25. Built and tested: the adapter, the server, the page adapter, replay (WP1 to WP6), the `captain.md` task-label rule, the docs (WP7) and lit wires for running tasks. One real `/dcs:work` run (3 tasks) has passed through the tree (section 9.3). Open: a real run with a failure, a retry and the refuter.

## 1. Goal

Make `agent-tree.html` show a real dcs run. Today a demo script drives the page. After this work, real agent data drives the page.

The tree must show the same agents, status, time and cost that the run produces. The tree must not change the run.

## 2. Decision

Use Agent Monitor (https://github.com/a0s/agent-monitor) as the source of agents. Add a small dcs adapter on top.

| Need | Source |
|---|---|
| Agents, `parentId`, model, task text, running or stopped | Agent Monitor |
| `taskId` (the lane) | dcs: parsed from the task text, checked against the dcs store |
| `queued` | dcs store: tasks at `todo` with no agent yet |
| `failed`, `needs_input` | The agent's own last reply: a dcs worker or reviewer ends with JSON that has a `status` |
| Cost | Adapter: transcript tokens times a price table |

Reason: Agent Monitor already reads Claude Code transcripts and subagent metadata. It has an optional hook log. This removes the need to write hooks and a transcript parser in the dcs plugin.

Fallback: if the dependency causes trouble, move to option C. Option C copies the transcript parsing into `dcs/lib/events.js`. The page-side work does not change.

## 3. Scope

In scope:

- Install and pin Agent Monitor.
- An adapter that turns its output into the tree's `agents` list.
- A local server that streams the result to the page.
- An adapter in the page.
- Real cost and real time on the cards.
- Replay of finished runs.

Out of scope:

- Control from the tree. The tree is read-only. It does not approve, unblock, or stop tasks.
- Codex agents. Agent Monitor supports them. The dcs harness does not use them.
- Publishing a live tree as a claude.ai artifact (see section 10).

## 4. Starting point (before the build, 2026-10-25)

This table records what the page and the harness were like before this work. Section 9.1 has the state now.

| Part | Where | Fact |
|---|---|---|
| Data model | `agent-tree.html` ~line 216 | Flat `agents` list. `parentId` gives the wire. `taskId` gives the lane. |
| Demo feed | `agent-tree.html` ~line 700 | `buildScript()` returns `[seconds, mutation]` pairs. A comment marks it as the swap point. |
| Clock | `setInterval` ~line 745 | Simulated `now` and `speed`. |
| Cost | `RATE` constant | Fixed dollars per second by role. This is an estimate. |
| Fold behavior | `holdRoot()` | The Captain card stays still on fold and unfold. A live update must keep this. |
| Harness | `dcs/` plugin | Hooks: `PreToolUse` (guard) and `SessionStart` (brief). No event output. |
| Harness state | `dcs/lib/store.js`, `tasks.js` | JSON files, atomic write, lock. Task states: todo, doing, verified, approved, done, blocked. |

## 5. What Agent Monitor gives

Source: its README, `docs/how-it-works.md` and its code (version 0.2.3, commit `7f4c2dd`, 2026-10-14). Section 5.1 gives what the code confirms. A live run still must confirm real output.

| Topic | Fact |
|---|---|
| Output | Terminal view, or `--json` for one snapshot. |
| Without hooks | Reads `~/.claude/projects/` transcripts every 2 seconds. Subagents are `<session>/subagents/agent-<id>.jsonl`. A `.meta.json` gives type and task text. It reads the process list every 6 seconds. |
| With hooks | Hooks append start and stop rows to `~/.agent-monitor/events.jsonl`. Stop times become exact. A hook has a 3-second timeout and never blocks the agent. |
| Status | `running`, `stopped`, `unknown`. Stopped agents leave the view. |
| Gaps | No cost or tokens. No `queued`, `failed` or `needs_input`. No `taskId`. |

### 5.1 Code review findings (2026-10-25)

I read all of `lib/agent-monitor.mjs` (606 lines) and `bin/agent-monitor` (62 lines). I did not run the code or its tests.

Size and safety:

- The tool has no dependencies and no network code. It starts only `git`, `ps` and `lsof`.
- A snapshot writes nothing. It reads transcripts in every `~/.claude*` and `~/.codex*` folder, `~/.agent-monitor/events.jsonl`, `teams/*/config.json`, and the process list.
- Writes happen only in three cases:
  - `--install-hooks` edits `settings.json` (Claude) or `hooks.json` (Codex) in the folders named. With no folder named, it edits `~/.claude` and `~/.codex`. It also removes old harness-supervisor leftovers: a `.bin/agent-tree` link and a `hook.agent-tree-install` git config section.
  - `--remove-hooks` removes only its own hook entries. It matches them with the pattern `agent-monitor _event`.
  - A hook (`_event`) appends one row to `~/.agent-monitor/events.jsonl`. The row holds the **whole hook payload**. The file is cut to the last day when it passes 8 MB.

Output shape of `snapshot()` (the same data as `--json`):

```
{ worktrees: [ { path, agents: [ node ] } ] }
node = { id, cli, type, parent, parentKnown, source, model, effort, title,
         status, lastEvent, lastAt, lastOrder, pid?, children: [node] }
```

| Field | Value |
|---|---|
| `id` | Session ID, or agent ID for a subagent. |
| `type` | `session` for the top session. For a subagent, `agentType` from its `.meta.json` (for example `dcs:worker`, to confirm). |
| `parent` | For a Claude subagent, always the session ID. This is the Captain. This matches the tree. |
| `title` | The `description` from the subagent `.meta.json`. WP2 parses the task ID from it. This is confirmed. |
| `status` | `running`, `stopped` or `unknown` only. |
| `lastAt` | Time of the last event or transcript change. There is **no start time and no end time**. |
| `source` | `event` or `process`. A `process` node has no model or title. |
| `children` | Nested nodes. The list is a tree, not flat. |

Gaps and traps:

1. **The node has no transcript path, tokens or cost.** The adapter must find the transcript itself. A subagent file is `<claude dir>/projects/<project>/<session id>/subagents/agent-<id>.jsonl`. The top session file is `<claude dir>/projects/<project>/<session id>.jsonl`.
2. **Stopped agents vanish.** The output keeps only agents that run, have a process, or were active in the last 15 minutes with an unknown status. A stopped subagent leaves the output at the next poll, unless a live child needs it. The adapter must keep its own memory of every agent.
3. **A subagent is stopped only when its last turn ended with `end_turn`.** In Claude Code 2.1.310 this never happens for a background subagent (see 5.2). Read `finished` from the `.meta.json` instead. A failed agent looks the same as a finished agent. `failed` must come from the dcs store or from the transcript.
4. **The Captain stays `running` while Claude Code waits for you.** It runs as long as its process runs. Do not use it to detect the end of a run. Use the dcs store (all tasks done) or "all subagents stopped for 60 seconds".
5. **`needs_input` is not available.** The hook list for Claude Code is `SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `TeammateIdle` and `TaskCompleted`. There is no `Notification` hook. This gap in Agent Monitor is **resolved (2026-10-25):** a dcs worker returns `needs_input` in its own last reply (captain.md rule 2), and the adapter reads that reply (section 9.3). No hook is needed.
6. **Cost on the CLI path is high.** Each CLI call re-parses every transcript from the last day. The cache lives in process memory only. A server that imports the library keeps the cache between polls.
7. **Hook payloads name the files.** The code reads `agent_id`, `session_id`, `transcript_path` and `agent_transcript_path` from `SubagentStart` and `SubagentStop` payloads. This answers the old question about payload fields, from code, not from the Claude Code docs.

### 5.2 Live run findings (2026-10-25)

Method: I imported `snapshot()` from the clone (no install, no hooks). I started one real subagent in this session with the description `t-01 Spec the pricing screen`. I polled every 4 seconds. The subagent ran for 43 seconds (Claude Code 2.1.310).

| Check | Result |
|---|---|
| Captain found | Yes. `type: session`, running, with the right `pid`. Model `sonnet-5-5`, effort `medium`. |
| Subagent found as child of the Captain | Yes. `parent` is the session ID. |
| `title` carries the description | Yes, verbatim: `t-01 Spec the pricing screen`. The task-ID rule in WP2 works. |
| `type` for the subagent | `general-purpose` (the `agentType` in `.meta.json`). A `dcs:worker` value is **not tested**. |
| Poll time | 35 to 150 ms when warm. 1.3 s on the first call. About 700 ms when a transcript changes. Importing the library works as planned. |
| **Stop detected** | **No.** The subagent finished at 16:58:06 and still showed `running` at 16:58:41. |

Why the stop was missed: in this Claude Code version a background subagent ends with a `SubagentHandback` tool call, followed by a `tool_result` row. Agent Monitor marks a subagent stopped only when its last turn is an assistant row with `stop_reason: end_turn`. This subagent never ends that way. So Agent Monitor shows it as `running` until the session ends or 15 minutes pass.

The fix is available and needs no hook. Claude Code writes `"finished": true` into the subagent `.meta.json` when the agent ends. Agent Monitor does not read this field. The adapter must read it. The transcript timestamps were exact: first row 16:57:22.830, last row 16:58:06.128, which matches the 43.3 s duration.

Not tested:

- A real `/dcs:work` run. The `dcs:worker` and `dcs:reviewer` type names, and the Captain's real task descriptions, are still unconfirmed.
- Failure, retry and `needs_input` cases.
- Several parallel agents.

What this changes:

- **Import the library.** `snapshot(cwd, only, options)` is an exported ES module function. The server imports it from the pinned checkout. The server does not start the CLI on each poll.
- **Take times from the transcript.** Each transcript row has a timestamp. `start` is the first row. `end` is the last row of a stopped agent. This is more exact than first-seen time.
- **Hooks are not needed for status.** The transcript gives `stopped` with `end_turn`. Agent Monitor's own hooks add exact stop times only. Leave them off.
- **The library is `private` and is not on npm.** Vendor the pinned files into `agent-tree/vendor/agent-monitor/` with the licence, or import them by path from a pinned checkout. Vendoring is simpler. Recommendation: vendor.

## 6. Architecture

```
Agent Monitor (--json, every 2 s)  ─┐
dcs store (.claude/dcs/*.json)     ─┼─> adapter.mjs ─> server.mjs ─> SSE /stream ─> agent-tree.html
transcripts (tokens for cost)      ─┘   merge + map    poll, diff,    snapshot      applySnapshot()
                                                       record runs                    -> agents[] -> render()
```

1. The server polls the sources every 2 seconds.
2. The adapter builds one normalized snapshot of all agents.
3. The server sends the snapshot to the page when it changes. It also appends it to a run file for replay.
4. The page compares the snapshot with its `agents` list and applies the differences.

Reason to send snapshots, not events: Agent Monitor gives state, not a change feed. A snapshot is simple and survives a missed message. The server keeps a run file because Agent Monitor drops stopped agents from its view.

## 7. Snapshot spec

One JSON message per change. The `data` field of each SSE message holds this object:

```
{ "v": 1, "seq": 42, "ts": 1761407000000, "run": "r-20261025-1148", "live": true,
  "agents": [ { "id", "parentId", "taskId", "role", "name", "model", "task",
                "status", "start", "end", "cost", "costFinal", "note" } ] }
```

| Field | Rule |
|---|---|
| `id` | Agent Monitor's agent ID. Unique in a run. |
| `parentId` | `null` only for the Captain. Every other agent has the Captain as parent. |
| `taskId` | Parsed from the task text (WP2). `null` if none. The page puts such an agent on the Captain's rail. |
| `role` | `captain` for the top session. `worker` or `reviewer` from the agent type (`dcs:worker`, `dcs:reviewer`). |
| `status` | `queued`, `running`, `done`, `failed` or `needs_input`. See the mapping below. |
| `note` | The reason for a `failed` or `needs_input` status, from the agent's reply. `null` otherwise. The page shows it as the tooltip of the task text. |
| `start`, `end` | Unix milliseconds. `end` is `null` while running. |
| `cost` | US dollars. `costFinal` is `false` while the agent runs. The page shows `~` before the value. |

Status mapping:

| Condition | Page status |
|---|---|
| Monitor says running and `.meta.json` does not say `finished` | `running` |
| Finished, and its last reply is JSON with `"status": "failed"` or `"blocked"` | `failed` (a blocked agent is a failure with a reason) |
| Finished, and its last reply is JSON with `"status": "needs_input"` | `needs_input` |
| Finished, and its last reply is `"status": "done"`, is not JSON, or there is none | `done` |
| Monitor says stopped, or the `.meta.json` has `finished: true` | finished (the three rows above) |
| dcs task is `todo` and has no agent yet | No card. A card appears only when the Captain starts an agent for the task (changed 2026-10-25; the adapter no longer adds `queued` placeholders) |
| Monitor says unknown | `running` with a warning mark, until 15 minutes pass |

Page rules:

- The page skips an agent with an unknown `parentId` and logs a warning.
- The page never removes an agent during a live run. A stopped agent that leaves Agent Monitor's view stays in the list as `done`.

## 8. Work packages

### Step 0. Spike (read-only, no code in the plugin)

1. Read the Agent Monitor code. Pin one commit.
2. Check the code with the `skill-inspector` skill or a manual read. It reads transcripts and can edit `settings.json` with `--install-hooks`.
3. Install from the pinned checkout. Do not install hooks.
4. Start a small `/dcs:work` run in a test repo. Run `agent-monitor --json <repo>` every few seconds. Save the outputs.
5. Record in this plan: the exact JSON fields, how it names the Captain, and whether it gives start time, stop time, transcript path and agent type.
6. Check whether the task text carries a `taskId` (WP2).
7. Check whether `needs_input` can be found (WP1 fallback: skip it in the first version).

Exit check: section 5 has no unconfirmed rows. The user approves the field mapping.

Progress on 2026-10-25:

- Item 1 is done: code read, version 0.2.3, commit `7f4c2dd`.
- Item 2 is done as a manual read. The result is in section 5.1. No network code. Writes only on hook install, hook removal and hook events.
- Items 3 to 5 are done with a test subagent. See section 5.2. Install was not needed: the library runs from the clone.
- Item 6 is partly done. The description passes through as `title`. A real Captain dispatch is not tested.
- Item 7 is done: `needs_input` has no source (section 5.1, trap 5).
- Open: one real `/dcs:work` run in a test repo, to check the `dcs:worker` type name, the Captain's descriptions, failure, retry and parallel agents.

### WP1. Adapter (`agent-tree/adapter.mjs`) — built 2026-10-25

Node only. No dependencies. One function: `snapshot(repoPath) -> { agents[] }`.

1. Import `snapshot()` from the pinned library (see section 5.1). Call it with the repo path and `'claude-code'`. Flatten the nested `children`.
2. Map each agent to the snapshot spec.
3. Read the dcs store for task states.
4. ~~Add placeholder `queued` agents~~ Dropped: a task with no agent shows no card.
5. Keep a per-run memory of every agent. Agent Monitor drops a stopped agent at the next poll. Take `start` and `end` from the first and last row timestamps of the agent transcript. Use first-seen and last-seen time only if the transcript is missing.
6. On any parse error, return the last good snapshot and a warning. Do not throw.

### WP2. Task ID

Agent Monitor knows the task text of each subagent. That text is the `description` that the Captain gives when it starts the agent.

1. Change `dcs/references/captain.md`: the Captain starts every worker and reviewer with a description that begins with the dcs task ID, for example `t2 Build the plan cards`. **Done 2026-10-25:** rule 16 and the four dispatch templates (worker, reviewer, refuter, visual QA) in `dcs/references/captain.md`. dcs issues IDs like `t1` and `t2`, not `t-01`. Run `claude plugin update dcs@dcs-local` so Claude Code loads the new text.
2. The adapter parses `^t-?0*(\d+)`. It reads `t-01` and `T01` as `t1`. The rest of the text becomes `task`.
3. The adapter checks the ID against the dcs store. An unknown ID gives `taskId: null` and a warning.

If Step 0 shows a better field, use that field. Do not add a hook only for this.

### WP3. Cost — built 2026-10-25 (price table in `agent-tree/prices.json`)

1. Find the transcript of each agent: `<session>/subagents/agent-<id>.jsonl` (or the path from `--json`).
2. Sum input, output and cache tokens from the `usage` fields.
3. Multiply by `dcs/references/prices.json` (new). Key it by model ID. One file holds all prices.
4. Set `costFinal: true` when the agent is stopped.
5. While an agent runs, recompute on each poll. Cache the file offset so each poll reads only new lines.
6. If the price table lacks a model, the cost is `null` (the page shows `—`) and the adapter does not guess.
7. The price table lives in `agent-tree/prices.json`, not in the plugin. Input, output and some cache-read prices come from the claude-api skill (cached 2026-10-06). **Cache-write prices were checked on a real run (section 9.3):** for `claude-sonnet-5-5` a 5-minute write costs the input price and a 1-hour write costs 2x. The first guess (1.25x for 5 minutes) made the tree 10% too high. The other models use the same rule, which is not verified for them. The Haiku cache-read price is assumed.

The Captain's cost comes from the top session transcript in the same way.

### WP4. Server (`agent-tree/server.mjs`) — built 2026-10-25

Node only. No dependencies.

| Route | Behavior |
|---|---|
| `GET /` | Serves `agent-tree.html`. |
| `GET /stream` | SSE stream. Sends the latest snapshot at once, then each change. |
| `GET /runs` | Lists recorded runs, newest first. |
| `GET /runs/<id>` | Returns the recorded snapshots of one run. |

Rules:

- Bind to `127.0.0.1` only.
- Poll every 2 seconds. Send a message only if the snapshot changed. Send a comment line every 15 seconds as a keep-alive.
- Take the repo path as an argument: `node server.mjs /path/to/repo`.
- Append each changed snapshot to `agent-tree/runs/<run>.jsonl`. Keep the folder out of any synced or shared location.
- A run ends when the Captain stops. The server sets `live: false`.
- Add a `dcs tree` command later, if wanted. It starts the server and opens the page.

### WP5. Page adapter (`agent-tree.html`) — built 2026-10-25

Replace the demo block only.

1. Add `applySnapshot(s)`. It updates existing agents by `id`, adds new agents, and calls `fresh.add(id)` for new ones.
2. Add `connect()`. It opens `EventSource('/stream')`. On error it shows "Disconnected" and retries.
3. Keep `buildScript()` as demo mode. Use it when the URL has `?demo=1` or when no server answers.
4. In live mode, set `now` from the snapshot time. Hide the simulated `speed` control.
5. Show `~` before a cost while `costFinal` is `false`.
6. Add a small status line: run ID, "Live", "Replay" or "Disconnected", and the time of the last snapshot.
7. Call `render()` only when the agent list changes. Call `tick()` for number updates. This is the current pattern.
8. Keep `holdRoot()` for fold and unfold.

Drag offsets, folds and the canvas view must survive each live update. They already do for simulated updates.

### WP6. Replay — built 2026-10-25

1. `?replay=<run>` loads `/runs/<id>`. The page applies the snapshots at their `ts` gaps. The `speed` control sets the pace.
2. A finished run with `?replay=<run>&instant=1` opens fully built.

### WP7. Docs — done 2026-10-25

1. `agent-tree-anatomy.html`: new Part 10 "Live data" (the five page modes, the snapshot fields, the cost marks, the queued card, privacy). Published to the artifact as version 11. The same publish carried the UI Kit ripple port of the click effect, which was only in the local file before.
2. `dcs/README.md`: new "Agent Tree" section (start command, rule 16, plugin update, privacy) and "16 rules" in the details list.
3. `agent-tree/README.md`: new. Start, URL modes, data flow, the task label rule, files, tests, cost note, limits, privacy, how to update the vendored library.
4. `How It Works/build-course/09-captain-and-skills.md`: the simplified Captain gets rule 11 and a `description` in the three dispatch templates. "15 rules" is now "16 rules".
5. This plan: decisions updated (section 10).

Not changed on purpose: `docs/plan.md` and `docs/plan-v1.md` (the historical build plans, with the old templates) and `docs/spec.md` (it only points to `captain.md`).

## 9. Order and exit checks

| Step | Work | Exit check |
|---|---|---|
| 0 | Spike | Section 5 fully confirmed. Field mapping approved. |
| 1 | WP1 with saved Step 0 outputs | The adapter turns a saved output into a valid snapshot. A test reads it back. |
| 2 | WP4 and WP5 | A hand-made snapshot file renders the same tree as the demo. |
| 3 | WP2 | A real `/dcs:work` run shows the right agents, parents and lanes. |
| 4 | WP3 | Card costs match a manual token count within 5%. |
| 5 | WP6 and WP7 | A finished run replays. Docs match the code. |

### 9.1 Build status (2026-10-25)

| Item | State |
|---|---|
| `vendor/agent-monitor/` | Done. Version 0.2.3, commit `7f4c2dd`, file unmodified (hash checked), licence and `VENDORED.md` included. |
| `adapter.mjs` | Done. `createAdapter({ repo }).poll()` returns one snapshot. `node adapter.mjs <repo>` prints it. |
| `prices.json` | Done. Sonnet 5.5 cache-write prices are checked against a real run (0.14% from the Claude Code total). The other models use the same rule, not verified. |
| `test/adapter.test.mjs` | 16 tests, all pass. Run with `node --test test/adapter.test.mjs` (Node 25 needs the file path, not the folder). Two deliberate breaks of the adapter made 4 and 1 tests fail. |
| Real data check | The adapter read this session: Captain found, one test subagent shown as `done`, 43.3 s, $0.1215 (matches a hand count). |
| `captain.md` task-ID rule | Done: rule 16 and a `description` in each dispatch template. The seven dcs test files still pass. On the machine where dcs is installed, run `claude plugin update dcs@dcs-local`. **On this machine dcs is not installed** (checked 2026-10-25: no dcs marketplace, no cache copy). Load it for one session with `claude --plugin-dir <harness>/dcs`. A real run must show that the Captain follows the rule. |
| `server.mjs` | Done. Serves the page, polls the adapter every 2 s, streams each snapshot over SSE, records the run to `runs/<run>.jsonl` when the agents change. Local only: binds to `127.0.0.1`, refuses any other Host header, run ids cannot leave `runs/`. 6 tests. |
| Page (`agent-tree.html`) | Done. Live mode (default when served), `?replay=<run>` and `&instant=1`, `?demo=1`, demo when opened from a file. A status label shows Live, Replay, Demo, Disconnected or Waiting. The `~` mark shows a cost that is still counting and `—` a model without a price. |
| Page fixes the live data needed | A card now updates its name, model and task text when they change. An agent that leaves the data now leaves the list (the old code left it in the DOM). |
| `test/page.cdp.mjs` | 46 browser checks, all pass (including lit wires, the wire shine, the wire stability and the card entrance). Needs Chrome. Run by hand: `node test/page.cdp.mjs`. Removing the stale-card fix made one check fail. The earlier Captain-position test still passes. |
| Lit wires | Done. Each wire is its own path. The wire into an agent is lit (lighter orchid, with a travelling comet) while that agent or anyone under it runs. The comet uses the shine of a running card: the card's `--shine-line` color, the same grain filters (copied as user-space filters so a straight wire still renders), the orchid glow, and the card's slow fade-in at the tail and fast fade-out at the tip (up to 28 stacked dashes for the line and 10 for the glow, with lengths that follow 1 - sqrt(j/n) and the longest layers carrying the least opacity, so the first step at each end is 3.4% and the largest step anywhere is 4%; a budget of about 600 layers lowers the count when many wires are lit). The speed is the constant `WIRE_SPEED`, 120 px a second. With 24 wires lit at once (552 layers) headless Chrome ran at 33 frames a second against 61 with none lit. One shared clock keeps the pulse going through a drag or resize. Reduced motion keeps the lighter color only. 7 browser checks, which fail when the feature is broken. |
| Wire stability | Done. When a card appeared on a rail (the reviewers), its wire was first drawn to the card's entrance pose (3 px across, 7 px down from where it settles) and then redrawn, and every redraw rebuilt all wires and comet layers, which flickered. The measurement now takes a new card at the end of its entrance animation (seek, measure, put back, with no paint in between), and the wires are updated in place: only the `d` of a moved wire changes, new wires are added, old ones removed. Checked on the replay of a real run: no wire end moves; the 6.8 px move and the rebuild were reproduced by two new browser checks before the fix. Dragging still moves the wire with the card. |
| Card entrance | Done. A new child card starts hidden behind its parent (centre on the parent's centre, scale 0, opacity 0) and moves into place in 650 ms while it grows to full size and fades in (opacity full at 70%). It is under every other card while it moves (`z-index` 1 against 2, until 100 ms after the animation). The motion is made with the Web Animations API after layout, because the start point is the parent's centre. The wire is measured at the end of the animation (`settledRect`) and fades in with the card. The Captain only grows from 94%. 4 browser checks. Checked in frames at 0, 70, 140, 220, 300, 400, 520 and 650 ms of a reviewer card in a replay. |
| Run end | Done. A run also ends when the Captain has no live process for 15 s and every agent has stopped. Found on the first real run (section 9.3). 1 test. |
| Docs (WP7) | Done: anatomy page Part 10 (published, version 11), `dcs/README.md`, `agent-tree/README.md`, build-course chapter 09. See WP7. |

How to run:

1. `node server.mjs <repo>` (add `--port <n>`, default 4173). It prints the address.
2. Open `http://127.0.0.1:4173/`. Start or continue a Claude Code session in `<repo>`.
3. Replay a recorded run: `http://127.0.0.1:4173/?replay=<run id>`. List the ids at `/runs`.
4. Run files are in `agent-tree/runs/`. They hold real task names and costs. Keep this folder out of any shared or synced location.

What the adapter does beyond the plan:

- **Catch-up:** Agent Monitor drops a stopped agent. A server that starts mid-run would miss it. The adapter also lists the Captain's `subagents` folder, so finished agents show at once. An agent in that folder that Agent Monitor does not show counts as stopped.

- **Run end:** the run is over when every dcs task is closed and every subagent has stopped. Without a dcs store it waits 60 seconds after the last subagent stops.
- **Failed and needs-input agents:** read from the agent's own last reply (`failed`, `blocked`, `needs_input`). The first design guessed from the dcs failure count. A real run showed that the count is the wrong signal: a worker can fail verify twice and then succeed, and a worker can stop with 0 failures (section 9.3).
- **Captain choice:** the newest running Claude Code session in the repo. Pass `captainId` to pin one.
- **Several sessions in one repo:** only one Captain is shown.

Known limits:

- The server keeps one run per Captain session. A new Claude Code session in the same repo, newer than the old one, becomes the Captain and the page clears.
- A snapshot arrives every 2 s. Costs update at that pace. Time runs smoothly between snapshots.
- The page has no control. It cannot start, stop or approve anything.

- Not yet seen in a real run: a reviewer that returns `needs_input`, and the refuter.
- The Captain's cost covers its whole transcript, not only the current run.

### 9.2 Real-run test setup (2026-10-25)

- Throwaway repo: `dcs-test-repo` in the session scratchpad, git, `main`, two commits, `npm test` and `npm run lint` pass.
- Server: `node server.mjs <that repo> --port 4173 --runs <scratchpad>/dcs-test-runs`, page at `http://127.0.0.1:4173/`.
- The user runs `/dcs:setup`, `/dcs:plan` and `/dcs:work` in an interactive session with `--plugin-dir`. Those steps need the user's approvals, so they cannot run unattended.
- After the run: compare the page, `GET /runs` and `node adapter.mjs <repo>` with the real agents, and record the findings here.

### 9.3 Result of the first real run (2026-10-25)

Setup: the throwaway repo below, settings and three tasks made with the dcs CLI (`dcs init`, `dcs add`), then a headless Captain: `claude -p "/dcs:work t1 t2 t3 --parallel …" --plugin-dir <harness>/dcs --permission-mode dontAsk --max-budget-usd 8`. `dontAsk` refuses anything that needs approval, so the run stopped before landing and committing. Claude Code reported $1.3357 and 90 s. All three tasks reached `approved` (0 failures, 12 review passes, no refuter). Nothing was landed or committed.

| Check | Result |
|---|---|
| Does the Captain follow rule 16? | **Yes.** Every worker is "t1 Add slugify helper" style. Every reviewer is "t1 ac review" style. All 15 agents had a task id and landed in the right column. |
| Agent types | `dcs:worker` and `dcs:reviewer` map to Worker and Reviewer. Task ids `t1`, `t2`, `t3` matched the dcs store with no warning. |
| Agent count | 16 in the tree: the Captain, 3 workers and 12 reviewers (4 passes for each task, no a11y because `ui` is false). This matches the run. |
| Parallel workers | They overlapped: t1 22 to 34 s, t2 25 to 39 s, t3 28 to 42 s after the Captain began. The Captain starts them about 3 s apart, one after another. The 12 reviewers also start about 3.5 s apart. |
| Cost | Sum of all cards $1.3338 against $1.3357 from Claude Code (0.14%). The first price guess gave $1.4653 (10% high), which led to the price fix. |
| Live updates | The page filled in as the run went. The page and `/runs` agree with the real agents. |
| Run end | **Bug found and fixed.** The run stayed "live" after the headless session had exited, because dcs counts `approved` as open. The adapter now ends a run when the Captain has no live process for 15 s and every agent has stopped. After the fix the same run reads "ended", with the Captain Done. |

Not exercised in that run: a failed task, a retry, the refuter, a UI task (a11y pass), landing and the commit. Runs 2 to 4 below cover the failing task.

### 9.4 Failing-task runs, with the Figma KPI card (2026-10-25)

Source design: node 787:375 "KPI Card" (Default and Hover states) of Figma file `MtH8OwzyZgd0u49f4M8QXz`. Its values were copied into `design/kpi-card.spec.json` in each test repo. Three tasks in the first two runs (`t1` formatDelta, `t2` KPI card with `ui: true` and the Figma URL, `t3` scaleBars); two tasks in run 4. The same headless Captain command as in 9.3.

| Run | What was different | What happened | What the tree showed |
|---|---|---|---|
| 2 | A check requires a 7:1 text contrast (AAA) and the design's label color. The two cannot both hold. Figma tools were **not** allowed in the headless session. | The `t2` worker called a Figma tool, was denied, wrote no code and replied `{"status": "blocked", "reason": "Figma read failed…"}`. The Captain stopped the task (rule 15). dcs counted 0 failures. | With the first adapter: Done (wrong). With the reply-based adapter: Failed, with the reason as the tooltip. |
| 3 | Same repo design, Figma read tools allowed. | The `t2` worker read the design, found the contrast conflict, wrote no code and replied `needs_input` with the conflict and three options. This is the "nobody guesses" rule working. dcs counted 0 failures. | **Needs input** (amber). |
| 4 | The design check is satisfiable. A second verify command, `check:render`, needs a `kpi-render` program and a reference PNG that do not exist on this machine. | The worker **built the card** (`src/kpi-card.html`, 62 lines, and `test/kpi-card.test.js`, 42 lines). `npm test`, `lint` and `check:design` passed. `check:render` failed with ENOENT. The Captain sent the verify output back to the same worker, which changed nothing and replied `blocked`. The task stayed `doing`, and dcs counted 0 failures (a verify fail streak of 1). | **Failed**, with the reason as the tooltip. The run then ended: Captain Done. |

Findings:

1. **dcs's failure count is the wrong signal for the tree.** In all three runs the count stayed at 0 although the task failed. A count of 3 verify failures in a row needs the worker to keep running verify, and these workers stopped at the first block. The adapter now reads the agent's own reply (`failed`, `blocked` and `needs_input`). The first design used the count. It showed the failed worker as Done in run 2.
2. **`needs_input` has a source after all** (the worker's reply), which closes the gap that section 5.1 listed.
3. **The harness behaves well on a task that cannot pass.** No worker guessed, edited the check, or added a fake program. The Captain did not unblock or work around anything. It asked the user, who was not there, so the task waited.
4. **The component.** Run 4's card is rendered in Chrome: 640 px wide, 40 px radius, 2 px `#e8ebef` border, shadows `0 8px 32px rgba(15,23,41,0.08)` and `0 16px 48px rgba(15,23,41,0.16)` on hover, ten bars of 40 to 112 px, 12 px gaps, colors as designed. It differs from the design in two places that the check does not test. Its height is 524 px against 536 px in Figma, probably because Inter is not loaded and a fallback font sets the line heights. It also has no `@font-face` for Inter, and the Figma hover state grows the card by a few pixels, which the worker did not copy. The worker also added a 0.2 s shadow transition that the AC did not ask for, and it reported this as discovered work.
5. **The Figma tool asks questions of its own.** `get_design_context` first answered with a Code Connect mapping prompt, and later with a request to fetch animation data. These are tool instructions, not user requests. They were skipped here.

## 10. Decisions

Made:

1. Source: Agent Monitor, with a dcs adapter (option B).
2. Message form: full snapshots, not an event feed. The server sends the latest full snapshot to each new connection, so the page needs no `Last-Event-ID` handling.
3. The tree is read-only.
4. Agent Monitor's hooks: off. Stop times come from the `finished` flag in each subagent `.meta.json` and from transcript timestamps. Hooks are not needed.
5. Library: vendored in `vendor/agent-monitor/`, pinned to version 0.2.3, commit `7f4c2dd`. It is not on npm. Update it only on purpose (steps in `README.md`).
6. Run boundary: one run per Captain session. The run id is the date plus the first six characters of the session id. A new, newer session in the repo starts a new run.
7. Retries: a failed worker and its retry share a `taskId`. Kept.
8. The adapter, server and prices live in `agent-tree/`, outside the plugin.
9. Task label: the Captain starts each agent with a description that begins with the dcs task id (rule 16 in `captain.md`). The adapter reads `t2`, `t-02` and `T02` as `t2`.
10. Cost: tokens from the transcript times `agent-tree/prices.json`. A model with no price gives no cost. It never gives a guess.

When to add a thin dcs hook (option A) later. Add one only if a real run shows one of these:

1. ~~`needs_input` must show on the tree.~~ Resolved: it comes from the worker's reply. A hook would only be needed for a question that the Captain itself asks the user.
2. Inferred stop times are visibly wrong. Try Agent Monitor's project-only hooks first.
3. The task id from the description is not reliable. The hook would write the id from the dcs store.

If a hook is added, it appends to one small file that the adapter reads. It does not bring back the full event pipeline of the first plan.

Open:

1. A real run that reaches the refuter, a UI task review with an a11y pass, and a worker that fails verify three times in a row (a dcs-counted failure). Rule 16, the agent type names, parallel workers, `failed`, `blocked` and `needs_input` are confirmed (sections 9.3 and 9.4).
2. Check the cache-write prices of the other models and the Haiku cache-read price in `prices.json`.
3. A real `Needs input` status. See trigger 1 above.

## 11. Risks

| Risk | Control |
|---|---|
| Agent Monitor is a third-party tool that reads local transcripts and can edit `settings.json` | Read the code and pin a commit in Step 0. Run without hooks first. Ask Information Security (CyberRiskAssessments@rccl.com) if the install needs approval. |
| Hook events store the whole hook payload in `~/.agent-monitor/events.jsonl` (task text, paths, maybe model replies), unencrypted, for at least one day | Keep hooks off in the first version. If you turn them on, install them for one project only. The file stays on disk and must stay out of any synced folder. |
| Its `--json` format or transcript format changes | Pin the commit. The adapter validates fields and returns the last good snapshot on error. Fall back to option C. |
| Stop times are inferred, not exact | Show the inferred time. Add project-only hooks if needed. |
| Wrong `parentId` or `taskId` draws a wrong wire | The page validates and logs a warning. |
| The task ID rule is missed by the Captain | The adapter puts the agent on the Captain's rail and logs a warning. |
| Real task names and costs may be Internal or Confidential | The server binds to localhost. Run files stay on disk locally. A published artifact uses demo data only. |
| The guard blocks adapter reads of `.claude/dcs` or transcripts | The adapter runs outside Claude Code, so the guard does not apply. Test it from a normal terminal. |
| Plugin cache is stale after a `captain.md` change | Run `claude plugin update dcs@dcs-local` (see the README). |

## 12. Test plan

1. Unit: the adapter maps saved Agent Monitor outputs to the snapshot spec, including a retry, a failed agent and a queued task.
2. Unit: the adapter returns the last good snapshot when the input is invalid.
3. Unit: the token sum and price lookup match a hand count for one transcript.
4. Integration: replay a recorded run. Compare the card count, status and cost with the run file.
5. Browser (CDP): connect, receive snapshots, drag a group during updates, fold the Captain, and check that offsets and the Captain position hold.
6. Disconnect test: stop the server in the middle of a run. The page shows "Disconnected". It catches up on reconnect with no duplicate cards.
7. Live: run one small `/dcs:work` task in a test repo and watch the tree.

## 13. References

- Agent Monitor (MIT, Node 20, no dependencies): https://github.com/a0s/agent-monitor
  - Reviewed 2026-10-25 from its README and `docs/how-it-works.md`.
  - It started as the `agent-tree` monitor in https://github.com/a0s/harness-supervisor.
- `agent-tree.html`: the page. `agent-tree-anatomy.html`: its anatomy page.
- `dcs/`: the harness plugin. `dcs/references/captain.md`: the Captain rules.

## 14. Retry button (2026-10-25)

The failed list has a Retry button. It is the first write path of the tree. `retry.mjs` runs `dcs unblock <id>` for a blocked task, then starts `claude -p "/dcs:work <id>"` headless in the repo with `dontAsk` and a budget cap (default $5). The page asks for a second click first. Details and limits are in the README, section "The failed list". Not verified on a real run: a retry of a blocked task.
