import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import { logTrade } from "@dave/feedback";

const workDir = mkdtempSync(join(tmpdir(), "dave-selfaware-"));
process.env.DAVE_DATA_ROOT = workDir;

const { runSelfAwareSweep, slProgressTowardStop, SL_ALERT_THRESHOLD } = await import("../src/self-aware-sweep.js");
const { listAlertedTickets } = await import("../src/self-aware-alert-store.js");

/**
 * Real feature (the trader, exact): "upgrade the self-aware tool -- so when a trade is reaching 50%
 * toward the SL it should alert." Proactive (fires even with autonomous trading off), edge-triggered
 * (once per crossing, never per sweep), carries the original trade reason, and -- the bug I caught
 * finishing this -- uses a DIRECTIONAL progress measure so it never fires on a winning trade.
 */

const USER = "user-selfaware-1";
const CHAT = "999";

/** Seed the live EA snapshot the sweep reads (same path ea-webhook.ts persists it to). */
function setPositions(positions: unknown[]): void {
  const dir = join(workDir, "data", "ea-bridge", USER);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "last-known-state.json"), JSON.stringify({ positions, pendingOrders: [] }), "utf8");
}

const db = new DaveDatabase(join(workDir, "dave.db"));
// A long: entry 100, SL 90. Halfway toward the stop is price 95.
const LONG = { ticket: "T1", symbol: "VOL_80", type: "buy", lots: 0.02, openPrice: 100, sl: 90, tp: 130 };
logTrade(db, USER, { ticket: "T1", symbol: "VOL_80", direction: "buy", entryPrice: 100, sl: 90, tp: 130, reasoning: ["Swept the session low, bullish FVG reclaim."], confluenceScore: 78 } as never);

console.log("=== Real proof: proactive 50%-toward-SL alert, edge-triggered, directional ===\n");

try {
  console.log("[1] The progress measure is DIRECTIONAL -- a move toward profit reads 0, not 'progress'...\n");
  // long, price above entry (winning) -> 0
  assert.equal(slProgressTowardStop({ ...LONG, currentPrice: 110 } as never), 0, "a long in profit must read 0 toward SL");
  // long, halfway to SL
  assert.equal(slProgressTowardStop({ ...LONG, currentPrice: 95 } as never), 0.5, "long halfway to SL must read 0.5");
  // short: entry 100, SL 110; price 105 is halfway to the stop
  assert.equal(slProgressTowardStop({ ticket: "S", symbol: "X", type: "sell", lots: 1, openPrice: 100, sl: 110, currentPrice: 105 } as never), 0.5, "short halfway to SL must read 0.5");
  assert.equal(slProgressTowardStop({ ticket: "S", symbol: "X", type: "sell", lots: 1, openPrice: 100, sl: 110, currentPrice: 95 } as never), 0, "a short in profit must read 0");
  // no SL, or SL at entry -> undefined (never alertable)
  assert.equal(slProgressTowardStop({ ...LONG, sl: undefined, currentPrice: 95 } as never), undefined, "no SL -> never measurable");
  assert.equal(slProgressTowardStop({ ...LONG, sl: 100, currentPrice: 95 } as never), undefined, "SL at entry -> no distance to measure");
  console.log("    confirmed: directional, guards no-SL and SL-at-entry, never counts a winning move");

  console.log("\n[2] A position at 40% toward SL does NOT alert...\n");
  setPositions([{ ...LONG, currentPrice: 96 }]); // 40% toward SL
  const sent: string[] = [];
  const none = await runSelfAwareSweep({ db, userId: USER, notify: async (t) => void sent.push(t) });
  assert.equal(none.length, 0, "40% must not fire");
  assert.equal(sent.length, 0, "and nothing is sent");
  console.log("    confirmed: 40% -> silent");

  console.log("\n[3] Crossing to 50%+ fires ONCE, with the original trade reason...\n");
  setPositions([{ ...LONG, currentPrice: 95 }]); // exactly 50%
  const fired = await runSelfAwareSweep({ db, userId: USER, notify: async (t) => void sent.push(t) });
  assert.equal(fired.length, 1, "50% must fire");
  assert.deepEqual(fired, ["T1"]);
  assert.equal(sent.length, 1, "exactly one alert");
  assert.match(sent[0], /VOL_80/, "names the symbol");
  assert.match(sent[0], /#T1/, "names the ticket");
  assert.match(sent[0], /50%/, "states how far toward the stop");
  assert.match(sent[0], /Swept the session low, bullish FVG reclaim\./, "carries the original reason verbatim");
  console.log(`    real alert:\n      ${sent[0].split("\n").join("\n      ")}`);

  console.log("\n[4] Staying past 50% across more sweeps NEVER re-fires...\n");
  setPositions([{ ...LONG, currentPrice: 93 }]); // 70% -- deeper, still same crossing
  const again = await runSelfAwareSweep({ db, userId: USER, notify: async (t) => void sent.push(t) });
  assert.equal(again.length, 0, "a position already alerted must never re-alert on a later sweep");
  assert.equal(sent.length, 1, "still exactly one alert total");
  console.log("    confirmed: 'the bot is disturbing me' repeat-alert cannot happen here");

  console.log("\n[5] When the position closes and a NEW trade later crosses 50%, it alerts again...\n");
  setPositions([]); // T1 closed -> reconcile clears its record
  await runSelfAwareSweep({ db, userId: USER, notify: async () => {} });
  assert.equal(listAlertedTickets(USER).length, 0, "closing the position clears its alert record");
  logTrade(db, USER, { ticket: "T2", symbol: "VOL_80", direction: "buy", entryPrice: 200, sl: 180, tp: 260, reasoning: ["Fresh trade, new ticket."], confluenceScore: 70 } as never);
  setPositions([{ ticket: "T2", symbol: "VOL_80", type: "buy", lots: 0.02, openPrice: 200, sl: 180, tp: 260, currentPrice: 190 }]); // 50%
  const t2 = await runSelfAwareSweep({ db, userId: USER, notify: async (t) => void sent.push(t) });
  assert.deepEqual(t2, ["T2"], "a genuinely new position must be able to alert");
  assert.match(sent[sent.length - 1], /Fresh trade, new ticket\./, "with its own reason");
  console.log("    confirmed: a new ticket alerts again after the old one closed");

  console.log("\n[6] A position with no SL never alerts, however far price moves...\n");
  setPositions([{ ticket: "T3", symbol: "CRASH_200", type: "sell", lots: 0.01, openPrice: 600000, currentPrice: 1 }]); // no sl
  const noSl = await runSelfAwareSweep({ db, userId: USER, notify: async (t) => void sent.push(t) });
  assert.equal(noSl.length, 0, "a position with no SL is never alertable");
  console.log("    confirmed: no SL -> never fires");

  console.log(`\n(threshold in force: ${SL_ALERT_THRESHOLD})`);
  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
