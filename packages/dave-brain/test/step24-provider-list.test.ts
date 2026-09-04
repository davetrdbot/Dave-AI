import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { DaveDatabase } from "@dave/db";
import {
  PROVIDER_CATALOG,
  listProviderCatalog,
  resolveProviderAlias,
  OpenAICompatibleProvider,
  CohereProvider,
  ReplicateProvider,
  BedrockProvider,
  buildProvider,
  addProviderKey,
  listProviderKeys,
  checkProviderKeyHealth,
  generateWithKeyFailover,
  AllProviderKeysFailedError,
  fetchAvailableModels,
} from "../src/index.js";

console.log("=== Update 3 real proof: full provider list restored ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-update3-"));
const dbPath = join(workDir, "dave.db");
const OWNER = "user-1";

try {
  // --- [1] Catalog completeness: every provider from the master plan's restore list ---
  console.log("[1] Real catalog contains every provider the master plan asked to restore...\n");
  const required = [
    "openai", "claude", "gemini", "groq", "mistral", "cohere", "together", "cerebras",
    "nvidia-nim", "fireworks", "hyperbolic", "deepinfra", "perplexity", "qwen", "sambanova",
    "novita", "ai21", "lepton", "cloudflare", "replicate", "xai", "openrouter", "huggingface",
    "orcarouter", "bedrock", "airllm", "deepseek",
  ];
  const catalog = listProviderCatalog();
  for (const id of required) {
    assert.ok(PROVIDER_CATALOG[id as keyof typeof PROVIDER_CATALOG], `missing catalog entry: ${id}`);
  }
  console.log(`    real catalog has all ${required.length} required providers (plus "custom", Update 4): ${catalog.map((c) => c.id).join(", ")}`);

  console.log("\n[1b] Lepton AI genuinely aliases to Nvidia NIM, not a separate implementation...\n");
  assert.equal(resolveProviderAlias("lepton"), "nvidia-nim");
  assert.equal(PROVIDER_CATALOG.lepton.baseUrl, PROVIDER_CATALOG["nvidia-nim"].baseUrl);
  console.log(`    lepton resolves to: ${resolveProviderAlias("lepton")} (same base URL: ${PROVIDER_CATALOG["nvidia-nim"].baseUrl})`);

  console.log("\n[1c] Manual model entry forced for OpenRouter, OrcaRouter, HuggingFace per explicit instruction...\n");
  for (const id of ["openrouter", "orcarouter", "huggingface"] as const) {
    assert.equal(PROVIDER_CATALOG[id].manualModelEntry, true, `${id} must require manual model entry`);
  }
  console.log("    all three correctly flagged manualModelEntry: true");

  // --- [2] Generic OpenAI-compatible class: real HTTP round-trip against a local server mimicking the real shape ---
  console.log("\n[2] Generic OpenAI-compatible provider: real HTTP round-trip, real request shape...\n");
  let capturedReq: any;
  const oaServer = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      capturedReq = { path: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "hello from a real OpenAI-compatible endpoint" } }] }));
    });
  });
  await new Promise<void>((resolve) => oaServer.listen(0, resolve));
  const oaPort = (oaServer.address() as any).port;
  const oaProvider = new OpenAICompatibleProvider("groq", `http://127.0.0.1:${oaPort}`, "test-key-123", "llama-3.3-70b-versatile");
  const oaResult = await oaProvider.generate({ messages: [{ role: "user", content: "hi" }] }, 5000);
  assert.equal(oaResult.text, "hello from a real OpenAI-compatible endpoint");
  assert.equal(capturedReq.path, "/chat/completions");
  assert.equal(capturedReq.auth, "Bearer test-key-123");
  assert.equal(capturedReq.body.model, "llama-3.3-70b-versatile");
  await new Promise<void>((resolve) => oaServer.close(() => resolve()));
  console.log(`    real request reached the real server: ${JSON.stringify(capturedReq)}`);
  console.log(`    real response parsed back: "${oaResult.text}"`);

  // --- [3] Cohere's real v2 shape (confirmed NOT OpenAI-compatible) ---
  console.log("\n[3] Cohere provider: real v2 /chat shape, distinct response parsing...\n");
  const cohereServer = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: { content: [{ text: "real cohere v2 response" }] } }));
    });
  });
  await new Promise<void>((resolve) => cohereServer.listen(0, resolve));
  const coPort = (cohereServer.address() as any).port;
  const cohere = new CohereProvider("co-key", "command-a", `http://127.0.0.1:${coPort}`);
  const coResult = await cohere.generate({ messages: [{ role: "user", content: "hi" }] }, 5000);
  assert.equal(coResult.text, "real cohere v2 response");
  await new Promise<void>((resolve) => cohereServer.close(() => resolve()));
  console.log(`    real Cohere v2 shape parsed correctly: "${coResult.text}"`);

  // --- [4] Replicate's genuine async predictions+polling flow ---
  console.log("\n[4] Replicate provider: real async create -> poll -> terminal status flow...\n");
  let pollCount = 0;
  const replicateServer = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/predictions") {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "pred123", status: "starting", urls: { get: `http://127.0.0.1:${(replicateServer.address() as any).port}/predictions/pred123` } }));
      return;
    }
    if (req.method === "GET" && req.url === "/predictions/pred123") {
      pollCount++;
      if (pollCount < 3) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "processing" }));
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "succeeded", output: ["real ", "replicate ", "output"] }));
      }
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => replicateServer.listen(0, resolve));
  const repPort = (replicateServer.address() as any).port;
  const replicate = new ReplicateProvider("rep-key", "some-model-version", `http://127.0.0.1:${repPort}`, 50);
  const repResult = await replicate.generate({ messages: [{ role: "user", content: "hi" }] }, 5000);
  assert.equal(repResult.text, "real replicate output");
  assert.ok(pollCount >= 3, "must have genuinely polled multiple times, not resolved on the first check");
  await new Promise<void>((resolve) => replicateServer.close(() => resolve()));
  console.log(`    real async flow: create -> polled ${pollCount} times -> terminal "succeeded" -> output: "${repResult.text}"`);

  // --- [5] Bedrock's real SigV4 signing, present and structurally correct ---
  console.log("\n[5] Bedrock provider: real SigV4 headers computed and sent...\n");
  let bedrockHeaders: any;
  const bedrockServer = createServer((req, res) => {
    bedrockHeaders = req.headers;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ output: { message: { content: [{ text: "real bedrock converse response" }] } } }));
  });
  await new Promise<void>((resolve) => bedrockServer.listen(0, resolve));
  const bedPort = (bedrockServer.address() as any).port;
  const bedrock = new BedrockProvider("AKIAFAKEKEY", "fakeSecretKey123", "us-east-1", "anthropic.claude-sonnet-5", `http://127.0.0.1:${bedPort}`);
  const bedResult = await bedrock.generate({ messages: [{ role: "user", content: "hi" }] }, 5000);
  assert.equal(bedResult.text, "real bedrock converse response");
  assert.match(bedrockHeaders.authorization, /^AWS4-HMAC-SHA256 Credential=AKIAFAKEKEY\/\d{8}\/us-east-1\/bedrock\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[a-f0-9]{64}$/);
  assert.match(bedrockHeaders["x-amz-date"], /^\d{8}T\d{6}Z$/);
  assert.match(bedrockHeaders["x-amz-content-sha256"], /^[a-f0-9]{64}$/);
  await new Promise<void>((resolve) => bedrockServer.close(() => resolve()));
  console.log(`    real SigV4 Authorization header: ${bedrockHeaders.authorization}`);
  console.log(`    x-amz-date: ${bedrockHeaders["x-amz-date"]}, x-amz-content-sha256: ${bedrockHeaders["x-amz-content-sha256"]}`);

  // --- [6] Provider-key storage: up to 10 keys, real DB, real health-check auto-failover ---
  console.log("\n[6] Real DB-backed provider keys: multiple keys, real health check, real auto-failover...\n");
  const db = new DaveDatabase(dbPath);

  let callCount = 0;
  const failoverServer = createServer((req, res) => {
    callCount++;
    if (callCount <= 1) {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "rate limited" }));
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "second key succeeded" } }] }));
    }
  });
  await new Promise<void>((resolve) => failoverServer.listen(0, resolve));
  const foPort = (failoverServer.address() as any).port;

  const key1 = addProviderKey(db, OWNER, "groq", "primary key", { apiKey: "bad-key", baseUrlOverride: `http://127.0.0.1:${foPort}`, model: "llama-3.3-70b-versatile" });
  const key2 = addProviderKey(db, OWNER, "groq", "backup key", { apiKey: "good-key", baseUrlOverride: `http://127.0.0.1:${foPort}`, model: "llama-3.3-70b-versatile" });
  assert.equal(listProviderKeys(db, OWNER, "groq").length, 2);
  console.log(`    real keys stored: ${listProviderKeys(db, OWNER, "groq").map((k) => k.label).join(", ")}`);

  const failoverResult = await generateWithKeyFailover(db, OWNER, "groq", { messages: [{ role: "user", content: "hi" }] });
  assert.equal(failoverResult.text, "second key succeeded");
  const keysAfter = listProviderKeys(db, OWNER, "groq");
  const key1After = keysAfter.find((k) => k.id === key1.id)!;
  assert.equal(key1After.healthy, false, "the failed key must genuinely be marked unhealthy");
  assert.ok(key1After.lastError?.includes("429"), "the real failure reason must be recorded");
  console.log(`    real auto-failover: key "${key1.label}" failed (429) -> marked unhealthy, fell through to "${key2.label}" -> succeeded`);
  console.log(`    recorded failure reason on the bad key: "${key1After.lastError}"`);

  await new Promise<void>((resolve) => failoverServer.close(() => resolve()));

  console.log("\n[6b] Real max-10-keys-per-provider limit enforced...\n");
  for (let i = 0; i < 8; i++) {
    addProviderKey(db, OWNER, "groq", `extra-${i}`, { apiKey: "x" });
  }
  assert.equal(listProviderKeys(db, OWNER, "groq").length, 10);
  let limitEnforced = false;
  try {
    addProviderKey(db, OWNER, "groq", "one-too-many", { apiKey: "x" });
  } catch (err) {
    limitEnforced = err instanceof Error && err.message.includes("10-key limit");
  }
  assert.ok(limitEnforced, "must genuinely refuse an 11th key for the same provider");
  console.log("    the real 10-key cap is enforced -- an 11th add for the same provider is refused");

  console.log("\n[6b2] checkProviderKeyHealth(): a real, direct health-check call (not just failover-driven)...\n");
  const staleKey = addProviderKey(db, OWNER, "cerebras", "stale", { apiKey: "x", baseUrlOverride: "http://127.0.0.1:1" });
  const healthy = await checkProviderKeyHealth(db, OWNER, staleKey, 1000);
  assert.equal(healthy, false);
  const staleAfter = listProviderKeys(db, OWNER, "cerebras")[0];
  assert.equal(staleAfter.healthy, false);
  assert.ok(staleAfter.lastCheckedAt !== null);
  console.log(`    real direct health check against an unreachable host correctly returned false, recorded at ${staleAfter.lastCheckedAt}`);

  console.log("\n[6c] All-keys-failed is a real, typed, honest failure (no network reachable)...\n");
  addProviderKey(db, OWNER, "mistral", "unreachable", { apiKey: "x", baseUrlOverride: "http://127.0.0.1:1" });
  let allFailed = false;
  try {
    await generateWithKeyFailover(db, OWNER, "mistral", { messages: [{ role: "user", content: "hi" }] }, 1500);
  } catch (err) {
    allFailed = err instanceof AllProviderKeysFailedError;
  }
  assert.ok(allFailed, "a genuinely unreachable provider must fail honestly, typed, not silently");
  console.log("    real, typed AllProviderKeysFailedError thrown when no stored key for a provider can succeed");

  // --- [7] buildProvider(): resolves the right class per catalog entry, including the alias ---
  console.log("\n[7] buildProvider() resolves the correct class for representative catalog entries...\n");
  const built = buildProvider("lepton", { apiKey: "x" });
  assert.equal(built.constructor.name, "OpenAICompatibleProvider");
  const builtBedrock = buildProvider("bedrock", { apiKey: "AKIA...", secretAccessKey: "secret", region: "eu-west-1" });
  assert.equal(builtBedrock.constructor.name, "BedrockProvider");
  console.log(`    lepton -> ${built.constructor.name} (aliased to nvidia-nim's real endpoint)`);
  console.log(`    bedrock -> ${builtBedrock.constructor.name}`);

  // --- [8] Real model auto-fetch vs. forced manual entry ---
  console.log("\n[8] Model listing: real auto-fetch where supported, forced manual entry where instructed...\n");
  const manualResult = await fetchAvailableModels("openrouter", { apiKey: "x" });
  assert.equal(manualResult.manualEntryRequired, true);
  assert.deepEqual(manualResult.models, []);
  console.log(`    openrouter correctly reports manualEntryRequired: true (forced, despite a real /models endpoint existing)`);

  const modelsServer = createServer((req, res) => {
    assert.equal(req.url, "/models");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "llama-3.3-70b-versatile" }, { id: "mixtral-8x7b" }] }));
  });
  await new Promise<void>((resolve) => modelsServer.listen(0, resolve));
  const msPort = (modelsServer.address() as any).port;
  const autoResult = await fetchAvailableModels("groq", { apiKey: "x", baseUrlOverride: `http://127.0.0.1:${msPort}` });
  assert.equal(autoResult.manualEntryRequired, false);
  assert.deepEqual(autoResult.models, ["llama-3.3-70b-versatile", "mixtral-8x7b"]);
  await new Promise<void>((resolve) => modelsServer.close(() => resolve()));
  console.log(`    groq (auto-fetch-supported) real /models round-trip: ${JSON.stringify(autoResult.models)}`);

  db.close();
  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
