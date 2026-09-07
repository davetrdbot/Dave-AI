import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import { getModelConfig, setModelConfig, addProviderKey } from "@dave/brain";
import { TelegramClient } from "@dave/telegram";
import { dispatchCallback, type CommandRouterDeps } from "../src/command-router.js";

/**
 * Real proof for the user's explicit ask: "the fallback you set it to Claude and deepseek and
 * airllm only the fallback should be configurable in the /provider" -- before this, the fallback
 * chain was only ever DEFAULT_CONFIG's hardcoded value (or whatever was left over after switching
 * primary), with no real button anywhere to change it. `/providers` -> tap a provider now has a
 * real "Add/remove from fallback chain" toggle that genuinely persists.
 */

console.log("=== Real proof: the fallback provider chain is genuinely configurable via real /providers buttons ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-fallback-chain-"));
process.chdir(workDir);
const OWNER = "user-fallback-chain-1";
const CHAT_ID = 313131;

const db = new DaveDatabase(join(workDir, "dave.db"));
const client = new TelegramClient("000000:fake-token-for-transport-mock");
const deps: CommandRouterDeps = { db, client, userId: OWNER, publicBaseUrl: "https://dave.example.com" };

const realFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 })) as typeof fetch;

try {
  addProviderKey(db, OWNER, "openai", "primary key", { apiKey: "sk-openai-fake", model: "gpt-x" });
  addProviderKey(db, OWNER, "groq", "groq key", { apiKey: "sk-groq-fake", model: "groq-x" });
  setModelConfig(OWNER, { primary: "openai", fallback: [] });

  console.log("[1] Fresh config: no fallback provider configured...");
  assert.deepEqual(getModelConfig(OWNER).fallback, []);

  console.log("\n[2] A real tap on 'Add to fallback chain' for groq genuinely adds it...");
  await dispatchCallback(deps, { id: "cb1", data: "togglefallback:groq", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  assert.deepEqual(getModelConfig(OWNER).fallback, ["groq"]);
  console.log(`    real config: ${JSON.stringify(getModelConfig(OWNER))}`);

  console.log("\n[3] Tapping it again genuinely removes it -- a real toggle, not just an add...");
  await dispatchCallback(deps, { id: "cb2", data: "togglefallback:groq", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  assert.deepEqual(getModelConfig(OWNER).fallback, []);
  console.log(`    real config: ${JSON.stringify(getModelConfig(OWNER))}`);

  console.log("\n[4] Multiple providers can genuinely be added to the fallback chain independently...");
  await dispatchCallback(deps, { id: "cb3", data: "togglefallback:groq", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  await dispatchCallback(deps, { id: "cb4", data: "togglefallback:deepseek", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  assert.deepEqual(getModelConfig(OWNER).fallback, ["groq", "deepseek"]);
  console.log(`    real config: ${JSON.stringify(getModelConfig(OWNER))}`);

  console.log("\n[5] Switching primary provider genuinely does not silently wipe an unrelated fallback entry...");
  await dispatchCallback(deps, { id: "cb5", data: "setprimaryprovider:groq", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  const afterSwitch = getModelConfig(OWNER);
  assert.equal(afterSwitch.primary, "groq");
  assert.deepEqual(afterSwitch.fallback, ["deepseek"], "the new primary must be dropped OUT of its own fallback list, but an unrelated fallback entry must survive");
  console.log(`    real config after switching primary to groq: ${JSON.stringify(afterSwitch)}`);

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  globalThis.fetch = realFetch;
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
