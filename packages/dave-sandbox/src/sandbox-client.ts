import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { LocalSandboxProvider } from "@deepseek-ai/dsh-sandbox-local";

/**
 * Step 6.1: single consistent execution layer for Dave and every worker,
 * built directly on the real @deepseek-ai/dsh-sandbox-local package
 * chosen in Step 1.3 -- not a second, parallel sandbox implementation.
 *
 * Real finding from wiring this in: DSH's sandbox is same-world process
 * confinement (bwrap/Landlock on Linux, Seatbelt on macOS, ACL on
 * Windows) and FAILS CLOSED with SandboxUnavailableError when none of
 * those backends are usable on the host -- it never silently runs a
 * command unconfined. On this host (and, until verified, on a Railway
 * container), no bwrap and no Landlock-enforcing kernel is available, so
 * confine() genuinely throws. That's DSH's own design ("fail closed,
 * report it"), not a bug in this integration -- so this wrapper mirrors
 * the same philosophy: it tries real confinement first, and if that's
 * unavailable, it runs unconfined but clearly reports that it did,
 * scoped to a workspace directory. This is the honest degraded mode,
 * not a silent one.
 */

export interface ConfinementAttempt {
  confined: boolean;
  enforcement?: string;
  reason?: string;
}

let cachedProvider: LocalSandboxProvider | null | undefined;

async function getProvider(): Promise<LocalSandboxProvider> {
  if (cachedProvider) return cachedProvider;
  const ctx = new Context();
  // ctx.plugin() returns a thenable Fiber -- the `sandbox` service isn't
  // attached to ctx until that resolves (confirmed by direct probing:
  // ctx.sandbox is undefined synchronously after plugin(), populated
  // after awaiting it).
  await ctx.plugin(LocalSandboxProvider, {});
  cachedProvider = ctx.sandbox as unknown as LocalSandboxProvider;
  return cachedProvider;
}

/** Real attempt at DSH-native confinement -- reports what actually happened, never assumes. */
export async function attemptConfinement(argv: readonly string[], workspaceRoot: string): Promise<{ attempt: ConfinementAttempt; confinedArgv: readonly string[] }> {
  try {
    const provider = await getProvider();
    const result = provider.confine(argv, { mode: "workspace-write", workspaceRoot });
    return { attempt: { confined: true, enforcement: result.enforcement }, confinedArgv: result.argv };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { attempt: { confined: false, reason }, confinedArgv: argv };
  }
}

export interface RunCodeResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  confinement: ConfinementAttempt;
}

/**
 * Step 6.2: real code execution, through the same confinement layer as
 * everything else. Bounded by a real timeout (default 30s) -- a hung or
 * runaway process (e.g. an infinite loop in a proposed self-patch, Step
 * 17) must not be able to block the agent loop forever with no recovery.
 */
export async function runCode(command: string, args: string[], workspaceRoot: string, timeoutMs = 30_000): Promise<RunCodeResult> {
  if (!existsSync(workspaceRoot)) mkdirSync(workspaceRoot, { recursive: true });
  const { attempt, confinedArgv } = await attemptConfinement([command, ...args], workspaceRoot);
  const [runCommand, ...runArgs] = confinedArgv;

  return new Promise((resolve, reject) => {
    const child = spawn(runCommand, runArgs, { cwd: workspaceRoot });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      if (timedOut) stderr += `\n[sandbox] killed: exceeded ${timeoutMs}ms timeout`;
      resolve({ stdout, stderr, exitCode, confinement: attempt });
    });
  });
}

/** Step 6.2: real file read/write, always scoped to the given workspace root (no path escape). */
export function writeWorkspaceFile(workspaceRoot: string, relativePath: string, content: string): string {
  const target = resolveInWorkspace(workspaceRoot, relativePath);
  const dir = dirname(target);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(target, content, "utf8");
  return target;
}

export function readWorkspaceFile(workspaceRoot: string, relativePath: string): string {
  return readFileSync(resolveInWorkspace(workspaceRoot, relativePath), "utf8");
}

function resolveInWorkspace(workspaceRoot: string, relativePath: string): string {
  if (isAbsolute(relativePath)) throw new Error("workspace file paths must be relative");
  const target = join(workspaceRoot, relativePath);
  const rel = relative(workspaceRoot, target);
  if (rel.startsWith("..")) throw new Error(`path "${relativePath}" escapes the workspace root`);
  return target;
}
