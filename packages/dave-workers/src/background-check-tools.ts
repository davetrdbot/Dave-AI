import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Background checks -- a genuinely general-purpose "mark something and check on it later"
 * primitive. The trader's own example: "mark a key level and check if price will reach that
 * level or a direction" -- but `whatToCheck` is deliberately free text, not a hardcoded
 * "price >= X" comparator, so this is equally usable for anything else Dave might want to poll
 * for in the background (a news event landing, a correlated pair's behavior, a spread
 * normalizing, anything).
 *
 * Split the same way subagent-tools.ts/worker-factory.ts are split: this file (dave-workers) owns
 * the real bookkeeping record (file-backed, same pattern as worker-factory.ts's registry) and the
 * tool definitions Dave calls; the real polling engine that calls back into a live `AgentLoop` to
 * actually evaluate `whatToCheck` lives in dave-agent-loop (background-check-loop.ts), for the
 * exact reason create_subagent's real execution (runWorkerTask) lives there too:
 * dave-workers must never import dave-agent-loop (that would invert the real, one-way package
 * dependency). full-registry.ts wraps `start_background_check`/`stop_background_check`'s
 * execute the same way it already wraps `create_subagent`.
 */

export type BackgroundCheckStatus = "active" | "met" | "expired" | "stopped" | "error";

/** Mirrors dave-e2b's own ScriptLanguage. Deliberately re-declared rather than imported: this
 *  package owns bookkeeping only and must not take a dependency on the execution layer (the same
 *  one-way-dependency rule that keeps runWorkerTask in dave-agent-loop, not here). */
export type BackgroundCheckScriptLanguage = "bash" | "python" | "node";

export interface BackgroundCheck {
  id: string;
  ownerUserId: string;
  /** Free text, WHY this check was started -- stored verbatim at creation and resurfaced
   *  byte-for-byte whenever this check fires or is inspected. Never re-derived or paraphrased. */
  reason: string;
  /** Free text, WHAT to check on every poll tick -- re-evaluated by a real agent-loop tool-call
   *  round each tick, never pattern-matched/parsed here. */
  whatToCheck: string;
  /** Optional real script (the trader: "expand the background tool ... so it can run any script to
   *  check for anything in the market"). When set, it is genuinely executed in a fresh E2B sandbox
   *  at the START of every tick and its real stdout/stderr/exit code are handed to the tick's
   *  reasoning as evidence. This is the deterministic half of a check: the same script, the same
   *  way, every tick -- rather than relying on the model to re-invent the measurement each time.
   *  The tick can ALSO write and run ad-hoc scripts itself via its own run_script tool. */
  script?: string;
  scriptLanguage?: BackgroundCheckScriptLanguage;
  checkEveryMs: number;
  maxDurationMs: number;
  createdAt: number;
  expiresAt: number;
  status: BackgroundCheckStatus;
  lastCheckedAt?: number;
  /** Set once the check reaches a terminal state (met/expired/stopped/error) -- the real outcome
   *  found on the tick that ended it (or the stop/error reason). */
  outcome?: string;
  checkCount: number;
}

/** Default ceiling when the caller doesn't specify one -- generous enough for a genuine
 *  multi-day watch, never truly unbounded (the resource-leak concern this whole file exists to
 *  avoid: a forgotten check polling forever). */
export const DEFAULT_MAX_DURATION_MS = 48 * 60 * 60_000; // 48h
export const MIN_CHECK_EVERY_MS = 30_000; // a genuinely tight poll floor -- never busy-loop
export const DEFAULT_CHECK_EVERY_MS = 5 * 60_000; // 5 minutes

function registryPath(ownerUserId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "background-checks", ownerUserId, "registry.json");
}

function readRegistry(ownerUserId: string): BackgroundCheck[] {
  const path = registryPath(ownerUserId);
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8"));
}

function saveRegistry(ownerUserId: string, checks: BackgroundCheck[]): void {
  const path = registryPath(ownerUserId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(checks, null, 2), "utf8");
}

