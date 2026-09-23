import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workDir = mkdtempSync(join(tmpdir(), "dave-tradeevents-"));
process.env.DAVE_DATA_ROOT = workDir;

const { deriveTradeEvents, appendTradeEvents, readTradeEventsAfter, latestTradeEventId, TRADE_EVENT_LOG_CAP } = await import("../src/trade-events.js");
const { EaBridge } = await import("../src/ea-bridge.js");
type Pos = import("../src/ea-webhook.js").EaPosition;

/**
 * The durable open/close log behind the mobile app's Firebase-free notifications.
 *
 * Section 5 is the one that matters most: it drives the REAL EaBridge.handleReport path, because
 * the open-detection gap this closes was in that path -- it noticed closes and never opens, so a
 * trade opened by hand in MT5 was reported to nobody.
 */

console.log("=== Step 156: trade open/close event log ===\n");

const pos = (ticket: string, extra: Partial<Pos> = {}): Pos => ({ ticket, symbol: "VOL_80", type: "buy", lots: 0.02, openPrice: 196740, ...extra });

// ---------------------------------------------------------------------------
console.log("[1] Opens and closes are derived from the before/after diff\n");

{
  const events = deriveTradeEvents({
    previous: [pos("100"), pos("101", { pnl: -4.2 })],
    current: [pos("100"), pos("102", { type: "sell", sl: 196900 })],
    closedPositions: [],
    daveClosed: new Set(),
    isFirstReport: false,
  });
  const opened = events.filter((e) => e.type === "opened");
  const closed = events.filter((e) => e.type === "closed");
  assert.equal(opened.length, 1);
  assert.equal(opened[0].ticket, "102");
  assert.equal(opened[0].type === "opened" && opened[0].side, "sell");
  assert.equal(closed.length, 1);
  assert.equal(closed[0].ticket, "101");
  assert.equal(closed[0].type === "closed" && closed[0].reason, "manual", "a vanished position with no close report is manual");
  assert.equal(closed[0].type === "closed" && closed[0].pnl, -4.2, "and carries its last known P&L");
  console.log("   ✓ one open (102), one close (101, manual, last P&L)");
}

// ---------------------------------------------------------------------------
console.log("\n[2] An explicit close report wins over the vanished-position guess\n");

{
  const events = deriveTradeEvents({
    previous: [pos("200", { pnl: 3 })],
    current: [],
    closedPositions: [{ ticket: "200", symbol: "VOL_80", pnl: 12.5, reason: "tp" }],
    daveClosed: new Set(),
    isFirstReport: false,
  });
  assert.equal(events.length, 1, "one close, not two -- the vanished-position path must not double it");
  assert.equal(events[0].type === "closed" && events[0].reason, "tp");
  assert.equal(events[0].type === "closed" && events[0].pnl, 12.5, "the REALISED P&L, not the last floating value");
  console.log("   ✓ tp close with realised P&L, not duplicated");

  const daveEvents = deriveTradeEvents({
    previous: [pos("201")],
    current: [],
    closedPositions: [],
    daveClosed: new Set(["201"]),
    isFirstReport: false,
  });
  assert.equal(daveEvents[0].type === "closed" && daveEvents[0].reason, "dave", "Dave's own close is labelled as his, not as manual");
  console.log("   ✓ a close Dave issued is labelled 'dave'");
}

// ---------------------------------------------------------------------------
console.log("\n[3] The first report ever does not announce every already-open trade\n");

{
  const events = deriveTradeEvents({
    previous: [],
    current: [pos("300"), pos("301"), pos("302")],
    closedPositions: [],
    daveClosed: new Set(),
    isFirstReport: true,
  });
  assert.equal(events.length, 0, "three positions already open when the terminal first connects are not 'just opened'");
  console.log("   ✓ first report: silent");

  // ...but a genuinely flat account opening its first trade must still notify -- the guard is
  // "first report ever", not "previous list was empty".
  const flat = deriveTradeEvents({ previous: [], current: [pos("303")], closedPositions: [], daveClosed: new Set(), isFirstReport: false });
  assert.equal(flat.length, 1, "flat -> first trade still notifies");
  console.log("   ✓ flat account's first trade still notifies\n");
}

