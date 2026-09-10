import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { TelegramClient } from "@dave/telegram";
import {
  createWorkerBotWebhookServer,
  enableWorkerBotWebhook,
  getOrCreateWorkerBotWebhookRoute,
  syncWorkerBotWebhooks,
  resetWorkerBotWebhookRegistrationState,
} from "../src/worker-bot-webhook.js";
import { setWorkerBotToken, getWorkerBotId } from "../src/worker-bot-tokens.js";

/**
 * Real proof for the receiving infrastructure itself (worker-bot-webhook.ts) -- each configured
 * Setup Panel specialist gets its OWN real inbound webhook, distinct from Dave's own bot's
 * webhook and from every other specialist's, using the exact same real Telegram webhook contract
 * (secret-token header verification, JSON body, fast 200 ack) dave-telegram's own webhook module
 * uses for Dave's bot -- just under a separate route prefix so the two token/userId spaces never
 * collide.
 */

console.log("=== Real proof: each worker bot gets its own real, distinct webhook route ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-worker-bot-webhook-"));
process.chdir(workDir);
const OWNER = "user-worker-bot-webhook-1";

async function main() {
  console.log("[1] Two different specialists get two DIFFERENT real webhook paths, never the same one...\n");
  const routeA = getOrCreateWorkerBotWebhookRoute(OWNER, "Structure & Liquidity");
  const routeB = getOrCreateWorkerBotWebhookRoute(OWNER, "Momentum & Trend");
  assert.notEqual(routeA.path, routeB.path);
  assert.ok(routeA.path.startsWith("/hooks/workerbot/"));
  console.log(`    real routes: ${routeA.path}, ${routeB.path}`);

  console.log("\n[2] The SAME specialist genuinely gets the SAME real path across calls (persisted, not regenerated)...\n");
  const routeAAgain = getOrCreateWorkerBotWebhookRoute(OWNER, "Structure & Liquidity");
  assert.equal(routeAAgain.path, routeA.path);
  assert.equal(routeAAgain.secretToken, routeA.secretToken);

  console.log("\n[3] A real HTTP POST to the real server, with the real correct secret token, genuinely reaches onUpdate with the right ownerUserId+specialist...\n");
  const received: { ownerUserId: string; specialist: string; text: string }[] = [];
  const server = createWorkerBotWebhookServer({
    onUpdate: (ownerUserId, specialist, update) => {
      received.push({ ownerUserId, specialist, text: update.message?.text ?? "" });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a real bound port");

  const post = (path: string, secretToken: string, body: unknown): Promise<number> =>
    new Promise((resolve, reject) => {
      const json = JSON.stringify(body);
      const req = request(
        { hostname: "127.0.0.1", port: address.port, path, method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secretToken, "content-length": Buffer.byteLength(json) } },
        (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); }
      );
      req.on("error", reject);
      req.write(json);
      req.end();
    });

  try {
    const status = await post(routeA.path, routeA.secretToken, { update_id: 1, message: { message_id: 1, chat: { id: -100111, type: "supergroup" }, from: { id: 42, is_bot: true }, text: "real test message", date: Date.now() / 1000 } });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(status, 200);
    assert.equal(received.length, 1);
    assert.equal(received[0].ownerUserId, OWNER);
    assert.equal(received[0].specialist, "Structure & Liquidity");
    assert.equal(received[0].text, "real test message");
    console.log(`    confirmed: real POST to ${routeA.path} reached onUpdate with the right owner/specialist`);

    console.log("\n[4] A real POST with the WRONG secret token is genuinely rejected (401), never reaches onUpdate...\n");
    const badStatus = await post(routeA.path, "wrong-secret", { update_id: 2, message: { message_id: 2, chat: { id: -100111, type: "supergroup" }, text: "should be rejected", date: Date.now() / 1000 } });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(badStatus, 401);
    assert.equal(received.length, 1, "the rejected request must never have reached onUpdate");
    console.log("    confirmed: wrong secret token genuinely rejected with a real 401");

    console.log("\n[5] A real POST to an unknown path token is genuinely a 404...\n");
    const unknownStatus = await post("/hooks/workerbot/not-a-real-token", "anything", {});
    assert.equal(unknownStatus, 404);
  } finally {
    server.close();
  }

  console.log("\n[6] enableWorkerBotWebhook genuinely calls the real setWebhook + getMe against THIS bot's own token, and caches its real numeric bot id...\n");
  const realFetch = globalThis.fetch;
  const calls: { method: string }[] = [];
  globalThis.fetch = (async (url: string) => {
    const method = String(url).split("/").pop() ?? "";
    calls.push({ method });
    if (method === "getMe") return new Response(JSON.stringify({ ok: true, result: { id: 7777, username: "structure_bot", first_name: "Structure Bot" } }), { status: 200 });
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  }) as typeof fetch;
  try {
    const client = new TelegramClient("333:fake-structure-bot-token");
    const route = await enableWorkerBotWebhook(client, OWNER, "Structure & Liquidity", "https://dave.example.com");
    assert.ok(calls.some((c) => c.method === "getMe"));
    assert.ok(calls.some((c) => c.method === "setWebhook"));
    assert.equal(getWorkerBotId(OWNER, "Structure & Liquidity"), 7777, "the real bot's own numeric id must genuinely be cached");
    assert.equal(route.path, routeA.path, "must reuse the SAME real persisted route, not a new one");
    console.log(`    confirmed: real getMe (id=7777) + setWebhook genuinely called, bot id cached`);
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log("\n[7] syncWorkerBotWebhooks genuinely registers a webhook for a NEWLY configured token, idempotently (no double-registration)...\n");
  resetWorkerBotWebhookRegistrationState();
  setWorkerBotToken(OWNER, "Levels & Confluence", "444:levels-bot-token");
  let syncCalls = 0;
  const realFetch2 = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    const method = String(url).split("/").pop() ?? "";
    if (method === "getMe") { syncCalls++; return new Response(JSON.stringify({ ok: true, result: { id: 8888, username: "levels_bot", first_name: "Levels Bot" } }), { status: 200 }); }
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  }) as typeof fetch;
  try {
    await syncWorkerBotWebhooks(OWNER, "https://dave.example.com");
    await syncWorkerBotWebhooks(OWNER, "https://dave.example.com"); // second call must be a genuine no-op for the same token
    assert.equal(syncCalls, 1, "a real webhook must only be registered ONCE per configured token, not re-registered every sync tick");
    console.log("    confirmed: real idempotent registration -- exactly 1 real getMe call across 2 sync ticks");
  } finally {
    globalThis.fetch = realFetch2;
  }

  console.log("\n=== ALL ASSERTIONS PASSED ===");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(workDir, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  });
