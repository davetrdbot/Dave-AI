import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.DAVE_DATA_ROOT = mkdtempSync(join(tmpdir(), "dave-calls-"));

/** Dave calls the trader: the call rides the phone's trade-event stream, has a cooldown, turns
 *  "missed" when nobody answers, and the live call opens knowing why he called. */
const calls = await import("../src/dave-calls.js");
const { readTradeEventsAfter } = await import("@dave/ea-bridge");
const bus = await import("../src/activity-bus.js");

const u = "owner";
const t0 = 1_800_000_000_000;
const c1 = calls.placeCall(u, { reason: "Gold swept the Asian low and shifted up -- want me to take the long?", symbol: "xauusd" }, t0);
assert.equal(c1.status, "ringing");
assert.equal(c1.symbol, "XAUUSD");
const ev = readTradeEventsAfter(u, 0).filter((e) => e.type === "call");
assert.equal(ev.length, 1, "the phone gets a call event");
assert.equal(ev[0].ticket, c1.id);
assert.match((ev[0] as { text: string }).text, /Asian low/);

assert.throws(() => calls.placeCall(u, { reason: "again soon" }, t0 + 60_000), calls.CallCooldownError, "one call per 10 minutes");
const urgent = calls.placeCall(u, { reason: "VOL_10 is racing to the stop", urgent: true }, t0 + 60_000);
assert.equal(urgent.urgent, true, "urgent skips the gap");

// Nobody answered the first one within a minute -> missed, told to the chat.
const before = bus.latestActivityId(u);
assert.equal(calls.getCall(u, c1.id, t0 + 61_000)?.status, "missed");
assert.ok(bus.activityAfter(u, before).some((e) => e.kind === "notice" && /Missed call from Dave/.test(String(e.data.text))));

assert.equal(calls.setCallStatus(u, urgent.id, "answered", t0 + 70_000)?.status, "answered");
const opening = calls.callOpeningInstruction(c1);
assert.match(opening, /YOU called the trader about XAUUSD/);
assert.match(opening, /Open the call yourself/);

const tool = calls.createCallTraderTool(u);
const r = (await tool.execute({ reason: "x" })) as { ok: boolean; error?: string };
assert.equal(r.ok, false, "a reason is needed");
console.log("=== ALL ASSERTIONS PASSED ===");
