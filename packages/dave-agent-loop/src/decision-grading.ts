import type { Provider, ToolSpec } from "@dave/brain";
import {
  pendingDueDecisions,
  lessonsOwed,
  gradeDecision,
  settleDecision,
  describeVerdict,
  learnFact,
  getMinRiskReward,
  type GradeBar,
  type GradedDecision,
} from "@dave/trading";
import { publishActivity } from "./activity-bus.js";

/**
 * Settles Dave's pending calls (decision-grades.ts): pulls the candles since each decision, grades
 * it, and asks for a one-line lesson on the ones that went wrong -- a skip that missed a clean move,
 * or an entry that hit its stop first. Lessons are filed into the brain's neurons.
 *
 * Bounded on purpose: a few pairs per run (each is one EA request), one model call for all lessons.
 */

const MAX_SYMBOLS_PER_RUN = 6;
const M15 = 15 * 60_000;
const H1 = 60 * 60_000;
/** M15 candles from the EA cover ~5h; H1 ~21h. Older than that can no longer be graded. */
const M15_REACH_MS = 4.5 * 3_600_000;
const H1_REACH_MS = 19 * 3_600_000;

export interface AnalysisLike {
  get<T>(endpoint: string, symbol: string, timeframe: string, opts?: { timeoutMs?: number }): Promise<T>;
}

/** The EA's candles payload -> bars (oldest first) + ATR (from each bar's size_vs_atr). */
export function parseCandles(raw: unknown): { bars: GradeBar[]; atr: number } {
  const list = (Array.isArray(raw) ? raw : ((raw as { candles?: unknown })?.candles ?? (raw as { data?: unknown })?.data)) as unknown;
  const arr = Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
  const bars: GradeBar[] = [];
  const atrs: number[] = [];
  for (const c of arr) {
    const t = Date.parse(String(c.t ?? c.time ?? ""));
    const o = Number(c.o), h = Number(c.h), l = Number(c.l), cl = Number(c.c);
    if (!Number.isFinite(t) || ![o, h, l, cl].every(Number.isFinite)) continue;
    bars.push({ t, o, h, l, c: cl });
    const rel = Number(c.size_vs_atr);
    if (rel > 0.05) atrs.push((h - l) / rel);
  }
  atrs.sort((a, b) => a - b);
  return { bars: bars.sort((a, b) => a.t - b.t), atr: atrs.length ? atrs[Math.floor(atrs.length / 2)] : 0 };
}

const LESSON_TOOL = "submit_lessons";

function lessonTool(): ToolSpec {
  return {
    name: LESSON_TOOL,
    description: "One short, specific lesson per graded call.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              lesson: { type: "string", description: "1-2 sentences: what the reason missed and what to check next time on this pair. Specific, never 'be careful'." },
              neuron: { type: "string", description: "rsi, macd, volatility, zones, structure, trend, momentum, liquidity, sessions, synthetic, news, risk, execution, psychology" },
            },
            required: ["id", "lesson", "neuron"],
          },
        },
      },
      required: ["items"],
    },
  };
}

export interface GradingResult {
  settled: GradedDecision[];
  expired: number;
  lessons: number;
}

