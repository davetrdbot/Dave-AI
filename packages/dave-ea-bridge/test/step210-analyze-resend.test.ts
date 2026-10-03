import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { createEaWebhookServer, getOrCreateEaWebhook, peekQueue, type EaCommand } from "../src/ea-webhook.js";
import { requestAnalysis } from "../src/analysis-request.js";

/** An analyze command the EA never received (its reply was lost) is sent once more, same id. */
process.chdir(mkdtempSync(join(tmpdir(), "dave-ea-resend-")));
const OWNER = "user-ea-resend-1";
const webhook = getOrCreateEaWebhook(OWNER);
const server = createEaWebhookServer();
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const post = (body: unknown): Promise<{ commands: EaCommand[] }> =>
  new Promise((resolve, reject) => {
    const json = JSON.stringify(body);
    const req = request({ hostname: "127.0.0.1", port, path: webhook.path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(json) } }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve(JSON.parse(d)));
    });
    req.on("error", reject);
    req.write(json);
    req.end();
  });
const hb = { type: "heartbeat", account: "1", balance: 1000, positions: [], pendingOrders: [] };

const pending = requestAnalysis(OWNER, "all", "EURUSD", "H1", { timeoutMs: 5000, pollIntervalMs: 20, resendAfterMs: 200 });
// The EA's report picks the command up -- and then that reply is "lost" (we just ignore it).
const first = await post(hb);
const lost = first.commands.find((c) => c.action === "analyze") as { id: string } | undefined;
assert.ok(lost, "command handed out");
assert.equal(peekQueue(OWNER).length, 0, "queue is empty after hand-out");
await new Promise((r) => setTimeout(r, 400));
const again = peekQueue(OWNER).find((c) => c.id === lost.id);
assert.ok(again, "the same command (same id) is queued again after the resend window");
const second = await post(hb);
assert.ok(second.commands.some((c) => c.id === lost.id), "the EA gets it on its next report");
await post({ ...hb, results: [{ commandId: lost.id, status: "ok", data: { ok: 1 } }] });
assert.deepEqual(await pending, { ok: 1 }, "the answer to the resent command completes the request");
await new Promise((r) => setTimeout(r, 300));
assert.equal(peekQueue(OWNER).filter((c) => c.id === lost.id).length, 0, "sent at most once more");
server.close();
console.log("=== ALL ASSERTIONS PASSED ===");
process.exit(0);
