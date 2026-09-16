import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import { EaTradeExecutor } from "@dave/ea-bridge";
import { buildFullToolRegistry, buildToolCatalog, TOOL_CATALOG_CATEGORIES } from "../src/index.js";

console.log("=== Step 114 real proof: get_tool_catalog -- a real, structured, model-callable full tool catalog ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-step114-"));
const OWNER = "user-1";

try {
  process.chdir(workDir);
  const db = new DaveDatabase(join(workDir, "dave.db"));
  const executor = new EaTradeExecutor(OWNER);

  const registry = buildFullToolRegistry({ userId: OWNER, db, executor });

  // --- [1] The tool is genuinely registered ---
  console.log("[1] get_tool_catalog is genuinely registered in the real, full registry...\n");
  assert.ok(registry.has("get_tool_catalog"));
  console.log("    registered");

  // --- [2] Calling it returns every REAL registered tool, correctly grouped, nothing fabricated ---
  console.log("\n[2] Calling get_tool_catalog returns the real, complete categorized catalog...\n");
  const result: any = await registry.execute("get_tool_catalog", {});
  assert.ok(Array.isArray(result.categories) && result.categories.length > 5, "must genuinely return multiple real categories");
  assert.equal(typeof result.totalTools, "number");
  assert.equal(
    result.totalTools,
    registry.list().length,
    "totalTools must genuinely equal the real registry's total tool count -- no fabricated/stale number"
  );
  const flatNames = new Set(result.categories.flatMap((c: any) => c.tools.map((t: any) => t.name)));
  for (const tool of registry.list()) {
    assert.ok(flatNames.has(tool.name), `real registered tool "${tool.name}" must genuinely appear somewhere in the catalog, never silently dropped`);
  }
  console.log(`    ${result.totalCategories} real categories, ${result.totalTools} real tools total -- every single registered tool genuinely present`);

  // --- [3] Descriptions are the REAL registered descriptions, not paraphrased ---
  console.log("\n[3] Each entry's description is the SAME real string the tool was registered with...\n");
  const tradingCategory = result.categories.find((c: any) => c.category === "Trading");
  assert.ok(tradingCategory, "the real 'Trading' category must genuinely be present");
  const tradeExecuteEntry = tradingCategory.tools.find((t: any) => t.name === "trade_execute");
  assert.ok(tradeExecuteEntry);
  const realTool = registry.list().find((t) => t.name === "trade_execute")!;
  assert.equal(tradeExecuteEntry.description, realTool.description, "must genuinely be the real registered description, not a summary");
  console.log(`    trade_execute's catalog description matches its real registered description verbatim (${tradeExecuteEntry.description.length} chars)`);

  // --- [4] Since no live Telegram client was supplied, telegram-only tools are genuinely absent, never fabricated ---
  console.log("\n[4] Without a real Telegram client, telegram-only tools are genuinely absent from the catalog too...\n");
  assert.ok(!registry.has("push_message_to_user"));
  assert.ok(!flatNames.has("push_message_to_user"), "the catalog must never claim a tool exists that genuinely isn't registered in this build");
  console.log("    push_message_to_user correctly absent -- the catalog reflects the REAL live registry, not the static category map in isolation");

  // --- [4b] With a real Telegram client, it appears, correctly categorized ---
  console.log("\n[4b] With a real Telegram client supplied, push_message_to_user genuinely appears, correctly categorized...\n");
  const { TelegramClient } = await import("@dave/telegram");
  const telegramClient = new TelegramClient("fake-token", "http://127.0.0.1:1");
  const registryWithTelegram = buildFullToolRegistry({ userId: OWNER, db, executor, telegram: { client: telegramClient, chatId: 1 } });
  const resultWithTelegram: any = await registryWithTelegram.execute("get_tool_catalog", {});
  const messagingCategory = resultWithTelegram.categories.find((c: any) => c.category === "Telegram & messaging");
  assert.ok(messagingCategory);
  assert.ok(messagingCategory.tools.some((t: any) => t.name === "push_message_to_user"));
  console.log(`    push_message_to_user genuinely present under "Telegram & messaging" once a real Telegram client is wired in`);

  // --- [5] The category filter argument genuinely narrows the result ---
  console.log("\n[5] Passing `category` genuinely narrows the result to just that one category...\n");
  const filtered: any = await registry.execute("get_tool_catalog", { category: "Safety" });
  assert.equal(filtered.categories.length, 1);
  assert.equal(filtered.categories[0].category, "Safety");
  assert.ok(filtered.categories[0].tools.some((t: any) => t.name === "hard_stop"));
  assert.ok(filtered.totalTools < result.totalTools, "a filtered call must genuinely return fewer tools than the unfiltered call");
  console.log(`    category:"Safety" -> ${filtered.totalTools} real tool(s), including hard_stop`);

  // --- [6] Read-only: calling it never mutates anything (no trading/settings side effect) ---
  console.log("\n[6] Calling get_tool_catalog repeatedly is genuinely side-effect-free...\n");
  const before: any = await registry.execute("get_tool_catalog", {});
  const after: any = await registry.execute("get_tool_catalog", {});
  assert.deepEqual(before, after, "two consecutive calls with no registry change must return the identical real result");
  console.log("    two consecutive calls returned identical real data -- no hidden state mutated");

  // --- [7] buildToolCatalog is exported directly too, for non-tool callers ---
  console.log("\n[7] buildToolCatalog() is directly usable outside the tool-call path...\n");
  const direct = buildToolCatalog(registry);
  assert.equal(
    direct.reduce((sum, c) => sum + c.tools.length, 0),
    registry.list().length
  );
  assert.ok(Object.keys(TOOL_CATALOG_CATEGORIES).length > 5, "the real static category map must genuinely have multiple categories defined");
  console.log(`    buildToolCatalog() direct call: ${direct.length} categories, matching the real registry's total tool count`);

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
