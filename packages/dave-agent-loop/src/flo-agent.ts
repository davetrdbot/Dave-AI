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
const FLO_ENDPOINT_REFERENCE = `Your real analysis tools, grouped by what they actually tell you (each takes a symbol and an optional timeframe -- default timeframe is M15 unless you pass one):

TREND & MOMENTUM
- get_trend: moving-average alignment (EMA stack), golden/death cross, a real bias score -- use to confirm the proposed direction actually matches the prevailing trend, not just one candle.
- get_momentum: RSI/MACD/Stochastic/CCI/Williams %R rolled into one bull/bear signal -- use to check the move still has real fuel, not already exhausted.
- get_divergence: real RSI/MACD/Stochastic divergence (regular = reversal warning, hidden = continuation) -- a proposed continuation trade against a confirmed regular divergence is a real red flag.
- get_ichimoku: cloud position, TK cross, chikou -- a second independent trend/momentum read.
- get_mean_reversion: z-score vs. a 20-period mean -- flags when price is genuinely overextended and a "continuation" trade is really chasing.

STRUCTURE & SMC/ICT
- get_structure: real HH/HL/LH/LL sequence, BOS/CHoCH/MSS/CISD, dealing range, premium/discount, OTE zone -- the core real market-structure read; a BUY proposed inside a confirmed bearish CHoCH is a real conflict.
- get_zones: supply/demand zones with a freshness/strength score and mitigation % -- is the proposed entry actually AT a real, unmitigated zone, or just near a stale one?
- get_liquidity: BSL/SSL levels, equal highs/lows, real sweeps, liquidity voids -- did the setup form AFTER a real liquidity grab (higher-quality), or is it walking straight into unswept liquidity against it?
- get_order_blocks: real bullish/bearish order blocks with mitigated status and distance -- the actual OB the proposed entry claims to be reacting to, if any.
- get_inducement: whether the real IDM (inducement) high/low has been taken, next real liquidity target, and a valid_setup flag -- Flo's single most direct "is this a genuine ICT setup or a premature entry" check.
- get_premium_discount: real equilibrium/OTE zone position (0=range low, 1=range high) -- a BUY proposed deep in premium (or a SELL deep in discount) is buying/selling into the wrong half of the range.
- get_ict: FVG/iFVG, breaker blocks, killzones, silver bullet window, Judas swing, AMD phase, OTE zone all in one -- the fullest single ICT-concept read.
- get_wyckoff: accumulation/distribution/markup phase, spring/UTAD events, effort-vs-result -- catches a setup that's really still inside accumulation/distribution, not a genuine breakout.
- get_fractal: Williams fractal swing points -- the raw real swing points several of the above are built from.
- get_swing: real swing highs/lows with bar index/timestamp and the last leg's direction.

VOLATILITY, RISK & EXECUTION QUALITY
- get_volatility: ATR, Bollinger Bands, Keltner Channel, expansion/contraction, volatility regime -- is the proposed SL sized to genuine current volatility, or dangerously tight/loose for right now?
- get_risk_metrics: ATR-based SL/TP levels, real R:R ratios, pip value, a recommended lot size per % risk -- your real cross-check against the proposed sl/tp/lots.
- get_spread_analysis: spread vs. ATR, a cost rating, a tradeable flag -- a real setup can still be a bad trade if the spread genuinely eats the edge right now.
- get_candles: the last 10 real candles with body/wick ratios, size vs. ATR, gap/imbalance detection -- ground-truth current price action, not a summarized indicator.
- get_price: bid/ask/spread, day/week/month/52w high-low, swap, lot-size limits -- the real current price context every other read is measured against.
- get_levels: round-number/psychological levels and 52-week high/low distance -- real "why would price stall/react exactly here" context.
- get_pivots: classic/Fibonacci/Camarilla/weekly/monthly pivots and price's real position vs. them.
- get_fibonacci: real retracement/extension levels, nearest level, OTE zone, golden-ratio bounce -- a second, independent way to check the proposed entry sits at a real confluent level.

VOLUME & ORDER FLOW
- get_volume: current vs. average volume, bull/bear volume delta, real spikes/climax.
- get_orderflow: buy/sell volume delta, absorption, climax, stop runs, momentum ignition -- did real aggressive flow actually confirm the move, or is it thin?
- get_tape: real tick-tape up/down ratio and fast-tape detection -- very short-term flow confirmation.
- get_tape_flow: cumulative volume delta and aggressive buyer/seller flow over a longer window.
- get_market_profile: POC, value area high/low, price vs. value area, profile shape -- is price trading with or against where real volume has actually built up?

PATTERNS & CONFLUENCE
- get_patterns: real candlestick pattern recognition (single/double/triple), strongest pattern, bias, reliability.
- get_harmonic: real harmonic pattern detection (Gartley/Bat/Butterfly/Crab), XABCD ratios, PRZ, confidence.
- get_elliott: current real Elliott wave count, impulse/correction, wave target/invalidation.
- get_gann: Gann fan ratios, nearest Gann level, Square of 9 projection.
- get_confluence: a real multi-signal confluence score (MA/RSI/MACD/ADX/price-action agreement) with direction and strength -- a fast, single-number cross-check against everything above.
- get_backtest: a quick real MA20/50-cross backtest over loaded history (win rate, net pips, edge) -- context on whether this instrument/timeframe combo has a real historical edge at all.

CONTEXT: SESSION, NEWS, MACRO, REGIME
- get_session: real Tokyo/London/NY/Sydney session status, overlaps, time to next session, Asian range -- is this even a real liquid session for this pair right now?
- get_news: real upcoming economic-calendar events for this pair's currencies, high-impact count, news blackout window -- never approve into a real, imminent high-impact release blind.
- get_seasonality: most volatile hour of day, hourly average range, month/day-of-week context.
- get_macro: daily/weekly change, DXY/gold/USDJPY proxies, real risk-on/off regime.
- get_correlation: this pair vs. EURUSD/DXY proxy, risk-on/off, safe-haven status -- catches a setup that's really just correlated noise from another market.
- get_strength: currency strength differential for this pair's own base/quote, bias, strongest/weakest.
- get_heatmap: currency strength across all 8 majors -- broader real confirmation than get_strength alone.
- get_sentiment: a composite RSI+MACD+bull-bar% sentiment score, fear/greed-style label.
- get_regime: trending/ranging/transitional classification plus volatility regime and a suggested trading style -- a trend-following setup proposed inside a real ranging regime deserves real scrutiny.
- get_synthetic: Boom/Crash/Volatility synthetic-index spike detection (due/overdue, spike probability) -- only meaningful on synthetic-index symbols.

Use only what the proposed setup actually needs to genuinely verify -- you do not need to call all 44 on every review. Pick the handful that actually test the specific claim in Dave's reasoning (structure claim -> get_structure/get_order_blocks/get_inducement; momentum claim -> get_momentum/get_divergence; risk claim -> get_risk_metrics/get_volatility; timing claim -> get_session/get_news).`;

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