export interface CreateBackgroundCheckOptions {
  reason: string;
  whatToCheck: string;
  script?: string;
  scriptLanguage?: BackgroundCheckScriptLanguage;
  checkEveryMs?: number;
  maxDurationMs?: number;
}

export function createBackgroundCheck(ownerUserId: string, options: CreateBackgroundCheckOptions): BackgroundCheck {
  if (!options.reason || !options.reason.trim()) throw new Error("reason is required -- this is what gets resurfaced to the user when the check fires.");
  if (!options.whatToCheck || !options.whatToCheck.trim()) throw new Error("whatToCheck is required.");

  const checkEveryMs = Math.max(options.checkEveryMs ?? DEFAULT_CHECK_EVERY_MS, MIN_CHECK_EVERY_MS);
  const maxDurationMs = options.maxDurationMs && options.maxDurationMs > 0 ? options.maxDurationMs : DEFAULT_MAX_DURATION_MS;
  const now = Date.now();

  const check: BackgroundCheck = {
    id: randomBytes(6).toString("hex"),
    ownerUserId,
    reason: options.reason,
    whatToCheck: options.whatToCheck,
    script: options.script?.trim() ? options.script : undefined,
    scriptLanguage: options.script?.trim() ? options.scriptLanguage ?? "bash" : undefined,
    checkEveryMs,
    maxDurationMs,
    createdAt: now,
    expiresAt: now + maxDurationMs,
    status: "active",
    checkCount: 0,
  };

  const checks = readRegistry(ownerUserId);
  checks.push(check);
  saveRegistry(ownerUserId, checks);
  return check;
}

export function listBackgroundChecks(ownerUserId: string, activeOnly = true): BackgroundCheck[] {
  const checks = readRegistry(ownerUserId);
  return activeOnly ? checks.filter((c) => c.status === "active") : checks;
}

export function getBackgroundCheck(ownerUserId: string, checkId: string): BackgroundCheck | undefined {
  return readRegistry(ownerUserId).find((c) => c.id === checkId);
}

/** Real per-tick bookkeeping update -- called by the real polling engine (dave-agent-loop) after
 *  every tick, whether or not the tick concluded the check. */
export function recordBackgroundCheckTick(ownerUserId: string, checkId: string): BackgroundCheck {
  const checks = readRegistry(ownerUserId);
  const check = checks.find((c) => c.id === checkId);
  if (!check) throw new Error(`No background check ${checkId} for ${ownerUserId}`);
  check.lastCheckedAt = Date.now();
  check.checkCount += 1;
  saveRegistry(ownerUserId, checks);
  return check;
}

/** Moves a check to a terminal state ("met"/"expired"/"stopped"/"error") with the real outcome
 *  text attached. Idempotent against an already-terminal check (a race between a tick concluding
 *  and a user-initiated stop is possible -- this never overwrites a check that already finished). */
export function finalizeBackgroundCheck(ownerUserId: string, checkId: string, status: Exclude<BackgroundCheckStatus, "active">, outcome: string): BackgroundCheck {
  const checks = readRegistry(ownerUserId);
  const check = checks.find((c) => c.id === checkId);
  if (!check) throw new Error(`No background check ${checkId} for ${ownerUserId}`);
  if (check.status !== "active") return check;
  check.status = status;
  check.outcome = outcome;
  saveRegistry(ownerUserId, checks);
  return check;
}

export interface BackgroundCheckToolContext {
  ownerUserId: string;
}

export interface BackgroundCheckToolDefinitionShape {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: BackgroundCheckToolContext) => Promise<unknown>;
}

