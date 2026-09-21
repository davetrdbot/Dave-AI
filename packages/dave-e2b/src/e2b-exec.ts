import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { DaveDatabase } from "@dave/db";
import { Sandbox } from "e2b";
import { listE2BKeys, AllE2BKeysFailedError, type StoredE2BKey } from "./e2b-keys.js";

/**
 * Real code execution inside E2B (the trader: "expand the background tool and the subtask so it
 * can run any script to check for anything in the market... give the bot input and output, task
 * files inside and task files outside").
 *
 * This closes the honest gap e2b-client.ts documents in its own header: E2B's control plane
 * (create/list/kill) is REST and that client covers it, but actually RUNNING something inside a
 * sandbox is E2B's envd data plane, which is Connect/gRPC -- not reachable from a hand-rolled
 * fetch. So the real `e2b` SDK (v2.51.0) is a genuine dependency now, and this module is the only
 * place that touches it. e2b-client.ts stays exactly as it is for the REST key-health path.
 *
 * Two deliberate safety properties, both load-bearing:
 *
 * 1. The script is never interpolated into a shell string. It is WRITTEN TO A FILE inside the
 *    sandbox and the interpreter is pointed at that file. A script containing quotes, backticks,
 *    `$(...)`, newlines, or anything else shell-significant therefore cannot break out of its own
 *    argument -- there is no shell string for it to break out of. This matters because the script
 *    text comes from the model, and in the background-check path it re-runs unattended on a timer.
 * 2. Everything is bounded: stdout/stderr, per-file bytes, file count, and wall-clock. A sandbox
 *    is always killed in a `finally`, including when the command times out or the read-back fails,
 *    so a failed run can never leave paid compute running.
 */

export type ScriptLanguage = "bash" | "python" | "node";

/** Where a script drops anything it wants handed back. Anything written here comes out
 *  automatically -- the "task files outside" half of the trader's ask. */
export const SANDBOX_OUT_DIR = "/home/user/out";
/** Where `filesIn` land -- the "task files inside" half. */
export const SANDBOX_IN_DIR = "/home/user/in";
const SANDBOX_WORK_DIR = "/home/user";

/** Bounded so one runaway script can never blow up a Telegram message or the model's context. */
export const MAX_STREAM_CHARS = 20_000;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_FILES_OUT = 20;
export const DEFAULT_RUN_TIMEOUT_MS = 120_000;
export const MAX_RUN_TIMEOUT_MS = 10 * 60_000;

const INTERPRETERS: Record<ScriptLanguage, { file: string; argv: (p: string) => string }> = {
  bash: { file: "task.sh", argv: (p) => `bash ${p}` },
  python: { file: "task.py", argv: (p) => `python3 -u ${p}` },
  node: { file: "task.mjs", argv: (p) => `node ${p}` },
};

/**
 * The user's own uploaded-file directory -- where the live Telegram webhook path saves every
 * document the user sends (telegram-bot-server.ts imports this rather than defining its own copy,
 * so there is exactly one definition of where inbound files live).
 *
 * This is also a real SECURITY BOUNDARY, and the reason `run_script` takes filenames from here
 * rather than arbitrary host paths: the bot host also holds the SQLite database with every stored
 * provider/E2B/broker credential, plus the process environment. A tool that could upload any host
 * path into a sandbox would let a model -- or anything that can influence one -- read those and
 * print them to stdout or ship them out in an output file. Scripts get the user's own uploads and
 * nothing else.
 */
