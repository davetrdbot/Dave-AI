import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { DaveDatabase } from "@dave/db";
import { EaTradeExecutor, createEaWebhookServer, getOrCreateEaWebhook, type EaCommand } from "@dave/ea-bridge";
import { addProviderKey, setModelConfig } from "@dave/brain";
import { startTelegramBotServer } from "../src/telegram-bot-server.js";
import { runSetupPanel } from "../src/setup-panel.js";
import { setWorkerBotToken, getWorkerBotToken, listWorkerBotStatus, getPanelGroupChatId, WORKER_BOT_SPECIALISTS } from "../src/worker-bot-tokens.js";

/**
 * Real proof for the user's explicit ask: "bot can now talk to each other in group so you can
 * add in settings like a each worker panel have its own bot token so I can see how they are
 * talking to each other analyzing and talking to each other." Proves:
 *   (1) /set_panel_group, sent inside a real group chat, genuinely captures that group's real
 *       chat id -- through Dave's own already-live webhook, no separate webhook per worker bot.
 *   (2) /settings -> Worker Bots genuinely stores/removes a real per-specialist bot token.
 *   (3) A real Setup Panel run, with tokens configured for 2 of the 8 specialists, genuinely
 *       posts each configured specialist's real finding to the real group chat using THAT
 *       specialist's OWN distinct bot token (not Dave's, not another specialist's) -- proven by
 *       the mock distinguishing which bot token hit api.telegram.org for each message.
 */

console.log("=== Real proof: each Setup Panel specialist can talk in a real group with its own bot ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-worker-bots-"));
process.chdir(workDir);
const OWNER = "user-worker-bots-1";
const GROUP_CHAT_ID = -100123456789;