export const BACKGROUND_CHECK_TOOLS: BackgroundCheckToolDefinitionShape[] = [
  {
    name: "start_background_check",
    description:
      "Start a real background check that polls on an interval and reports back the moment its condition is met OR its deadline passes -- genuinely general-purpose, not just price levels: mark ANYTHING to check on later (a key level being swept, a pair's direction, a news event landing, a correlated pair's behavior, anything). Each poll tick re-runs your own real reasoning (with real tool access) against `whatToCheck` -- it is never pattern-matched or hardcoded. When it fires, the user is messaged with BOTH your original `reason` (verbatim) and the real outcome found.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Free text: WHY you're starting this check, in your own words (e.g. \"watching for XAUUSD to sweep the 2380 low before considering a reversal entry\"). Stored verbatim and resurfaced exactly as written when this check fires -- never paraphrased later, so write it the way you want to see it again.",
        },
        whatToCheck: {
          type: "string",
          description: "Free text describing the actual condition to check on EVERY poll tick (e.g. \"has XAUUSD traded at or below 2380.00 yet, and if so did it reverse or continue\"). Re-evaluated by a real reasoning+tool-call round each tick -- be specific enough that a fresh read of just this text, with no other memory of why you started the check, is enough to judge it.",
        },
        script: {
          type: "string",
          description:
            "Optional but powerful: a real script that is genuinely executed in a fresh sandbox at the start of EVERY tick, with its real stdout/stderr/exit code handed to your reasoning as evidence. Use this whenever the condition is measurable by code -- fetch a live price or feed over HTTP, compute an indicator or spread, diff against a threshold -- so every tick measures the same way instead of you re-inventing it each time. Print what you need to judge the condition to stdout. You can still investigate further with your other tools on top of this.",
        },
        scriptLanguage: { type: "string", enum: ["bash", "python", "node"], description: "Language for `script`. Defaults to bash." },
        checkEveryMs: { type: "number", description: `How often to poll, in ms. Default ${DEFAULT_CHECK_EVERY_MS}ms (5 min); floor of ${MIN_CHECK_EVERY_MS}ms -- never busy-loop.` },
        maxDurationMs: { type: "number", description: `Deadline after which this auto-expires and notifies the user even if the condition was never met -- never runs forever. Default ${DEFAULT_MAX_DURATION_MS}ms (48h).` },
      },
      required: ["reason", "whatToCheck"],
    },
    execute: async (args, ctx) =>
      createBackgroundCheck(ctx.ownerUserId, {
        reason: args.reason as string,
        whatToCheck: args.whatToCheck as string,
        script: args.script as string | undefined,
        scriptLanguage: args.scriptLanguage as BackgroundCheckScriptLanguage | undefined,
        checkEveryMs: args.checkEveryMs as number | undefined,
        maxDurationMs: args.maxDurationMs as number | undefined,
      }),
  },
  {
    name: "list_background_checks",
    description: "List your pending/active background checks (or all, including finished ones), each with its reason, whatToCheck, and status.",
    parameters: { type: "object", properties: { includeFinished: { type: "boolean" } } },
    execute: async (args, ctx) => listBackgroundChecks(ctx.ownerUserId, !args.includeFinished),
  },
  {
    name: "get_background_check",
    description: "Inspect one specific background check's real current state by id -- reason, whatToCheck, status, how many times it's been polled, and its outcome if finished.",
    parameters: { type: "object", properties: { checkId: { type: "string" } }, required: ["checkId"] },
    execute: async (args, ctx) => {
      const check = getBackgroundCheck(ctx.ownerUserId, args.checkId as string);
      if (!check) throw new Error(`No background check "${args.checkId}".`);
      return check;
    },
  },
  {
    name: "stop_background_check",
    description: "Cancel a specific background check -- stops its polling and cleans it up. Use when the condition no longer matters (e.g. you changed your mind, or already acted on it another way).",
    parameters: { type: "object", properties: { checkId: { type: "string" } }, required: ["checkId"] },
    execute: async (args, ctx) => {
      const check = getBackgroundCheck(ctx.ownerUserId, args.checkId as string);
      if (!check) throw new Error(`No background check "${args.checkId}".`);
      if (check.status === "active") finalizeBackgroundCheck(ctx.ownerUserId, check.id, "stopped", "Stopped manually before the condition fired.");
      return { ok: true };
    },
  },
];
