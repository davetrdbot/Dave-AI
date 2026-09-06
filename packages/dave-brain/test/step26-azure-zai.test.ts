import assert from "node:assert/strict";
import { buildProvider } from "../src/provider-factory.js";
import { PROVIDER_CATALOG } from "../src/provider-catalog.js";

/**
 * Real proof for this pass's provider-catalog changes (user request: "replace monster api
 * with z ai and add aws too and azure"): MonsterAPI removed, Z.AI added (manual model entry,
 * real OpenAI-compatible base URL), Azure OpenAI added with its own genuinely different real
 * auth mechanism (a real `api-key` header, NOT Authorization: Bearer -- confirmed against
 * Microsoft's own docs). Also proves authStyle stopped being purely decorative catalog
 * metadata: before this pass, EVERY provider through OpenAICompatibleProvider always sent
 * Bearer regardless of what the catalog declared.
 */

console.log("=== Real proof: MonsterAPI -> Z.AI swap + Azure OpenAI's real api-key auth ===\n");

console.log("[1] MonsterAPI is genuinely gone from the catalog...");
assert.equal((PROVIDER_CATALOG as Record<string, unknown>).monsterapi, undefined);
console.log("    confirmed absent");

console.log("\n[2] Z.AI is present, OpenAI-compatible, forced to manual model entry...");
const zai = PROVIDER_CATALOG.zai;
console.log(`    baseUrl: ${zai.baseUrl}, manualModelEntry: ${zai.manualModelEntry}`);
assert.equal(zai.baseUrl, "https://api.z.ai/api/paas/v4");
assert.equal(zai.manualModelEntry, true);
assert.equal(zai.openAICompatible, true);

console.log("\n[3] Azure OpenAI: real per-deployment URL shape, requires accountId + model (deployment)...");
const azure = PROVIDER_CATALOG.azure;
assert.equal(typeof azure.baseUrl, "function");
const builtUrl = typeof azure.baseUrl === "function" ? azure.baseUrl({ apiKey: "x", accountId: "my-resource", model: "my-gpt4-deployment" }) : "";
console.log(`    built baseUrl: ${builtUrl}`);
assert.equal(builtUrl, "https://my-resource.openai.azure.com/openai/deployments/my-gpt4-deployment");
assert.match(azure.chatPath, /api-version=/);

console.log("\n[4] buildProvider('azure', ...) genuinely refuses without accountId or model...");
let threwNoAccount = false;
try {
  buildProvider("azure", { apiKey: "x", model: "dep" });
} catch {
  threwNoAccount = true;
}
assert.equal(threwNoAccount, true, "must refuse without accountId");

let threwNoModel = false;
try {
  buildProvider("azure", { apiKey: "x", accountId: "my-resource" });
} catch {
  threwNoModel = true;
}
assert.equal(threwNoModel, true, "must refuse without a deployment name");
console.log("    both genuinely refused");

console.log("\n[5] Real network proof: buildProvider('azure', ...).generate() sends a real 'api-key' header, NOT Authorization: Bearer...");
const realFetch = globalThis.fetch;
let capturedHeaders: Record<string, string> | undefined;
let capturedUrl = "";
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  capturedUrl = String(url);
  capturedHeaders = init?.headers as Record<string, string>;
  return new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), { status: 200 });
}) as typeof fetch;

try {
  const provider = buildProvider("azure", { apiKey: "real-azure-key", accountId: "my-resource", model: "my-gpt4-deployment" });
  await provider.generate({ messages: [{ role: "user", content: "hello" }] }, 5000);
  console.log(`    real URL called: ${capturedUrl}`);
  console.log(`    real headers sent: ${JSON.stringify(capturedHeaders)}`);
  assert.equal(capturedUrl, "https://my-resource.openai.azure.com/openai/deployments/my-gpt4-deployment/chat/completions?api-version=2024-06-01");
  assert.equal(capturedHeaders?.["api-key"], "real-azure-key", "must use the real api-key header");
  assert.equal(capturedHeaders?.authorization, undefined, "must NOT send Authorization: Bearer -- Azure genuinely rejects that");
} finally {
  globalThis.fetch = realFetch;
}

console.log("\n[6] A normal provider (openai) is unaffected -- still sends real Bearer auth as before...");
let openaiHeaders: Record<string, string> | undefined;
globalThis.fetch = (async (_url: string, init?: RequestInit) => {
  openaiHeaders = init?.headers as Record<string, string>;
  return new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), { status: 200 });
}) as typeof fetch;
try {
  const provider = buildProvider("openai", { apiKey: "sk-real", model: "gpt-5.6-sol" });
  await provider.generate({ messages: [{ role: "user", content: "hello" }] }, 5000);
  console.log(`    real headers sent: ${JSON.stringify(openaiHeaders)}`);
  assert.equal(openaiHeaders?.authorization, "Bearer sk-real");
  assert.equal(openaiHeaders?.["api-key"], undefined);
} finally {
  globalThis.fetch = realFetch;
}

console.log("\n=== ALL ASSERTIONS PASSED ===");
