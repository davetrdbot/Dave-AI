import type { Provider, ToolSpec } from "@dave/brain";
import { getLastKnownState } from "@dave/ea-bridge";
import { breakevenStop, getSelfAwareMode, type TradeExecutor } from "@dave/trading";
import { holdOrClose, protectInstead } from "./hold-to-plan.js";
import { parseCandles, type AnalysisLike } from "./decision-grading.js";
import { activeAiOutage } from "./ai-outage.js";
import { rMultiple, slProgress, type MonitorAlertKind, type TradeMonitor } from "./trade-monitor-store.js";
import { exitRuleFor, describeExitRule, setExitRule } from "./exit-rules.js";
import { alertKindStats, recordVerdict } from "./alert-outcomes.js";

/**
 * Self-aware v2: when an alert that calls for a decision fires, Dave actually makes one.
 *
 * Before, an alert went to the trader and sat in Dave's context until his next scan or chat turn --
 * with autonomous trading off, nothing ever answered it. Now he reviews the trade on the spot: the
 * original idea against fresh M5/M15 candles, where it stands in R, what his own history says about
 * trades that hit this alert, and returns one verdict -- HOLD, BREAKEVEN, TIGHTEN_STOP, PARTIAL_CLOSE,
 * CLOSE or EXIT_RULE -- with the evidence.
 *
 * What happens with it is the trader's setting (getSelfAwareMode): "advise" (default) only says it;
 * "act" carries out the protective ones. The rules below are enforced here, not left to the model:
 * a stop only ever tightens, breakeven only on a trade in profit, a partial leaves something
 * running, and a full close needs the idea judged BROKEN -- discomfort is not a reason.
 */

/** The alerts that deserve a decision. Pure information (tpNear, profitStable...) doesn't. */
export const REVIEW_KINDS = new Set<MonitorAlertKind>([
  // In profit for a while: is the plan still valid, should the profit be protected?
  "profitStable",
  "quickProfitCheck",
  "loss10m",
  "deepLoss",
  "slDanger",
  "slNear",
  "slLevel",
  "range",
  "stuck",
  "roundTrip",
  "neverGreen",
  "racing",
  "profitDrop",
  "peakPullback",
  "noStop",
]);

export const REVIEW_TICKET_COOLDOWN_MS = 10 * 60_000;
export const REVIEW_MAX_PER_HOUR = 6;

export type Verdict = "HOLD" | "BREAKEVEN" | "TIGHTEN_STOP" | "PARTIAL_CLOSE" | "CLOSE" | "EXIT_RULE";
// No BREAKEVEN here: the trader never wants the self-aware review to jump the stop to breakeven
// on its own -- Dave trails it behind structure himself (TIGHTEN_STOP to a real level).
const VERDICTS: Verdict[] = ["HOLD", "TIGHTEN_STOP", "PARTIAL_CLOSE", "CLOSE", "EXIT_RULE"];

export interface VerdictArgs {
  verdict: Verdict;
  thesis: "intact" | "weakened" | "broken";
  confidence: number;
  reason: string;
  changeMind?: string;
  newSl?: number;
  partialPercent?: number;
  closeAtProfit?: number;
  closeAtLoss?: number;
}

const TOOL = "self_aware_verdict";

function verdictTool(): ToolSpec {
  return {
    name: TOOL,
    description: "Your verdict on this open trade, right now.",
    parameters: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: VERDICTS },
        thesis: { type: "string", enum: ["intact", "weakened", "broken"], description: "the ORIGINAL idea, judged against the candles" },
        confidence: { type: "number", description: "0-100" },
        reason: { type: "string", description: "1-2 sentences of evidence from the candles/levels -- prices, not feelings" },
        changeMind: { type: "string", description: "for HOLD: the price or event that would make you act" },
        newSl: { type: "number", description: "TIGHTEN_STOP: the new stop (must be tighter than the current one)" },
        partialPercent: { type: "number", description: "PARTIAL_CLOSE: 10-90" },
        closeAtProfit: { type: "number", description: "EXIT_RULE: close when P/L recovers to this (money; 0 = breakeven)" },
        closeAtLoss: { type: "number", description: "EXIT_RULE: close if P/L falls to this loss (money)" },
      },
      required: ["verdict", "thesis", "confidence", "reason"],
    },
  };
}

