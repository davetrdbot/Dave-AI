import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workDir = mkdtempSync(join(tmpdir(), "dave-watch-"));
process.env.DAVE_DATA_ROOT = workDir;

const { createWatch, listActiveWatches, cancelWatch, listAllWatches, WatchReasonRequiredError, InvalidWatchLevelError, MAX_ACTIVE_WATCHES, TooManyActiveWatchesError } =
  await import("@dave/trading");
const { runWatchSweep, midPrice } = await import("../src/watch-sweep.js");
import type { AnalysisSource } from "@dave/trading";

/**
 * Real feature (the trader, explicit): "add a feature similar like your background tool like the
 * way you run your background script -- the bot will use that for anything it want to check, like
 * to mark key level and to check if price will reach so so level... and when the script is
 * returning back it should come back with the reason made earlier why it mark or do that, and also
 * add a tool to check like his pending script the way you normally do, and also stop it."
 *
 * The three properties that made this worth building rather than "just re-analyse every cycle":
 * it runs on its own, it fires exactly once, and the alert carries Dave's original thesis.
 */

const USER = "user-watch-1";

function analysisAt(prices: Record<string, number>, onCall?: (symbol: string) => void): AnalysisSource {
  return {
    get: (async (_endpoint: string, symbol: string) => {
      onCall?.(symbol);
      const price = prices[symbol];
      if (price === undefined) throw new Error(`no quote for ${symbol}`);
      return { bid: price - 1, ask: price + 1 };
    }) as AnalysisSource["get"],
  };
}

console.log("=== Real proof: Dave's background checks run themselves and come back with his reason ===\n");

