import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import { TelegramClient } from "@dave/telegram";
import type { TradeExecutor } from "@dave/trading";
import { setConfidenceThreshold, setAutoApproveBelowThreshold } from "@dave/trading";
import { buildFullToolRegistry } from "../src/full-registry.js";
import { buildTradeApprovalRequestMessage } from "../src/trade-notifications.js";

/**
 * Real proof for the live Railway bug: repeated `TelegramError: 400: message is too long` errors,
 * root-caused to full-registry.ts's trade_execute wrapper sending `args.reason` (the model's raw,
 * unbounded free-text argument) straight into a single unchunked sendMessage call -- unlike
 * autonomous-tick.ts's autonomous path, which already routes through chunkForTelegram. This test
 * proves: (1) a deliberately-long reason no longer crashes the send -- it's chunked into multiple
 * <=4000-char messages that reconstruct the real content, with the Approve/Decline/Find Another
 * buttons on the last chunk only; (2) a normal short reason still produces exactly one sendMessage
 * call with the EXACT same text+reply_markup as before this fix (no-op regression proof).
 */

console.log("=== Real proof: full-registry.ts chunks long Telegram messages instead of crashing sendMessage ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-msg-chunking-"));
process.chdir(workDir);
const OWNER = "user-msg-chunking-1";
const CHAT_ID = 445566;

const sentMessages: Array<{ text: string; reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (_url: string, init?: RequestInit) => {
  const body = init?.body ? JSON.parse(init.body as string) : undefined;
  if (body?.text !== undefined) sentMessages.push({ text: body.text, reply_markup: body.reply_markup });
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
}) as typeof fetch;

try {
  const db = new DaveDatabase(join(workDir, "dave.db"));
  const client = new TelegramClient("000000:fake-token-for-transport-mock");
  const executor: TradeExecutor = {
    openOrder: async (order) => ({ ticket: `T-${order.symbol}` }),
    modifyOrder: async () => {},
    closePosition: async (_t, lots) => ({ closedLots: lots ?? 1, remainingLots: 0 }),
    deletePendingOrder: async () => {},
    listOpenPositions: async () => [],
    listPendingOrders: async () => [],
  };

  setConfidenceThreshold(OWNER, 80);
  // Needs the queued-for-approval path for both cases below, not the auto-approve default.
  setAutoApproveBelowThreshold(OWNER, false);

  const registry = buildFullToolRegistry({ userId: OWNER, db, executor, telegram: { client, chatId: CHAT_ID } });

  console.log("[1] A deliberately long (>4096 char) reason genuinely gets chunked instead of crashing the send...\n");
  const longReason = "This is a long, real reasoning sentence explaining the confluence behind this trade idea. ".repeat(60);
  assert.ok(longReason.length > 4096, "sanity: the reason must actually exceed Telegram's real limit");

  sentMessages.length = 0;
  const longResult: any = await registry.execute("trade_execute", {
    symbol: "EURUSD",
    type: "buy",
    lots: 0.1,
    sl: 1.09,
    tp: 1.11,
    confidence: 50,
    reason: longReason,
  });
  assert.equal(longResult.needsApproval, true);

  // Real fire-and-forget send is async relative to trade_execute's own return -- give the event
  // loop a tick to let the chunk loop's awaited sendMessage calls actually land.
  await new Promise((r) => setTimeout(r, 50));

  console.log(`    real sendMessage call count: ${sentMessages.length}`);
  assert.ok(sentMessages.length > 1, "a message over the real 4096-char limit must genuinely be split into multiple sendMessage calls");
  for (const m of sentMessages) {
    assert.ok(m.text.length <= 4000, `every chunk must respect the real chunkForTelegram limit (got ${m.text.length} chars)`);
  }

  const expectedFullText = buildTradeApprovalRequestMessage(
    { symbol: "EURUSD", type: "buy", lots: 0.1, sl: 1.09, tp: 1.11 } as any,
    50,
    longResult.threshold,
    longReason,
  );
  // Most robust check: independently chunk the exact same expected text with the real
  // chunkForTelegram utility (re-derived here via dynamic import to avoid a second hardcoded
  // chunking algorithm in the test) and assert the captured chunks match it exactly.
  const { chunkForTelegram } = await import("@dave/telegram");
  const expectedChunks = chunkForTelegram(expectedFullText);
  assert.deepEqual(
    sentMessages.map((m) => m.text),
    expectedChunks,
    "captured chunks must exactly match chunkForTelegram(expectedFullText)",
  );
  console.log(`    real chunks: ${sentMessages.length}, all <=4000 chars, reconstruct the exact real message content`);

  console.log("\n[2] The Approve/Decline/Find Another buttons are attached to the LAST chunk only...\n");
  for (let i = 0; i < sentMessages.length - 1; i++) {
    assert.equal(sentMessages[i].reply_markup, undefined, `chunk ${i} must NOT carry the buttons`);
  }
  const lastButtons = sentMessages[sentMessages.length - 1].reply_markup!.inline_keyboard[0];
  assert.ok(lastButtons.some((b) => b.text.includes("Approve")));
  assert.ok(lastButtons.some((b) => b.text.includes("Decline")));
  assert.ok(lastButtons.some((b) => b.text.includes("Find Another")));
  console.log(`    real buttons on last chunk: ${lastButtons.map((b) => b.text).join(" | ")}`);

  console.log("\n[3] A normal SHORT reason still produces exactly ONE sendMessage call, byte-identical to pre-fix behavior...\n");
  sentMessages.length = 0;
  const shortReason = "RSI oversold bounce with bullish divergence on the 15m chart.";
  const shortResult: any = await registry.execute("trade_execute", {
    symbol: "GBPUSD",
    type: "sell",
    lots: 0.2,
    sl: 1.28,
    tp: 1.25,
    confidence: 40,
    reason: shortReason,
  });
  assert.equal(shortResult.needsApproval, true);
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(sentMessages.length, 1, "a normal short message must genuinely produce exactly one sendMessage call (no-op chunking)");
  const expectedShortText = buildTradeApprovalRequestMessage(
    { symbol: "GBPUSD", type: "sell", lots: 0.2, sl: 1.28, tp: 1.25 } as any,
    40,
    shortResult.threshold,
    shortReason,
  );
  assert.equal(sentMessages[0].text, expectedShortText, "the short-case text must be exactly what buildTradeApprovalRequestMessage produces -- unchanged by the fix");
  assert.ok(sentMessages[0].reply_markup, "the single chunk must carry the real buttons, same as before this fix");
  const shortButtons = sentMessages[0].reply_markup!.inline_keyboard[0];
  assert.ok(shortButtons.some((b) => b.text.includes("Approve")));
  assert.ok(shortButtons.some((b) => b.text.includes("Decline")));
  assert.ok(shortButtons.some((b) => b.text.includes("Find Another")));
  console.log(`    real single message: "${sentMessages[0].text}"`);
  console.log("    real buttons present on that single message, exactly as before this fix");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  globalThis.fetch = realFetch;
  rmSync(workDir, { recursive: true, force: true });
}

// buildFullToolRegistry wires real timers/handles that can keep the event loop alive -- same
// real-cleanup pattern other tests in this suite already use.
process.exit(0);