export function userUploadDir(userId: string): string {
  const dir = join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "telegram-inbox", userId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function listUserUploads(userId: string): { name: string; bytes: number; modifiedAt: number }[] {
  const dir = userUploadDir(userId);
  return readdirSync(dir)
    .map((name) => {
      const stat = statSync(join(dir, name));
      return { name, bytes: stat.size, modifiedAt: stat.mtimeMs };
    })
    .filter((f) => f.bytes > 0)
    .sort((a, b) => b.modifiedAt - a.modifiedAt);
}

/** Resolves an upload by name, refusing anything that escapes the directory. `basename` alone
 *  already strips traversal, but the resolved path is re-checked so the guarantee holds even if
 *  that ever changes. Exported because it is the enforcement point of the boundary described
 *  above -- a guarantee that nothing can assert against directly is not much of a guarantee. */
export function readUserUpload(userId: string, name: string): Buffer {
  const dir = userUploadDir(userId);
  const safe = basename(name);
  const path = resolve(dir, safe);
  if (!path.startsWith(resolve(dir) + "/")) throw new Error(`refusing to read "${name}" -- outside the user's own upload directory`);
  if (!existsSync(path)) {
    const available = listUserUploads(userId).map((f) => f.name);
    throw new Error(`no uploaded file "${safe}". Files the user has sent: ${available.length > 0 ? available.join(", ") : "(none yet)"}`);
  }
  return readFileSync(path);
}

export interface TaskFileIn {
  /** Path inside the sandbox. A bare name (e.g. "prices.csv") lands in SANDBOX_IN_DIR. */
  path: string;
  content: string;
  /** "base64" for binary payloads; defaults to utf8 text. */
  encoding?: "utf8" | "base64";
}

export interface TaskFileOut {
  path: string;
  content: string;
  encoding: "utf8" | "base64";
  bytes: number;
  /** True when the file was larger than MAX_FILE_BYTES and `content` is only its head. */
  truncated: boolean;
}

export interface RunScriptOptions {
  script: string;
  language?: ScriptLanguage;
  filesIn?: TaskFileIn[];
  /** Names of files the USER sent the bot (see userUploadDir) to copy into the sandbox. This is
   *  how a document the user uploaded actually reaches a script -- before this, the live inbound
   *  path saved it to disk and told the model to "use your sandbox file tools", but nothing could
   *  actually reach it. */
  attachUserFiles?: string[];
  /** Explicit extra paths to read back, on top of whatever landed in SANDBOX_OUT_DIR. */
  filesOut?: string[];
  envVars?: Record<string, string>;
  timeoutMs?: number;
  templateID?: string;
}

export interface RunScriptResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
  filesOut: TaskFileOut[];
  sandboxId: string;
  durationMs: number;
  timedOut: boolean;
  /** Which stored key actually ran this, so a failover is visible rather than silent. */
  keyLabel: string;
  truncated: { stdout: boolean; stderr: boolean; files: boolean };
}

