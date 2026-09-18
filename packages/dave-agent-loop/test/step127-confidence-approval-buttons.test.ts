import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { DaveDatabase } from "@dave/db";
import type { Provider, CompletionRequest, CompletionResult, ToolCall } from "@dave/brain";
import type { OrderRequest, TradeExecutor } from "@dave/trading";
import {
  upsertGroup,
  setActiveGroup,
  setRiskMode,
  setConfidenceThreshold,
  setAutoApproveBelowThreshold,
  listPendingTradeApprovals,
  queueTradeForApproval,
} from "@dave/trading";
import { getOrCreateEaWebhook, createEaWebhookServer, type EaCommand } from "@dave/ea-bridge";
import { TelegramClient, type InlineKeyboardMarkup } from "@dave/telegram";
import { runAutonomousTick } from "../src/autonomous-tick.js";
import { sendTickOutcome } from "../src/telegram-bot-server.js";
import { dispatchCallback, type CommandRouterDeps } from "../src/command-router.js";

/**
 * Real production bug fixed (the owner, from a live Telegram screenshot): a below-threshold trade
 * arrived as
 *
 *   "⚠️ CRASH_200 SELL 0.01 lots -- confidence 66% is below your 70% threshold. ...
 *    Approve to place it, or decline to skip."
 *
 * with NO inline keyboard attached, so there was literally nothing to press and the gated trade
 * could never be approved or declined. Root cause: autonomous-tick.ts's confidence-gate branch
 * returned only a message STRING (reading gate.pendingId and throwing it away), and
 * telegram-bot-server.ts sent that string with `text` only -- no reply_markup. The interactive
 * half existed solely inline in full-registry.ts's trade_execute wrapper, i.e. the OTHER producer
 * of the same ask.
 *
 * This proves the whole round trip through the REAL code paths, nothing reimplemented here: a real
 * tick decision -> the real gate -> the real send path (sendTickOutcome) -> a real captured
 * Telegram sendMessage payload -> the real callback_query dispatcher (dispatchCallback) -> a real
 * order at the real executor, with the margin-aware lot ladder and the risk:reward guard genuinely
 * on that approval path, and a second press genuinely placing nothing.
 */

console.log("=== Real proof: a confidence-gated trade arrives WITH real Approve/Decline buttons that genuinely trade ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-confidence-buttons-"));
process.chdir(workDir);
const OWNER = "user-confidence-buttons-1";
const CHAT_ID = 5150501;

/** A real simulated EA cycle answering "analyze" commands -- same race-free pattern as step93,
 *  and mirroring the real EA's own shape (ea/DaveEA.mq5): endpoint "price" answers with the price
 *  object directly, every other endpoint answers with an object carrying a "price" key. */
function startSimulatedEa(userId: string, priceBySymbol: Record<string, { bid: number; ask: number; spread_pips: number }>) {
  const webhook = getOrCreateEaWebhook(userId);
  const server = createEaWebhookServer();
  let port = 0;
  const ready = new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as { port: number }).port;
      resolve();
    })
  );
  const postReport = (body: unknown): Promise<{ commands: EaCommand[] }> =>
    new Promise((resolve, reject) => {
      const json = JSON.stringify(body);
      const req = request(
        { hostname: "127.0.0.1", port, path: webhook.path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(json) } },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve(JSON.parse(data)));
        }
      );
      req.on("error", reject);
      req.write(json);
      req.end();
    });
  let running = true;
  const loop = (async () => {
    await ready;
    while (running) {
      const heartbeat = { type: "heartbeat", account: "123", balance: 1000, positions: [], pendingOrders: [] };
      const resp = await postReport(heartbeat).catch(() => ({ commands: [] as EaCommand[] }));
      for (const cmd of resp.commands) {
        if (cmd.action !== "analyze") continue;
        const price = priceBySymbol[cmd.symbol] ?? { bid: 1, ask: 1.0002, spread_pips: 1 };
        const data = cmd.endpoint === "price" ? price : { price };
        await postReport({ ...heartbeat, results: [{ commandId: cmd.id, status: "ok", data }] }).catch(() => undefined);
      }
      await new Promise((r) => setTimeout(r, 30));
    }
  })();
  return { stop: async () => { running = false; await loop; await ready; server.close(); } };
}

