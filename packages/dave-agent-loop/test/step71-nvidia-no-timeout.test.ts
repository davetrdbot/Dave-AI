import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { DaveDatabase } from "@dave/db";
import { DavemaClient } from "@dave/davema";
import { EaTradeExecutor } from "@dave/ea-bridge";
import { addProviderKey, setModelConfig, listProviderCatalog } from "@dave/brain";
import { getOrCreateTelegramWebhookRoute } from "@dave/telegram";
import { startTelegramBotServer } from "../src/telegram-bot-server.js";
import { dispatchCallback, type CommandRouterDeps } from "../src/command-router.js";
import { TelegramClient } from "@dave/telegram";
import { getProviderTimeoutConfig } from "../src/provider-timeout-config.js";

/**
 * Real proof for the user's explicit follow-up: "actually specially for Nvidia they shouldn't be
 * any timeout" -- nvidia-nim genuinely runs slower/less predictably (real large-model cold starts
 * on build.nvidia.com) than the other providers, so it must NEVER be aborted by the configured
 * primary/fallback timeout, even when that timeout is set very short. This is proven by configuring
 * the shortest legal primary timeout (3s), setting nvidia-nim as the primary provider, and having
 * the mocked nvidia-nim endpoint genuinely honor real AbortSignal semantics but only resolve after
 * 5 real seconds -- well past the 3s configured timeout. If nvidia-nim were still subject to that
 * timeout, this request would be aborted and never reach the user; because it's exempted, the real
 * reply still arrives.
 */

console.log("=== Real proof: nvidia-nim is exempt from the configured/default provider timeout ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-nvidia-no-timeout-"));
process.chdir(workDir);
const OWNER = "user-nvidia-no-timeout-1";
const CHAT_ID = 777888;

const nvidiaEntry = listProviderCatalog().find((e) => e.id === "nvidia-nim")!;

console.log("[1] Configure the shortest legal primary timeout (3s) -- this WOULD abort any other provider...");
const db = new DaveDatabase(join(workDir, "dave.db"));
const client = new TelegramClient("000000:fake-token-for-transport-mock");
const routerDeps: CommandRouterDeps = { db, client, userId: OWNER, publicBaseUrl: "https://dave.example.com" };
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 })) as typeof fetch;
try {
  await dispatchCallback(routerDeps, { id: "cb1", data: "providertimeout:primary:3", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
} finally {
  globalThis.fetch = realFetch;
}
assert.equal(getProviderTimeoutConfig(OWNER).primarySeconds, 3);
console.log("    real configured primary timeout: 3s");

console.log("\n[2] A real request to nvidia-nim genuinely takes 5s (longer than the 3s configured timeout) and still completes...");
const providerCallTimestamps: { provider: string; at: number }[] = [];
const sentMessages: string[] = [];
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const urlStr = String(url);
  if (urlStr.includes("api.telegram.org")) {
    const method = urlStr.split("/").pop() ?? "";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    if (method === "setWebhook" || method === "setMyCommands" || method === "setMyDescription" || method === "setMyShortDescription") {
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }
    if (body?.text) sentMessages.push(body.text);
    if (body?.rich_message?.html) sentMessages.push(body.rich_message.html);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  }
  if (urlStr === `${nvidiaEntry.baseUrl}${nvidiaEntry.chatPath}`) {
    providerCallTimestamps.push({ provider: "nvidia-nim", at: Date.now() });
    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      const abort = () => reject(new DOMException("Aborted", "AbortError"));
      if (signal) {
        if (signal.aborted) { abort(); return; }
        signal.addEventListener("abort", abort);
      }
      setTimeout(() => resolve(new Response(JSON.stringify({ choices: [{ message: { content: "Real reply from nvidia-nim, arrived after 5 real seconds." } }] }), { status: 200 })), 5000);
    });
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

let server: Awaited<ReturnType<typeof startTelegramBotServer>> | undefined;
try {
  addProviderKey(db, OWNER, "nvidia-nim", "primary key", { apiKey: "nvapi-fake", model: "meta/llama-3.1-405b-instruct" });
  setModelConfig(OWNER, { primary: "nvidia-nim", fallback: [] });

  const davema = new DavemaClient(undefined, "http://127.0.0.1:1");
  const executor = new EaTradeExecutor(OWNER);
  server = await startTelegramBotServer({ ownerUserId: OWNER, db, davema, executor, botToken: "000000:fake-bot-token", publicBaseUrl: "https://dave.example.com", systemPrompt: "You are Dave." });
  await new Promise<void>((resolve) => server!.server.listen(0, "127.0.0.1", resolve));
  const port = (server.server.address() as { port: number }).port;
  const webhookPath = new URL(server.webhookUrl).pathname;
  const routeInfo = getOrCreateTelegramWebhookRoute(OWNER);

  const postUpdate = (body: unknown) =>
    new Promise<void>((resolve, reject) => {
      const json = JSON.stringify(body);
      const req = request(
        { hostname: "127.0.0.1", port, path: webhookPath, method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": routeInfo.secretToken, "content-length": Buffer.byteLength(json) } },
        (res) => { res.resume(); res.on("end", resolve); }
      );
      req.on("error", reject);
      req.write(json);
      req.end();
    });

  const before = Date.now();
  await postUpdate({ update_id: 1, message: { message_id: 1, chat: { id: CHAT_ID }, text: "check the market", date: Date.now() / 1000 } });
  await new Promise((r) => setTimeout(r, 6000));
  const elapsedMs = Date.now() - before;

  console.log(`    real elapsed wait: ${elapsedMs}ms (past the 3s configured timeout)`);
  assert.deepEqual(providerCallTimestamps.map((c) => c.provider), ["nvidia-nim"], "nvidia-nim must genuinely be the only provider tried");
  const nvidiaReply = sentMessages.find((t) => t.includes("Real reply from nvidia-nim"));
  assert.ok(nvidiaReply, "nvidia-nim's real 5s-later response must still reach the user -- it must NOT have been aborted at the configured 3s timeout");
  console.log(`    real reply reached the user despite exceeding the 3s configured timeout: "${nvidiaReply}"`);

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  server?.server.close();
  globalThis.fetch = realFetch;
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
