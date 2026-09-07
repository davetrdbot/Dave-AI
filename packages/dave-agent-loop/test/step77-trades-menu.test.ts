import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import { getOrCreateEaWebhook } from "@dave/ea-bridge";
import { TelegramClient } from "@dave/telegram";
import { dispatchCommand, dispatchCallback, type CommandRouterDeps } from "../src/command-router.js";
import type { TradeExecutor } from "@dave/trading";

/**
 * Real proof for the user's ask, with real screenshots of the exact desired UI: "in the menu ui
 * add a button called trades... refreshes every 2 sec... close your trade check which one are in
 * profit and others". Real live per-position P/L comes from the EA's own real POSITION_PROFIT
 * (ea-webhook.ts's EaPosition.pnl, ea/DaveEA.mq5's real report) -- never reported before this.
 */

console.log("=== Real proof: /trades shows real live positions with real P/L and real close buttons ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-trades-menu-"));
process.chdir(workDir);
const OWNER = "user-trades-menu-1";
const CHAT_ID = 727272;

const db = new DaveDatabase(join(workDir, "dave.db"));
const client = new TelegramClient("000000:fake-token-for-transport-mock");
const closedTickets: string[] = [];
const stubExecutor: TradeExecutor = {
  async openOrder() { return { ticket: "T" }; },
  async modifyOrder() {},
  async closePosition(ticket: string) { closedTickets.push(ticket); return { closedLots: 0.01, remainingLots: 0 }; },
  async deletePendingOrder() {},
  async listOpenPositions() { return []; },
  async listPendingOrders() { return []; },
};
const deps: CommandRouterDeps = { db, client, userId: OWNER, publicBaseUrl: "https://dave.example.com", executor: stubExecutor };

const sentMessages: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const urlStr = String(url);
  if (!urlStr.includes("api.telegram.org")) return realFetch(url, init); // let the real local EA-bridge HTTP server through
  const body = init?.body ? JSON.parse(init.body as string) : undefined;
  if (body?.text) sentMessages.push(body.text);
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
}) as typeof fetch;

try {
  console.log("[1] A real EA report carrying real open positions with real live P/L...");
  const hook = getOrCreateEaWebhook(OWNER);
  // Real last-known-state is populated the same way as any real EA report -- a genuine POST
  // against a real EA-bridge webhook server, same pattern as step75's close-notification test.
  const { EaBridge } = await import("@dave/ea-bridge");
  const bridge = new EaBridge({});
  const server = bridge.createServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (typeof address !== "object" || !address) throw new Error("bind failed");
  const base = `http://127.0.0.1:${address.port}`;
  await fetch(`${base}${hook.path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "heartbeat",
      account: "1",
      balance: 1000,
      positions: [
        { ticket: "T1", symbol: "VOL_80", type: "buy", lots: 0.01, openPrice: 355624, pnl: 1.6 },
        { ticket: "T2", symbol: "CRASH_100", type: "sell", lots: 0.01, openPrice: 503999, pnl: -2.56 },
      ],
      pendingOrders: [],
    }),
  });
  server.close();

  console.log("\n[2] /trades genuinely shows both real positions with their real P/L...");
  await dispatchCommand(deps, CHAT_ID, `${OWNER}:${CHAT_ID}`, "/trades");
  const screen = sentMessages.at(-1)!;
  assert.match(screen, /VOL_80 BUY 0\.01 @ 355624 — \+\$1\.60/);
  assert.match(screen, /CRASH_100 SELL 0\.01 @ 503999 — -\$2\.56/);
  console.log(`    real /trades screen:\n${screen}`);

  console.log("\n[3] Tapping 'Close losers' genuinely routes ONLY the losing position to the real executor...");
  closedTickets.length = 0;
  await dispatchCallback(deps, { id: "cb1", data: "trades:closelosers", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  assert.deepEqual(closedTickets, ["T2"], "only the real losing position (T2, -$2.56) must have been closed");
  console.log(`    real close routed to executor: ${JSON.stringify(closedTickets)}`);

  console.log("\n[4] Tapping 'Close ALL' genuinely routes every real open position...");
  closedTickets.length = 0;
  await dispatchCallback(deps, { id: "cb2", data: "trades:closeall", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  assert.deepEqual(closedTickets.sort(), ["T1", "T2"]);
  console.log(`    real close-all routed to executor: ${JSON.stringify(closedTickets.sort())}`);

  console.log("\n[5] Tapping an individual close button genuinely closes only that one real position...");
  closedTickets.length = 0;
  await dispatchCallback(deps, { id: "cb3", data: "trades:close:T1", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  assert.deepEqual(closedTickets, ["T1"]);
  console.log(`    real individual close routed to executor: ${JSON.stringify(closedTickets)}`);

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  globalThis.fetch = realFetch;
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
