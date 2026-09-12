import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import { logTrade, getTradeLifecycle, appendTradeComment } from "../src/trade-log.js";
import { logClosedTrade } from "../src/closed-trade-log.js";

/**
 * Real gap fixed (user, live: "the trade logs it's having problem with that because it doesn't
 * know when a tp hit or other... it should just save every trade placed to logs, tp hit to logs,
 * why it place the trade to logs... and the bot any time asked a trade question like the tp hit
 * it can check logs"). TradeLogEntry (the open-trade record) and ClosedTradeLogEntry (the real
 * TP/SL/manual/dave close event, already sourced from the EA's own authoritative report) shared
 * no join key before this -- neither carried the real MT5 ticket the other could correlate
 * against. This is NOT a new background process -- it's the same EA-bridge close-event stream
 * that already drives the existing Telegram close notification, just made correlatable and
 * queryable. Proves the real join: an open trade whose ticket later closes shows up with its
 * real close reason/pnl; one that never closes stays "open"; a legacy ticket-less row never
 * crashes the join, it just can't be correlated ("unknown").
 */

console.log("=== Real proof: a trade's real lifecycle (open -> closed, TP/SL/manual/dave) is genuinely queryable by ticket ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-trade-lifecycle-"));
process.chdir(workDir);
const OWNER = "user-trade-lifecycle-1";

try {
  const db = new DaveDatabase(join(workDir, "dave.db"));

  console.log("[1] A real trade logged with a ticket, then a matching real close event -- 'did my TP hit' is genuinely answerable...\n");
  logTrade(db, OWNER, {
    ticket: "1001",
    symbol: "EURUSD",
    direction: "buy",
    entryPrice: 1.085,
    sl: 1.08,
    tp: 1.095,
    reasoning: ["real BOS + OB retest"],
    confluenceScore: 78,
  });
  logClosedTrade(db, OWNER, { ticket: "1001", symbol: "EURUSD", pnl: 42.5, reason: "tp" });

  const lifecycle1 = getTradeLifecycle(db, OWNER, { ticket: "1001" });
  assert.equal(lifecycle1.length, 1);
  assert.equal(lifecycle1[0].status, "closed");
  assert.equal(lifecycle1[0].closeReason, "tp");
  assert.equal(lifecycle1[0].closedPnl, 42.5);
  console.log(`    confirmed: ticket #1001 shows status=closed, closeReason=tp, pnl=${lifecycle1[0].closedPnl}`);

  console.log("\n[2] A real trade logged with a ticket that never closes stays genuinely 'open'...\n");
  logTrade(db, OWNER, {
    ticket: "1002",
    symbol: "GBPUSD",
    direction: "sell",
    entryPrice: 1.27,
    reasoning: ["real bear structure"],
    confluenceScore: 65,
  });
  const lifecycle2 = getTradeLifecycle(db, OWNER, { ticket: "1002" });
  assert.equal(lifecycle2.length, 1);
  assert.equal(lifecycle2[0].status, "open");
  assert.equal(lifecycle2[0].closeReason, undefined);
  console.log("    confirmed: ticket #1002 (never closed) shows status=open");

  console.log("\n[3] A legacy row logged with no ticket at all never crashes the join -- genuinely 'unknown', not guessed...\n");
  logTrade(db, OWNER, {
    symbol: "USDJPY",
    direction: "buy",
    entryPrice: 148,
    reasoning: ["pre-migration row, no ticket"],
  });
  const all = getTradeLifecycle(db, OWNER, { symbol: "USDJPY" });
  assert.equal(all.length, 1);
  assert.equal(all[0].status, "unknown", "a real ticket-less row must never be guessed as open or closed");
  console.log("    confirmed: a real ticket-less legacy row is honestly 'unknown', not silently misreported");

  console.log("\n[4] A real manual close (not TP/SL) shows the correct real reason too...\n");
  logTrade(db, OWNER, { ticket: "1003", symbol: "AUDUSD", direction: "buy", entryPrice: 0.65, reasoning: ["real setup"] });
  logClosedTrade(db, OWNER, { ticket: "1003", symbol: "AUDUSD", pnl: -3.2, reason: "manual" });
  const lifecycle4 = getTradeLifecycle(db, OWNER, { ticket: "1003" });
  assert.equal(lifecycle4[0].status, "closed");
  assert.equal(lifecycle4[0].closeReason, "manual");
  assert.equal(lifecycle4[0].closedPnl, -3.2);
  console.log(`    confirmed: ticket #1003 shows status=closed, closeReason=manual, pnl=${lifecycle4[0].closedPnl}`);

  console.log("\n[5] A real trade can accumulate appendable comments (user, live: 'the log worker will give a existing trade comment') without ever overwriting earlier notes, and an unknown ticket is a clean no-op, not a crash...\n");
  logTrade(db, OWNER, { ticket: "1004", symbol: "XAUUSD", direction: "buy", entryPrice: 2400, reasoning: ["real supply reclaim"] });
  const firstAppend = appendTradeComment(db, OWNER, "1004", "moved SL to breakeven");
  assert.equal(firstAppend, true);
  const secondAppend = appendTradeComment(db, OWNER, "1004", "price approaching TP, holding");
  assert.equal(secondAppend, true);
  const withComments = getTradeLifecycle(db, OWNER, { ticket: "1004" });
  assert.ok(withComments[0].comment?.includes("moved SL to breakeven"), "the first comment must survive the second append");
  assert.ok(withComments[0].comment?.includes("price approaching TP, holding"), "the second comment must also be present");
  console.log(`    confirmed: ticket #1004's comment field carries both notes:\n${withComments[0].comment}`);

  const missingAppend = appendTradeComment(db, OWNER, "no-such-ticket", "should not crash");
  assert.equal(missingAppend, false, "an unknown ticket must be a clean false, never a throw");
  console.log("    confirmed: appending to an unknown ticket returns false, doesn't throw");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
