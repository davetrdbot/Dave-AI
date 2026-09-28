import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Provider, ToolSpec } from "@dave/brain";
import { readClosedTradeHistory, getLastKnownAccountSnapshot } from "@dave/ea-bridge";
import { listJournalEntries } from "@dave/workers";
import {
  getGrowthGoals,
  getStrategyState,
  saveStrategyState,
  currentVersion,
  scoreAgainstGoals,
  describeGoals,
  validateChange,
  applyChange,
  changeStillInPlace,
  describeChange,
  learnFact,
  reinforceFact,
  listNeurons,
  topFacts,
  GROWTH_VARIABLES,
  getMinRiskReward,
  getConfidenceSettings,
  type GrowthScore,
  type GrowthStatusView,
  computeGrowthStatus,
  type ScoredTrade,
  type StrategyState,
  type StrategyVersion,
} from "@dave/trading";
import { publishActivity } from "./activity-bus.js";

/**
 * The loop from the trader's pictures, run for real:
 *
 *     Outcome  ->  Hypothesis  ->  Test (change ONE variable)  ->  Revise (keep or undo)
 *
 * It wakes after every closed trade and on a timer. Once a test cycle has its N closed trades, the
 * version under test is scored against the trader's goal and compared to the score it had to beat:
 * better or equal -> kept as the new baseline; worse -> the change is undone. Then (and only when
 * nothing is under test) Dave looks at the outcome, writes down what he learned into the brain's
 * neurons, forms one hypothesis and changes exactly one variable to test it.
 *
 * A failure limit breached mid-test (drawdown, losing streak, bad day) ends the test at once.
 */

const REFLECTION_TOOL = "submit_reflection";
/** Closed trades used for the "outcome" look when no test is running. */
const OUTCOME_WINDOW = 20;

export interface GrowthTrade extends ScoredTrade {
  ticket: string;
  side?: string;
  /** Why Dave opened it (from his journal), when known. */
  why?: string;
}

export function loadGrowthTrades(userId: string): GrowthTrade[] {
  const reasons = new Map<string, string>();
  try {
    for (const e of listJournalEntries(userId)) {
      if (e.input.ticket) reasons.set(String(e.input.ticket), [e.input.reasoning?.join("; "), e.input.sl ? `sl ${e.input.sl}` : "", e.input.tp ? `tp ${e.input.tp}` : "", `entry ${e.input.entryPrice}`].filter(Boolean).join(" · "));
    }
  } catch {
    /* no journal is fine */
  }
  return readClosedTradeHistory(userId)
    .filter((r) => typeof r.pnl === "number")
    .map((r) => ({ ticket: r.ticket, symbol: r.symbol, side: r.side, pnl: r.pnl as number, closedAt: r.closedAt, reason: r.reason, why: reasons.get(r.ticket)?.slice(0, 300) }))
    .sort((a, b) => a.closedAt - b.closedAt);
}

export type GrowthStatus = GrowthStatusView;

export function growthStatus(userId: string, now = Date.now()): GrowthStatus {
  return computeGrowthStatus(userId, loadGrowthTrades(userId), getLastKnownAccountSnapshot(userId)?.balance, now);
}

export interface ReflectionResult {
  ran: boolean;
  judged?: { version: number; kept: boolean; note: string };
  newVersion?: StrategyVersion;
  learned: { neuron: string; text: string; isNew: boolean }[];
  message?: string;
  skipped?: string;
}