export interface ReviewDeps {
  userId: string;
  provider: () => Provider | undefined;
  analysis: AnalysisLike;
  executor?: TradeExecutor;
  notify: (text: string) => Promise<void>;
}

const lastByTicket = new Map<string, number>();
const recentByUser = new Map<string, number[]>();
const inFlight = new Set<string>();

/** Whether a review may run now for this trade (cooldown per trade, cap per hour, no outage). */
export function reviewAllowed(userId: string, ticket: string, now = Date.now()): boolean {
  if (getSelfAwareMode(userId) === "off") return false;
  if (activeAiOutage(userId, now)) return false;
  const key = `${userId}:${ticket}`;
  if (inFlight.has(key)) return false;
  const last = lastByTicket.get(key);
  if (last !== undefined && now - last < REVIEW_TICKET_COOLDOWN_MS) return false;
  const recent = (recentByUser.get(userId) ?? []).filter((t) => now - t < 3_600_000);
  recentByUser.set(userId, recent);
  return recent.length < REVIEW_MAX_PER_HOUR;
}

/** Test seam. */
export function resetReviewLimits(): void {
  lastByTicket.clear();
  recentByUser.clear();
  inFlight.clear();
}

const capitalize = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const r2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(2)}`;

function candleRows(raw: unknown, n: number): string {
  const { bars, atr } = parseCandles(raw);
  if (!bars.length) return "(no candles)";
  const rows = bars.slice(-n).map((b) => `${new Date(b.t).toISOString().slice(11, 16)} ${b.o} ${b.h} ${b.l} ${b.c}`);
  return `${atr ? `ATR~${r2(atr)}\n` : ""}time o h l c\n${rows.join("\n")}`;
}

/** The checks the model's answer must pass before anything is touched. */
export function checkVerdict(
  v: VerdictArgs,
  pos: { type: "buy" | "sell"; lots: number; openPrice: number; sl?: number; currentPrice?: number; pnl?: number },
  mode: "advise" | "act"
): { act: boolean; problem?: string } {
  const price = pos.currentPrice;
  const sl = pos.sl && pos.sl > 0 ? pos.sl : undefined;
  switch (v.verdict) {
    case "HOLD":
      return { act: false };
    case "BREAKEVEN": {
      return { act: false, problem: "the self-aware review never moves a stop to breakeven by itself -- trail it behind structure instead" };
    }
    case "TIGHTEN_STOP": {
      const n = v.newSl;
      if (typeof n !== "number" || !Number.isFinite(n) || price === undefined) return { act: false, problem: "no valid new stop given" };
      const rightSide = pos.type === "buy" ? n < price : n > price;
      if (!rightSide) return { act: false, problem: `a stop at ${n} would be on the wrong side of price ${price}` };
      const tighter = sl === undefined || (pos.type === "buy" ? n > sl : n < sl);
      // The trader: "when the self-aware alert hits on the SL it can extend the SL" -- allowed once
      // the idea is still valid, to the real invalidation (FMD), but never past double the stop's
      // current distance from the entry.
      if (!tighter && sl !== undefined && Math.abs(n - pos.openPrice) > 2 * Math.abs(sl - pos.openPrice)) return { act: false, problem: `${n} would more than double the stop's distance -- too far` };
      return { act: mode === "act" };
    }
    case "PARTIAL_CLOSE": {
      const pct = v.partialPercent;
      if (typeof pct !== "number" || pct < 10 || pct > 90) return { act: false, problem: "a partial must be 10-90%" };
      const lots = Math.floor(pos.lots * (pct / 100) * 100) / 100;
      if (lots < 0.01 || lots >= pos.lots) return { act: false, problem: `${pos.lots} lots can't be split at ${pct}%` };
      return { act: mode === "act" };
    }
    case "CLOSE": {
      // Banking a winner is allowed; a loser is held to its stop anyway (hold-to-plan.ts).
      const green = price !== undefined && (pos.type === "buy" ? price > pos.openPrice : price < pos.openPrice);
      if (!green && v.thesis !== "broken") return { act: false, problem: "a losing trade stays open to its stop -- so this stays a suggestion" };
      return { act: mode === "act" };
    }
    case "EXIT_RULE":
      if (typeof v.closeAtProfit !== "number" && typeof v.closeAtLoss !== "number") return { act: false, problem: "no exit levels given" };
      return { act: mode === "act" };
  }
}

