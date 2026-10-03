import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative, sep } from "node:path";
import type { DaveDatabase } from "@dave/db";
import type { CompletionMessage, CompletionRequest, CompletionResult, Provider, ProviderName } from "@dave/brain";
import { buildProvider, listProviderKeys } from "@dave/brain";
import { runScriptInE2B } from "@dave/e2b";
import { FIRECRAWL_TOOLS } from "@dave/firecrawl";
import { AgentLoop, type AgentEvent } from "./agent-loop.js";
import { ToolRegistry, adaptTools, type AgentTool } from "./tool-registry.js";
import { modelConfigProvider } from "./provider-selection.js";

/**
 * The trader's own coding agent (the trader: "a coding agent, not for trading, just for me -- give
 * it the E2B sandbox and Firecrawl, give it tasks and loops so it doesn't stop; in the system
 * prompt just tell it about its tools, no safety prompt; same providers").
 *
 * Separate from Dave in every way that matters: its own conversation, its own workspace, its own
 * provider/model choice, no trading tools. A task runs round after round until the agent says it's
 * done (or the round limit, or Stop); a task can also be put on a loop -- run again every N minutes.
 *
 * The workspace persists: files live on the bot (data/coder/<user>/ws) and are carried into the
 * E2B sandbox on every `run` and back out after, so the agent builds on its own earlier work.
 */

export const CODER_DONE_MARK = "TASK COMPLETE";
const WS_IN_SANDBOX = "/home/user/work";
const SKIP_DIRS = ["node_modules", ".venv", "venv", "__pycache__", ".git", ".cache", "dist", "build", ".next"];

export interface CoderSettings {
  /** Unset = Dave's own main AI and its backups. */
  provider?: ProviderName;
  model?: string;
  /** How many rounds a task gets before it stops on its own. */
  maxRounds: number;
  /** A task run again and again. */
  loop?: { task: string; everyMinutes: number; nextAt: number };
}

export interface CoderEntry {
  id: number;
  at: number;
  kind: "user" | "text" | "tool_start" | "tool_end" | "final" | "notice" | "error";
  text?: string;
  name?: string;
  args?: string;
  result?: string;
  isError?: boolean;
  ms?: number;
}

const DEFAULT_SETTINGS: CoderSettings = { maxRounds: 30 };

function root(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "coder", userId);
}
export function workspaceDir(userId: string): string {
  const d = join(root(userId), "ws");
  mkdirSync(d, { recursive: true });
  return d;
}
function readJson<T>(path: string, fallback: T): T {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    /* broken file -> fallback */
  }
  return fallback;
}
function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value), "utf8");
}

export function getCoderSettings(userId: string): CoderSettings {
  return { ...DEFAULT_SETTINGS, ...readJson<Partial<CoderSettings>>(join(root(userId), "settings.json"), {}) };
}
export function setCoderSettings(userId: string, patch: Partial<CoderSettings>): CoderSettings {
  const next = { ...getCoderSettings(userId), ...patch };
  next.maxRounds = Math.max(1, Math.min(200, Math.round(next.maxRounds || DEFAULT_SETTINGS.maxRounds)));
  if (patch.provider === null || (patch as { provider?: string }).provider === "") delete next.provider;
  if (patch.model === null || (patch as { model?: string }).model === "") delete next.model;
  if (patch.loop === null) delete next.loop;
  writeJson(join(root(userId), "settings.json"), next);
  return next;
}

// ───────────────────────────── the log the app shows ─────────────────────────────

const LOG_CAP = 800;
export function readCoderLog(userId: string, after = 0): CoderEntry[] {
  return readJson<CoderEntry[]>(join(root(userId), "log.json"), []).filter((e) => e.id > after);
}
function appendLog(userId: string, entry: Omit<CoderEntry, "id" | "at">): CoderEntry {
  const path = join(root(userId), "log.json");
  const all = readJson<CoderEntry[]>(path, []);
  const e: CoderEntry = { id: (all.at(-1)?.id ?? 0) + 1, at: Date.now(), ...entry };
  all.push(e);
  writeJson(path, all.slice(-LOG_CAP));
  return e;
}
const clip = (v: unknown, max: number) => {
  const t = typeof v === "string" ? v : JSON.stringify(v);
  return t && t.length > max ? `${t.slice(0, max)}…` : t;
};

// ───────────────────────────── the workspace ─────────────────────────────

