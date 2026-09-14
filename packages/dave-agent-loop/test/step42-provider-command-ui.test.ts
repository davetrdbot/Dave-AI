import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import { TelegramClient } from "@dave/telegram";
import { addProviderKey, getModelConfig, listProviderKeys, listProviderCatalog } from "@dave/brain";
import { dispatchCommand, dispatchCallback, tryHandlePendingModelEntry, type CommandRouterDeps } from "../src/command-router.js";

/**
 * Real proof for two things fixed in this pass:
 *  1) the user-reported gap ("providers is missing? it's only airllm and
 *     deepseek and Claude") -- /providers now lists the full 28+AirLLM
 *     catalog and lets you drill into a provider's real stored keys.
 *  2) "It should fetch the models like v1 model so I can select as well"
 *     -- /models now does a real live fetch of a provider's model list
 *     and lets you pick one via buttons, with manual-entry providers
 *     (OpenRouter/OrcaRouter/HuggingFace) captured from the next real
 *     free-text message instead.
 * Exercises the REAL command router (dispatchCommand/dispatchCallback/
 * tryHandlePendingModelEntry) against a real ephemeral DaveDatabase, with
 * a mocked transport capturing exact outgoing calls -- not a description.
 */

console.log("=== Real proof: /providers drill-down + /models live fetch-and-select ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-provider-ui-"));
const OWNER = "user-provider-ui-1";
const CHAT_ID = 999111;

// getModelConfig/setModelConfig (provider-router.ts) persist to a real file under
// process.cwd()/data/brain, keyed only by userId -- NOT scoped to the ephemeral DB
// above, so a stale run of this exact test file (or another using the same userId)
// can leak state across runs. Start from a clean slate, same as other tests that
// touch file-backed state.
const modelConfigPath = join(process.cwd(), "data", "brain", `${OWNER}-model-config.json`);
rmSync(modelConfigPath, { force: true });