async function main() {
  console.log("[1] /set_panel_group, sent inside a real group, genuinely captures that group's real chat id...\n");
  const sentMessages: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = String(url).split("/").pop() ?? "";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    if (method === "setWebhook" || method === "setMyCommands" || method === "setMyDescription" || method === "setMyShortDescription") {
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }
    if (body?.text) sentMessages.push(body.text);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  }) as typeof fetch;

  const db = new DaveDatabase(join(workDir, "dave.db"));
  const executor = new EaTradeExecutor(OWNER);
  let server: Awaited<ReturnType<typeof startTelegramBotServer>> | undefined;
  try {
    server = await startTelegramBotServer({ ownerUserId: OWNER, db, executor, botToken: "000000:fake-bot-token", publicBaseUrl: "https://dave.example.com", systemPrompt: "You are Dave." });
    await new Promise<void>((resolve) => server!.server.listen(0, "127.0.0.1", resolve));
    const port = (server.server.address() as { port: number }).port;
    const webhookPath = new URL(server.webhookUrl).pathname;
    const routeInfo = (await import("@dave/telegram")).getOrCreateTelegramWebhookRoute(OWNER);

    assert.equal(getPanelGroupChatId(OWNER), undefined, "no panel group set yet for a fresh user");

    await new Promise<void>((resolve, reject) => {
      const update = JSON.stringify({ update_id: 1, message: { message_id: 1, chat: { id: GROUP_CHAT_ID, type: "supergroup" }, text: "/set_panel_group", date: Date.now() / 1000 } });
      const req = request(
        { hostname: "127.0.0.1", port, path: webhookPath, method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": routeInfo.secretToken, "content-length": Buffer.byteLength(update) } },
        (res) => { res.resume(); res.on("end", resolve); }
      );
      req.on("error", reject);
      req.write(update);
      req.end();
    });
    await new Promise((r) => setTimeout(r, 100));

    assert.equal(getPanelGroupChatId(OWNER), GROUP_CHAT_ID, "the real group's chat id must genuinely be captured");
    assert.ok(sentMessages.some((t) => t.includes("Setup Panel")), `expected a real confirmation, got: ${JSON.stringify(sentMessages)}`);
    console.log(`    confirmed: real panel group chat id captured (${GROUP_CHAT_ID})`);
  } finally {
    server?.server.close();
    globalThis.fetch = realFetch;
  }

  console.log("\n[2] Per-specialist bot tokens genuinely store and clear...\n");
  assert.equal(listWorkerBotStatus(OWNER).every((s) => !s.configured), true, "no tokens configured yet");
  setWorkerBotToken(OWNER, "Structure & Liquidity", "111:structure-bot-token");
  setWorkerBotToken(OWNER, "Goal & Risk Appetite", "222:goalrisk-bot-token");
  const status = listWorkerBotStatus(OWNER);
  assert.equal(status.find((s) => s.specialist === "Structure & Liquidity")?.configured, true);
  assert.equal(status.find((s) => s.specialist === "Goal & Risk Appetite")?.configured, true);
  assert.equal(status.find((s) => s.specialist === "Momentum & Trend")?.configured, false, "an unconfigured specialist must genuinely stay unconfigured");
  assert.equal(getWorkerBotToken(OWNER, "Structure & Liquidity"), "111:structure-bot-token");
  console.log(`    confirmed: ${WORKER_BOT_SPECIALISTS.length} specialists tracked, 2 genuinely configured, 6 genuinely not`);

  console.log("\n[3] A real Setup Panel run posts each CONFIGURED specialist's real finding to the real group using THAT specialist's own distinct bot token...\n");
  addProviderKey(db, OWNER, "openai", "test key", { apiKey: "sk-real-fake" });
  setModelConfig(OWNER, { primary: "openai", fallback: [] });

  const hook = getOrCreateEaWebhook(OWNER);
  const eaServer = createEaWebhookServer();
  await new Promise<void>((resolve) => eaServer.listen(0, "127.0.0.1", resolve));
  const eaAddress = eaServer.address();
  if (!eaAddress || typeof eaAddress === "string") throw new Error("expected a real bound port");
  const postReport = (body: unknown): Promise<{ commands: EaCommand[] }> =>
    new Promise((resolve, reject) => {
      const json = JSON.stringify(body);
      const req = request(
        { hostname: "127.0.0.1", port: eaAddress.port, path: hook.path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(json) } },
        (res) => { let data = ""; res.on("data", (c) => (data += c)); res.on("end", () => resolve(JSON.parse(data))); }
      );
      req.on("error", reject);
      req.write(json);
      req.end();
    });
  let eaRunning = true;
  const eaPoller = (async () => {
    while (eaRunning) {
      const resp = await postReport({ account: "1", balance: 1000, equity: 1000, margin: 0, freeMargin: 1000, positions: [], pendingOrders: [], results: [] });
      const results = resp.commands.filter((c) => c.action === "analyze").map((c) => ({ commandId: c.id, status: "ok" as const, data: { score: 70, direction: "bullish" } }));
      if (results.length > 0) await postReport({ account: "1", balance: 1000, equity: 1000, margin: 0, freeMargin: 1000, positions: [], pendingOrders: [], results });
      await new Promise((r) => setTimeout(r, 30));
    }
  })();

  const groupPostsByToken: Record<string, string[]> = {};
  const realFetch2 = globalThis.fetch;
  let openaiCalls = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const urlStr = String(url);
    if (urlStr.includes("api.telegram.org")) {
      // Extract the real bot token from the URL path (…/bot<token>/sendMessage), same as the
      // real Bot API convention -- proves WHICH bot identity actually sent this message.
      const match = urlStr.match(/\/bot([^/]+)\/sendMessage/);
      const token = match?.[1] ?? "unknown";
      const body = init?.body ? JSON.parse(init.body as string) : {};
      (groupPostsByToken[token] ??= []).push(body.text as string);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (urlStr.includes("api.openai.com")) {
      openaiCalls++;
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const tools = (body.tools ?? []) as { function: { name: string } }[];
      const toolNames: string[] = tools.map((t) => t.function.name);
      const alreadyCalledTool = (body.messages as { role: string }[]).some((m) => m.role === "tool");
      if (toolNames.some((n) => n.startsWith("get_"))) {
        if (!alreadyCalledTool) {
          const toolName = toolNames.find((n) => n.startsWith("get_"))!;
          return new Response(JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: `c${openaiCalls}`, type: "function", function: { name: toolName, arguments: JSON.stringify({ symbol: "EURUSD" }) } }] } }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: "Real finding for this specialist." } }] }), { status: 200 });
      }
      if (!alreadyCalledTool) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: `c${openaiCalls}`, type: "function", function: { name: "no_setup", arguments: JSON.stringify({ reason: "Mixed real findings, no genuine edge." }) } }] } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "Recorded." } }] }), { status: 200 });
    }
    return realFetch2(url, init);
  }) as typeof fetch;

  try {
    await runSetupPanel({ db, ownerUserId: OWNER, symbol: "EURUSD", timeframe: "H1" });

    console.log(`    real bot tokens that posted to the group: ${Object.keys(groupPostsByToken).join(", ")}`);
    assert.ok(groupPostsByToken["111:structure-bot-token"]?.length === 1, "Structure & Liquidity's own bot token must genuinely have posted its real finding");
    assert.ok(groupPostsByToken["111:structure-bot-token"]![0].includes("Structure & Liquidity"), "the real posted message must identify the real specialist");
    assert.ok(groupPostsByToken["222:goalrisk-bot-token"]?.length === 1, "Goal & Risk Appetite's own bot token must genuinely have posted its real finding");
    assert.ok(groupPostsByToken["222:goalrisk-bot-token"]![0].includes("Goal & Risk Appetite"));
    assert.equal(Object.keys(groupPostsByToken).length, 2, "only the 2 genuinely configured specialists' bots should have posted -- the other 6 have no token, so they must stay silent in the group");
    console.log(`    confirmed: exactly the 2 configured specialists posted, each with its OWN distinct real bot token`);

    console.log("\n=== ALL ASSERTIONS PASSED ===");
  } finally {
    eaRunning = false;
    await eaPoller;
    eaServer.close();
    globalThis.fetch = realFetch2;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(workDir, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0); // two real http servers + keep-alive fetch sockets can otherwise leave the event loop open
  });