function safePath(userId: string, p: string): string {
  const base = workspaceDir(userId);
  const full = normalize(join(base, p.replace(/^\/+/, "").replace(/^home\/user\/work\/?/, "")));
  if (full !== base && !full.startsWith(base + sep)) throw new Error(`"${p}" is outside the workspace`);
  return full;
}

export function listWorkspace(userId: string): { path: string; bytes: number }[] {
  const base = workspaceDir(userId);
  const out: { path: string; bytes: number }[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (!SKIP_DIRS.includes(name)) walk(full);
      } else out.push({ path: relative(base, full), bytes: st.size });
      if (out.length > 2000) return;
    }
  };
  walk(base);
  return out;
}

export function readWorkspaceFile(userId: string, path: string): Buffer {
  return readFileSync(safePath(userId, path));
}

const tarExcludes = SKIP_DIRS.flatMap((d) => ["--exclude", d]);

export function packWorkspace(userId: string): string {
  return execFileSync("tar", ["czf", "-", ...tarExcludes, "-C", workspaceDir(userId), "."], { maxBuffer: 64 * 1024 * 1024 }).toString("base64");
}
export function unpackWorkspace(userId: string, base64: string): void {
  const dir = workspaceDir(userId);
  const tmp = join(root(userId), "incoming.tgz");
  writeFileSync(tmp, Buffer.from(base64, "base64"));
  // Replace the workspace with what the sandbox ended with (files it deleted stay deleted).
  for (const name of readdirSync(dir)) rmSync(join(dir, name), { recursive: true, force: true });
  execFileSync("tar", ["xzf", tmp, "-C", dir]);
  rmSync(tmp, { force: true });
}

// ───────────────────────────── tools ─────────────────────────────

function coderTools(db: DaveDatabase, userId: string): AgentTool[] {
  const run: AgentTool = {
    name: "run",
    description:
      `Run code in an E2B cloud sandbox (Linux, internet access, python3/pip, node/npm, bash). The workspace is at ${WS_IN_SANDBOX} and is the working directory; ` +
      "files you create or change there persist to the next run. Installed packages do not persist (node_modules, .venv and caches aren't kept) -- install what you need in the same run, e.g. `pip install -q requests && python main.py`. " +
      "Returns stdout, stderr and the exit code.",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", description: "The code or shell commands to run." },
        language: { type: "string", enum: ["bash", "python", "node"], description: "Default bash." },
        timeoutSeconds: { type: "number", description: "Up to 600. Default 180." },
      },
      required: ["code"],
    },
    execute: async (args) => {
      const lang = args.language === "python" || args.language === "node" ? args.language : "bash";
      const runner = lang === "python" ? "python3 /home/user/in/__task" : lang === "node" ? "node /home/user/in/__task" : "bash /home/user/in/__task";
      const wrapper = [
        `mkdir -p ${WS_IN_SANDBOX} && cd ${WS_IN_SANDBOX}`,
        `tar xzf /home/user/in/__ws.tgz -C ${WS_IN_SANDBOX} 2>/dev/null || true`,
        `${runner}`,
        "code=$?",
        `tar czf "$DAVE_OUT_DIR/__ws.tgz" ${SKIP_DIRS.map((d) => `--exclude ${d}`).join(" ")} -C ${WS_IN_SANDBOX} . 2>/dev/null`,
        "exit $code",
      ].join("\n");
      const timeoutMs = Math.min(600, Math.max(10, Number(args.timeoutSeconds) || 180)) * 1000;
      const r = await runScriptInE2B(db, userId, {
        script: wrapper,
        language: "bash",
        timeoutMs,
        filesIn: [
          { path: "__ws.tgz", content: packWorkspace(userId), encoding: "base64" },
          { path: "__task", content: String(args.code ?? "") },
        ],
      });
      const ws = r.filesOut.find((f) => f.path.endsWith("__ws.tgz"));
      let synced = "workspace saved";
      if (ws && !ws.truncated) unpackWorkspace(userId, ws.encoding === "base64" ? ws.content : Buffer.from(ws.content, "utf8").toString("base64"));
      else synced = ws?.truncated ? "workspace NOT saved: over 2 MB packed -- keep big outputs out of the workspace" : "workspace NOT saved this run";
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut, durationMs: r.durationMs, workspace: synced, ...(r.error ? { error: r.error } : {}) };
    },
  };
  const files: AgentTool[] = [
    {
      name: "write_file",
      description: "Create or overwrite a file in the workspace (path relative to the workspace).",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
      execute: async (args) => {
        const p = safePath(userId, String(args.path));
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, String(args.content ?? ""), "utf8");
        return { written: String(args.path), bytes: Buffer.byteLength(String(args.content ?? "")) };
      },
    },
    {
      name: "read_file",
      description: "Read a workspace file (text). Optional start/end line numbers for big files.",
      parameters: { type: "object", properties: { path: { type: "string" }, startLine: { type: "number" }, endLine: { type: "number" } }, required: ["path"] },
      execute: async (args) => {
        const lines = readWorkspaceFile(userId, String(args.path)).toString("utf8").split("\n");
        const s = Math.max(1, Number(args.startLine) || 1);
        const e = Math.min(lines.length, Number(args.endLine) || s + 1999);
        return { path: args.path, totalLines: lines.length, from: s, to: e, content: lines.slice(s - 1, e).join("\n") };
      },
    },
    {
      name: "edit_file",
      description: "Replace an exact piece of text in a workspace file (old must appear exactly once).",
      parameters: { type: "object", properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" } }, required: ["path", "old", "new"] },
      execute: async (args) => {
        const p = safePath(userId, String(args.path));
        const text = readFileSync(p, "utf8");
        const count = text.split(String(args.old)).length - 1;
        if (count !== 1) throw new Error(`"old" appears ${count} times -- it must appear exactly once`);
        writeFileSync(p, text.replace(String(args.old), String(args.new)), "utf8");
        return { edited: args.path };
      },
    },
    {
      name: "list_files",
      description: "List the workspace files with sizes.",
      parameters: { type: "object", properties: {} },
      execute: async () => listWorkspace(userId),
    },
    {
      name: "delete_file",
      description: "Delete a file or folder in the workspace.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute: async (args) => {
        rmSync(safePath(userId, String(args.path)), { recursive: true, force: true });
        return { deleted: args.path };
      },
    },
  ];
  const web = adaptTools(
    FIRECRAWL_TOOLS.filter((t) => t.name === "web_search" || t.name === "scrape_url"),
    { db, userId }
  );
  return [run, ...files, ...web];
}

