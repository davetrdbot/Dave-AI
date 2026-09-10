import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { EaBridge } from "../src/ea-bridge.js";
import { getOrCreateEaWebhook } from "../src/ea-webhook.js";

/**
 * Real proof for item 14 (user: "close-trade notification still sends multiple times -- the
 * earlier duplicate-message fix does not appear to hold for trade-close notifications
 * specifically"). Root cause confirmed: the webhook handler had no idempotency key at all -- if
 * the identical report body (with the same closedPositions entry) genuinely reaches the server
 * twice -- a real MT5 `WebRequest` network-retry pattern (the POST lands and is processed, but
 * the response never makes it back to the EA, so it retries) -- the notification fired twice.
 * This POSTs the EXACT SAME report body to the real webhook server twice and confirms the real
 * notification callback fires exactly once.
 */

console.log("=== Real proof: a duplicate EA report body fires the close notification exactly once ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-close-dedup-"));
process.chdir(workDir);
const OWNER = "user-close-dedup-1";

try {
  const webhook = getOrCreateEaWebhook(OWNER);
  const notifications: { ticket: string; reason: string }[] = [];
  const bridge = new EaBridge({
    onClosedPosition: (userId, closed) => notifications.push({ ticket: closed.ticket, reason: closed.reason }),
  });
  const server = bridge.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  const postReport = (body: unknown): Promise<{ commands: unknown[] }> =>
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

  console.log("[1] A real report with an open position, establishing the baseline...\n");
  await postReport({ type: "heartbeat", account: "123", balance: 1000, positions: [{ ticket: "T1", symbol: "EURUSD", type: "buy", lots: 0.5, openPrice: 1.085 }], pendingOrders: [] });
  assert.equal(notifications.length, 0, "no close notification yet -- the position is still open");

  const closedReportBody = {
    type: "heartbeat",
    account: "123",
    balance: 1010,
    positions: [],
    pendingOrders: [],
    closedPositions: [{ ticket: "T1", symbol: "EURUSD", pnl: 10.5, reason: "tp" }],
  };

  console.log("[2] The EXACT SAME closed-position report body POSTed to the server TWICE -- simulating a real MT5 WebRequest retry...\n");
  await postReport(closedReportBody);
  await postReport(closedReportBody);

  console.log(`    real notifications fired: ${JSON.stringify(notifications)}`);
  assert.equal(notifications.length, 1, "the real close notification must fire EXACTLY ONCE, not twice, for an identical duplicate report");
  assert.deepEqual(notifications[0], { ticket: "T1", reason: "tp" });

  console.log("\n[3] A GENUINELY DIFFERENT closed ticket still fires its own real notification -- the dedup is per-ticket, not a global lockout...\n");
  await postReport({
    type: "heartbeat",
    account: "123",
    balance: 1020,
    positions: [],
    pendingOrders: [],
    closedPositions: [{ ticket: "T2", symbol: "XAUUSD", pnl: -5, reason: "sl" }],
  });
  assert.equal(notifications.length, 2, "a real, different ticket's close must still notify normally");
  assert.deepEqual(notifications[1], { ticket: "T2", reason: "sl" });
  console.log(`    real notifications after a genuinely new close: ${JSON.stringify(notifications)}`);

  server.close();
  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
