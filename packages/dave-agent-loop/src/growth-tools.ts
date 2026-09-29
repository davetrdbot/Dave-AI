import type { DaveDatabase } from "@dave/db";
import {
  getGrowthGoals,
  setGrowthGoals,
  describeGoals,
  getStrategyState,
  currentVersion,
  describeChange,
  listNeurons,
  learnFact,
  forgetFact,
  reinforceFact,
  gradeStats,
  listGradedDecisions,
  describeVerdict,
} from "@dave/trading";
import { growthStatus, runGrowthReflection } from "./growth-reflection.js";
import { modelConfigProvider } from "./provider-selection.js";

/** Chat tools for the self-improvement loop: see it, feed the brain, reflect on demand. */
export function createGrowthTools(deps: { userId: string; db: DaveDatabase }) {
  const { userId } = deps;
  return [
    {
      name: "growth_status",
      description:
        "Your self-improvement state: the trader's goal (what success and failure mean), your score against it, the strategy card you're on (and the one variable under test), your rules, and the history of versions -- kept or undone.",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        const goals = getGrowthGoals(userId);
        const s = getStrategyState(userId);
        const st = growthStatus(userId);
        return {
          goals,
          definition: describeGoals(goals),
          score: st.score,
          testScore: st.testScore,
          stage: st.stage,
          cycle: { trades: st.tradesInCycle, of: st.tradesPerCycle },
          current: currentVersion(s),
          rules: s.rules,
          avoidSymbols: s.avoidSymbols,
          gradedCalls: {
            stats: gradeStats(userId),
            recent: listGradedDecisions(userId).filter((d) => d.status === "settled").slice(-10).map((d) => ({ symbol: d.symbol, action: d.action, verdict: describeVerdict(d), lesson: d.lesson })),
          },
          versions: s.versions.slice(-10).map((v) => ({ v: v.v, status: v.status, change: v.change ? describeChange(v.change) : null, hypothesis: v.hypothesis, score: v.score, baselineScore: v.baselineScore, note: v.verdictNote })),
        };
      },
    },
    {
      name: "brain_learn",
      description:
        "File one specific thing you learned into a neuron of your brain (rsi, macd, volatility, zones, structure, trend, momentum, liquidity, sessions, synthetic, news, risk, execution, psychology, or a new topic). " +
        "One reusable fact backed by evidence, e.g. 'Boom 1000 spikes cluster after 20+ quiet M1 candles'. Something you already know gets confirmed (stronger) instead of duplicated. " +
        "Pass `reinforce` with an existing fact id and supports:true/false to strengthen or weaken it; `forget` with an id to remove a wrong one.",
      parameters: {
        type: "object",
        properties: {
          neuron: { type: "string" },
          text: { type: "string" },
          evidence: { type: "string", description: "the trades/numbers behind it" },
          reinforce: { type: "string", description: "id of an existing fact to strengthen/weaken instead" },
          supports: { type: "boolean" },
          forget: { type: "string", description: "id of a fact to remove" },
        },
      },
      execute: async (args: Record<string, unknown>) => {
        if (typeof args.forget === "string") return { forgotten: forgetFact(userId, args.forget) };
        if (typeof args.reinforce === "string") return { fact: reinforceFact(userId, args.reinforce, args.supports !== false) };
        const r = learnFact(userId, String(args.neuron ?? ""), String(args.text ?? ""), { evidence: typeof args.evidence === "string" ? args.evidence : undefined, source: "dave" });
        return { neuron: r.neuron, fact: r.fact, isNew: r.isNew };
      },
    },
    {
      name: "brain_recall",
      description: "Read what your brain knows -- every neuron with its facts (ids, strength 1-5, confirmations), or one neuron by name.",
      parameters: { type: "object", properties: { neuron: { type: "string" } } },
      execute: async (args: Record<string, unknown>) => {
        const want = typeof args.neuron === "string" ? args.neuron.trim().toLowerCase() : "";
        const all = listNeurons(userId);
        const list = want ? all.filter((n) => n.id === want || n.label.toLowerCase() === want) : all.filter((n) => n.facts.length);
        return { neurons: list.map((n) => ({ id: n.id, label: n.label, facts: n.facts })) };
      },
    },
    {
      name: "reflect_now",
      description:
        "Run your self-improvement loop now instead of waiting for the cycle: judge the version under test if its cycle is done, then look at the outcome, file lessons into the brain, and change ONE variable. " +
        "Use when the trader asks you to review/improve yourself. It will refuse a new change while a test is still running (one variable at a time).",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        const r = await runGrowthReflection({ userId, provider: modelConfigProvider(deps.db, userId, () => undefined, "background"), force: true });
        return { ran: r.ran, message: r.message, skipped: r.skipped, newVersion: r.newVersion, learned: r.learned, judged: r.judged };
      },
    },
    {
      name: "set_growth_goals",
      description:
        "Change what success and failure mean -- ONLY when the trader asks. Fields: targetMonthlyReturnPct, minWinRatePct, minProfitFactor (success); maxDrawdownPct, maxLosingStreak, maxDailyLossPct (failure); tradesPerCycle; enabled.",
      parameters: {
        type: "object",
        properties: {
          targetMonthlyReturnPct: { type: "number" },
          minWinRatePct: { type: "number" },
          minProfitFactor: { type: "number" },
          maxDrawdownPct: { type: "number" },
          maxLosingStreak: { type: "number" },
          maxDailyLossPct: { type: "number" },
          tradesPerCycle: { type: "number" },
          enabled: { type: "boolean" },
        },
      },
      execute: async (args: Record<string, unknown>) => ({ goals: setGrowthGoals(userId, args) }),
    },
  ];
}