export function coderSystemPrompt(): string {
  return [
    "You are a coding agent. You work on whatever task the user gives you, start to finish.",
    "",
    "Your tools:",
    `- run: executes code in an E2B cloud sandbox (Linux, internet, python3/pip, node/npm, bash). The workspace (${WS_IN_SANDBOX}) is the working directory and its files persist between runs; installed packages don't, so install what you need in the same run.`,
    "- write_file / read_file / edit_file / list_files / delete_file: the same workspace, directly.",
    "- web_search: searches the web (Firecrawl). scrape_url: reads a page in full as markdown.",
    "",
    "The user sees your files in the app and can download them.",
    `When the whole task is done and you've checked it works, end your reply with the line ${CODER_DONE_MARK}. Until then, keep working: your turn is handed back to you to continue.`,
  ].join("\n");
}

// ───────────────────────────── provider ─────────────────────────────

function coderProvider(db: DaveDatabase, userId: string, settings: CoderSettings): Provider {
  if (!settings.provider) return modelConfigProvider(db, userId, async () => undefined, "chat");
  const name = settings.provider;
  return {
    name,
    async generate(req: CompletionRequest, timeoutMs: number, signal?: AbortSignal): Promise<CompletionResult> {
      const keys = listProviderKeys(db, userId, name);
      if (!keys.length) throw new Error(`No key stored for ${name} -- add one in Settings > AI providers, or set the coding agent back to Dave's main AI.`);
      let last: unknown;
      for (const k of [...keys.filter((x) => x.isPrimary), ...keys.filter((x) => !x.isPrimary)]) {
        try {
          return await buildProvider(name, { ...k.config, ...(settings.model ? { model: settings.model } : {}) }).generate(req, Math.max(timeoutMs, 120_000), signal);
        } catch (err) {
          if (signal?.aborted) throw err;
          last = err;
        }
      }
      throw last instanceof Error ? last : new Error(String(last));
    },
  };
}

// ───────────────────────────── running a task ─────────────────────────────

const running = new Map<string, AbortController>();
export function isCoderRunning(userId: string): boolean {
  return running.has(userId);
}
export function stopCoder(userId: string): boolean {
  const c = running.get(userId);
  if (!c) return false;
  c.abort();
  return true;
}
export function resetCoder(userId: string): void {
  stopCoder(userId);
  rmSync(join(root(userId), "history.json"), { force: true });
  appendLog(userId, { kind: "notice", text: "New conversation (the workspace files are kept)." });
}

