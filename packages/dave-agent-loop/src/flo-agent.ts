import type { Provider } from "@dave/brain";
import { EA_ANALYSIS_TOOLS, type EaToolContext } from "@dave/ea-bridge";
import type { AgentTool } from "./tool-registry.js";
import { ToolRegistry, adaptTools } from "./tool-registry.js";
import { AgentLoop, MaxStepsExceededError } from "./agent-loop.js";
import { beginTurn, endTurn } from "./turn-abort.js";
import { recordAnalysisFetch } from "./analysis-debug-store.js";
import type { TickDecision } from "./autonomous-tick.js";

/**
 * Real feature ("Two-step trading" -- a second, independent AI approves or declines every trade
 * before it fires). Flo is architecturally a SIBLING of Journal (see journal-agent.ts) -- its own
 * fresh AgentLoop + fresh, deliberately scoped ToolRegistry, wired to the same turn-abort.ts
 * mechanism so `/stop` can cancel it, with a small conclusion tool it must call and an honest
 * fallback when it can't reach a real conclusion.
 *
 * The scope is deliberately narrower than Journal's: Flo gets ONLY the 44 individual real-time
 * analysis endpoints (EA_ANALYSIS_TOOLS, minus `get_all_analysis` and the trivial `ping_ea`
 * health check -- neither is a genuine analysis read) -- never `get_all_analysis` (which also
 * bundles full account/margin awareness Flo has no business consuming just to second-guess one
 * trade), and never anything that can act on the account (`trade_execute`, `full_close`,
 * `partial_close`, `delete_pending_order`, `trade_modify`, or any other trading tool) -- none of
 * those are even registered here, so there is nothing for Flo to call even if it tried. Flo
 * reviews and decides; it never places, modifies, or cancels anything itself. Once Flo approves,
 * the CALLER (autonomous-tick.ts) proceeds through the exact same, unmodified final-gate/
 * tradeExecute path every trade already goes through -- Flo's approval never bypasses it, and
 * Flo's decline never itself fires anything either.
 */
export interface FloContext {
  userId: string;
  provider: Provider;
}

export interface FloVerdict {
  approved: boolean;
  reason: string;
}

const FLO_DECISION_TOOL_NAME = "flo_decision";

/** Real, honest fallback for a genuine failure to reach a conclusion (run out of steps, aborted,
 *  or the model simply never called flo_decision). Declining by default is the safe direction for
 *  real money -- Flo must NEVER auto-approve just because its own run didn't finish cleanly. */
const FLO_FALLBACK: FloVerdict = {
  approved: false,
  reason: "Flo could not reach a real conclusion -- declining by default, no trade placed",
};

/**
 * Real, genuine reference for the 44 individual analysis endpoints Flo is meant to use -- written
 * from each endpoint's own real computation (dave-ea-bridge/src/tools.ts's descriptions, cross-
 * checked against ea/DaveEA.mq5's real A_* functions), not a copy of prompts/trading.md (which
 * deliberately steers the MAIN model toward get_all_analysis only and documents none of these
 * individually). Grouped by what kind of read each one gives, since a second-opinion reviewer
 * needs to know WHICH tools actually answer "is this real" for a given concern, not just that 44
 * tools exist.
 */
const FLO_ENDPOINT_REFERENCE = `Your analysis tools (EA 4.0 groups -- raw facts with their rules, closed candles only; each takes a symbol and an optional timeframe, default M15):

- get_market_structure: wick swings HH/HL/LH/LL, trend, BOS/CHoCH (body close, displacement), CISD, dealing range, premium/discount, OTE, inducement, higher timeframe; APA shift point, shifted/transition, reclaim -- a BUY into a fresh bearish CHoCH is a real conflict.
- get_liquidity: untaken pools above/below, equal highs/lows, sweeps, draw on liquidity, liquidity engineering (thrust, FMD, CHoCH) -- did the setup form after a real sweep?
- get_zones: order blocks, breakers, FVG/IFVG/BPR, APA areas of liquidity with validation/invalidation, consumed % -- is the entry at a fresh zone or a consumed one?
- get_trend / get_momentum: moving averages, ADX/DI, Supertrend, Ichimoku; RSI/MACD/stochastic, divergence -- does momentum back the direction?
- get_volatility: ATR, Bollinger/Keltner, squeeze -- is the stop sized to real volatility?
- get_volume: tick-volume facts (estimates labelled).
- get_levels: pivots, round numbers, fib, the merged ladder, APA flip levels.
- get_session / get_news: session timing, killzones; upcoming high-impact events and blackout.
- get_intermarket: currency strength ranking and correlations.
- get_chart_patterns: double tops/bottoms, H&S, triangles, harmonics.
- get_summary: structure bias across D1/H4/H1/M15, APA cycles, FTA ahead.
- get_candles / get_price: raw candles; live price, spread vs normal, day/week levels.

Pull only what tests the specific claim in Dave's reasoning (structure claim -> get_market_structure/get_zones/get_liquidity; momentum claim -> get_momentum; risk claim -> get_volatility/get_summary; timing claim -> get_session/get_news).`;

