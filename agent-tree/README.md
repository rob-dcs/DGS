# Agent Tree

A live view of a dcs run. It shows the Captain and every worker and reviewer as a tree, with status, cost and time on each card. Costs roll up each branch, and a branch folds to one line.

The tree reads the Claude Code transcripts and the dcs task store. It does not write to either of them. One button writes: **Retry** on a failed task (see "The failed list"). Nothing else can start, stop or approve anything.

## Start

Node 22 or later. No packages to install.

```bash
node server.mjs <repo>              # then open http://127.0.0.1:4173/
node server.mjs <repo> --port 4200  # another port
node server.mjs <repo> --no-retry   # turn the Retry button off
node server.mjs <repo> --dcs <dcs plugin folder> --retry-budget 5 --retry-model sonnet
```

Start or continue a Claude Code session in `<repo>`. The Captain appears when the session has started.

| URL | What it shows |
|---|---|
| `/` | The live run. |
| `/?replay=<run id>` | A recorded run at its real pace. Add `&instant=1` to open the finished run. |
| `/?demo=1` | The built-in demo with simulated time and cost. Opening `agent-tree.html` from a file does the same. |
| `/runs` | The list of recorded runs (JSON). |

One snapshot of the current state, without the server: `node adapter.mjs <repo>`.

## How it works

```
Claude Code transcripts ─┐
dcs task store ──────────┼─> adapter.mjs ─> server.mjs ─> /stream (SSE) ─> agent-tree.html
Agent Monitor library ───┘   one snapshot     poll every 2 s              applies the snapshot
                                              and record the run
```

1. The Agent Monitor library lists the agents of the Claude Code session.
2. The adapter adds the task id, the status, the times and the cost. It reads each agent transcript and `.claude/dcs/tasks.json`.
3. The server sends the whole list of agents to the page every 2 seconds. It writes a run file when the agents change.
4. The page compares the list with what it shows and changes only the difference. A card you moved keeps its place.

The snapshot fields are in section 7 of [`integration-plan.md`](integration-plan.md). The page anatomy, with a live data section, is in `agent-tree-anatomy.html`.

## The task label rule

The tree puts each agent in a column by its task. The adapter reads the task from the start of the Agent tool `description`: `t2 Build the plan cards`. The id is the one `dcs list` shows. `t-02` and `T02` also read as `t2`.

The Captain follows this as rule 16 in `../dcs/references/captain.md`. After a change to that file, run `claude plugin update dcs@dcs-local` so Claude Code loads it. An agent with no task id hangs on the Captain.

## Files

| File | Purpose |
|---|---|
| `agent-tree.html` | The page. One file, no build. |
| `adapter.mjs` | Builds one snapshot from the sources above. |
| `server.mjs` | Serves the page, streams snapshots, records runs, and handles Retry. |
| `retry.mjs` | Starts a new headless run for a failed task. The only code that writes to the repo. |
| `prices.json` | Dollars per million tokens, by model. See the note below. |
| `vendor/agent-monitor/` | A copy of the Agent Monitor library, pinned. See `VENDORED.md`. |
| `test/` | The tests. |
| `runs/` | Recorded runs. Created on the first run. |
| `agent-tree-anatomy.html` | Every part of the tree, with sizes and tokens. |
| `integration-plan.md` | The plan, the findings and the decisions. |

## Tests

```bash
node --test test/adapter.test.mjs test/server.test.mjs test/retry.test.mjs   # 37 tests
node test/page.cdp.mjs                                   # 46 browser checks, needs Google Chrome
```

Node 25 needs the test file paths. A folder path fails.

## Cost

The adapter sums the tokens of each reply once and multiplies them by `prices.json`. A cost with a `~` is still counting. A `—` means the model has no price, and the page shows no guess.

Cache-write prices are checked against one real run. For `claude-sonnet-5-5`, a 5-minute cache write costs the input price and a 1-hour write costs 2× that. With those prices, the tree's costs summed to $1.3338 for a run that Claude Code reported as $1.3357 (0.14% apart). The other models use the same rule, which is **not verified** for them, and the Haiku cache-read price is assumed. See `prices.json`.

## Limits

- **Failed and Needs input** come from the agent's own last reply. A dcs worker ends with JSON such as `{"status": "failed", "reason": "…"}`. `failed` and `blocked` show as Failed, and `needs_input` shows as Needs input. The reason shows as the tooltip of the task text. A reply that is not dcs JSON counts as done.
- **A question that the Captain asks the user** does not show. Only a worker's `needs_input` does.
- **One Captain:** the newest running Claude Code session in the repo. Several sessions in one repo show only one.
- **Pace:** costs change every 2 seconds. Time runs smoothly in between.
- **Cost of the Captain:** it covers the whole session transcript, not only the current run.
- **Not exercised yet:** a worker that fails verify three times in a row, and a Retry run. The refuter and an a11y review ran in the Sailing card run (2026-10-26): they show as reviewer cards, "refute round 1" and "a11y review".
- **Review findings do not show.** A reviewer that reports a finding still replies `done`, so its card is Done. In that run `t2` went back to `doing` in dcs after a failed review, and the tree showed every card as Done. Real runs have covered a `blocked` worker, a `needs_input` worker, and a worker that failed a verify command and stopped (section 9.4 of the plan).