function historyPath(userId: string) {
  return join(root(userId), "history.json");
}

/** Runs one task round after round until it's done, the round limit, or Stop. */
export async function runCoderTask(db: DaveDatabase, userId: string, task: string, loopFactory?: (p: Provider, r: ToolRegistry) => AgentLoop): Promise<{ rounds: number; done: boolean; text: string }> {
  if (running.has(userId)) throw new Error("The coding agent is already working -- stop it first or wait.");
  const controller = new AbortController();
  running.set(userId, controller);
  const settings = getCoderSettings(userId);
  appendLog(userId, { kind: "user", text: task });
  const registry = new ToolRegistry().register(coderTools(db, userId));
  const loop = loopFactory ? loopFactory(coderProvider(db, userId, settings), registry) : new AgentLoop(coderProvider(db, userId, settings), registry);
  let history = readJson<CompletionMessage[]>(historyPath(userId), []);
  if (!history.length || history[0].role !== "system") history = [{ role: "system", content: coderSystemPrompt() }, ...history];
  else history[0] = { role: "system", content: coderSystemPrompt() };
  history.push({ role: "user", content: task });
  const starts = new Map<string, number>();
  const onEvent = (e: AgentEvent) => {
    if (e.type === "text" && e.text.trim()) appendLog(userId, { kind: "text", text: clip(e.text, 6000) });
    else if (e.type === "tool_start") {
      starts.set(e.id, Date.now());
      appendLog(userId, { kind: "tool_start", name: e.name, args: clip(e.args, 4000) });
    } else if (e.type === "tool_end") appendLog(userId, { kind: "tool_end", name: e.name, result: clip(e.result, 6000), isError: e.isError, ms: e.ms });
  };
  let rounds = 0;
  let text = "";
  let done = false;
  try {
    for (;;) {
      rounds++;
      const result = await loop.run(history, { signal: controller.signal, onEvent, overallTimeoutMs: 60 * 60_000 });
      history = result.history;
      writeJson(historyPath(userId), history.slice(-400));
      if (result.status === "aborted") {
        appendLog(userId, { kind: "notice", text: result.reason === "cancelled" ? "Stopped." : "That round ran out of time -- continuing." });
        if (result.reason === "cancelled") break;
      } else if (result.status === "done") {
        text = result.text;
        if (result.text.includes(CODER_DONE_MARK)) {
          done = true;
          appendLog(userId, { kind: "final", text: result.text.replace(CODER_DONE_MARK, "").trim() || "Done." });
          break;
        }
        if (result.text.trim()) appendLog(userId, { kind: "text", text: clip(result.text, 6000) });
      }
      if (rounds >= settings.maxRounds) {
        appendLog(userId, { kind: "notice", text: `Stopped after ${rounds} rounds (the round limit). Send "continue" to keep going.` });
        break;
      }
      if (controller.signal.aborted) break;
      appendLog(userId, { kind: "notice", text: `Round ${rounds + 1} -- carrying on.` });
      history.push({ role: "user", content: `Continue the task from where you are. If something failed, find out why and fix it. When everything is done and verified, end with ${CODER_DONE_MARK}.` });
    }
  } catch (err) {
    appendLog(userId, { kind: "error", text: err instanceof Error ? err.message : String(err) });
  } finally {
    running.delete(userId);
    writeJson(historyPath(userId), history.slice(-400));
  }
  return { rounds, done, text };
}

/** Starts a task in the background (the app polls the log). */
export function startCoderTask(db: DaveDatabase, userId: string, task: string): void {
  void runCoderTask(db, userId, task).catch((err) => appendLog(userId, { kind: "error", text: err instanceof Error ? err.message : String(err) }));
}

// ───────────────────────────── loops ─────────────────────────────

let loopTimer: ReturnType<typeof setInterval> | undefined;
/** Runs the looped task when it's due (checked every 30 s). */
export function startCoderLoopWatcher(db: DaveDatabase, userId: string): void {
  if (loopTimer) return;
  loopTimer = setInterval(() => {
    const s = getCoderSettings(userId);
    if (!s.loop || running.has(userId) || Date.now() < s.loop.nextAt) return;
    setCoderSettings(userId, { loop: { ...s.loop, nextAt: Date.now() + s.loop.everyMinutes * 60_000 } });
    appendLog(userId, { kind: "notice", text: `Loop: running the task again (every ${s.loop.everyMinutes} min).` });
    startCoderTask(db, userId, s.loop.task);
  }, 30_000);
  loopTimer.unref?.();
}