function describeVerdictAction(v: VerdictArgs, lots: number): string {
  switch (v.verdict) {
    case "HOLD":
      return "hold";
    case "BREAKEVEN":
      return "move the stop to breakeven";
    case "TIGHTEN_STOP":
      return `tighten the stop to ${v.newSl}`;
    case "PARTIAL_CLOSE":
      return `close ${v.partialPercent}% (${Math.floor(lots * ((v.partialPercent ?? 0) / 100) * 100) / 100} lots)`;
    case "CLOSE":
      return "close it";
    case "EXIT_RULE":
      return `arm an exit rule (${[typeof v.closeAtProfit === "number" ? `close at ${v.closeAtProfit === 0 ? "breakeven" : money(v.closeAtProfit)}` : null, typeof v.closeAtLoss === "number" ? `cut at ${-Math.abs(v.closeAtLoss)}` : null].filter(Boolean).join(", ")})`;
  }
}

/**
 * Reviews one trade. Resolves with the message it sent (or null when it didn't run). Never throws.
 * `alertKinds` are the kinds that fired this sweep; `alertText` is the message the trader just got.
 */
export async function reviewTrade(deps: ReviewDeps, m: TradeMonitor, alertKinds: MonitorAlertKind[], alertText: string, now = Date.now()): Promise<string | null> {
  const { userId } = deps;
  const key = `${userId}:${m.ticket}`;
  if (!reviewAllowed(userId, m.ticket, now)) return null;
  const provider = deps.provider();
  if (!provider) return null;
  const mode = getSelfAwareMode(userId);
  if (mode === "off") return null;
  inFlight.add(key);
  lastByTicket.set(key, now);
  recentByUser.set(userId, [...(recentByUser.get(userId) ?? []), now]);
  try {
    const pos = getLastKnownState(userId).positions.find((p) => String(p.ticket) === m.ticket);
    if (!pos) return null;
    const price = pos.currentPrice;
    const rNow = price !== undefined ? rMultiple(m, price) : undefined;
    const toStop = price !== undefined ? slProgress(m, price) : undefined;
    const [m5, m15] = await Promise.all(
      ["M5", "M15"].map((tf) => deps.analysis.get<unknown>("candles", m.symbol, tf, { timeoutMs: 30_000 }).then((raw) => candleRows(raw, 24)).catch(() => "(candles unavailable)"))
    );
    const history = alertKinds
      .map((k) => alertKindStats(userId, k, undefined, now))
      .filter((s): s is NonNullable<typeof s> => !!s && s.n >= 3)
      .map((s) => `- after "${s.kind}": ${s.n} trades, ${s.closedGreenPct}% still closed green, holding averaged ${money(s.avgChangeAfter)}`);
    const verdictHistory = VERDICTS.map((v) => alertKindStats(userId, `verdict:${v}`, undefined, now))
      .filter((s): s is NonNullable<typeof s> => !!s && s.n >= 3)
      .map((s) => `- your ${s.kind.slice(8)} calls: ${s.n}, ${s.closedGreenPct}% of those trades closed green`);
    const rule = exitRuleFor(userId, m.ticket);
    const status = [
      `${m.symbol} ${m.direction.toUpperCase()} #${m.ticket}, ${pos.lots} lots, entry ${m.openPrice}, stop ${pos.sl && pos.sl > 0 ? pos.sl : "NONE"}${m.initialSl !== undefined && m.initialSl !== pos.sl ? ` (first stop ${m.initialSl})` : ""}, target ${pos.tp && pos.tp > 0 ? pos.tp : "none"}`,
      `Now: price ${price ?? "?"}, P/L ${pos.pnl ?? "?"}${rNow !== undefined ? `, ${rNow}R` : ""}${toStop !== undefined ? `, ${Math.round(toStop * 100)}% of the way to the stop` : ""}`,
      `Open ${Math.round((now - m.openedAt) / 60_000)} min; best ${m.mfeR ?? "?"}R (${m.bestPnl ?? "?"}), worst ${m.maeR ?? "?"}R (${m.worstPnl ?? "?"})`,
      rule ? `Exit rule armed: ${describeExitRule(rule)}` : "No exit rule armed.",
    ].join("\n");
    const res = await provider.generate(
      {
        messages: [
          {
            role: "system",
            content:
              "You are Dave, a trading agent, reviewing one of YOUR OWN open trades because your trade monitor raised an alert. " +
              "Judge the ORIGINAL idea against what price is doing now in the candles -- structure, the levels the idea depended on, momentum. " +
              "Rules: you may extend (widen) a stop ONCE when the alert is about the stop and the idea is still valid -- to the real invalidation point (the furthest-most deviation), never past double its distance. HOLD is a real answer when the structure still supports the idea -- then name the price that would change your mind. " +
              "A LOSING trade is never closed -- the stop is its invalidation. A trade IN PROFIT may be closed (CLOSE) when the move is done: it reached an FTA / opposing area of liquidity, momentum died, or it is giving the profit back -- bank it rather than let a winner turn into a loss. " +
              "Your tools: HOLD, TIGHTEN_STOP (trail the stop behind a real structure level, or extend it once on a stop alert -- never jump it to breakeven), CLOSE (winners only). The market deceives: a pullback is not a broken idea. " +
              "Use your history numbers: if most trades that hit this alert still closed green, cutting needs a strong reason. Evidence = prices from the candles.",
          },
          {
            role: "user",
            content: [
              `ALERT (just sent to the trader):\n${alertText}`,
              `TRADE:\n${status}`,
              `ORIGINAL IDEA: ${m.reason}`,
              history.length ? `YOUR HISTORY after these alerts:\n${history.join("\n")}` : "",
              verdictHistory.length ? `YOUR PAST VERDICTS:\n${verdictHistory.join("\n")}` : "",
              `M5 candles (newest last):\n${m5}`,
              `M15 candles (newest last):\n${m15}`,
            ]
              .filter(Boolean)
              .join("\n\n"),
          },
        ],
        tools: [verdictTool()],
        toolChoice: { name: TOOL },
      },
      90_000
    );
    const raw = res.toolCalls?.find((c) => c.name === TOOL)?.arguments as Partial<VerdictArgs> | undefined;
    if (!raw || !VERDICTS.includes(raw.verdict as Verdict) || typeof raw.reason !== "string") return null;
    const v: VerdictArgs = {
      verdict: raw.verdict as Verdict,
      thesis: raw.thesis === "broken" || raw.thesis === "weakened" ? raw.thesis : "intact",
      confidence: Math.max(0, Math.min(100, Math.round(Number(raw.confidence) || 0))),
      reason: raw.reason.replace(/\s+/g, " ").trim().slice(0, 400),
      changeMind: typeof raw.changeMind === "string" ? raw.changeMind.replace(/\s+/g, " ").trim().slice(0, 200) : undefined,
      newSl: typeof raw.newSl === "number" ? raw.newSl : undefined,
      partialPercent: typeof raw.partialPercent === "number" ? raw.partialPercent : undefined,
      closeAtProfit: typeof raw.closeAtProfit === "number" ? raw.closeAtProfit : undefined,
      closeAtLoss: typeof raw.closeAtLoss === "number" ? raw.closeAtLoss : undefined,
    };
    const check = checkVerdict(v, pos, mode === "act" ? "act" : "advise");
    let outcome = "";
    if (check.act) {
      outcome = await carryOut(deps, v, pos);
    } else if (v.verdict !== "HOLD") {
      outcome = check.problem
        ? `⚠️ Not done: ${check.problem}.`
        : `👉 Suggestion only -- tell me "do it", or set Self-aware reviews to Act in settings to let me handle these myself.`;
    }
    recordVerdict(userId, { ticket: m.ticket, symbol: m.symbol, verdict: v.verdict, at: now, pnl: pos.pnl });
    const head = `🧠 SELF-REVIEW -- ${m.symbol} ${m.direction.toUpperCase()} #${m.ticket}${rNow !== undefined ? ` (${rNow}R)` : ""}`;
    const text = [
      head,
      `Verdict: ${capitalize(describeVerdictAction(v, pos.lots))} -- idea ${v.thesis} (${v.confidence}%)`,
      v.reason,
      v.verdict === "HOLD" && v.changeMind ? `I'd act if: ${v.changeMind}` : "",
      outcome,
    ]
      .filter(Boolean)
      .join("\n");
    await deps.notify(text);
    return text;
  } catch (err) {
    console.warn(`[self-aware] ${userId}: review of #${m.ticket} failed -- ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    inFlight.delete(key);
  }
}

async function carryOut(deps: ReviewDeps, v: VerdictArgs, pos: { ticket: string; symbol?: string; type?: string; lots: number; openPrice: number; currentPrice?: number; sl?: number; tp?: number; spread?: number; digits?: number; stopsLevel?: number }): Promise<string> {
  const ex = deps.executor;
  try {
    switch (v.verdict) {
      case "BREAKEVEN":
        if (!ex) return "⚠️ Couldn't act: no connection to MT5.";
      {
        // True breakeven: past the entry by the spread, so a hit closes at 0.00, not -spread.
        const be = breakevenStop({ side: String(pos.type ?? "buy").toLowerCase().startsWith("sell") ? "sell" : "buy", openPrice: pos.openPrice, currentPrice: pos.currentPrice, spread: pos.spread, digits: pos.digits, stopsLevel: pos.stopsLevel });
        const level = be.ok ? be.level : pos.openPrice;
        await ex.modifyOrder(pos.ticket, { sl: level });
        return `✅ Done: stop moved to breakeven (${level}).`;
      }
      case "TIGHTEN_STOP":
        if (!ex) return "⚠️ Couldn't act: no connection to MT5.";
        await ex.modifyOrder(pos.ticket, { sl: v.newSl });
        return `✅ Done: stop tightened to ${v.newSl}.`;
      case "PARTIAL_CLOSE":
      case "CLOSE":
        if (!ex) return "⚠️ Couldn't act: no connection to MT5.";
        {
          // Hold to the plan: no fear exits before the stop (hold-to-plan.ts).
          const hold = holdOrClose({ ...pos, symbol: pos.symbol ?? "", type: pos.type ?? "buy" });
          if (!hold.close) {
            const note = hold.inProfit ? ` ${await protectInstead(ex, { ...pos, symbol: pos.symbol ?? "", type: pos.type ?? "buy" })}.` : "";
            return `✋ Held, not closed: ${hold.why}.${note}`;
          }
        }
        if (v.verdict === "PARTIAL_CLOSE") {
          const lots = Math.floor(pos.lots * ((v.partialPercent ?? 0) / 100) * 100) / 100;
          await ex.closePosition(pos.ticket, lots);
          return `✅ Done: banked ${lots} of ${pos.lots} lots.`;
        }
        await ex.closePosition(pos.ticket);
        return "✅ Done: closed in profit.";
      case "EXIT_RULE": {
        // The trader (3 Oct): Dave manages exits himself -- an exit at a price or P/L is his tool.
        const rule = setExitRule(deps.userId, { ticket: pos.ticket, closeAtProfit: v.closeAtProfit, closeAtLoss: v.closeAtLoss, note: `self-review: ${v.reason.slice(0, 150)}` });
        return `✅ Done: exit rule armed -- ${describeExitRule(rule)}.`;
      }
      default:
        return "";
    }
  } catch (err) {
    return `⚠️ Tried, but it failed: ${err instanceof Error ? err.message : String(err)}.`;
  }
}