// ---------------------------------------------------------------------------
console.log("[4] The log: numbered, deduped, capped, resumable\n");

{
  const U = "user-log";
  assert.equal(latestTradeEventId(U), 0, "empty log starts at 0");
  const a = appendTradeEvents(U, [{ type: "opened", ticket: "1", symbol: "VOL_80", side: "buy", lots: 0.01, openPrice: 1 }]);
  const b = appendTradeEvents(U, [{ type: "closed", ticket: "1", symbol: "VOL_80", pnl: 2, reason: "tp" }]);
  assert.equal(a[0].id, 1);
  assert.equal(b[0].id, 2);
  assert.equal(latestTradeEventId(U), 2);

  // The same report arriving twice (EA retry, restart replay) must not notify twice.
  const again = appendTradeEvents(U, [{ type: "closed", ticket: "1", symbol: "VOL_80", pnl: 2, reason: "tp" }]);
  assert.equal(again.length, 0, "a duplicate (type, ticket) is dropped");
  assert.equal(readTradeEventsAfter(U, 0).length, 2);
  console.log("   ✓ ids 1,2; a replayed close is dropped");

  // Resume: an app that last saw id 1 gets exactly id 2.
  const resumed = readTradeEventsAfter(U, 1);
  assert.deepEqual(resumed.map((e) => e.id), [2], "Last-Event-ID resume returns only what was missed");
  console.log("   ✓ resume after id 1 returns only id 2");

  // Cap, and ids keep climbing past it rather than being reused.
  const many = Array.from({ length: TRADE_EVENT_LOG_CAP + 20 }, (_, i) => ({ type: "opened" as const, ticket: `m${i}`, symbol: "X", side: "buy" as const, lots: 1, openPrice: 1 }));
  appendTradeEvents(U, many);
  const all = readTradeEventsAfter(U, 0);
  assert.equal(all.length, TRADE_EVENT_LOG_CAP, "the log is capped");
  assert.equal(all[all.length - 1].id, 2 + many.length, "ids never reset or get reused");
  console.log(`   ✓ capped at ${TRADE_EVENT_LOG_CAP}, newest id ${all[all.length - 1].id}\n`);
}

// ---------------------------------------------------------------------------
console.log("[5] The REAL report path records opens -- the gap this closes\n");

{
  const U = "user-bridge";
  const bridge = new EaBridge({});
  // handleReport is private; drive it through the same call the webhook server makes.
  const handle = (bridge as unknown as { handleReport: (u: string, r: unknown, prev: Pos[], first: boolean) => void }).handleReport.bind(bridge);

  // First contact: two trades already open in the terminal.
  handle(U, { type: "snapshot", account: "1", balance: 1000, positions: [pos("10"), pos("11")], pendingOrders: [] }, [], true);
  assert.equal(readTradeEventsAfter(U, 0).length, 0, "nothing announced on first contact");

  // The trader opens one BY HAND in MT5. Before this change, nothing anywhere noticed.
  handle(U, { type: "heartbeat", account: "1", balance: 1000, positions: [pos("10"), pos("11"), pos("12", { symbol: "CRASH_300" })], pendingOrders: [] }, [pos("10"), pos("11")], false);
  let events = readTradeEventsAfter(U, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "opened");
  assert.equal(events[0].ticket, "12");
  assert.equal(events[0].symbol, "CRASH_300");
  console.log("   ✓ a manually-opened trade is now recorded");

  // TP hit on 10.
  handle(
    U,
    { type: "heartbeat", account: "1", balance: 1010, positions: [pos("11"), pos("12")], pendingOrders: [], closedPositions: [{ ticket: "10", symbol: "VOL_80", pnl: 10, reason: "tp" }] },
    [pos("10"), pos("11"), pos("12")],
    false
  );
  events = readTradeEventsAfter(U, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].type === "closed" && events[0].reason, "tp");
  console.log("   ✓ a TP close is recorded with its reason\n");
}

console.log("=== All sections passed ===");
