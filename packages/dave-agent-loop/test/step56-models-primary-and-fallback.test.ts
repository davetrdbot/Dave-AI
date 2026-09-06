import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import { TelegramClient } from "@dave/telegram";
import { addProviderKey, setModelConfig, listProviderKeys, listProviderCatalog } from "@dave/brain";
import { dispatchCommand, dispatchCallback, type CommandRouterDeps } from "../src/command-router.js";

/**
 * Real proof for item 5 of the live production bug report: "/model currently doesn't do what
 * it's supposed to... show the PRIMARY provider's active model clearly, ALSO show the FALLBACK
 * provider(s) and their currently active models -- this was missing entirely. Let the user pick a
 * model for whichever provider they're currently viewing/configuring, not just the primary."
 * Before this, /models only ever knew about config.primary -- a configured fallback provider was
 * completely invisible and its model could not be set from Telegram at all.
 */

console.log("=== Real proof: /models shows primary AND fallback providers, each independently settable ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-models-fallback-"));
const OWNER = "user-models-fallback-1";
const CHAT_ID = 777888;

const modelConfigPath = join(process.cwd(), "data", "brain", `${OWNER}-model-config.json`);
rmSync(modelConfigPath, { force: true });

const sentTelegramCalls: Array<{ body: unknown }> = [];
const openaiEntry = listProviderCatalog().find((e) => e.id === "openai")!;
const groqEntry = listProviderCatalog().find((e) => e.id === "groq")!;
const openaiModelsUrl = `${openaiEntry.baseUrl}${openaiEntry.modelsPath}`;
const groqModelsUrl = `${groqEntry.baseUrl}${groqEntry.modelsPath}`;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const urlStr = String(url);
  if (urlStr.includes("api.telegram.org")) {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    sentTelegramCalls.push({ body });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  }
  if (urlStr === openaiModelsUrl) return new Response(JSON.stringify({ data: [{ id: "gpt-primary-1" }] }), { status: 200 });
  if (urlStr === groqModelsUrl) return new Response(JSON.stringify({ data: [{ id: "groq-fallback-1" }] }), { status: 200 });
  return new Response("not found", { status: 404 });
}) as typeof fetch;

try {
  const db = new DaveDatabase(join(workDir, "dave.db"));
  const client = new TelegramClient("000000:fake-token-for-transport-mock");
  const deps: CommandRouterDeps = { db, client, userId: OWNER, publicBaseUrl: "https://dave.example.com" };

  addProviderKey(db, OWNER, "openai", "primary key", { apiKey: "sk-openai-fake", model: "gpt-already-set" });
  addProviderKey(db, OWNER, "groq", "fallback key", { apiKey: "sk-groq-fake" });
  setModelConfig(OWNER, { primary: "openai", fallback: ["groq"] });

  console.log("[1] /models shows BOTH the primary's real current model AND the fallback provider's line, not just primary...");
  sentTelegramCalls.length = 0;
  await dispatchCommand(deps, CHAT_ID, `${OWNER}:${CHAT_ID}`, "/models");
  const overview = sentTelegramCalls[0].body as { text: string; reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } };
  console.log(`    "${overview.text.replace(/\n/g, " | ")}"`);
  assert.match(overview.text, /Primary:.*openai.*gpt-already-set/s, "the primary line must show the real, already-configured model");
  assert.match(overview.text, /Fallback:/, "a fallback section header must be present");
  assert.match(overview.text, /groq/, "the configured fallback provider (groq) must genuinely appear -- previously invisible entirely");

  const buttons = overview.reply_markup.inline_keyboard.flat();
  const primaryBtn = buttons.find((b) => b.callback_data === "modelfor:openai");
  const fallbackBtn = buttons.find((b) => b.callback_data === "modelfor:groq");
  console.log(`    real buttons: ${buttons.map((b) => b.text).join(" | ")}`);
  assert.ok(primaryBtn, "must offer a real button to pick a model for the primary provider");
  assert.ok(fallbackBtn, "must offer a real button to pick a model for the FALLBACK provider -- this is the real gap fixed");

  console.log("\n[2] Tapping the FALLBACK provider's button opens THAT provider's real picker, confirmed per-provider not global...");
  sentTelegramCalls.length = 0;
  await dispatchCallback(deps, { id: "cb1", data: "modelfor:groq", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  const fallbackPicker = sentTelegramCalls[0].body as { text: string; reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } };
  console.log(`    "${fallbackPicker.text.split("\n")[0]}"`);
  assert.match(fallbackPicker.text, /Model for groq/);
  const fallbackFetchBtn = fallbackPicker.reply_markup.inline_keyboard.flat().find((b) => b.callback_data === "fetchmodels:groq");
  assert.ok(fallbackFetchBtn, "the fallback provider's own real fetch button must be present");

  console.log("\n[3] Fetching + picking a model for the FALLBACK provider stores it on groq's key, NOT openai's...");
  sentTelegramCalls.length = 0;
  await dispatchCallback(deps, { id: "cb2", data: "fetchmodels:groq", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  const groqPicker = sentTelegramCalls[0].body as { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } };
  const groqModelBtn = groqPicker.reply_markup.inline_keyboard.flat()[0];
  await dispatchCallback(deps, { id: "cb3", data: groqModelBtn.callback_data, message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  const groqModel = listProviderKeys(db, OWNER, "groq")[0].config.model;
  const openaiModel = listProviderKeys(db, OWNER, "openai")[0].config.model;
  console.log(`    groq's stored model -> "${groqModel}", openai's stored model (untouched) -> "${openaiModel}"`);
  assert.equal(groqModel, "groq-fallback-1", "the fallback provider's model must genuinely be settable");
  assert.equal(openaiModel, "gpt-already-set", "setting the fallback's model must NOT touch the primary's model -- confirmed per-provider, not global");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  globalThis.fetch = realFetch;
  rmSync(workDir, { recursive: true, force: true });
  rmSync(modelConfigPath, { force: true });
}
