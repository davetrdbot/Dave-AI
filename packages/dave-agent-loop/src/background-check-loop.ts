import type { DaveDatabase } from "@dave/db";
import { registerPollingCheck, unregisterPollingCheck } from "@dave/db";
import type { TradeExecutor, AnalysisSource } from "@dave/trading";
import { markdownToTelegramHtml, type TelegramClient } from "@dave/telegram";
import {
  createWorker,
  retireWorker,
  toolsForWorker,
  type BackgroundCheck,
  getBackgroundCheck,
  listBackgroundChecks,
  recordBackgroundCheckTick,
  finalizeBackgroundCheck,
} from "@dave/workers";
import { ToolRegistry, adaptTools, type AgentTool } from "./tool-registry.js";
import { AgentLoop } from "./agent-loop.js";
import { modelConfigProvider } from "./provider-selection.js";

/**
 * The real polling engine behind start_background_check/stop_background_check
 * (dave-workers/background-check-tools.ts owns the bookkeeping record; this owns actually
 * running it). Lives here, not in dave-workers, for the exact same one-way-dependency reason
 * worker-loop.ts's runWorkerTask does: driving a real tick genuinely needs AgentLoop/ToolRegistry.
 *
 * Each poll tick is a real, short agent-loop run (NOT a hardcoded comparator) -- given
 * `whatToCheck` as its task, real read/analysis tools (the same non-trade-placing tool set a
 * generic worker gets), and a single-purpose `report_check_result` tool it must call with its
 * genuine verdict. This is what keeps the check general-purpose: it can reason about a price
 * level, a news event, a pattern, anything expressible in free text -- nothing here parses
 * `whatToCheck` itself.
 */
export interface BackgroundCheckLoopDeps {
  db: DaveDatabase;
  ownerUserId: string;
  analysis: AnalysisSource;
  executor: TradeExecutor;
  client: TelegramClient;
  chatId: number;
}

async function notifyUser(deps: BackgroundCheckLoopDeps, check: BackgroundCheck, headline: string, outcome: string): Promise<void> {
  // The original `reason` is resurfaced here VERBATIM -- never re-derived/paraphrased, per the
  // trader's own explicit ask ("comes back with the reason made earlier why it mark or do that").
  const text = `${headline}\n\nReason it was started: ${check.reason}\n\nOutcome: ${outcome}`;
  await deps.client.sendMessage({ chat_id: deps.chatId, text: markdownToTelegramHtml(text), parse_mode: "HTML" });
}

interface TickVerdict {
  met: boolean;
  summary: string;
}

async function runBackgroundCheckTick(deps: BackgroundCheckLoopDeps, check: BackgroundCheck): Promise<TickVerdict> {
  // Same real lifecycle as security-check-cron.ts/dreaming-cron.ts: a real worker created for the
  // run, retired immediately after -- not an inline callback pretending to be one.
  const worker = createWorker(deps.ownerUserId, { assignment: "temporary", role: "generic", task: `Background check tick: ${check.whatToCheck}` });
  try {
    const tradingCtx = { userId: deps.ownerUserId, analysis: deps.analysis, executor: deps.executor };
    const liveRegistry = new ToolRegistry();
    liveRegistry.register(adaptTools(toolsForWorker(worker), tradingCtx));

    let verdict: TickVerdict | undefined;
    const reportTool: AgentTool = {
      name: "report_check_result",
      description: "Call this exactly once, as your final step, with your real, genuine verdict on whether the condition is met right now.",
      parameters: {
        type: "object",
        properties: {
          met: { type: "boolean", description: "true ONLY if the condition is genuinely, verifiably met right now -- never guess true." },
          summary: { type: "string", description: "The real, concrete outcome you found (actual prices/levels/facts you checked), not a vague restatement of the condition." },
        },
        required: ["met", "summary"],
      },
      execute: async (args) => {
        verdict = { met: Boolean(args.met), summary: String(args.summary ?? "") };
        return { ok: true };
      },
    };
    liveRegistry.register([reportTool]);

    const provider = modelConfigProvider(deps.db, deps.ownerUserId, () => undefined);
    const loop = new AgentLoop(provider, liveRegistry);
    const systemPrompt = `You are running one poll tick of a background check the owner started earlier. Use your real tools to genuinely investigate right now, then call report_check_result exactly once with your honest finding -- do not fabricate a result and do not report met=true unless it is genuinely, verifiably true right now.\n\nCondition to check: ${check.whatToCheck}`;
    const result = await loop.run(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: check.whatToCheck },
      ],
      { maxSteps: 8 }
    );

    if (verdict) return verdict;
    // The model answered in plain text instead of calling report_check_result -- never guess
    // "met" in that case; fall back to its own text as the running summary and try again next tick.
    if (result.status === "done" && result.text.trim().length > 0) {
      return { met: false, summary: result.text };
    }
    return { met: false, summary: "This tick couldn't reach a conclusion -- will check again next interval." };
  } finally {
    retireWorker(deps.ownerUserId, worker.id);
  }
}