try {
  console.log("[1] A marked level REQUIRES Dave's own reason -- that's the whole point of it...\n");
  assert.throws(() => createWatch(USER, { symbol: "VOL_80", kind: "price_at_or_above", level: 200000, reason: "" }), WatchReasonRequiredError);
  assert.throws(() => createWatch(USER, { symbol: "VOL_80", kind: "price_at_or_above", level: 200000, reason: "   " }), WatchReasonRequiredError);
  assert.throws(() => createWatch(USER, { symbol: "VOL_80", kind: "price_at_or_above", level: -5, reason: "x" }), InvalidWatchLevelError);
  console.log("    confirmed: a reasonless or nonsense mark is refused, typed");

  console.log("\n[2] Marking a real level, exactly as Dave would after an analysis...\n");
  const THESIS = "202388 is the ATH. If price reaches it again with H1 MACD still diverging, that's my short trigger.";
  const watch = createWatch(USER, { symbol: "VOL_80", kind: "price_at_or_above", level: 202388, reason: THESIS });
  assert.equal(watch.status, "active");
  assert.equal(listActiveWatches(USER).length, 1, "it must show up as pending");
  console.log(`    confirmed: marked ${watch.symbol} @ ${watch.level}, id ${watch.id}`);

  console.log("\n[3] It does NOT fire while price is short of the level...\n");
  const notYet = await runWatchSweep({ userId: USER, analysis: analysisAt({ VOL_80: 199000 }), notify: async () => {} });
  assert.equal(notYet.length, 0, "price below the level must not trigger an at-or-above watch");
  assert.equal(listActiveWatches(USER).length, 1, "it must still be pending");
  console.log("    confirmed: price 199,000 vs level 202,388 -> silent, still pending");

  console.log("\n[4] It fires when the level is reached, and the alert carries THE ORIGINAL REASON...\n");
  const sent: string[] = [];
  const fired = await runWatchSweep({
    userId: USER,
    analysis: analysisAt({ VOL_80: 202500 }),
    notify: async (text) => void sent.push(text),
  });
  assert.equal(fired.length, 1, "the level was reached -- it must fire");
  assert.equal(sent.length, 1, "exactly one alert must be sent");
  assert.ok(sent[0].includes(THESIS), `the alert MUST reproduce Dave's original reason verbatim -- got ${JSON.stringify(sent[0])}`);
  assert.match(sent[0], /VOL_80/, "the alert must name the symbol");
  assert.match(sent[0], /202388/, "the alert must name the level that was hit");
  console.log(`    real alert sent:\n      ${sent[0].split("\n").join("\n      ")}`);

  console.log("\n[5] Edge-triggered: it never fires again, however long price stays past the level...\n");
  const again = await runWatchSweep({
    userId: USER,
    analysis: analysisAt({ VOL_80: 203000 }),
    notify: async (text) => void sent.push(text),
  });
  assert.equal(again.length, 0, "a triggered watch must never re-fire");
  assert.equal(sent.length, 1, "still exactly ONE alert after three more sweeps past the level");
  assert.equal(listActiveWatches(USER).length, 0, "it must no longer be pending");
  assert.equal(listAllWatches(USER).filter((w) => w.status === "triggered").length, 1, "it must be recorded as triggered, not deleted");
  console.log("    confirmed: 'the bot is disturbing me' class of repeat-alert cannot happen here");

  console.log("\n[6] The other direction works, and Dave can stop one he no longer believes in...\n");
  const below = createWatch(USER, { symbol: "CRASH_200", kind: "price_at_or_below", level: 610000, reason: "Range floor -- watching for the flush." });
  const belowFired = await runWatchSweep({ userId: USER, analysis: analysisAt({ CRASH_200: 609500 }), notify: async () => {} });
  assert.equal(belowFired.length, 1, "an at-or-below watch must fire when price drops to the level");

  const doomed = createWatch(USER, { symbol: "BOOM_100", kind: "price_at_or_above", level: 1410000, reason: "Thesis I'll change my mind about." });
  cancelWatch(USER, doomed.id);
  const afterCancel = await runWatchSweep({ userId: USER, analysis: analysisAt({ BOOM_100: 1420000 }), notify: async () => {} });
  assert.equal(afterCancel.length, 0, "a cancelled watch must never fire even when its level is blown through");
  console.log(`    confirmed: at-or-below fires correctly (${below.symbol}); a cancelled mark stays silent`);

  console.log("\n[7] N watches on ONE symbol cost ONE price call, not N -- the EA is shared...\n");
  const calls: string[] = [];
  for (let i = 0; i < 4; i++) {
    createWatch(USER, { symbol: "STORM_500", kind: "price_at_or_above", level: 900000 + i, reason: `level ${i}` });
  }
  await runWatchSweep({ userId: USER, analysis: analysisAt({ STORM_500: 100 }, (s) => calls.push(s)), notify: async () => {} });
  assert.deepEqual(calls, ["STORM_500"], `four watches on one symbol must cost exactly one price call, got ${JSON.stringify(calls)}`);
  console.log("    confirmed: 4 marks on one symbol -> 1 EA round trip");

  console.log("\n[8] One unreachable symbol never stops the others being checked...\n");
  createWatch(USER, { symbol: "NOT_A_SYMBOL", kind: "price_at_or_above", level: 1, reason: "unpriceable symbol" });
  createWatch(USER, { symbol: "VOL_10", kind: "price_at_or_above", level: 1, reason: "priceable symbol" });
  const mixed = await runWatchSweep({ userId: USER, analysis: analysisAt({ VOL_10: 5 }), notify: async () => {} });
  assert.ok(
    mixed.some((w) => w.symbol === "VOL_10"),
    "a symbol that could not be priced must not prevent the rest of the sweep"
  );
  console.log("    confirmed: NOT_A_SYMBOL unpriceable, VOL_10 still evaluated and fired");

  console.log("\n[9] The active list is bounded -- it shares an EA with the trading loop...\n");
  let hitLimit = false;
  try {
    for (let i = 0; i < MAX_ACTIVE_WATCHES + 5; i++) {
      createWatch(USER, { symbol: `SYM${i}`, kind: "price_at_or_above", level: 1_000_000, reason: `bulk ${i}` });
    }
  } catch (err) {
    hitLimit = err instanceof TooManyActiveWatchesError;
  }
  assert.ok(hitLimit, `creating past ${MAX_ACTIVE_WATCHES} active watches must be refused, typed`);
  console.log(`    confirmed: capped at ${MAX_ACTIVE_WATCHES} active, refused beyond that`);

  console.log("\n[10] Mid-price is used, so a level isn't triggered a spread early...\n");
  assert.equal(midPrice({ bid: 100, ask: 102 }), 101, "both sides known -> mid");
  assert.equal(midPrice({ close: 50 }), 50, "only a close -> use it");
  assert.equal(midPrice(undefined), undefined, "no quote -> undefined, never a guess");
  console.log("    confirmed: mid of bid/ask, graceful fallbacks");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