function clamp(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max)}\n...[truncated ${text.length - max} more characters]`, truncated: true };
}

/** Node's Buffer is a Uint8Array view, not an ArrayBuffer -- the SDK's write() wants the latter,
 *  and the view may be a slice of a larger pooled buffer, so the offsets matter. */
function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function resolveInPath(path: string): string {
  return path.includes("/") ? path : `${SANDBOX_IN_DIR}/${path}`;
}

/** Binary-safe: a buffer that isn't valid UTF-8 (or carries NULs) comes back base64 rather than
 *  silently mangled into replacement characters. */
function encodeFile(bytes: Uint8Array): { content: string; encoding: "utf8" | "base64" } {
  const buf = Buffer.from(bytes);
  if (!buf.includes(0)) {
    const text = buf.toString("utf8");
    if (Buffer.from(text, "utf8").equals(buf)) return { content: text, encoding: "utf8" };
  }
  return { content: buf.toString("base64"), encoding: "base64" };
}

async function collectOutputs(sandbox: Sandbox, extraPaths: string[]): Promise<{ files: TaskFileOut[]; truncated: boolean }> {
  const paths = new Set<string>();

  try {
    for (const entry of await sandbox.files.list(SANDBOX_OUT_DIR, { depth: 5 })) {
      // EntryInfo.type is "file" for regular files; directories are skipped, not read.
      if (entry.type === "file") paths.add(entry.path);
    }
  } catch {
    // The script never created the out dir -- that is normal, not an error.
  }
  for (const p of extraPaths) paths.add(p.includes("/") ? p : `${SANDBOX_WORK_DIR}/${p}`);

  const all = [...paths];
  const capped = all.slice(0, MAX_FILES_OUT);
  const files: TaskFileOut[] = [];

  for (const path of capped) {
    try {
      const bytes = (await sandbox.files.read(path, { format: "bytes" })) as Uint8Array;
      const truncated = bytes.length > MAX_FILE_BYTES;
      const { content, encoding } = encodeFile(truncated ? bytes.slice(0, MAX_FILE_BYTES) : bytes);
      files.push({ path, content, encoding, bytes: bytes.length, truncated });
    } catch {
      // A path the script named but never wrote -- skipped rather than failing the whole run.
    }
  }
  return { files, truncated: all.length > capped.length };
}

async function runWithKey(key: StoredE2BKey, attachments: { name: string; data: ArrayBuffer }[], options: RunScriptOptions): Promise<RunScriptResult> {
  const language = options.language ?? "bash";
  const interpreter = INTERPRETERS[language];
  if (!interpreter) throw new Error(`unsupported script language "${language}" -- use bash, python, or node`);

  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS, 1_000), MAX_RUN_TIMEOUT_MS);
  const started = Date.now();

  // Sandbox lifetime deliberately outlives the command's own budget, so a command that hits its
  // timeout still has a live sandbox to read partial output files back out of.
  const sandbox = await Sandbox.create({
    apiKey: key.apiKey,
    template: options.templateID,
    timeoutMs: timeoutMs + 30_000,
    envs: options.envVars,
  });

  try {
    await sandbox.files.makeDir(SANDBOX_IN_DIR);
    await sandbox.files.makeDir(SANDBOX_OUT_DIR);

    for (const file of options.filesIn ?? []) {
      await sandbox.files.write(resolveInPath(file.path), file.encoding === "base64" ? toArrayBuffer(Buffer.from(file.content, "base64")) : file.content);
    }
    // Files the user actually sent the bot. Already resolved (and confined to the user's own
    // upload directory) before any key was tried -- see runScriptInE2B.
    for (const file of attachments) {
      await sandbox.files.write(`${SANDBOX_IN_DIR}/${file.name}`, file.data);
    }

    // The script is written, never interpolated into a shell string -- see this module's header.
    const scriptPath = `${SANDBOX_WORK_DIR}/${interpreter.file}`;
    await sandbox.files.write(scriptPath, options.script);

    let exitCode = 0;
    let stdout = "";
    let stderr = "";
    let error: string | undefined;
    let timedOut = false;

    try {
      const result = await sandbox.commands.run(interpreter.argv(scriptPath), {
        cwd: SANDBOX_WORK_DIR,
        envs: { ...options.envVars, DAVE_IN_DIR: SANDBOX_IN_DIR, DAVE_OUT_DIR: SANDBOX_OUT_DIR },
        timeoutMs,
      });
      exitCode = result.exitCode;
      stdout = result.stdout;
      stderr = result.stderr;
      error = result.error;
    } catch (err) {
      // A non-zero exit throws CommandExitError, which still carries the real streams -- those are
      // the most useful thing the model can see, so they are surfaced rather than swallowed.
      const e = err as { exitCode?: number; stdout?: string; stderr?: string; message?: string };
      exitCode = e.exitCode ?? 1;
      stdout = e.stdout ?? "";
      stderr = e.stderr ?? "";
      error = e.message;
      timedOut = /timeout|timed out/i.test(e.message ?? "");
    }

    const out = await collectOutputs(sandbox, options.filesOut ?? []);
    const cappedOut = clamp(stdout, MAX_STREAM_CHARS);
    const cappedErr = clamp(stderr, MAX_STREAM_CHARS);

    return {
      exitCode,
      stdout: cappedOut.text,
      stderr: cappedErr.text,
      error,
      filesOut: out.files,
      sandboxId: sandbox.sandboxId,
      durationMs: Date.now() - started,
      timedOut,
      keyLabel: key.label,
      truncated: { stdout: cappedOut.truncated, stderr: cappedErr.truncated, files: out.truncated },
    };
  } finally {
    // Always kill: a sandbox left running is real money, and a failure above must not leak one.
    await sandbox.kill().catch(() => undefined);
  }
}

/**
 * Runs a script in a fresh, disposable E2B sandbox, with real key failover across the user's
 * stored keys (healthy ones first -- same ordering createSandboxWithKeyFailover already uses).
 *
 * A non-zero exit is NOT a failover trigger: the script genuinely ran, and its failure is the
 * answer. Only an infrastructure failure (bad key, quota, unreachable) moves to the next key.
 */
export async function runScriptInE2B(db: DaveDatabase, userId: string, options: RunScriptOptions): Promise<RunScriptResult> {
  if (!options.script || !options.script.trim()) throw new Error("script is required");

  const keys = listE2BKeys(db, userId);
  if (keys.length === 0) {
    throw new Error("No E2B key stored yet -- add one with add_e2b_key before running scripts (get one free at e2b.dev).");
  }

  // Real bug fixed (caught by the first live run against real E2B): attached files used to be
  // resolved INSIDE the key loop, so naming a file that doesn't exist -- an ordinary mistake, and
  // the exact thing the traversal guard raises -- was caught by the failover handler and reported
  // as "All stored E2B keys failed", blaming the keys for what is really a bad filename. With
  // several keys stored it also span up a fresh sandbox per key to re-fail identically every time.
  // Resolving up front means a bad name fails immediately, with the message that actually helps.
  const attachments = (options.attachUserFiles ?? []).map((name) => {
    const safe = basename(name);
    return { name: safe, data: toArrayBuffer(readUserUpload(userId, safe)) };
  });

  const ordered = [...keys.filter((k) => k.healthy), ...keys.filter((k) => !k.healthy)];
  const attempts: { keyId: string; label: string; reason: string }[] = [];
  for (const key of ordered) {
    try {
      return await runWithKey(key, attachments, options);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      attempts.push({ keyId: key.id, label: key.label, reason });
    }
  }
  throw new AllE2BKeysFailedError(attempts);
}