/** Idempotent: safe to call for a check that's already polling (e.g. re-armed on a fresh
 *  registry build within the same process) -- silently no-ops instead of throwing. */
export function startBackgroundCheckPolling(deps: BackgroundCheckLoopDeps, check: BackgroundCheck): void {
  try {
    registerPollingCheck(check.id, check.checkEveryMs, async () => {
      const current = getBackgroundCheck(deps.ownerUserId, check.id);
      if (!current || current.status !== "active") return true; // stopped/finished elsewhere -- self-unregister

      // Resource-leak guard: a check with no deadline reached (or genuinely never met) must
      // auto-expire and tell the user, rather than polling forever unnoticed.
      if (Date.now() >= current.expiresAt) {
        const finished = finalizeBackgroundCheck(deps.ownerUserId, current.id, "expired", `Timed out after ${Math.round(current.maxDurationMs / 60_000)} minute(s) without the condition being met.`);
        // finalizeBackgroundCheck is idempotent against an already-terminal check (e.g. a
        // concurrent stop_background_check landed first) -- only notify if THIS call is what
        // actually finalized it, otherwise a message announcing "timed out" would contradict a
        // status the user (or another tick) already set.
        if (finished.status === "expired") await notifyUser(deps, finished, "⏰ Background check timed out", finished.outcome ?? "");
        return true;
      }

      try {
        const tick = await runBackgroundCheckTick(deps, current);
        recordBackgroundCheckTick(deps.ownerUserId, current.id);
        if (tick.met) {
          const finished = finalizeBackgroundCheck(deps.ownerUserId, current.id, "met", tick.summary);
          // Real race fixed: stop_background_check can finalize this check to "stopped" while
          // this tick (already in flight) is mid-run. finalizeBackgroundCheck correctly refuses
          // to overwrite that terminal state, but without this guard the check below still fired
          // an unconditional "condition met" notification, directly contradicting the user's own
          // stop -- they'd stop a check and then immediately get told it succeeded anyway. Only
          // notify when this call is genuinely what finalized it.
          if (finished.status === "met") await notifyUser(deps, finished, "✅ Background check condition met", tick.summary);
          return true;
        }
        return false;
      } catch (err) {
        // A transient tool/provider error on one tick must not kill the whole check -- just log
        // and try again next interval (the maxDurationMs ceiling still bounds it either way).
        recordBackgroundCheckTick(deps.ownerUserId, current.id);
        console.error(`[background-check] ${current.id} tick failed:`, err);
        return false;
      }
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("already registered")) return;
    throw err;
  }
}

export function stopBackgroundCheckPolling(checkId: string): void {
  unregisterPollingCheck(checkId);
}

/** Re-arms every still-active check for this user against a real poller -- called once per
 *  registry build (mirrors wireScheduledAutomations), so a check genuinely survives a process
 *  restart instead of silently going nowhere after one (same reasoning scheduled-trigger.ts's own
 *  doc comment gives for cron triggers: nothing here needs its own persistence, re-registering on
 *  boot is sufficient since `expiresAt` is a real wall-clock timestamp). */
export function rearmActiveBackgroundChecks(deps: BackgroundCheckLoopDeps): void {
  for (const check of listBackgroundChecks(deps.ownerUserId, true)) {
    startBackgroundCheckPolling(deps, check);
  }
}
