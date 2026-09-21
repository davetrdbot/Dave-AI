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
  recordBackgroundCheckScriptRun,
} from "@dave/workers";
import { E2B_TOOLS, runScriptInE2B } from "@dave/e2b";
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
/** Per-symbol ceiling on the EA round trip. Deliberately tighter than the EA's own 5-minute
 *  worst-case analysis budget: this runs unattended on a timer, and a tick that stalls for minutes
 *  per symbol would outlive its own interval. A fetch that misses this window is reported as a
 *  genuine failure for that symbol and simply retried on the next tick, which costs nothing. */
const SYMBOL_FETCH_TIMEOUT_MS = 120_000;

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
    // Real script capability for the tick itself (the trader: "expand the background tool and the
    // subtask so it can run any script to check for anything in the market"). The tick can write
    // and run ad-hoc code -- fetch a feed, compute a spread, parse a series -- not just call the
    // fixed analysis tools. Only run_script is granted; E2B key management is Dave's own business,
    // not something an unattended tick should be able to touch.
    const runScriptTool = E2B_TOOLS.find((t) => t.name === "run_script");
    if (runScriptTool) liveRegistry.register(adaptTools([runScriptTool], { userId: deps.ownerUserId, db: deps.db }));

    // The check's own stored script runs FIRST, deterministically, every tick -- same measurement
    // every time, rather than depending on the model to re-invent it. Its real output becomes
    // evidence in the prompt; a failure is reported honestly rather than silently swallowed, so a
    // broken script shows up as "I couldn't measure" instead of a confident wrong verdict.
    // Live EA data for the synthetic pairs this check names (the trader: "the background tool only
    // works for coins and others -- give it a way so it can check for synthetic pairs"). A sandbox
    // has real internet, so a script can price bitcoin by itself -- but VOL_80, CRASH_100 and the
    // rest are on NO public API: they exist only in the trader's own terminal. Fetching them here
    // and writing them in as market.json is the entire difference between a script that can check
    // a synthetic pair and one that can only check crypto.
    const market: Record<string, unknown> = {};
    const marketErrors: string[] = [];
    for (const symbol of check.symbols ?? []) {
      try {
        market[symbol] = await deps.analysis.get("all", symbol, check.timeframe ?? "M15", { timeoutMs: SYMBOL_FETCH_TIMEOUT_MS });
      } catch (err) {
        marketErrors.push(`${symbol}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const marketFile = Object.keys(market).length > 0 ? JSON.stringify({ timeframe: check.timeframe ?? "M15", fetchedAt: Date.now(), symbols: market }, null, 2) : undefined;

    let scriptEvidence = "";
    if (check.script) {
      try {
        const run = await runScriptInE2B(deps.db, deps.ownerUserId, {
          script: check.script,
          language: check.scriptLanguage ?? "bash",
          filesIn: marketFile ? [{ path: "market.json", content: marketFile }] : undefined,
        });
        // Persisted so an ACTIVE check can be inspected between firings -- get_background_check
        // and list_background_checks both surface this, so a script that is quietly failing or
        // printing something unexpected is visible now rather than at the deadline.
        recordBackgroundCheckScriptRun(deps.ownerUserId, check.id, { at: Date.now(), exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr });
        const files = run.filesOut.length > 0 ? `\n\nFiles it produced:\n${run.filesOut.map((f) => `- ${f.path} (${f.bytes} bytes)${f.encoding === "utf8" ? `\n${f.content}` : " [binary]"}`).join("\n")}` : "";
        scriptEvidence = `\n\nThis check has a script that was just run for this tick (exit code ${run.exitCode}).\nstdout:\n${run.stdout || "(empty)"}${run.stderr ? `\nstderr:\n${run.stderr}` : ""}${files}\n\nTreat this as your primary evidence, but sanity-check it -- a non-zero exit code or empty output means the measurement FAILED and you must not report met=true off it.`;
      } catch (err) {
        // A run that could not happen at all is recorded too -- otherwise a check whose script has
        // never once executed (no E2B key, say) would look identical to one that simply hasn't
        // ticked yet, and the trader would have no way to tell why nothing is coming back.
        recordBackgroundCheckScriptRun(deps.ownerUserId, check.id, { at: Date.now(), exitCode: null, stdout: "", stderr: "", error: err instanceof Error ? err.message : String(err) });
        scriptEvidence = `\n\nThis check has a script, but running it for this tick genuinely FAILED: ${err instanceof Error ? err.message : String(err)}\n\nYou therefore have no script evidence this tick. Do not report met=true on a guess -- investigate with your other tools, or report met=false and say the measurement failed.`;
      }
    }

    const provider = modelConfigProvider(deps.db, deps.ownerUserId, () => undefined);
    const loop = new AgentLoop(provider, liveRegistry);
    const marketNote =
      (check.symbols?.length ?? 0) > 0
        ? `\n\nLive data for ${check.symbols!.join(", ")} (${check.timeframe ?? "M15"}) was fetched from the trading terminal for this tick${marketFile ? ` and written into the sandbox as "market.json" (in $DAVE_IN_DIR), so your script reads it from there` : ""}.${marketErrors.length > 0 ? ` These genuinely FAILED to fetch and you have no data for them: ${marketErrors.join("; ")}. Do not guess at them.` : ""}\n\nThese are synthetic pairs -- they exist only in this terminal and are on no public API. Never try to fetch them over the internet, and never substitute a real-world instrument for one.`
        : "";
    const systemPrompt = `You are running one poll tick of a background check the owner started earlier. Use your real tools to genuinely investigate right now, then call report_check_result exactly once with your honest finding -- do not fabricate a result and do not report met=true unless it is genuinely, verifiably true right now.\n\nYou have run_script: you can write and run real code (bash/python/node, with network access) to measure anything you can express as code, rather than guessing. You also have get_all_analysis for a live read on any symbol.\n\nCondition to check: ${check.whatToCheck}${marketNote}${scriptEvidence}`;
    // No step cap (the trader: "give it uncountable max steps"). A tick that needs to run a script,
    // read its output, fix it and re-run was previously killed at 8 steps. Overlapping ticks are
    // already impossible -- registerPollingCheck skips a tick while the previous one is in flight --
    // and AgentLoop's own overall wall-clock deadline still bounds every run.
    const result = await loop.run([
      { role: "system", content: systemPrompt },
      { role: "user", content: check.whatToCheck },
    ]);

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