## The failed list

The "failed" count in the top bar is a button. It opens a list with one row for each failed agent: the agent name and task, the reason from its last reply (four lines, the full text as the tooltip), and two buttons. A click on the name or task pans the canvas to center that card. **Dismiss** removes the row and lowers the count; the card keeps its Failed status. Escape or a click outside closes the list.

**Retry** starts a new run for the task:

1. The first click arms the button: it reads "Confirm · up to $5". A new run spends money, so nothing starts yet. The button disarms after 5 seconds.
2. The second click sends `POST /retry {"task": "t2"}` to the server.
3. If dcs shows the task as `blocked`, the server runs `dcs unblock t2`. That resets the failure count.
4. The server starts a headless Captain in the repo: `claude -p "/dcs:work t2" --plugin-dir <dcs> --model sonnet --permission-mode dontAsk --max-budget-usd 5`. The log goes to `runs/retry-logs/`.
5. The button reads "Retry started". The new Captain is a new Claude Code session in the repo, so the tree switches to it as the new run.

Rules of Retry:
- It works in live mode only. In a replay or the demo the button is off, and the tooltip says why.
- It refuses a task that is `done`, `verified` or `approved`, an unknown task, a task that has a running agent, and a task whose retry still runs.
- `dontAsk` refuses anything that needs approval, so a retry run stops before it lands or commits. The budget cap stops a run that costs too much.
- The server accepts `POST /retry` only from this server's own page: it needs the header `x-agent-tree: retry` and a JSON body, and it refuses another Origin or Host.
- The server finds the dcs plugin at `../dcs`. Pass `--dcs <folder>` for another place. Without the folder, or with `--no-retry`, the button is off.
- **Not verified on a real run:** a retry run of a blocked task, and how `/dcs:work` treats a task that `dcs unblock` put back to `doing`. The unit tests use a fake `claude`.

## What a new card does

A card exists only for an agent that the Captain has started. A task that waits in dcs has no card. A new child card comes out from behind its parent. It starts hidden behind the parent card, at scale 0 and opacity 0, with its centre on the parent's centre. In 650 ms it moves into its place while it grows to full size and fades in (the opacity is full at 70% of the motion). While it moves, the card is under every other card, so it slides out from under its parent and past the cards above it. The wire to the card fades in with it. The Captain has no parent, so it only grows a little. With reduced motion the cards simply appear.

## What the wires show

A wire into a task is lit while that agent, or any agent under it, is running. It is a lighter orchid with a comet of light that travels from the parent to the child. The comet has the shine of a running card: the same light line with grain and a soft violet glow, and an orchid glow with grain, fading in slowly at the tail (an ease-in) and out faster at the tip, with no visible step at either end (the first step is 3% of the opacity with the default 28 layers). The comet speed is `WIRE_SPEED` in `agent-tree.html` (120 px a second; lower is slower). A wire into a finished task goes back to plain orchid. With reduced motion the pulse is off and only the lighter color marks the wire.

## When a run ends

The label changes to "ended", the Captain card turns Done and the clock stops when one of these holds:
- every dcs task is `done` or `blocked` and every agent has stopped;
- the Captain has no live process for 15 seconds and every agent has stopped (a headless run, or a closed terminal). Tasks left at `approved` do not keep the run open;
- there is no dcs store, and every agent has been stopped for 60 seconds.

A Captain whose process is alive stays live, however long it waits for you.

## Privacy

- The server listens on `127.0.0.1` only and refuses any other Host header. `POST /retry` also needs a custom header and refuses another Origin, so a web page on another site cannot start a run.
- `runs/` holds real task names and costs. Keep it out of any shared or synced folder.
- Agent Monitor's optional hooks are not installed and are not needed. They would write whole hook payloads to `~/.agent-monitor/events.jsonl`.

## Update the vendored library

1. Read the new code of [a0s/agent-monitor](https://github.com/a0s/agent-monitor). It reads local transcripts and, with `--install-hooks`, can edit `settings.json`.
2. Copy `lib/agent-monitor.mjs` into `vendor/agent-monitor/lib/`. Keep the licence.
3. Change the version and commit in `vendor/agent-monitor/VENDORED.md`.
4. Run the tests and the browser check.