function buildReflectionTool(): ToolSpec {
  return {
    name: REFLECTION_TOOL,
    description: "Submit your reflection on the last cycle: what happened, what you learned, and the ONE variable you'll change to test your hypothesis.",
    parameters: {
      type: "object",
      properties: {
        outcome: { type: "string", description: "2-3 sentences: what actually happened this cycle, measured against the goal -- numbers, not feelings." },
        diagnosis: { type: "string", description: "Why. Point at specific trades (ticket/symbol) and the pattern they share." },
        hypothesis: { type: "string", description: "One testable sentence: 'If I <change>, then <metric> will <improve>, because <reason>.'" },
        variable: { type: "string", enum: [...GROWTH_VARIABLES.map((v) => v.id), "none"], description: "The ONE thing to change. 'none' only if the current version is genuinely meeting the goal." },
        to: { type: ["string", "number"], description: "The new value: a number for min_rr/min_confidence, the rule sentence for add_rule, the rule id for remove_rule, the symbol for avoid_symbol/allow_symbol." },
        facts: {
          type: "array",
          maxItems: 6,
          description: "What you learned, filed into the brain's neurons. Each is ONE specific, reusable fact backed by these trades -- e.g. neuron 'rsi': 'On XAUUSD M15, RSI under 25 in a downtrend kept falling -- buying it lost 3 of 4 times.' Never vague ('be careful'), never a restatement of a rule.",
          items: {
            type: "object",
            properties: {
              neuron: { type: "string", description: "rsi, macd, volatility, zones, structure, trend, momentum, liquidity, sessions, synthetic, news, risk, execution, psychology -- or a new short topic" },
              text: { type: "string" },
              evidence: { type: "string", description: "the tickets / numbers behind it" },
            },
            required: ["neuron", "text"],
          },
        },
        reinforce: {
          type: "array",
          maxItems: 8,
          description: "Facts ALREADY in your brain (by id) that this cycle's trades agreed or disagreed with.",
          items: { type: "object", properties: { id: { type: "string" }, supports: { type: "boolean" } }, required: ["id", "supports"] },
        },
      },
      required: ["outcome", "diagnosis", "hypothesis", "variable"],
    },
  };
}

function fmtScore(s: GrowthScore): string {
  if (s.verdict === "no_data") return "no closed trades";
  const m = s.metrics;
  return `score ${s.score >= 0 ? "+" : ""}${s.score.toFixed(2)} (${s.verdict.replace("_", " ")}) -- ${m.trades} trades, win ${m.winRatePct?.toFixed(0) ?? "—"}%, PF ${m.profitFactor?.toFixed(2) ?? "—"}, net ${m.netPnl}, month ${m.monthlyReturnPct?.toFixed(1) ?? "—"}%, DD ${m.maxDrawdownPct?.toFixed(1) ?? "—"}%, worst streak ${m.longestLosingStreak}`;
}

function judge(userId: string, s: StrategyState, v: StrategyVersion, test: GrowthScore, reason: "cycle" | "failure", now: number): { kept: boolean; note: string } {
  if (!v.change) return { kept: true, note: "" };
  if (!changeStillInPlace(userId, s, v.change)) {
    v.status = "interrupted";
    v.judgedAt = now;
    v.score = test.score;
    v.verdictNote = "You changed this setting yourself during the test -- your value stands, the test is void.";
    return { kept: true, note: v.verdictNote };
  }
  const bar = v.baselineScore ?? 0;
  const kept = reason !== "failure" && test.score >= bar;
  v.status = kept ? "kept" : "reverted";
  v.score = test.score;
  v.judgedAt = now;
  v.verdictNote = kept
    ? `Kept: scored ${test.score.toFixed(2)} vs ${bar.toFixed(2)} before -- this is the new baseline.`
    : reason === "failure"
      ? `Undone early: a failure limit was hit during the test (${test.checks.filter((c) => c.kind === "failure" && !c.ok).map((c) => c.goal).join(", ")}).`
      : `Undone: scored ${test.score.toFixed(2)}, worse than ${bar.toFixed(2)} before.`;
  if (!kept) applyChange(userId, s, v.change, v.v, true);
  return { kept, note: v.verdictNote };
}

/**
 * One pass of the loop. `force` runs the reflection even if the cycle isn't full yet (the trader
 * pressed "Reflect now", or asked in chat).
 */
