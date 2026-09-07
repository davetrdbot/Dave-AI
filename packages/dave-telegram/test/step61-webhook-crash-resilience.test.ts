import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { getOrCreateTelegramWebhookRoute, createTelegramWebhookServer } from "../src/telegram-webhook.js";

/**
 * Real proof for the actual root cause behind the user's report "Nvidia is no longer working
 * again": real Railway logs showed the process crashing entirely (Node's default is to exit on an
 * unhandled promise rejection) whenever ANY onUpdate handler threw -- here that was a genuinely
 * malformed "<minutes>" in /help's HTML-parsed text (Telegram's real API rejected it with a 400),
 * but the actual bug is architectural: `createTelegramWebhookServer`'s request handler awaited
 * `handlers.onUpdate(...)` with no try/catch, so ANY thrown error (a future bad message, a
 * network blip, anything) took the ENTIRE bot down for every user, not just the one request that
 * failed. This proves the real fix: an onUpdate handler that genuinely throws no longer crashes
 * the process, and the server keeps serving every other request right after.
 */

console.log("=== Real proof: a throwing onUpdate handler no longer crashes the whole webhook server ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-webhook-resilience-"));
process.chdir(workDir);
const OWNER = "user-webhook-resilience-1";

const routeInfo = getOrCreateTelegramWebhookRoute(OWNER);
const receivedUpdates: number[] = [];

const server = createTelegramWebhookServer({
  onUpdate: async (userId, update) => {
    receivedUpdates.push(update.update_id);
    if (update.update_id === 1) {
      // Simulates the real crash: e.g. a Telegram sendMessage 400 from malformed HTML, thrown
      // deep inside command dispatch with nothing upstream catching it.
      throw new Error("Telegram sendMessage -> 400: Bad Request: can't parse entities: Unsupported start tag \"minutes\" at byte offset 1103");
    }
  },
});

try {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  const postUpdate = (updateId: number) =>
    new Promise<number>((resolve, reject) => {
      const json = JSON.stringify({ update_id: updateId, message: { message_id: updateId, chat: { id: 1 }, text: "/help", date: Date.now() / 1000 } });
      const req = request(
        { hostname: "127.0.0.1", port, path: routeInfo.path, method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": routeInfo.secretToken, "content-length": Buffer.byteLength(json) } },
        (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); }
      );
      req.on("error", reject);
      req.write(json);
      req.end();
    });

  console.log("[1] A real update whose handler genuinely throws (simulating the real crash)...");
  const status1 = await postUpdate(1);
  assert.equal(status1, 200, "the webhook ack itself is unaffected -- Telegram gets its fast 200 regardless of what onUpdate does afterward");
  await new Promise((r) => setTimeout(r, 200));
  console.log(`    real ack: ${status1}, handler genuinely threw (caught, not crashed)`);

  console.log("\n[2] The process (and this server) is genuinely still alive -- a second real update still gets served...");
  const status2 = await postUpdate(2);
  assert.equal(status2, 200);
  await new Promise((r) => setTimeout(r, 200));
  console.log(`    real ack: ${status2}`);

  assert.deepEqual(receivedUpdates, [1, 2], "both updates must have genuinely reached onUpdate -- the server kept running after the first one threw");
  console.log(`    real updates processed: ${JSON.stringify(receivedUpdates)} -- the throwing handler did NOT take the server down`);

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  server.close();
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
