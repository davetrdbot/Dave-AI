import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelegramClient } from "@dave/telegram";
import { EaBridge, type EaReport } from "@dave/ea-bridge";
import { RFeedBridge, type RFeedReport } from "@dave/rfeed";
import {
  formatMoney,
  formatConnectionAlert,
  formatTradeOpenedAlert,
  formatTradeClosedAlert,
  formatTpHitAlert,
  formatSlHitAlert,
  formatManualChangeAlert,
  routeClosedPositionAlert,
  sendConnectionAlert,
} from "../src/index.js";

console.log("=== Update 10+11 real proof: connection/open/close/TP-SL-hit notifications, manual close+modify detection ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-update15-"));
const USER_ID = "tg-847213";

try {
  process.chdir(workDir);

  // --- [1] formatMoney: always signed, always 2 decimals ---
  console.log("[1] formatMoney(): real sign + 2-decimal formatting...\n");
  assert.equal(formatMoney(12.3), "+$12.30");
  assert.equal(formatMoney(-4.5), "-$4.50");
  assert.equal(formatMoney(0), "+$0.00");
  console.log(`    12.3 -> "${formatMoney(12.3)}", -4.5 -> "${formatMoney(-4.5)}", 0 -> "${formatMoney(0)}"`);

  // --- [2] Every notification type mentions the system, clearly labeled ---
  console.log("\n[2] Every alert type clearly labels which system triggered it...\n");
  assert.ok(formatConnectionAlert("dave").includes("Dave"));
  assert.ok(formatConnectionAlert("rfeed").includes("R_Feed"));
  console.log(`    dave: "${formatConnectionAlert("dave")}"`);
  console.log(`    rfeed: "${formatConnectionAlert("rfeed")}"`);

  let connectionSent: any;
  const connectionCapture = { sendMessage: async (p: any) => { connectionSent = p; return { message_id: 7 }; } } as unknown as TelegramClient;
  await sendConnectionAlert(connectionCapture, 99, "rfeed");
  assert.equal(connectionSent.chat_id, 99);
  assert.ok(connectionSent.text.includes("R_Feed"));
  console.log(`    sendConnectionAlert() real call captured: ${JSON.stringify(connectionSent)}`);

  // --- [3] Trade-opened: system + symbol + lots + reason, ALL in one message ---
  console.log("\n[3] Trade-opened alert: system + symbol + lots + reason together...\n");
  const openedText = formatTradeOpenedAlert({ system: "dave", symbol: "XAUUSD", lots: 0.5, reason: "H4/H1 trend agree bullish, confluence 82." });
  assert.ok(openedText.includes("Dave"));
  assert.ok(openedText.includes("XAUUSD"));
  assert.ok(openedText.includes("0.5"));
  assert.ok(openedText.includes("confluence 82"));
  console.log(`    "${openedText.replace(/\n/g, " | ")}"`);

  // --- [4] Trade-closed: system + symbol + exact P&L + reason ---
  console.log("\n[4] Trade-closed alert: system + symbol + exact P&L + reason together...\n");
  const closedText = formatTradeClosedAlert({ system: "rfeed", symbol: "EURUSD", pnl: -4.5, reason: "Structure broke down, cutting the loss early." });
  assert.ok(closedText.includes("R_Feed"));
  assert.ok(closedText.includes("EURUSD"));
  assert.ok(closedText.includes("-$4.50"));
  assert.ok(closedText.includes("cutting the loss early"));
  console.log(`    "${closedText.replace(/\n/g, " | ")}"`);

  // --- [5] TP-hit and SL-hit get their OWN dedicated alert, distinct from a generic close ---
  console.log("\n[5] TP-hit and SL-hit are dedicated, distinct alerts...\n");
  const tpText = formatTpHitAlert({ system: "dave", symbol: "GBPUSD", profit: 18.75 });
  assert.ok(tpText.includes("take-profit"));
  assert.ok(tpText.includes("+$18.75"));
  const slText = formatSlHitAlert({ system: "dave", symbol: "GBPUSD", loss: -9.2 });
  assert.ok(slText.includes("stop-loss"));
  assert.ok(slText.includes("-$9.20"));
  console.log(`    TP: "${tpText}"`);
  console.log(`    SL: "${slText}"`);

  // --- [6] routeClosedPositionAlert(): a real closed-position record routes to the RIGHT alert ---
  console.log("\n[6] routeClosedPositionAlert(): real routing by the EA's own reported reason...\n");
  let sentText: string | undefined;
  const capturingClient = { sendMessage: async (p: any) => { sentText = p.text; return { message_id: 1 }; } } as unknown as TelegramClient;

  await routeClosedPositionAlert(capturingClient, 1, { system: "dave", symbol: "XAUUSD", pnl: 22.1, reason: "tp" });
  assert.ok(sentText!.includes("take-profit"));
  console.log(`    reason="tp" -> ${sentText}`);

  await routeClosedPositionAlert(capturingClient, 1, { system: "dave", symbol: "XAUUSD", pnl: -8.4, reason: "sl" });
  assert.ok(sentText!.includes("stop-loss"));
  console.log(`    reason="sl" -> ${sentText}`);

  await routeClosedPositionAlert(capturingClient, 1, { system: "dave", symbol: "XAUUSD", pnl: 5.0, reason: "dave", daveCloseReason: "Momentum stalled, banking the gain." });
  assert.ok(sentText!.includes("Momentum stalled"));
  console.log(`    reason="dave" -> ${sentText}`);

  await routeClosedPositionAlert(capturingClient, 1, { system: "rfeed", symbol: "XAUUSD", pnl: -1.2, reason: "manual" });
  assert.ok(sentText!.includes("Closed manually"));
  console.log(`    reason="manual" -> ${sentText}`);

  // --- [7] REAL end-to-end: a real EA connection + a real closed-position report drives real alerts ---
  console.log("\n[7] Real end-to-end: EaBridge's real webhook -> real onConnect + onClosedPosition events...\n");
  const daveEvents: string[] = [];
  const daveBridge = new EaBridge({
    onConnect: (userId) => daveEvents.push(`connect:${userId}`),
    onClosedPosition: (userId, closed) => daveEvents.push(`closed:${userId}:${closed.ticket}:${closed.reason}:${closed.pnl}`),
  });
  const daveServer = daveBridge.createServer();
  await new Promise<void>((resolve) => daveServer.listen(0, resolve));
  const daveAddr = daveServer.address() as any;
  const daveHook = (await import("@dave/ea-bridge")).getOrCreateEaWebhook(USER_ID);

  const firstReport: EaReport = { type: "heartbeat", account: "1", balance: 10000, positions: [], pendingOrders: [] };
  await fetch(`http://127.0.0.1:${daveAddr.port}${daveHook.path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(firstReport) });
  assert.deepEqual(daveEvents, [`connect:${USER_ID}`], "the very first report must genuinely fire onConnect");
  console.log(`    real first report -> real onConnect fired: ${daveEvents[0]}`);

  const secondReport: EaReport = {
    type: "heartbeat",
    account: "1",
    balance: 10022,
    positions: [],
    pendingOrders: [],
    closedPositions: [{ ticket: "T1", symbol: "XAUUSD", pnl: 22.0, reason: "tp" }],
  };
  await fetch(`http://127.0.0.1:${daveAddr.port}${daveHook.path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(secondReport) });
  assert.ok(daveEvents.includes("closed:tg-847213:T1:tp:22"), "a real closedPositions entry from the EA's own report must genuinely fire onClosedPosition");
  assert.equal(daveEvents.filter((e) => e.startsWith("connect:")).length, 1, "a second report within the gap window must NOT fire onConnect again");
  console.log(`    real closedPositions entry -> real onClosedPosition fired: ${daveEvents[daveEvents.length - 1]}`);
  console.log(`    second report (no gap) correctly did NOT re-fire onConnect`);
  await new Promise<void>((resolve) => daveServer.close(() => resolve()));

  // --- [8] Manual CLOSE detection still works (Step 11.1), now alongside the new pieces ---
  console.log("\n[8] Manual close detection (Step 11.1) still fires correctly...\n");
  const closeEvents: string[] = [];
  const closeBridge = new EaBridge({ onManualClose: (userId, pos) => closeEvents.push(`${userId}:${pos.ticket}`) });
  const closeServer = closeBridge.createServer();
  await new Promise<void>((resolve) => closeServer.listen(0, resolve));
  const closeAddr = closeServer.address() as any;
  const closeHook = (await import("@dave/ea-bridge")).getOrCreateEaWebhook("tg-close-test");
  await fetch(`http://127.0.0.1:${closeAddr.port}${closeHook.path}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "heartbeat", account: "1", balance: 100, positions: [{ ticket: "TX", symbol: "EURUSD", type: "buy", lots: 0.1, openPrice: 1.1, sl: 1.09, tp: 1.12 }], pendingOrders: [] }),
  });
  await fetch(`http://127.0.0.1:${closeAddr.port}${closeHook.path}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "heartbeat", account: "1", balance: 100, positions: [], pendingOrders: [] }),
  });
  assert.deepEqual(closeEvents, ["tg-close-test:TX"]);
  console.log(`    real manual close still detected: ${closeEvents[0]}`);
  await new Promise<void>((resolve) => closeServer.close(() => resolve()));

  // --- [9] NEW: manual MODIFY detection (Update 11, part 2) ---
  console.log("\n[9] Manual SL/TP MODIFY detection -- NEW, real...\n");
  const modifyEvents: string[] = [];
  const modifyBridge = new EaBridge({ onManualModify: (userId, mod) => modifyEvents.push(`${userId}:${mod.ticket}:${mod.field}:${mod.oldValue}->${mod.newValue}`) });
  const modifyServer = modifyBridge.createServer();
  await new Promise<void>((resolve) => modifyServer.listen(0, resolve));
  const modifyAddr = modifyServer.address() as any;
  const modifyHook = (await import("@dave/ea-bridge")).getOrCreateEaWebhook("tg-modify-test");
  await fetch(`http://127.0.0.1:${modifyAddr.port}${modifyHook.path}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "heartbeat", account: "1", balance: 100, positions: [{ ticket: "TM", symbol: "EURUSD", type: "buy", lots: 0.1, openPrice: 1.1, sl: 1.09, tp: 1.12 }], pendingOrders: [] }),
  });
  await fetch(`http://127.0.0.1:${modifyAddr.port}${modifyHook.path}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "heartbeat", account: "1", balance: 100, positions: [{ ticket: "TM", symbol: "EURUSD", type: "buy", lots: 0.1, openPrice: 1.1, sl: 1.095, tp: 1.12 }], pendingOrders: [] }),
  });
  assert.deepEqual(modifyEvents, ["tg-modify-test:TM:sl:1.09->1.095"]);
  console.log(`    real manual SL modification genuinely detected: ${modifyEvents[0]}`);
  const alertText = formatManualChangeAlert({ system: "dave", symbol: "EURUSD", detail: `moved your SL to 1.095` });
  assert.ok(alertText.includes("moved your SL to 1.095"));
  console.log(`    real alert text: "${alertText}"`);
  await new Promise<void>((resolve) => modifyServer.close(() => resolve()));

  console.log("\n[9b] A Dave-INITIATED modify must NOT be misreported as manual...\n");
  const modifyBridge2 = new EaBridge({ onManualModify: (userId, mod) => modifyEvents.push(`unexpected:${userId}:${mod.ticket}`) });
  const daveModifyServer = modifyBridge2.createServer();
  await new Promise<void>((resolve) => daveModifyServer.listen(0, resolve));
  const dmAddr = daveModifyServer.address() as any;
  const dmHook = (await import("@dave/ea-bridge")).getOrCreateEaWebhook("tg-dave-modify-test2");
  const dmExecutor = modifyBridge2.getExecutor("tg-dave-modify-test2");
  await fetch(`http://127.0.0.1:${dmAddr.port}${dmHook.path}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "heartbeat", account: "1", balance: 100, positions: [{ ticket: "TD", symbol: "EURUSD", type: "buy", lots: 0.1, openPrice: 1.1, sl: 1.09, tp: 1.12 }], pendingOrders: [] }),
  });
  const modifyPromise = dmExecutor.modifyOrder("TD", { sl: 1.1 });
  const queuedRaw = (await import("node:fs")).readFileSync(join(workDir, "data", "ea-bridge", "tg-dave-modify-test2", "command-queue.json"), "utf8");
  const queued = JSON.parse(queuedRaw);
  const commandId = queued[0].id;
  await fetch(`http://127.0.0.1:${dmAddr.port}${dmHook.path}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "heartbeat", account: "1", balance: 100,
      positions: [{ ticket: "TD", symbol: "EURUSD", type: "buy", lots: 0.1, openPrice: 1.1, sl: 1.1, tp: 1.12 }],
      pendingOrders: [],
      results: [{ commandId, status: "ok" }],
    }),
  });
  await modifyPromise;
  assert.ok(!modifyEvents.some((e) => e.includes("unexpected")), "a Dave-initiated modify must NOT be misreported as manual");
  console.log("    real Dave-initiated modify correctly NOT flagged as manual");
  await new Promise<void>((resolve) => daveModifyServer.close(() => resolve()));

  // --- [10] Same connection/closed-position wiring for R_Feed ---
  console.log("\n[10] R_Feed: real onConnect + onClosedPosition wiring too...\n");
  const rfeedEvents: string[] = [];
  const rfeedBridge = new RFeedBridge({
    onConnect: (userId) => rfeedEvents.push(`connect:${userId}`),
    onClosedPosition: (userId, closed) => rfeedEvents.push(`closed:${userId}:${closed.reason}`),
  });
  const rfeedServer = rfeedBridge.createServer();
  await new Promise<void>((resolve) => rfeedServer.listen(0, resolve));
  const rfeedAddr = rfeedServer.address() as any;
  const rfeedHook = (await import("@dave/rfeed")).getOrCreateRFeedWebhook("tg-rfeed-notif");
  const firstRfeedReport: RFeedReport = { type: "heartbeat", account: "50000", balance: 10000, positions: [], pendingOrders: [] };
  await fetch(`http://127.0.0.1:${rfeedAddr.port}${rfeedHook.path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(firstRfeedReport) });
  const secondRfeedReport: RFeedReport = {
    type: "heartbeat", account: "50000", balance: 10005, positions: [], pendingOrders: [],
    closedPositions: [{ ticket: "R1", symbol: "BOOM_500", pnl: 5, reason: "manual" }],
  };
  await fetch(`http://127.0.0.1:${rfeedAddr.port}${rfeedHook.path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(secondRfeedReport) });
  assert.deepEqual(rfeedEvents, ["connect:tg-rfeed-notif", "closed:tg-rfeed-notif:manual"]);
  console.log(`    real R_Feed events: ${rfeedEvents.join(", ")}`);
  await new Promise<void>((resolve) => rfeedServer.close(() => resolve()));

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