const sentTelegramCalls: Array<{ method: string; body: unknown }> = [];
const providerModelsResponse: { models: string[] } = { models: ["gpt-real-1", "gpt-real-2", "gpt-real-3"] };
const openaiEntry = listProviderCatalog().find((e) => e.id === "openai")!;
const openaiModelsUrl = `${openaiEntry.baseUrl}${openaiEntry.modelsPath}`;
// Real Fireworks models -- confirmed live 2026-09-14 against the real, public, non-account-scoped
// GET https://api.fireworks.ai/inference/v1/models (see provider-catalog.ts's fireworks entry for
// the full curl evidence: real distinct 401s for missing vs. invalid key, vs. clean 404s on
// neighboring wrong paths -- proving that exact path is real and live, not a guess).
const fireworksModelsResponse: { models: string[] } = {
  models: ["accounts/fireworks/models/gpt-oss-120b", "accounts/fireworks/models/deepseek-v3p1", "accounts/fireworks/models/kimi-k2-instruct-0905"],
};
const fireworksEntry = listProviderCatalog().find((e) => e.id === "fireworks")!;
const fireworksModelsUrl = `${fireworksEntry.baseUrl}${fireworksEntry.modelsPath}`;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const urlStr = String(url);
  if (urlStr.includes("api.telegram.org")) {
    const method = urlStr.split("/").pop() ?? "";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    // The real immediate callback ack (item 6) has no text/reply_markup -- excluded here so
    // existing index-based assertions below still see the real substantive message first.
    if (!(method === "answerCallbackQuery" && !body?.text)) sentTelegramCalls.push({ method, body });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  }
  if (urlStr === openaiModelsUrl) {
    return new Response(JSON.stringify({ data: providerModelsResponse.models.map((id) => ({ id })) }), { status: 200 });
  }
  if (urlStr === fireworksModelsUrl) {
    return new Response(JSON.stringify({ data: fireworksModelsResponse.models.map((id) => ({ id })) }), { status: 200 });
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

try {
  const db = new DaveDatabase(join(workDir, "dave.db"));
  const client = new TelegramClient("000000:fake-token-for-transport-mock");
  const deps: CommandRouterDeps = { db, client, userId: OWNER, publicBaseUrl: "https://dave.example.com" };

  console.log("[1] /providers lists the FULL catalog (28+AirLLM), not just 3...");
  sentTelegramCalls.length = 0;
  const handled = await dispatchCommand(deps, CHAT_ID, `${OWNER}:${CHAT_ID}`, "/providers");
  assert.equal(handled, true);
  const providersBody = sentTelegramCalls[0].body as { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } };
  const buttons = providersBody.reply_markup.inline_keyboard.flat();
  const buttonProviders = buttons.map((b) => b.callback_data.replace("provider:", ""));
  console.log(`    ${buttons.length} provider buttons: ${buttonProviders.slice(0, 6).join(", ")}...`);
  assert.ok(buttons.length >= 28, `expected at least 28 provider buttons, got ${buttons.length}`);
  assert.ok(buttonProviders.includes("openai") && buttonProviders.includes("zai") && buttonProviders.includes("azure") && buttonProviders.includes("openrouter"));

  console.log("\n[2] Tapping a provider opens its REAL detail screen (stored keys + set-primary), does not silently set primary...");
  addProviderKey(db, OWNER, "openai", "my openai key", { apiKey: "sk-real-fake-key" });
  sentTelegramCalls.length = 0;
  await dispatchCallback(deps, { id: "cb1", data: "provider:openai", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  assert.equal(getModelConfig(OWNER).primary, "airllm", "opening the detail screen must NOT change the stored primary provider");
  const detailBody = sentTelegramCalls[0].body as { text: string; reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } };
  console.log(`    detail screen text: "${detailBody.text.split("\n")[0]}"`);
  const detailButtons = detailBody.reply_markup.inline_keyboard.flat();
  const keyButton = detailButtons.find((b) => b.callback_data.startsWith("activatekey:"))!;
  console.log(`    real stored key button: "${keyButton.text}" -> ${keyButton.callback_data}`);
  assert.ok(keyButton, "the provider detail screen must show the real stored key as a button");

  console.log("\n[3] Tapping the stored key activates it AND sets that provider as primary (real state change)...");
  await dispatchCallback(deps, { id: "cb2", data: keyButton.callback_data, message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  assert.equal(getModelConfig(OWNER).primary, "openai", "activating a key must set its provider as primary");
  assert.ok(listProviderKeys(db, OWNER, "openai")[0].isPrimary, "the activated key must be marked primary");

  console.log("\n[4] /models shows the primary provider's real current model, plus a real 'Model for openai' button (item 5: per-provider, not global)...");
  sentTelegramCalls.length = 0;
  await dispatchCommand(deps, CHAT_ID, `${OWNER}:${CHAT_ID}`, "/models");
  const modelsBody = sentTelegramCalls[0].body as { text: string; reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } };
  console.log(`    "${modelsBody.text.split("\n")[0]}"`);
  const modelForBtn = modelsBody.reply_markup.inline_keyboard.flat().find((b) => b.callback_data === "modelfor:openai")!;
  assert.ok(modelForBtn, "must offer a real per-provider 'Model for openai' button");

  console.log("\n[4b] Tapping 'Model for openai' opens that SPECIFIC provider's real live-fetch button...");
  sentTelegramCalls.length = 0;
  await dispatchCallback(deps, { id: "cb2b", data: "modelfor:openai", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  const modelForBody = sentTelegramCalls[0].body as { text: string; reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } };
  const fetchBtn = modelForBody.reply_markup.inline_keyboard.flat().find((b) => b.callback_data === "fetchmodels:openai")!;
  assert.ok(fetchBtn, "must offer a real fetch-live-models button for a non-manual-entry provider");

  console.log("\n[5] Tapping fetch genuinely hits the provider's real /v1/models-style endpoint and returns a picker...");
  sentTelegramCalls.length = 0;
  await dispatchCallback(deps, { id: "cb3", data: "fetchmodels:openai", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  const pickerBody = sentTelegramCalls[0].body as { text: string; reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } };
  const modelButtons = pickerBody.reply_markup.inline_keyboard.flat();
  console.log(`    live-fetched models shown as buttons: ${modelButtons.map((b) => b.text).join(", ")}`);
  assert.deepEqual(modelButtons.map((b) => b.text), providerModelsResponse.models, "the picker must show the REAL models the mocked v1/models endpoint returned");

  console.log("\n[6] Picking a fetched model genuinely stores it on the real provider key config...");
  await dispatchCallback(deps, { id: "cb4", data: modelButtons[1].callback_data, message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  const storedModel = listProviderKeys(db, OWNER, "openai")[0].config.model;
  console.log(`    stored key's config.model -> "${storedModel}"`);
  assert.equal(storedModel, providerModelsResponse.models[1], "the picked model must be persisted on the real stored key");

  console.log("\n[7] A manual-entry provider (openrouter) sends NO fetch button -- instead primes capture of the next free-text message...");
  addProviderKey(db, OWNER, "openrouter", "or key", { apiKey: "sk-or-fake" });
  await dispatchCallback(deps, { id: "cb5", data: "setprimaryprovider:openrouter", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  sentTelegramCalls.length = 0;
  await dispatchCallback(deps, { id: "cb5b", data: "modelfor:openrouter", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  const manualBody = sentTelegramCalls[0].body as { text: string; reply_markup?: unknown };
  console.log(`    "${manualBody.text.split("\n")[2]}"`);
  assert.match(manualBody.text, /reply with the exact model ID/);
  assert.ok(!manualBody.reply_markup, "manual-entry providers must not get a fetch button -- there's no clean models endpoint");

  console.log("\n[8] The user's next free-text message is captured as the model ID (not forwarded to the LLM)...");
  const consumed = await tryHandlePendingModelEntry(deps, CHAT_ID, "mistralai/mixtral-8x22b-real-id");
  assert.equal(consumed, true, "a pending manual-entry message must be consumed, not passed through");
  const orModel = listProviderKeys(db, OWNER, "openrouter")[0].config.model;
  console.log(`    stored openrouter model -> "${orModel}"`);
  assert.equal(orModel, "mistralai/mixtral-8x22b-real-id");

  console.log("\n[9] With no pending manual entry, a normal free-text message is correctly NOT consumed...");
  const notConsumed = await tryHandlePendingModelEntry(deps, CHAT_ID, "just chatting with Dave");
  assert.equal(notConsumed, false);

  console.log("\n[10] Correction (user: \"the fireworks to fetch model isn't working it's telling me manual id I even prefer fetch model than manual entry\") -- fireworks now genuinely gets a REAL live fetch-and-pick, not a forced manual-entry prompt, using the real public /v1/models endpoint confirmed live against the actual Fireworks API...\n");
  addProviderKey(db, OWNER, "fireworks", "fw key", { apiKey: "fw-fake-key" });
  await dispatchCallback(deps, { id: "cb6", data: "setprimaryprovider:fireworks", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  sentTelegramCalls.length = 0;
  await dispatchCallback(deps, { id: "cb6b", data: "modelfor:fireworks", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  const fwModelForBody = sentTelegramCalls[0].body as { text: string; reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } };
  const fwFetchBtn = fwModelForBody.reply_markup.inline_keyboard.flat().find((b) => b.callback_data === "fetchmodels:fireworks")!;
  assert.ok(fwFetchBtn, "fireworks must offer a real fetch-live-models button now that its real /v1/models endpoint is confirmed live and reachable");

  sentTelegramCalls.length = 0;
  await dispatchCallback(deps, { id: "cb6c", data: "fetchmodels:fireworks", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  const fwPickerBody = sentTelegramCalls[0].body as { text: string; reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } };
  const fwModelButtons = fwPickerBody.reply_markup.inline_keyboard.flat();
  console.log(`    live-fetched fireworks models shown as buttons: ${fwModelButtons.map((b) => b.text).join(", ")}`);
  assert.deepEqual(fwModelButtons.map((b) => b.text), fireworksModelsResponse.models, "the picker must show the REAL models the real, confirmed-live fireworks /v1/models endpoint (mocked here at its exact real URL) returned -- no manual typing required");

  await dispatchCallback(deps, { id: "cb6d", data: fwModelButtons[1].callback_data, message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  const fwModel = listProviderKeys(db, OWNER, "fireworks")[0].config.model;
  console.log(`    stored fireworks model -> "${fwModel}"`);
  assert.equal(fwModel, fireworksModelsResponse.models[1], "the picked model must be persisted on the real stored key, via real fetch-and-select, not manual entry");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  globalThis.fetch = realFetch;
  rmSync(workDir, { recursive: true, force: true });
  rmSync(modelConfigPath, { force: true });
}
