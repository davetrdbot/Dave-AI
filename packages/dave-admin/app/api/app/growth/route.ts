import { NextResponse } from "next/server";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readClosedTradeHistory, getLastKnownAccountSnapshot } from "@dave/ea-bridge";
import {
  getGrowthGoals,
  setGrowthGoals,
  describeGoals,
  getStrategyState,
  currentVersion,
  describeChange,
  computeGrowthStatus,
  stopCurrentTest,
  listNeurons,
  learnFact,
  forgetFact,
  GROWTH_VARIABLES,
  getMinRiskReward,
  getConfidenceSettings,
} from "@dave/trading";
import { withDevice } from "../../../../server/require-device";

/**
 * Dave's self-improvement, for the app's Growth screen: the goal (what success and failure mean),
 * the score against it, the strategy card under test and every earlier version, and the brain's
 * neurons with the facts in each.
 *
 * The reflection itself needs the model, which lives in the bot process -- "Reflect now" drops a
 * request file the bot picks up within ~20 s (growth-reflection.ts's startGrowthLoop).
 */

function snapshot(userId: string) {
  const trades = readClosedTradeHistory(userId)
    .filter((r) => typeof r.pnl === "number")
    .map((r) => ({ pnl: r.pnl as number, closedAt: r.closedAt, symbol: r.symbol, reason: r.reason }))
    .sort((a, b) => a.closedAt - b.closedAt);
  const goals = getGrowthGoals(userId);
  const s = getStrategyState(userId);
  const status = computeGrowthStatus(userId, trades, getLastKnownAccountSnapshot(userId)?.balance);
  const v = currentVersion(s);
  return {
    goals,
    definition: describeGoals(goals),
    status,
    current: {
      ...v,
      changeText: v.change ? describeChange(v.change) : null,
      settings: { minRiskReward: getMinRiskReward(userId), minConfidence: getConfidenceSettings(userId).threshold },
    },
    cycle: s.cycle,
    floors: s.floors,
    rules: s.rules,
    avoidSymbols: s.avoidSymbols,
    versions: [...s.versions].reverse().map((x) => ({ ...x, changeText: x.change ? describeChange(x.change) : null })),
    neurons: listNeurons(userId),
    variables: GROWTH_VARIABLES,
    lastReflectionAt: s.lastReflectionAt ?? null,
  };
}

export const GET = withDevice(async ({ userId }) => NextResponse.json(snapshot(userId)));

export const POST = withDevice(async ({ userId, req }) => {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  try {
    switch (body.action) {
      case "goals":
        setGrowthGoals(userId, (body.goals ?? {}) as Record<string, unknown>);
        break;
      case "reflect": {
        const path = join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "trading", userId, "growth", "reflect-request.json");
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify({ at: Date.now() }), "utf8");
        return NextResponse.json({ ok: true, queued: true, ...snapshot(userId) });
      }
      case "stop_test":
        if (!stopCurrentTest(userId)) return NextResponse.json({ error: "Nothing is under test right now." }, { status: 409 });
        break;
      case "learn":
        learnFact(userId, String(body.neuron ?? ""), String(body.text ?? ""), { source: "trader", strength: 3 });
        break;
      case "forget":
        if (!forgetFact(userId, String(body.id ?? ""))) return NextResponse.json({ error: "That fact is gone already." }, { status: 404 });
        break;
      default:
        return NextResponse.json({ error: "action must be goals, reflect, stop_test, learn or forget." }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
  return NextResponse.json({ ok: true, ...snapshot(userId) });
});