/** Mock provider returning a real tool call per tick, matching how autonomous-tick.ts actually
 *  reads a decision (result.toolCalls) -- same helper shape as step93. */
function mockToolProvider(decisions: Record<string, unknown>[]): Provider {
  let i = 0;
  return {
    name: "claude",
    generate: async (req: CompletionRequest): Promise<CompletionResult> => {
      const args = decisions[Math.min(i, decisions.length - 1)];
      i++;
      const toolCalls: ToolCall[] = [{ id: `call-${i}`, name: req.tools?.[0]?.name ?? "submit_trading_decision", arguments: args }];
      return { text: "", provider: "claude", latencyMs: 1, toolCalls };
    },
  };
}

// Every real Telegram API call this test triggers, captured whole (text AND reply_markup) --
// the missing-keyboard bug was invisible to any assertion that only looked at text.
interface SentMessage { text?: string; reply_markup?: InlineKeyboardMarkup }
const sent: SentMessage[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const urlStr = String(url);
  if (!urlStr.includes("api.telegram.org")) return realFetch(url as string, init); // the real local EA-bridge HTTP server must still work
  const body = init?.body ? JSON.parse(init.body as string) : undefined;
  if (urlStr.includes("/sendMessage")) sent.push({ text: body?.text, reply_markup: body?.reply_markup });
  return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }), { status: 200 });
}) as typeof fetch;

const db = new DaveDatabase(join(workDir, "dave.db"));
const client = new TelegramClient("000000:fake-token-for-transport-mock");

// A real executor that refuses anything above the broker-affordable size with the EXACT wording a
// real MT5 bridge returned live ("not enough money") -- so the margin-aware lot ladder is
// genuinely exercised on the APPROVAL path, not merely assumed to be there.
const placedOrders: OrderRequest[] = [];
const refusedLots: number[] = [];
let affordableLots = 0.01;
const executor: TradeExecutor = {
  async openOrder(order: OrderRequest) {
    if (order.lots > affordableLots) {
      refusedLots.push(order.lots);
      throw new Error("failed: not enough money");
    }
    placedOrders.push({ ...order });
    return { ticket: `T-${placedOrders.length}` };
  },
  async modifyOrder() {},
  async closePosition() { return { closedLots: 0, remainingLots: 0 }; },
  async deletePendingOrder() {},
  async listOpenPositions() { return []; },
  async listPendingOrders() { return []; },
};
const deps: CommandRouterDeps = { db, client, userId: OWNER, publicBaseUrl: "https://dave.example.com", executor };

const callbackQuery = (data: string, id: string) => ({
  id,
  from: { id: CHAT_ID, is_bot: false, first_name: "Owner" },
  message: { message_id: 1, date: 0, chat: { id: CHAT_ID, type: "private" as const } },
  data,
});

const ea = startSimulatedEa(OWNER, { CRASH_200: { bid: 627681, ask: 627701, spread_pips: 20 } });