export async function runGrowthReflection(opts: { userId: string; provider: Provider; force?: boolean; now?: number }): Promise<ReflectionResult> {
  const { userId, provider } = opts;
  const now = opts.now ?? Date.now();
  const goals = getGrowthGoals(userId);
  if (!goals.enabled) return { ran: false, learned: [], skipped: "self-improvement is switched off" };
  const s = getStrategyState(userId, now);
  const trades = loadGrowthTrades(userId);
  const balance = getLastKnownAccountSnapshot(userId)?.balance;
  const result: ReflectionResult = { ran: false, learned: [] };
  let v = currentVersion(s);

  // ── REVISE: judge the version under test ──
  if (v.status === "testing") {
    const cycleTrades = trades.filter((t) => t.closedAt >= v.startedAt);
    const test = scoreAgainstGoals(cycleTrades, balance, goals, now);
    const failureHit = cycleTrades.length > 0 && test.checks.some((c) => c.kind === "failure" && !c.ok);
    if (cycleTrades.length >= goals.tradesPerCycle || failureHit) {
      const j = judge(userId, s, v, test, failureHit && cycleTrades.length < goals.tradesPerCycle ? "failure" : "cycle", now);
      result.judged = { version: v.v, kept: j.kept, note: j.note };
      s.cycle++;
      saveStrategyState(userId, s);
      publishActivity(userId, "background", "growth", { text: `🧪 v${pad(v.v)} ${describeChange(v.change!)} -- ${j.note}`, stage: "revise", version: v.v, kept: j.kept });
    } else if (!opts.force) {
      return { ...result, skipped: `testing v${pad(v.v)}: ${cycleTrades.length}/${goals.tradesPerCycle} trades so far` };
    } else {
      return { ...result, skipped: `v${pad(v.v)} is still under test (${cycleTrades.length}/${goals.tradesPerCycle} trades) -- one change at a time, so no new change until it's judged` };
    }
  }

  // ── OUTCOME: enough new trades since the last version started? ──
  v = currentVersion(s);
  const sinceVersion = trades.filter((t) => t.closedAt >= v.startedAt);
  if (!opts.force && sinceVersion.length < goals.tradesPerCycle) {
    if (result.judged) result.message = `🧪 Strategy v${pad(result.judged.version)}: ${result.judged.note}`;
    return { ...result, ran: !!result.judged, skipped: result.judged ? undefined : `${sinceVersion.length}/${goals.tradesPerCycle} trades since v${pad(v.v)}` };
  }
  const window = (sinceVersion.length >= 3 ? sinceVersion : trades).slice(-OUTCOME_WINDOW);
  if (!window.length) return { ...result, skipped: "no closed trades to learn from yet" };
  const score = scoreAgainstGoals(window, balance, goals, now);

  // ── HYPOTHESIS: ask Dave ──
  const d = describeGoals(goals);
  const neurons = listNeurons(userId).filter((n) => n.facts.length);
  const history = s.versions.slice(-6).map((x) => `v${pad(x.v)} ${x.status}${x.change ? ` (${describeChange(x.change)})` : ""}${x.verdictNote ? ` -- ${x.verdictNote}` : ""}${x.hypothesis ? ` | hypothesis: ${x.hypothesis}` : ""}`);
  const user = [
    `THE GOAL. Success = ${d.success.join("; ")}. Failure = ${d.failure.join("; ")}.`,
    `Per trade, a SUCCESS is: ${d.perTrade.success.join("; ")}. A FAILURE is: ${d.perTrade.failure.join("; ")}.`,
    `THIS CYCLE'S OUTCOME: ${fmtScore(score)}.`,
    `Goal checks: ${score.checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.goal} (${c.value})`).join("; ")}.`,
    `TRADES (oldest first):\n${window.map((t) => `#${t.ticket} ${t.symbol} ${t.side ?? ""} ${t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(2)} closed by ${t.reason ?? "?"} ${new Date(t.closedAt).toISOString().slice(0, 16)}${t.why ? ` | why opened: ${t.why}` : ""}`).join("\n")}`,
    `CURRENT SETTINGS: min R:R ${getMinRiskReward(userId)} (trader's floor ${s.floors.minRiskReward}), confidence bar ${getConfidenceSettings(userId).threshold}% (trader's floor ${s.floors.minConfidence}%).`,
    s.rules.length ? `YOUR RULES: ${s.rules.map((r) => `[${r.id}] ${r.text}`).join(" | ")}` : "YOUR RULES: none yet.",
    s.avoidSymbols.length ? `PAIRS LEFT ALONE: ${s.avoidSymbols.map((a) => a.symbol).join(", ")}` : "",
    `STRATEGY HISTORY (what was tried and how it went -- don't repeat a change that was already undone unless something is genuinely different):\n${history.join("\n")}`,
    neurons.length ? `YOUR BRAIN (facts by neuron, with ids):\n${neurons.map((n) => `${n.label}: ${n.facts.map((f) => `[${f.id}] ${f.text} (strength ${f.strength})`).join(" | ")}`).join("\n")}` : "YOUR BRAIN: empty so far -- this is your first chance to fill it.",
    `VARIABLES YOU MAY CHANGE (exactly ONE): ${GROWTH_VARIABLES.map((x) => `${x.id} = ${x.explain}`).join("; ")}.`,
  ].filter(Boolean);
  const system =
    "You are Dave, a trading agent reviewing your own results like a scientist. Change ONE variable at a time so the next cycle shows whether it worked. " +
    "Measure against the trader's goal, not against feelings. Blame the process, not luck: find the pattern shared by the losers (or the winners). " +
    "Pick the single change most likely to move the weakest goal check. Keep what works. Write facts that will help you on a future scan -- specific pair, timeframe, indicator reading, session, outcome.";
  const res = await provider.generate({ messages: [{ role: "system", content: system }, { role: "user", content: user.join("\n\n") }], tools: [buildReflectionTool()], toolChoice: { name: REFLECTION_TOOL } }, 90_000);
  const args = res.toolCalls?.find((c) => c.name === REFLECTION_TOOL)?.arguments as Record<string, unknown> | undefined;
  if (!args) return { ...result, skipped: "the model didn't return a reflection" };
  result.ran = true;

  // Brain first -- facts are kept even if the proposed change is refused.
  for (const f of Array.isArray(args.facts) ? (args.facts as Record<string, unknown>[]).slice(0, 6) : []) {
    try {
      const r = learnFact(userId, String(f.neuron ?? ""), String(f.text ?? ""), { evidence: typeof f.evidence === "string" ? f.evidence : undefined, source: "reflection" }, now);
      result.learned.push({ neuron: r.neuron, text: r.fact.text, isNew: r.isNew });
    } catch {
      /* a malformed fact is dropped */
    }
  }
  for (const r of Array.isArray(args.reinforce) ? (args.reinforce as Record<string, unknown>[]).slice(0, 8) : []) {
    if (typeof r.id === "string") reinforceFact(userId, r.id, r.supports === true, now);
  }

  // ── TEST: apply exactly one change ──
  const variable = String(args.variable ?? "none");
  let changeNote = "No change this cycle -- the current version is holding up.";
  if (variable !== "none") {
    try {
      const change = validateChange(userId, s, variable, args.to);
      const nextV = s.versions.length ? Math.max(...s.versions.map((x) => x.v)) + 1 : 1;
      applyChange(userId, s, change, nextV);
      const version: StrategyVersion = {
        v: nextV,
        createdAt: now,
        status: "testing",
        change,
        outcome: String(args.outcome ?? "").slice(0, 600),
        hypothesis: String(args.hypothesis ?? "").slice(0, 400),
        baselineScore: score.score,
        startedAt: now,
        startedAtTrade: trades.length,
      };
      s.versions.push(version);
      result.newVersion = version;
      changeNote = `New version v${pad(nextV)}: ${describeChange(change)}. Testing it over the next ${goals.tradesPerCycle} closed trades.`;
    } catch (err) {
      changeNote = `Proposed change refused (${err instanceof Error ? err.message : String(err)}) -- carrying on with the current version.`;
    }
  }
  s.lastReflectionAt = now;
  s.lastReflectionTrades = trades.length;
  // A reflection that changed nothing still closes the "outcome" cycle, so the next one needs
  // fresh trades rather than re-reading the same ones.
  if (!result.newVersion) {
    const cur = currentVersion(s);
    if (cur.status !== "testing") cur.startedAt = now;
  }
  saveStrategyState(userId, s);

  const text = [
    `🪞 Reflection (cycle ${s.cycle}) -- ${fmtScore(score)}`,
    result.judged ? `🧪 v${pad(result.judged.version)}: ${result.judged.note}` : null,
    `📋 ${String(args.outcome ?? "").slice(0, 400)}`,
    `🔎 ${String(args.diagnosis ?? "").slice(0, 400)}`,
    `💡 ${String(args.hypothesis ?? "").slice(0, 300)}`,
    `⚙️ ${changeNote}`,
    result.learned.length ? `🧠 Learned: ${result.learned.map((l) => `${l.neuron} -- ${l.text}${l.isNew ? "" : " (confirmed)"}`).join(" | ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  result.message = text;
  publishActivity(userId, "background", "growth", { text, stage: result.newVersion ? "test" : "outcome", version: result.newVersion?.v });
  return result;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Facts relevant to one scan: the strongest overall, for the prompt. */
export function brainLine(userId: string, max = 8): string | null {
  const f = topFacts(userId, max);
  return f.length ? f.map((x) => `${x.neuron}: ${x.fact.text}`).join(" | ") : null;
}

/** The app drops this file to ask for a reflection now (the admin panel can't reach the model). */
export function reflectRequestPath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "trading", userId, "growth", "reflect-request.json");
}

export function takeReflectRequest(userId: string): boolean {
  const p = reflectRequestPath(userId);
  if (!existsSync(p)) return false;
  try {
    readFileSync(p, "utf8");
  } finally {
    rmSync(p, { force: true });
  }
  return true;
}

/**
 * Wires the loop into the running bot: a check after every closed trade (debounced) and every 30
 * minutes, plus the app's "Reflect now" request (polled every 20 s). Returns a stop function.
 */
export function startGrowthLoop(opts: { userId: string; provider: () => Provider; onMessage: (text: string) => void }): { onTradeClosed: () => void; stop: () => void } {
  let running = false;
  const run = async (force: boolean) => {
    if (running) return;
    running = true;
    try {
      const r = await runGrowthReflection({ userId: opts.userId, provider: opts.provider(), force });
      if (r.message) opts.onMessage(r.message);
      else if (force && r.skipped) {
        publishActivity(opts.userId, "background", "growth", { text: `🪞 ${r.skipped}`, stage: "outcome" });
        opts.onMessage(`🪞 ${r.skipped}`);
      }
      if (r.skipped) console.log(`[growth] ${opts.userId}: ${r.skipped}`);
    } catch (err) {
      console.warn(`[growth] ${opts.userId}: reflection failed -- ${err instanceof Error ? err.message : String(err)}`);
      if (force) {
        const text = `🪞 Couldn't reflect right now: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`;
        publishActivity(opts.userId, "background", "growth", { text, stage: "outcome" });
        opts.onMessage(text);
      }
    } finally {
      running = false;
    }
  };
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const timer = setInterval(() => void run(false), 30 * 60_000);
  timer.unref();
  const poll = setInterval(() => {
    if (takeReflectRequest(opts.userId)) void run(true);
  }, 20_000);
  poll.unref();
  return {
    onTradeClosed: () => {
      if (debounce) clearTimeout(debounce);
      // A few seconds' grace so a batch of closes (a basket, a partial + close) counts as one.
      debounce = setTimeout(() => void run(false), 15_000);
      debounce.unref();
    },
    stop: () => {
      clearInterval(timer);
      clearInterval(poll);
      if (debounce) clearTimeout(debounce);
    },
  };
}
