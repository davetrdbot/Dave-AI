import assert from "node:assert/strict";
import { computeMtfAlignment, computeMtfConfluenceScore, computeBasketCurrencyRisk, computeSpreadNewsRisk } from "../src/mtf-confluence.js";
import type { EaPosition } from "@dave/ea-bridge";

/**
 * Real gaps fixed (user: SMC/ICT audit -- "HTF bias same as HTF & LTF", "a single real number
 * multi-timeframe confluence score", "no basket/correlation risk check", "no spread-widening-
 * around-news detection"). All four computed from data the autonomous tick ALREADY fetches every
 * cycle (6 real timeframes' worth of "all" endpoint calls) -- zero new EA calls, zero MQL5 changes.
 */

console.log("=== Real proof: MTF alignment, confluence score, basket-currency risk, spread+news risk ===\n");

console.log("[1] Full bull alignment across every real fetched timeframe is genuinely detected...\n");
{
  const suite = ["M1", "M3", "M5", "M15", "H1", "H4"].map((tf) => ({ tf, data: { trend: { bias: "STRONG_BULL", score: 5 } } }));
  const line = computeMtfAlignment(suite);
  assert.match(line, /FULL BULL ALIGNMENT/);
  assert.match(line, /LTF \(M1=STRONG_BULL\) vs HTF \(H4=STRONG_BULL\): AGREE/);
  console.log(`    ${line}`);
}

console.log("\n[2] A genuine LTF/HTF disagreement is called out explicitly, not averaged away...\n");
{
  const suite = [
    { tf: "M1", data: { trend: { bias: "BULL", score: 2 } } },
    { tf: "H4", data: { trend: { bias: "BEAR", score: -3 } } },
  ];
  const line = computeMtfAlignment(suite);
  assert.match(line, /LTF \(M1=BULL\) vs HTF \(H4=BEAR\): DISAGREE/);
  console.log(`    ${line}`);
}

console.log("\n[3] A genuinely mixed read (no majority) is honestly reported as mixed, not forced into a false bias...\n");
{
  const suite = [
    { tf: "M1", data: { trend: { bias: "BULL", score: 2 } } },
    { tf: "M5", data: { trend: { bias: "BEAR", score: -2 } } },
  ];
  const line = computeMtfAlignment(suite);
  assert.match(line, /GENUINELY MIXED/);
  console.log(`    ${line}`);
}

console.log("\n[4] Missing trend data on every timeframe is reported honestly, not silently defaulted...\n");
{
  const line = computeMtfAlignment([{ tf: "M1", data: { error: "unavailable this cycle" } }]);
  assert.match(line, /no real trend data available/);
  console.log(`    ${line}`);
}

console.log("\n[5] The real multi-timeframe confluence score is genuinely the mean of real per-timeframe scores...\n");
{
  const suite = [
    { tf: "M1", data: { trend: { bias: "BULL", score: 3 } } },
    { tf: "H1", data: { trend: { bias: "BULL", score: 5 } } },
  ];
  const line = computeMtfConfluenceScore(suite);
  assert.match(line, /MTF CONFLUENCE SCORE: 4\.0/, "mean of 3 and 5 must genuinely be 4.0");
  console.log(`    ${line}`);
}

console.log("\n[6] Real stacked basket-currency risk is detected across two forex positions sharing a currency in the same direction...\n");
{
  const positions: EaPosition[] = [
    { ticket: "T1", symbol: "EURUSD", type: "buy", lots: 0.1, openPrice: 1.08, pnl: 5 },
    { ticket: "T2", symbol: "GBPUSD", type: "buy", lots: 0.1, openPrice: 1.27, pnl: -2 },
  ];
  const line = computeBasketCurrencyRisk(positions, () => null);
  assert.ok(line, "must genuinely detect the real stacked USD exposure");
  assert.match(line!, /SHORT USD/);
  assert.match(line!, /EURUSD #T1/);
  assert.match(line!, /GBPUSD #T2/);
  console.log(`    ${line}`);
}

console.log("\n[7] Two forex positions NOT sharing a currency direction is genuinely a no-op (no false alarm)...\n");
{
  const positions: EaPosition[] = [
    { ticket: "T1", symbol: "EURUSD", type: "buy", lots: 0.1, openPrice: 1.08, pnl: 5 },
    { ticket: "T2", symbol: "AUDCAD", type: "sell", lots: 0.1, openPrice: 0.9, pnl: 1 },
  ];
  const line = computeBasketCurrencyRisk(positions, () => null);
  assert.equal(line, null, "no shared currency exposure -- must genuinely report nothing, not a false positive");
  console.log("    confirmed: no false alarm on genuinely independent positions");
}

console.log("\n[8] Synthetic-index positions never trigger basket-currency risk (they're independent by design)...\n");
{
  const positions: EaPosition[] = [
    { ticket: "T1", symbol: "VOL_80", type: "buy", lots: 0.02, openPrice: 154000, pnl: 1 },
    { ticket: "T2", symbol: "CRASH_100", type: "sell", lots: 0.02, openPrice: 500000, pnl: -1 },
  ];
  const line = computeBasketCurrencyRisk(positions, () => null);
  assert.equal(line, null, "synthetic symbols are never forex-shaped -- must never be flagged");
  console.log("    confirmed: synthetics never flagged");
}

console.log("\n[9] Real compounding spread+news risk is detected when both are genuinely bad at once...\n");
{
  const line = computeSpreadNewsRisk({ spread_analysis: { cost_rating: "HIGH", tradeable: false }, news: { minutes_to_next: 10, high_impact_count: 1 } });
  assert.ok(line);
  assert.match(line!, /SPREAD\+NEWS RISK/);
  console.log(`    ${line}`);
}

console.log("\n[10] Only spread being bad (no imminent news) reports the real spread-only risk, not a fabricated news risk...\n");
{
  const line = computeSpreadNewsRisk({ spread_analysis: { cost_rating: "HIGH", tradeable: false }, news: { minutes_to_next: 500, high_impact_count: 0 } });
  assert.ok(line);
  assert.match(line!, /^SPREAD RISK/);
  console.log(`    ${line}`);
}

console.log("\n[11] Normal conditions (neither spread nor news is a real problem) genuinely produce no line at all...\n");
{
  const line = computeSpreadNewsRisk({ spread_analysis: { cost_rating: "LOW", tradeable: true }, news: { minutes_to_next: 500, high_impact_count: 0 } });
  assert.equal(line, null);
  console.log("    confirmed: no false alarm under normal conditions");
}

console.log("\n=== ALL ASSERTIONS PASSED ===");
