import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { DaveDatabase } from "@dave/db";
import { logClosedTrade } from "@dave/feedback";
import { proposeProtectedLimitChange, approveProtectedLimitChange } from "@dave/trading";
import { createEaWebhookServer, getOrCreateEaWebhook } from "@dave/ea-bridge";
import { isTradingHalted } from "@dave/safety";
import { checkDrawdown, enforceDrawdownLimit } from "../src/drawdown-guard.js";

/**
 * Real proof for item 6's drawdown cap (user's reference pattern: "drawdown cap (auto-pauses
 * trading entirely if hit, notifies the user)"). Root cause confirmed: `maxDailyLossPct` existed
 * as a real settable RiskSettings field, but nothing anywhere ever read it -- a full grep before
 * this fix found zero real consumers. This proves the real check against a real EA account
 * balance and a real closed-trade log, and that a genuine breach auto-pauses trading (the same
 * real halt mechanism /stop uses) and notifies exactly once per real UTC day.
 */

console.log("=== Real proof: the daily drawdown cap is genuinely enforced ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-drawdown-"));
process.chdir(workDir);
const USER = "user-drawdown-1";

async function seedAccountBalance(userId: string, balance: number): Promise<void> {
  const webhook = getOrCreateEaWebhook(userId);
  const server = createEaWebhookServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => {
    const body = JSON.stringify({ type: "heartbeat", account: "123", balance, positions: [], pendingOrders: [] });
    const req = request(
      { hostname: "127.0.0.1", port, path: webhook.path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
      (res) => { res.on("data", () => {}); res.on("end", () => resolve()); }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
  server.close();
}

async function main() {
  const db = new DaveDatabase(join(workDir, "dave.db"));

  console.log("[1] No maxDailyLossPct set -- the real default -- never breaches regardless of losses...\n");
  await seedAccountBalance(USER, 1000);
  logClosedTrade(db, USER, { symbol: "EURUSD", pnl: -500, reason: "sl" });
  assert.equal(checkDrawdown(db, USER).breached, false, "must genuinely never breach when no limit is configured");
  console.log("    confirmed: no limit configured -> never breaches");

  console.log("\n[2] A real maxDailyLossPct IS set, and today's real net loss genuinely clears it -- breach detected...\n");
  const change = proposeProtectedLimitChange(USER, "maxDailyLossPct", 10, "test: 10% daily loss cap");
  approveProtectedLimitChange(USER, change.id);
  // Balance 1000, today's real net loss -500 -> 50% loss, well above the real 10% limit.
  const result = checkDrawdown(db, USER);
  assert.equal(result.breached, true, "a real 50% loss against a 10% limit must genuinely breach");
  assert.ok(result.lossPct! > 10);
  console.log(`    real check: lossPct=${result.lossPct?.toFixed(1)}%, limitPct=${result.limitPct}% -> breached=${result.breached}`);

  console.log("\n[3] enforceDrawdownLimit genuinely pauses trading (the real /stop halt) and notifies exactly once...\n");
  assert.equal(isTradingHalted(USER), false, "must genuinely not be halted before the breach is enforced");
  const notifications: string[] = [];
  const notify = async (text: string) => { notifications.push(text); };
  const paused1 = await enforceDrawdownLimit(db, USER, notify);
  assert.equal(paused1, true);
  assert.equal(isTradingHalted(USER), true, "trading must genuinely be halted now -- the real mechanism /stop uses");
  assert.equal(notifications.length, 1, "must notify exactly once for this real breach");
  assert.match(notifications[0], /Daily loss limit hit/);
  console.log(`    real notification sent: "${notifications[0]}"`);
  console.log(`    isTradingHalted(USER) = ${isTradingHalted(USER)}`);

  console.log("\n[4] A second call the SAME real day does NOT re-notify -- already paused, already told...\n");
  const paused2 = await enforceDrawdownLimit(db, USER, notify);
  assert.equal(paused2, true, "must still report as breached/paused");
  assert.equal(notifications.length, 1, "must genuinely NOT send a second notification for the same real day's breach");
  console.log(`    confirmed: still 1 real notification after a second call -- no spam`);

  console.log("\n[5] A user with real profit today never breaches, regardless of the limit...\n");
  const PROFIT_USER = "user-drawdown-profit-1";
  await seedAccountBalance(PROFIT_USER, 1000);
  const change2 = proposeProtectedLimitChange(PROFIT_USER, "maxDailyLossPct", 5, "test");
  approveProtectedLimitChange(PROFIT_USER, change2.id);
  logClosedTrade(db, PROFIT_USER, { symbol: "XAUUSD", pnl: 200, reason: "tp" });
  assert.equal(checkDrawdown(db, PROFIT_USER).breached, false, "a real profitable day must never breach");
  console.log("    confirmed: real net profit today -> never breaches, regardless of the configured limit");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(workDir, { recursive: true, force: true });
  });
