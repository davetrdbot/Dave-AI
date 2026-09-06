import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import { TelegramClient } from "@dave/telegram";
import { addProviderKey, getModelConfig } from "@dave/brain";
import { dispatchCommand, dispatchCallback, type CommandRouterDeps } from "../src/command-router.js";

/**
 * Real proof for the user-reported gap ("providers is missing? it's only
 * airllm and deepseek and Claude"): /providers and /models used to be
 * hardcoded to 3 providers even after the catalog held 28+AirLLM. This
 * exercises the REAL command router (dispatchCommand/dispatchCallback),
 * against a real ephemeral DaveDatabase, with a mocked Telegram transport
 * capturing the exact outgoing API calls -- not a description of the fix.
 */

console.log("=== Real proof: /providers and /models list the full catalog, callback tap sets primary ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-provider-ui-"));
const OWNER = "user-provider-ui-1";
const CHAT_ID = 999111;

const sentMessages: Array<{ method: string; body: unknown }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const method = String(url).split("/").pop() ?? "";
  const body = init?.body ? JSON.parse(init.body as string) : undefined;
  sentMessages.push({ method, body });
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
}) as typeof fetch;

try {
  const db = new DaveDatabase(join(workDir, "dave.db"));
  const client = new TelegramClient("000000:fake-token-for-transport-mock");
  const deps: CommandRouterDeps = { db, client, userId: OWNER, publicBaseUrl: "https://dave.example.com" };

  console.log("[1] /providers lists the FULL catalog (29 entries incl. custom), not just 3...");
  sentMessages.length = 0;
  const handled = await dispatchCommand(deps, CHAT_ID, `${OWNER}:${CHAT_ID}`, "/providers");
  assert.equal(handled, true);
  assert.equal(sentMessages.length, 1);
  const providersBody = sentMessages[0].body as { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } };
  const buttons = providersBody.reply_markup.inline_keyboard.flat();
  const buttonProviders = buttons.map((b) => b.callback_data.replace("provider:", ""));
  console.log(`    ${buttons.length} provider buttons: ${buttonProviders.join(", ")}`);
  assert.ok(buttons.length >= 28, `expected at least 28 provider buttons, got ${buttons.length}`);
  assert.ok(buttonProviders.includes("openrouter"), "openrouter must be selectable");
  assert.ok(buttonProviders.includes("monsterapi"), "monsterapi (the researched addition) must be selectable");
  assert.ok(buttonProviders.includes("airllm") && buttonProviders.includes("deepseek") && buttonProviders.includes("claude"), "the original 3 must still be present");

  console.log("\n[2] A provider with no configured key is honestly marked '(no key)'...");
  const openrouterBtn = buttons.find((b) => b.callback_data === "provider:openrouter")!;
  console.log(`    button text: "${openrouterBtn.text}"`);
  assert.match(openrouterBtn.text, /\(no key\)/);

  console.log("\n[3] AirLLM is never marked '(no key)' -- it's self-hosted via AIRLLM_BASE_URL, no stored key needed...");
  const airllmBtn = buttons.find((b) => b.callback_data === "provider:airllm")!;
  console.log(`    button text: "${airllmBtn.text}"`);
  assert.ok(!airllmBtn.text.includes("(no key)"));

  console.log("\n[4] After a real key is added for openrouter, its button drops the '(no key)' tag...");
  addProviderKey(db, OWNER, "openrouter", "test key", { apiKey: "sk-or-fake-key" });
  sentMessages.length = 0;
  await dispatchCommand(deps, CHAT_ID, `${OWNER}:${CHAT_ID}`, "/providers");
  const refreshedButtons = (sentMessages[0].body as { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } }).reply_markup.inline_keyboard.flat();
  const refreshedOpenrouter = refreshedButtons.find((b) => b.callback_data === "provider:openrouter")!;
  console.log(`    button text: "${refreshedOpenrouter.text}"`);
  assert.ok(!refreshedOpenrouter.text.includes("(no key)"), "adding a real key must remove the honest warning");

  console.log("\n[5] Tapping a provider button (real callback_query dispatch) genuinely sets it as primary...");
  await dispatchCallback(deps, {
    id: "cb1",
    data: "provider:openrouter",
    message: { message_id: 1, chat: { id: CHAT_ID } },
  } as never);
  const config = getModelConfig(OWNER);
  console.log(`    getModelConfig(${OWNER}) -> primary=${config.primary}`);
  assert.equal(config.primary, "openrouter", "the callback tap must genuinely change the stored primary provider");

  console.log("\n[6] /models lists all catalog providers with an honest per-provider model note (manual entry vs default)...");
  sentMessages.length = 0;
  await dispatchCommand(deps, CHAT_ID, `${OWNER}:${CHAT_ID}`, "/models");
  const modelsText = (sentMessages[0].body as { text: string }).text;
  console.log(`    ${modelsText.split("\n").length} lines`);
  assert.match(modelsText, /openrouter: manual model entry/);
  assert.match(modelsText, /monsterapi: manual model entry/);
  assert.match(modelsText, /claude: default: claude-sonnet-5/);

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  globalThis.fetch = realFetch;
  rmSync(workDir, { recursive: true, force: true });
}