function buildFloSystemPrompt(): string {
  return `You are Flo, the second, INDEPENDENT approver in Dave's two-step trading review. Dave (the autonomous trading AI) has already made a real trade decision and wants your genuine, independent sign-off before it fires -- not a rubber stamp, not automatic agreement.

You have real, on-demand access to the same live MT5 market-analysis endpoints Dave used -- pull whatever you genuinely need to verify Dave's reasoning actually holds up, then decide. You do NOT have access to get_all_analysis (that also bundles full account state Flo has no need for), and you have NO tool that can place, modify, or cancel a trade -- you are a reviewer, never an executor. If you genuinely find nothing wrong with a real, defensible setup, approve it -- this is not "find a reason to decline," it's "confirm this is real." Decline only when your own real tool checks show something Dave's reasoning got wrong or missed (structure conflict, exhausted momentum, an imminent high-impact news blackout, a spread that eats the edge, an SL/TP that doesn't match real current volatility, etc.) -- be specific about what you actually found, never vague.

${FLO_ENDPOINT_REFERENCE}

When you have genuinely finished your real review, call the ${FLO_DECISION_TOOL_NAME} tool exactly once with your verdict -- this is the ONLY way to conclude a review; nothing else you say counts as a real decision. Give a real, specific reason either way (a few sentences, referencing what you actually found), never a generic one.`;
}

function summarizeDecisionForFlo(decision: TickDecision): string {
  const parts = [
    `Dave wants to ${decision.action}${decision.symbol ? ` ${decision.symbol}` : ""}`,
    decision.entry !== undefined ? `entry=${decision.entry}` : null,
    decision.sl !== undefined ? `sl=${decision.sl}` : null,
    decision.tp !== undefined ? `tp=${decision.tp}` : null,
    decision.lots !== undefined ? `lots=${decision.lots}` : null,
    decision.confidence !== undefined ? `Dave's own confidence=${decision.confidence}%` : null,
    decision.strategyTag ? `setup: ${decision.strategyTag}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  const reason = decision.reason ? `\nDave's real reasoning: ${decision.reason}` : "";
  return `${parts}${reason}\n\nReview this real setup using your own real tool checks and give your genuine verdict.`;
}

function floDecisionTool(onDecision: (verdict: FloVerdict) => void): AgentTool {
  return {
    name: FLO_DECISION_TOOL_NAME,
    description: "Conclude your review with a real approve/decline verdict and a specific reason. Call this exactly once, when you are genuinely done reviewing -- this is the only way to finish.",
    parameters: {
      type: "object",
      properties: {
        approve: { type: "boolean", description: "true to approve this trade, false to decline it" },
        reason: { type: "string", description: "your real, specific reasoning -- what you actually checked and found" },
      },
      required: ["approve", "reason"],
    },
    execute: async (args: Record<string, unknown>) => {
      const verdict: FloVerdict = { approved: Boolean(args.approve), reason: typeof args.reason === "string" ? args.reason : "" };
      onDecision(verdict);
      return { recorded: true };
    },
  };
}

/** Real, separate agent run -- Flo's own provider.generate()-backed AgentLoop, scoped to a
 *  read-only, analysis-only tool registry that cannot touch the account. Returns Flo's real
 *  verdict, or the honest decline-by-default fallback if Flo genuinely never reached one. */
export async function consultFlo(ctx: FloContext, decision: TickDecision, contextLines: string[] = []): Promise<FloVerdict> {
  const registry = new ToolRegistry();
  const eaCtx: EaToolContext = { userId: ctx.userId, onAnalysisDebug: (entry) => recordAnalysisFetch(ctx.userId, entry) };
  // Deliberately excludes get_all_analysis (bundles account-wide state Flo has no need for) and
  // ping_ea (a trivial health check, not a real analysis read) -- every one of the 44 real
  // individual analysis endpoints, and NOTHING that can act on the account, is registered here.
  const analysisOnlyTools = EA_ANALYSIS_TOOLS.filter((t) => t.name !== "get_all_analysis" && t.name !== "ping_ea");
  registry.register(adaptTools(analysisOnlyTools, eaCtx));

  let captured: FloVerdict | null = null;
  registry.register([floDecisionTool((verdict) => { captured = verdict; })]);

  const loop = new AgentLoop(ctx.provider, registry);
  const userContent = [summarizeDecisionForFlo(decision), ...contextLines].join("\n");

  // Real, wired abort path -- same turn-abort.ts mechanism Journal already uses, tracked under
  // the same real owner user id, so `/stop`/`/panic` genuinely reaches Flo's consult too, exactly
  // like it already does for Journal.
  const abortController = beginTurn(ctx.userId);
  try {
    // Bounded, generous-but-finite step cap -- consulting Flo happens INSIDE a single autonomous
    // tick, same real reasoning as Journal's own cap.
    await loop
      .run(
        [
          { role: "system", content: buildFloSystemPrompt() },
          { role: "user", content: userContent },
        ],
        { timeoutMs: 60_000, maxSteps: 8, signal: abortController.signal }
      )
      .catch((err) => {
        if (err instanceof MaxStepsExceededError) return null;
        throw err;
      });

    // Real, honest rule: only a genuine flo_decision call counts as a real verdict, regardless of
    // whether the underlying run finished "done," ran out of steps, or was cancelled mid-flight --
    // NEVER auto-approve on any kind of failure, since declining by default is the safe direction
    // for real money.
    return captured ?? FLO_FALLBACK;
  } finally {
    endTurn(ctx.userId, abortController);
  }
}
