import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { DaveDatabase } from "@dave/db";
import { addProviderKey, setModelConfig } from "@dave/brain";
import { createEaWebhookServer, getOrCreateEaWebhook, type EaCommand } from "@dave/ea-bridge";
import type { TelegramUpdate } from "@dave/telegram";
import { runSetupPanel } from "../src/setup-panel.js";
import { handleWorkerBotReactiveUpdate } from "../src/setup-panel.js";
import { setWorkerBotToken, setWorkerBotId, setPanelGroupChatId, startPanelDiscussionSession } from "../src/worker-bot-tokens.js";

/**
 * Real proof for the user's explicit ask: "add to the workers prompt that they are risk taker
 * there is nothing like perfect setup... when a opportunity comes take it." Confirms the real
 * risk-taker framing genuinely reaches every one of the 4 real system prompts the Setup Panel
 * uses -- the 7 analytical specialists, the Goal & Risk Appetite voice, the synthesis step, and
 * the live reactive replies -- by inspecting the REAL request bodies sent to the provider, not
 * just reading the source.
 */

console.log("=== Real proof: the risk-taker / no-perfect-setup framing reaches every real Setup Panel prompt ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-risk-taker-prompts-"));
process.chdir(workDir);
const OWNER = "user-risk-taker-prompts-1";
const RISK_TAKER_PHRASE = "no such thing as a perfect setup";

async function main() {
  const db = new DaveDatabase(join(workDir, "dave.db"));
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

  const systemPromptsSeen: string[] = [];
  const realFetch = globalThis.fetch;
  let openaiCalls = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const urlStr = String(url);
    if (urlStr.includes("api.openai.com")) {
      openaiCalls++;
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const systemMsg = (body.messages as { role: string; content: string }[]).find((m) => m.role === "system");
      if (systemMsg) systemPromptsSeen.push(systemMsg.content);
      const tools = (body.tools ?? []) as { function: { name: string } }[];
      const toolNames: string[] = tools.map((t) => t.function.name);
      const alreadyCalledTool = (body.messages as { role: string }[]).some((m) => m.role === "tool");
      if (toolNames.some((n) => n.startsWith("get_"))) {
        if (!alreadyCalledTool) {
          const toolName = toolNames.find((n) => n.startsWith("get_"))!;
          return new Response(JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: `c${openaiCalls}`, type: "function", function: { name: toolName, arguments: JSON.stringify({ symbol: "EURUSD" }) } }] } }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: "Real bullish finding." } }] }), { status: 200 });
      }
      if (!alreadyCalledTool) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: `c${openaiCalls}`, type: "function", function: { name: "propose_setup", arguments: JSON.stringify({ direction: "buy", confidence: 75, reasoning: "Real broad agreement." }) } }] } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "Recorded." } }] }), { status: 200 });
    }
    if (urlStr.includes("api.telegram.org")) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    return realFetch(url, init);
  }) as typeof fetch;

  try {
    console.log("[1] Every specialist's real system prompt (analytical + Goal & Risk Appetite + synthesis) genuinely carries the risk-taker framing...\n");
    await runSetupPanel({ db, ownerUserId: OWNER, symbol: "EURUSD", timeframe: "H1" });
    assert.ok(systemPromptsSeen.length > 0, "must have genuinely captured real system prompts");
    const missingFraming = systemPromptsSeen.filter((p) => !p.toLowerCase().includes(RISK_TAKER_PHRASE));
    assert.equal(missingFraming.length, 0, `every real system prompt must carry the risk-taker framing -- ${missingFraming.length}/${systemPromptsSeen.length} were missing it`);
    assert.ok(systemPromptsSeen.some((p) => p.includes("Goal & Risk Appetite")), "the Goal & Risk Appetite voice's own prompt must be among those captured");
    console.log(`    confirmed: all ${systemPromptsSeen.length} real system prompts (specialists + goal_risk + synthesis) carry "${RISK_TAKER_PHRASE}"`);

    console.log("\n[2] The real LIVE REACTIVE reply prompt also carries the framing...\n");
    systemPromptsSeen.length = 0;
    setPanelGroupChatId(OWNER, -100555);
    setWorkerBotToken(OWNER, "Structure & Liquidity", "111:structure-token");
    setWorkerBotId(OWNER, "Structure & Liquidity", 5001);
    setWorkerBotToken(OWNER, "Momentum & Trend", "222:momentum-token");
    setWorkerBotId(OWNER, "Momentum & Trend", 5002);
    const threadId = "panel:EURUSD:reactive-test";
    startPanelDiscussionSession(OWNER, threadId);
    const update: TelegramUpdate = {
      update_id: 1,
      message: { message_id: 1, chat: { id: -100555, type: "supergroup" }, from: { id: 5002, is_bot: true }, text: "Momentum looks strong.", date: Date.now() / 1000 },
    } as TelegramUpdate;
    await handleWorkerBotReactiveUpdate({ db, ownerUserId: OWNER, specialist: "Structure & Liquidity", update });
    assert.ok(systemPromptsSeen.length > 0, "the real reactive turn must genuinely have made a real provider call");
    assert.ok(systemPromptsSeen[0].toLowerCase().includes(RISK_TAKER_PHRASE), "the real live reactive-reply prompt must also carry the risk-taker framing");
    console.log(`    confirmed: real reactive-reply prompt carries "${RISK_TAKER_PHRASE}"`);

    console.log("\n=== ALL ASSERTIONS PASSED ===");
  } finally {
    eaRunning = false;
    await eaPoller;
    eaServer.close();
    globalThis.fetch = realFetch;
  }
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