try {
  upsertGroup(OWNER, { id: "synthetic", name: "Synthetic", symbols: ["CRASH_200"] });
  setActiveGroup(OWNER, "synthetic");
  setRiskMode(OWNER, "sl", "off");
  setRiskMode(OWNER, "tp", "off");
  setRiskMode(OWNER, "lot", "off");
  // The owner's own real live configuration from the screenshot: a 70% threshold, auto-approval
  // deliberately turned OFF -- i.e. below-threshold trades must come back as a real ask.
  setConfidenceThreshold(OWNER, 70);
  setAutoApproveBelowThreshold(OWNER, false);

  console.log("[1] A real autonomous tick decides a 66%-confidence SELL against a 70% threshold -- the exact live case...\n");
  const provider = mockToolProvider([
    { action: "SELL", symbol: "CRASH_200", sl: 632170, tp: 617000, lots: 0.02, confidence: 66, reason: "Deep bear orderblock at 627681 invalidated ISM M1 at 625285; snapshot M15 shows bullish macro shift but trend is still bear on H4/M1, favoring a short while pullback extends toward 632170 (next Gann). Momentum is fading into the level." },
    { action: "SELL", symbol: "CRASH_200", sl: 632170, tp: 617000, lots: 0.01, confidence: 61, reason: "Same bear structure, second look -- still below threshold." },
  ]);
  const outcome = await runAutonomousTick({ userId: OWNER, db, executor, provider });
  console.log(`    real outcome action=${outcome.action} notable=${outcome.notable}`);
  assert.equal(outcome.action, "SELL");
  assert.equal(placedOrders.length, 0, "a below-threshold trade with auto-approve off must NOT fire on its own");
  const pending = listPendingTradeApprovals(OWNER);
  assert.equal(pending.length, 1, "the gated trade must genuinely be queued");
  const pendingId = pending[0].id;
  console.log(`    real pending approval queued: id=${pendingId} ${pending[0].order.symbol} ${pending[0].order.type} ${pending[0].order.lots} lots @ ${pending[0].confidence}%`);

  // This is the regression itself: the outcome must CARRY the real keyboard, not just prose.
  assert.ok(outcome.replyMarkup, "REGRESSION: the gated tick outcome carries no keyboard at all -- this is the exact production bug");
  const row = outcome.replyMarkup!.inline_keyboard[0];
  assert.equal(row.length, 3);
  assert.equal(row[0].callback_data, `tradeapprove:${pendingId}`, "Approve must carry the REAL pending id the gate just queued");
  assert.equal(row[1].callback_data, `tradedecline:${pendingId}`);
  assert.equal(row[2].callback_data, `tradefindanother:${pendingId}`);
  assert.equal(row[0].style, "success");
  assert.equal(row[1].style, "danger");
  console.log(`    real keyboard on the outcome: ${JSON.stringify(outcome.replyMarkup)}`);

  console.log("\n[2] The REAL send path (sendTickOutcome -- what the live cycle calls) attaches it to a real Telegram sendMessage...\n");
  sent.length = 0;
  await sendTickOutcome(client, CHAT_ID, outcome);
  assert.ok(sent.length >= 1, "the ask must genuinely be sent");
  const last = sent[sent.length - 1];
  assert.match(sent[0].text!, /confidence 66% is below your 70% threshold/);
  assert.match(last.text!, /Approve to place it, or decline to skip\./);
  assert.ok(last.reply_markup, "REGRESSION: the message that says 'Approve to place it' went out with NO inline keyboard -- the owner's screenshot");
  assert.equal(last.reply_markup!.inline_keyboard[0][0].callback_data, `tradeapprove:${pendingId}`);
  console.log(`    real sent payload: text=${JSON.stringify(last.text!.slice(0, 70))}… reply_markup=${JSON.stringify(last.reply_markup)}`);

  console.log("\n[3] Pressing the REAL callback_data off that sent message, through the REAL dispatcher, genuinely places the trade (margin-aware ladder included)...\n");
  const approveData = last.reply_markup!.inline_keyboard[0][0].callback_data!;
  sent.length = 0;
  await dispatchCallback(deps, callbackQuery(approveData, "cb-approve-1"));
  console.log(`    broker refused these sizes for margin first: ${JSON.stringify(refusedLots)}`);
  console.log(`    real orders at the executor: ${JSON.stringify(placedOrders)}`);
  assert.equal(placedOrders.length, 1, "pressing Approve must genuinely place exactly one real order");
  assert.equal(placedOrders[0].symbol, "CRASH_200");
  assert.equal(placedOrders[0].type, "sell");
  assert.equal(placedOrders[0].sl, 632170, "the approved order must be the SAME order that was queued -- levels intact");
  assert.equal(placedOrders[0].tp, 617000);
  assert.deepEqual(refusedLots, [0.02], "the margin-aware retry must genuinely be on the approval path -- the 0.02 request was refused for margin and stepped down");
  assert.equal(placedOrders[0].lots, 0.01, "…and the order that actually went out is the largest size the broker accepted");
  const placedMsg = sent.map((m) => m.text ?? "").join("\n");
  assert.match(placedMsg, /Ticket #T-1/, "the owner must get a real placement confirmation");
  assert.match(placedMsg, /Size reduced to 0\.01 lots/, "…including the honest reduced-size note");
  assert.equal(listPendingTradeApprovals(OWNER).length, 0, "the pending entry must be gone once decided");
  console.log(`    real confirmation to the owner: ${JSON.stringify(placedMsg)}`);

  console.log("\n[4] Pressing Approve a SECOND time places nothing -- genuinely idempotent...\n");
  sent.length = 0;
  await dispatchCallback(deps, callbackQuery(approveData, "cb-approve-2"));
  assert.equal(placedOrders.length, 1, "a double press must NEVER open a second real position");
  assert.match(sent.map((m) => m.text ?? "").join("\n"), /Already handled/);
  console.log(`    second press answered: ${JSON.stringify(sent.map((m) => m.text))} -- still exactly ${placedOrders.length} real order`);

  console.log("\n[5] A second real gated tick, DECLINED through the real button data -- nothing is placed and the queue drains...\n");
  const outcome2 = await runAutonomousTick({ userId: OWNER, db, executor, provider });
  assert.ok(outcome2.replyMarkup, "the second gated tick must also carry real buttons");
  sent.length = 0;
  await sendTickOutcome(client, CHAT_ID, outcome2);
  const declineData = sent[sent.length - 1].reply_markup!.inline_keyboard[0][1].callback_data!;
  sent.length = 0;
  await dispatchCallback(deps, callbackQuery(declineData, "cb-decline-1"));
  assert.equal(placedOrders.length, 1, "a decline must place nothing at all");
  assert.equal(listPendingTradeApprovals(OWNER).length, 0, "a declined entry must be dropped from the queue");
  assert.match(sent.map((m) => m.text ?? "").join("\n"), /was not placed/);
  console.log(`    real decline honored: ${JSON.stringify(sent.map((m) => m.text))}`);

  console.log("\n[6] The risk:reward guard is genuinely on the approval path too -- the confidence gate runs BEFORE it in the tick, so a queued trade had never been checked at all...\n");
  // Same real storage the tick's own gate writes to (queueTradeForApproval is literally the
  // function evaluateConfidenceGate calls), so this is the identical pending shape -- with a stop
  // on the wrong side of a SELL entry, which must never reach the broker even when approved.
  const upsideDown = queueTradeForApproval(OWNER, { symbol: "CRASH_200", type: "sell", lots: 0.01, sl: 600000, tp: 640000 }, 66, "inverted levels");
  sent.length = 0;
  await dispatchCallback(deps, callbackQuery(`tradeapprove:${upsideDown.id}`, "cb-approve-bad"));
  assert.equal(placedOrders.length, 1, "an approved-but-structurally-losing trade must still be refused, not placed");
  assert.match(sent.map((m) => m.text ?? "").join("\n"), /wrong side of the SELL entry/);
  console.log(`    real refusal: ${JSON.stringify(sent.map((m) => m.text))}`);

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  await ea.stop();
  globalThis.fetch = realFetch;
  db.close?.();
  process.chdir(tmpdir());
  rmSync(workDir, { recursive: true, force: true });
}
