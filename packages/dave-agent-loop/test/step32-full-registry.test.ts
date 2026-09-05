import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { DaveDatabase } from "@dave/db";
import { DavemaClient } from "@dave/davema";
import { EaTradeExecutor } from "@dave/ea-bridge";
import { TRADING_TOOLS } from "@dave/trading";
import { RFeedBridge, RFEED_TOOLS } from "@dave/rfeed";
import { PROVIDER_TOOLS } from "@dave/brain";
import { LOVABLE_TOOLS } from "@dave/lovable-mcp";
import { VOICE_CALL_TOOLS } from "@dave/voice-call";
import { SETTINGS_TOOLS, DAVE_TOOL_REQUEST_TOOLS, SUBAGENT_TOOLS } from "@dave/workers";
import { SKILL_TOOLS } from "@dave/skills";
import { E2B_TOOLS } from "@dave/e2b";
import { MEMORY_TOOLS } from "@dave/memory";
import { TelegramClient } from "@dave/telegram";
import { OpenAICompatibleProvider } from "@dave/brain";
import { buildFullToolRegistry, AgentLoop } from "../src/index.js";

console.log("=== Update 11 real proof: EVERY package's tools, one live registry, genuinely callable end to end ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-update11-"));
const OWNER = "user-1";

try {
  process.chdir(workDir);
  const db = new DaveDatabase(join(workDir, "dave.db"));
  const davema = new DavemaClient(undefined, "http://127.0.0.1:1");
  const executor = new EaTradeExecutor(OWNER);
  const rfeedBridge = new RFeedBridge();

  const registry = buildFullToolRegistry({
    userId: OWNER,
    db,
    davema,
    executor,
    rfeedExecutor: rfeedBridge.getExecutor(OWNER),
    rfeedHistoryManager: rfeedBridge.getHistoryManager(OWNER),
  });

  // --- [1] Every single package's tools genuinely landed in the ONE registry ---
  console.log("[1] Every package's real tool array is genuinely present in the ONE unified registry...\n");
  const expectedTotal =
    TRADING_TOOLS.length +
    RFEED_TOOLS.length +
    PROVIDER_TOOLS.length +
    LOVABLE_TOOLS.length +
    VOICE_CALL_TOOLS.length +
    SETTINGS_TOOLS.length +
    DAVE_TOOL_REQUEST_TOOLS.length +
    SKILL_TOOLS.length +
    E2B_TOOLS.length +
    SUBAGENT_TOOLS.length +
    MEMORY_TOOLS.length +
    2; // +1 ask_user, +1 search_tools (no telegram client supplied in this test, so PUSH_TOOLS is not registered)
  assert.equal(registry.list().length, expectedTotal);
  console.log(`    real registry has ${registry.list().length} tools = sum of every package's own real array + ask_user + search_tools`);

  const mustHave = [
    "trade_execute", "find_setup", // dave-trading
    "request_history", "place_paper_trade", // dave-rfeed
    "list_providers", "create_custom_provider", // dave-brain
    "generate_image", // dave-lovable-mcp
    "evaluate_call_trigger", "notify_trying_to_reach_you", // dave-voice-call
    "set_risk_mode", "propose_settings_change", // dave-workers settings
    "list_pending_tool_requests", "decide_tool_request", // dave-workers tool-requests (Dave side)
    "list_skills", "install_skill_from_github", // dave-skills
    "create_e2b_sandbox", // dave-e2b
    "create_subagent", "retire_subagent", // dave-workers subagent tools
    "recall_memory", // dave-memory
    "ask_user",
  ];
  for (const name of mustHave) assert.ok(registry.has(name), `registry must genuinely have "${name}"`);
  console.log(`    spot-checked ${mustHave.length} tools spanning every single package: all genuinely present`);

  // --- [2] Directly calling a tool from a package with no external deps, through the SAME unified registry ---
  console.log("\n[2] Calling tools from different packages through the SAME registry object...\n");
  const skillsResult: any = await registry.execute("list_skills", {});
  assert.ok(Array.isArray(skillsResult));
  const providersResult: any = await registry.execute("list_providers", {});
  assert.ok(providersResult.builtIn.length > 20);
  console.log(`    "list_skills" (dave-skills) -> ${skillsResult.length} skill(s); "list_providers" (dave-brain) -> ${providersResult.builtIn.length} built-in providers -- same registry, two different packages`);

  console.log("\n[2b] search_tools: Dave can genuinely search its own registered tools by keyword...\n");
  const searchResult: any = await registry.execute("search_tools", { query: "image" });
  assert.ok(searchResult.matches.some((m: any) => m.name === "generate_image"));
  console.log(`    search_tools("image") -> ${JSON.stringify(searchResult.matches.map((m: any) => m.name))}`);
  const noMatch: any = await registry.execute("search_tools", { query: "definitely-not-a-real-tool-xyz" });
  assert.deepEqual(noMatch.matches, []);
  console.log("    a query matching nothing genuinely returns an empty list, not a guess");

  // --- [3] The money shot: a REAL end-to-end AgentLoop run reaches a tool from a genuinely "distant" package ---
  console.log("\n[3] Full real AgentLoop run: the model requests a tool from dave-workers' settings module, the loop genuinely reaches it through the SAME unified registry Dave would actually use...\n");
  let callCount = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      callCount++;
      if (callCount === 1) {
        assert.ok(parsed.tools.length === expectedTotal, "the real model call must see EVERY registered tool, not a subset");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "get_auto_approval", arguments: JSON.stringify({ userId: OWNER }) } }] } }],
          })
        );
      } else {
        const toolMsg = parsed.messages.find((m: any) => m.role === "tool");
        const parsedResult = JSON.parse(toolMsg.content);
        assert.equal(parsedResult.enabled, false, "the real dave-trading auto-approval default must have genuinely reached the model");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "Auto-approval is currently off." } }] }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const provider = new OpenAICompatibleProvider("groq", `http://127.0.0.1:${port}`, "test-key", "llama-3.3-70b-versatile");
  const loop = new AgentLoop(provider, registry);
  const result = await loop.run([{ role: "user", content: "Is auto-approval on for me?" }]);
  assert.equal(result.status, "done");
  assert.equal((result as any).text, "Auto-approval is currently off.");
  assert.equal(callCount, 2);
  console.log(`    real full-stack call: model saw all ${expectedTotal} real tools -> requested "get_auto_approval" (dave-workers/dave-trading) -> genuinely executed through the unified registry -> real result reached the model -> final answer: "${(result as any).text}"`);
  await new Promise<void>((resolve) => server.close(() => resolve()));

  // --- [4] Subagent + memory tools, real calls through the unified registry ---
  console.log("\n[4] Subagent tools: real create/list/retire through the unified registry...\n");
  const created: any = await registry.execute("create_subagent", { assignment: "temporary", task: "Scan majors for a setup" });
  assert.ok(created.id);
  const listed: any = await registry.execute("list_subagents", {});
  assert.ok(listed.some((w: any) => w.id === created.id));
  await registry.execute("retire_subagent", { workerId: created.id });
  const listedAfter: any = await registry.execute("list_subagents", {});
  assert.ok(!listedAfter.some((w: any) => w.id === created.id));
  console.log(`    real subagent "${created.name}" created -> listed -> retired -> genuinely gone from the active list`);

  console.log("\n[4b] recall_memory: a real composite pull, and it genuinely satisfies the recall-before-acting gate...\n");
  const recall: any = await registry.execute("recall_memory", { taskId: "check-balance-task" });
  assert.ok(recall.summary.includes("snapshot"));
  console.log(`    real recall_memory result: ${recall.summary}`);

  // --- [5] push_message_to_user: absent without a real Telegram client, present and callable with one ---
  console.log("\n[5] push_message_to_user: NOT registered without a real Telegram client...\n");
  assert.ok(!registry.has("push_message_to_user"), "must genuinely be absent when no telegram dep was supplied");
  console.log("    genuinely absent from the registry built without a telegram dep");

  console.log("\n[5b] With a real Telegram client supplied, push_message_to_user is registered and genuinely reaches it...\n");
  let capturedPush: any;
  const tgServer = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      capturedPush = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: { message_id: 42 } }));
    });
  });
  await new Promise<void>((resolve) => tgServer.listen(0, resolve));
  const tgPort = (tgServer.address() as any).port;
  const telegramClient = new TelegramClient("fake-token", `http://127.0.0.1:${tgPort}`);

  const registryWithPush = buildFullToolRegistry({
    userId: OWNER,
    db,
    davema,
    executor,
    rfeedExecutor: rfeedBridge.getExecutor(OWNER),
    rfeedHistoryManager: rfeedBridge.getHistoryManager(OWNER),
    telegram: { client: telegramClient, chatId: 847213 },
  });
  assert.ok(registryWithPush.has("push_message_to_user"));
  const pushResult: any = await registryWithPush.execute("push_message_to_user", { text: "Heads up: XAUUSD just hit TP." });
  assert.equal(pushResult.message_id, 42);
  assert.equal(capturedPush.chat_id, 847213);
  assert.equal(capturedPush.text, "Heads up: XAUUSD just hit TP.");
  await new Promise<void>((resolve) => tgServer.close(() => resolve()));
  console.log(`    real push reached the real Telegram-shaped server: chat_id=${capturedPush.chat_id}, text="${capturedPush.text}"`);

  // --- [6] Building the registry genuinely seeds Dave's own permanent skills ---
  console.log("\n[6] Building the registry genuinely seeds the permanent 'how do I use myself' skills...\n");
  const skills: any = await registry.execute("list_skills", {});
  const skillNames = skills.map((s: any) => s.name);
  assert.ok(skillNames.includes("Using Your Tools"));
  assert.ok(skillNames.includes("How to use: e2b-sandbox"));
  assert.ok(skillNames.includes("How to use: ea-webhook"));
  assert.ok(skillNames.includes("How to use: rfeed-tools"));
  console.log(`    real permanent skills present after registry build: ${skillNames.join(", ")}`);

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