export async function settleDueDecisions(opts: { userId: string; analysis: AnalysisLike; provider?: Provider; now?: number }): Promise<GradingResult> {
  const { userId, analysis } = opts;
  const now = opts.now ?? Date.now();
  const due = pendingDueDecisions(userId, now);
  const result: GradingResult = { settled: [], expired: 0, lessons: 0 };
  const owed = lessonsOwed(userId, now);
  if (!due.length && !(opts.provider && owed.length)) return result;
  const rr = Math.min(3, Math.max(1, getMinRiskReward(userId)));

  // Too old to grade from the EA's candle depth.
  for (const d of due.filter((x) => now - x.at > H1_REACH_MS)) {
    settleDecision(userId, d.id, { status: "expired" }, now);
    result.expired++;
  }
  const live = due.filter((x) => now - x.at <= H1_REACH_MS);
  const bySymbol = new Map<string, GradedDecision[]>();
  for (const d of live) bySymbol.set(d.symbol, [...(bySymbol.get(d.symbol) ?? []), d]);

  for (const [symbol, items] of [...bySymbol.entries()].slice(0, MAX_SYMBOLS_PER_RUN)) {
    const oldest = Math.min(...items.map((d) => d.at));
    const useM15 = now - oldest <= M15_REACH_MS;
    let parsed: { bars: GradeBar[]; atr: number };
    try {
      parsed = parseCandles(await analysis.get<unknown>("candles", symbol, useM15 ? "M15" : "H1", { timeoutMs: 45_000 }));
    } catch (err) {
      console.warn(`[grading] ${userId}: candles for ${symbol} failed -- ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const d of items) {
      const g = gradeDecision(d, parsed.bars, parsed.atr, rr, useM15 ? M15 : H1);
      if (!g) continue;
      settleDecision(userId, d.id, { ...g, status: "settled" }, now);
      result.settled.push({ ...d, ...g, status: "settled" });
    }
  }

  // Lessons for the calls that went wrong.
  const fresh = result.settled.filter((d) => d.verdict === "missed_long" || d.verdict === "missed_short" || d.verdict === "bad_call");
  // Owed ones first (they've waited), then this run's. Every one is marked owed until its lesson
  // is actually written -- a failed model call no longer loses it for good.
  for (const d of fresh) settleDecision(userId, d.id, { lessonPending: true }, now);
  const notable = [...owed.filter((o) => !fresh.some((f) => f.id === o.id)), ...fresh].slice(0, 6);
  if (opts.provider && notable.length) {
    try {
      const user = notable
        .map((d) => `[${d.id}] ${d.symbol} ${d.action} at ${new Date(d.at).toISOString().slice(0, 16)} (confidence ${d.confidence ?? "?"}%). Your reason then: "${d.reason}". What happened in the next 2h: ${describeVerdict(d)}; price went up ${d.upAtr} ATR and down ${d.downAtr} ATR from ${d.refPrice}.`)
        .join("\n");
      const res = await opts.provider.generate(
        {
          messages: [
            { role: "system", content: "You are Dave, a trading agent, grading your own recent calls against what price did next. For each, write the lesson that would have changed the call. Specific to the pair and the reading -- no generic advice." },
            { role: "user", content: user },
          ],
          tools: [lessonTool()],
          toolChoice: { name: LESSON_TOOL },
        },
        60_000
      );
      const items = ((res.toolCalls?.find((c) => c.name === LESSON_TOOL)?.arguments as { items?: { id: string; lesson: string; neuron: string }[] })?.items ?? []).slice(0, 6);
      for (const it of items) {
        const d = notable.find((x) => x.id === it.id);
        if (!d || typeof it.lesson !== "string" || it.lesson.trim().length < 8) continue;
        const lesson = it.lesson.replace(/\s+/g, " ").trim().slice(0, 300);
        settleDecision(userId, d.id, { lesson, neuron: it.neuron, lessonPending: false }, d.settledAt ?? now);
        d.lesson = lesson;
        try {
          learnFact(userId, it.neuron || "execution", `${d.symbol}: ${lesson}`, { evidence: `${d.action} ${new Date(d.at).toISOString().slice(0, 16)} -- ${describeVerdict(d)}`, source: "reflection", strength: 2 });
        } catch {
          /* a malformed neuron name just skips the brain */
        }
        result.lessons++;
      }
    } catch (err) {
      console.warn(`[grading] ${userId}: lessons failed -- ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (result.settled.length) {
    const missed = result.settled.filter((d) => d.verdict?.startsWith("missed")).length;
    const bad = result.settled.filter((d) => d.verdict === "bad_call").length;
    const text = `📐 Graded ${result.settled.length} call${result.settled.length === 1 ? "" : "s"}: ${result.settled.map((d) => `${d.symbol} ${d.action} → ${describeVerdict(d).split(" -- ")[0]}`).join(" · ")}${missed || bad ? ` (${missed} missed, ${bad} bad${result.lessons ? `, ${result.lessons} lesson${result.lessons === 1 ? "" : "s"} learned` : ""})` : ""}`;
    publishActivity(userId, "background", "growth", { text, stage: "grading" });
  }
  return result;
}
