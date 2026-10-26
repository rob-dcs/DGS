/* Retry: starts a new headless dcs run for one failed task.
   This is the only part of the Agent Tree that writes to the repo. The server calls it when the user presses Retry.
   1. A task that dcs shows as `blocked` is unblocked with the dcs CLI. That resets its failure count.
   2. A new headless Captain starts: claude -p "/dcs:work <task id>" in the repo. `dontAsk` refuses anything that needs approval,
      so the run stops before it lands or commits. A budget cap stops a run that costs too much. */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TASK_ID = /^t\d+$/;
const RETRYABLE = ["todo", "doing", "blocked"];
const TOOLS = "Bash Read Write Edit Glob Grep Agent Task SendMessage Skill TaskOutput";

/* options: repo, dcsDir (the dcs plugin folder), tasksFile, logDir, budget (US dollars), model, tools, claudeBin, spawnFn, execFn */
export function createRetry(options) {
  const { repo, dcsDir, tasksFile, logDir } = options;
  const budget = options.budget ?? 5, model = options.model || "sonnet", tools = options.tools || TOOLS, claudeBin = options.claudeBin || "claude";
  const spawnFn = options.spawnFn || spawn, execFn = options.execFn || execFileSync;
  const dcsBin = dcsDir ? join(dcsDir, "bin", "dcs") : null;
  const enabled = !!(dcsBin && existsSync(dcsBin) && tasksFile);
  const started = new Map();   // task id -> child process, while it runs

  const readTasks = () => { try { return JSON.parse(readFileSync(tasksFile, "utf8")).tasks || []; } catch { return null; } };
  const info = () => ({ enabled, budget, model });

  /* agents: the agents of the live snapshot. Returns { ok, code, message, pid }. */
  function start(task, agents = []) {
    if (!enabled) return { ok: false, code: 404, message: "Retry is not set up. Start the server with --dcs <dcs plugin folder>." };
    if (typeof task !== "string" || !TASK_ID.test(task)) return { ok: false, code: 400, message: "The task id must look like t2." };
    const tasks = readTasks();
    const t = tasks && tasks.find((x) => x.id === task);
    if (!t) return { ok: false, code: 404, message: `dcs has no task ${task}.` };
    if (!RETRYABLE.includes(t.status)) return { ok: false, code: 409, message: `${task} is ${t.status}. Only a todo, doing or blocked task can retry.` };
    if (agents.some((a) => a.taskId === task && a.status === "running")) return { ok: false, code: 409, message: `An agent for ${task} is still running.` };
    if (started.has(task)) return { ok: false, code: 409, message: `A retry of ${task} is already running.` };
    try {
      if (t.status === "blocked") execFn(process.execPath, [dcsBin, "unblock", task], { cwd: repo, stdio: "ignore" });
      let out = "ignore";
      if (logDir) { mkdirSync(logDir, { recursive: true }); out = openSync(join(logDir, `retry-${task}-${Date.now()}.log`), "a"); }
      const args = ["-p", `/dcs:work ${task}`, "--plugin-dir", dcsDir, "--model", model, "--permission-mode", "dontAsk", "--max-budget-usd", String(budget), "--allowedTools", tools];
      const child = spawnFn(claudeBin, args, { cwd: repo, detached: true, stdio: ["ignore", out, out] });
      if (out !== "ignore") closeSync(out);
      started.set(task, child);
      child.on?.("exit", () => started.delete(task));
      child.on?.("error", () => started.delete(task));
      child.unref?.();
      return { ok: true, code: 202, message: `Started a new run for ${task}. Budget cap $${budget}.`, pid: child.pid };
    } catch (e) {
      started.delete(task);
      return { ok: false, code: 500, message: `Could not start the retry: ${e.message}` };
    }
  }
  return { info, start };
}
