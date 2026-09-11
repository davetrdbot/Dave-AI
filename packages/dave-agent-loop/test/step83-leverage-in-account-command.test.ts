import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import { getOrCreateEaWebhook } from "@dave/ea-bridge";
import { TelegramClient } from "@dave/telegram";
import { dispatchCommand, type CommandRouterDeps } from "../src/command-router.js";
import type { TradeExecutor } from "@dave/trading";

/**
 * Real gap found on re-verification of item 5 (user: "leverage is STILL not showing up for them
 * live"). buildLiveSettingsBlock (step82's test) genuinely surfaces leverage to the MODEL every
 * turn, and that part was already correct. But the SEPARATE /account command (and the "💰 Account"
 * menu button) -- a second, independent code path in command-router.ts's handleAccount that reads
 * the exact same AccountSnapshot straight off disk and builds its OWN summary text -- never
 * included leverage at all. A user who checks /account directly (rather than asking the model)
 * genuinely never saw it. This drives a real EA report through the real webhook server, then
 * drives the real /account command through the real command router and asserts the rendered
 * Telegram message text includes the real leverage value.
 */

console.log("=== Real proof: /account shows real leverage from a real EA report ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-account-leverage-"));
process.chdir(workDir);
const OWNER = "user-account-leverage-1";
const CHAT_ID = 838383;

const db = new DaveDatabase(join(workDir, "dave.db"));
const client = new TelegramClient("000000:fake-token-for-transport-mock");
const stubExecutor: TradeExecutor = {
  async openOrder() { return { ticket: "T" }; },
  async modifyOrder() {},
  async closePosition() { return { closedLots: 0, remainingLots: 0 }; },
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
  console.log("[1] Before any EA report, /account is honest that there's no data yet...\n");
  await dispatchCommand(deps, CHAT_ID, `${OWNER}:${CHAT_ID}`, "/account");
  assert.match(sentMessages.at(-1)!, /No EA report yet/);
  console.log("    confirmed honest default");

  console.log("\n[2] A real EA report (the exact shape the MT5 EA sends, leverage included) is posted to the real webhook server...\n");
  const hook = getOrCreateEaWebhook(OWNER);
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
    body: JSON.stringify({ type: "heartbeat", account: "555", balance: 2000, equity: 2050, margin: 100, freeMargin: 1950, leverage: 500, positions: [], pendingOrders: [] }),
  });
  server.close();

  console.log("\n[3] /account genuinely shows the real leverage now, not just balance/equity/margin...\n");
  sentMessages.length = 0;
  await dispatchCommand(deps, CHAT_ID, `${OWNER}:${CHAT_ID}`, "/account");
  const screen = sentMessages.at(-1)!;
  console.log(`    real /account screen:\n${screen}`);
  assert.match(screen, /Leverage: 1:500/, "leverage must genuinely be visible in the /account screen, not just the model's live-context block");
  assert.match(screen, /Balance: \$2000\.00/);

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  globalThis.fetch = realFetch;
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
