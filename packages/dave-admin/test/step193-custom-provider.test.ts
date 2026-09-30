import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workDir = mkdtempSync(join(tmpdir(), "dave-customprov-"));
process.env.DAVE_DATA_ROOT = workDir;
process.env.DATA_DIR = join(workDir, "db");
delete process.env.OWNER_USER_ID;

const { NextRequest } = await import("next/server");
const { createPairingCode, redeemPairingCode } = await import("../server/device-auth.js");
const { DaveDatabase } = await import("@dave/db");
const brain = await import("@dave/brain");
const providerRoute = await import("../app/api/app/provider/route.js");
const providersRoute = await import("../app/api/app/providers/route.js");
const { dbPathFor } = await import("../server/db-path.js");

/**
 * The trader: "make provision to add provider in the app ... like OpenAI compatible". A custom
 * provider added from the phone (name, web address, key, model) must be one Dave really answers
 * with -- the saved row was never used by anything before -- and the new catalog providers
 * show up in the app's list.
 */

console.log("=== Step 193: your own OpenAI-compatible provider, from the app ===\n");

const USER = "default";
const { code } = createPairingCode(USER);
const { token } = redeemPairingCode(USER, code, "test phone");
type Handler = (req: InstanceType<typeof NextRequest>) => Promise<Response>;
async function call(handler: Handler, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const req = new NextRequest(`http://localhost${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await handler(req);
  return { status: res.status, json: await res.json() };
}

// A stand-in OpenAI-compatible service that records what it was sent.
const seen: { path: string; auth: string; model: string }[] = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = body ? JSON.parse(body) : {};
    seen.push({ path: req.url ?? "", auth: String(req.headers.authorization ?? ""), model: parsed.model });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "x", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "hello from my provider" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }));
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;

try {
  console.log("[1] Adding one needs a web address and a model; a pasted full endpoint is cleaned up\n");
  let r = await call(providerRoute.POST as Handler, "POST", "/api/app/provider", { provider: "custom", action: "add-key", label: "My box", apiKey: "sk-test-123", model: "my-model" });
  assert.equal(r.status, 400, "no web address -> refused");
  r = await call(providerRoute.POST as Handler, "POST", "/api/app/provider", { provider: "custom", action: "add-key", label: "My box", apiKey: "sk-test-123", baseUrl: "http://evil.example.com/v1", model: "my-model" });
  assert.equal(r.status, 400, "plain http to a remote host is refused (keys would travel unencrypted)");
  r = await call(providerRoute.POST as Handler, "POST", "/api/app/provider", {
    provider: "custom",
    action: "add-key",
    label: "My box",
    apiKey: "sk-test-123",
    baseUrl: `http://127.0.0.1:${port}/v1/chat/completions/`,
    model: "my-model",
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.isCustom, true);
  assert.equal(r.json.keys[0].baseUrl, `http://127.0.0.1:${port}/v1`, "the /chat/completions the trader pasted is trimmed");
  assert.equal(r.json.keys[0].model, "my-model");
  assert.ok(!JSON.stringify(r.json).includes("sk-test-123"), "the key never comes back in full");
  console.log("   ✓\n");

  console.log("[2] Made Dave's main AI, it is the one that answers\n");
  r = await call(providerRoute.POST as Handler, "POST", "/api/app/provider", { provider: "custom", action: "make-main" });
  assert.equal(r.status, 200);
  assert.equal(brain.getModelConfig(USER).primary, "custom");
  const db = new DaveDatabase(dbPathFor(USER));
  try {
    const result = await brain.generateWithKeyFailover(db, USER, "custom", { messages: [{ role: "user", content: "hi" }] }, 5000);
    assert.equal(result.text, "hello from my provider");
  } finally {
    db.close();
  }
  assert.deepEqual(seen.at(-1), { path: "/v1/chat/completions", auth: "Bearer sk-test-123", model: "my-model" });
  console.log("   ✓\n");

  console.log("[3] Each connection keeps its own model\n");
  r = await call(providerRoute.POST as Handler, "POST", "/api/app/provider", {
    provider: "custom",
    action: "add-key",
    label: "Second",
    apiKey: "sk-two",
    baseUrl: `127.0.0.1:${port}/v1`,
    model: "other-model",
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.keys[1].baseUrl, `https://127.0.0.1:${port}/v1`, "an address typed without https:// gets it");
  r = await call(providerRoute.POST as Handler, "POST", "/api/app/provider", { provider: "custom", action: "remove-key", keyId: r.json.keys[1].id });
  assert.equal(r.json.keys.length, 1);
  r = await call(providerRoute.POST as Handler, "POST", "/api/app/provider", { provider: "custom", action: "add-key", label: "Second", apiKey: "sk-two", baseUrl: `http://localhost:${port}/v1`, model: "other-model" });
  assert.equal(r.status, 200);
  const [first, second] = r.json.keys;
  assert.equal(first.model, "my-model");
  assert.equal(second.model, "other-model");
  r = await call(providerRoute.POST as Handler, "POST", "/api/app/provider", { provider: "custom", action: "set-model", keyId: second.id, model: "renamed-model" });
  assert.equal(r.json.keys[0].model, "my-model", "changing one connection's model leaves the other alone");
  assert.equal(r.json.keys[1].model, "renamed-model");
  console.log("   ✓\n");

  console.log("[4] The new catalog providers are in the app's list\n");
  r = await call(providersRoute.GET as Handler, "GET", "/api/app/providers");
  const ids = JSON.stringify(r.json);
  for (const id of ["chutes", "featherless", "requesty", "vercelgateway", "ollamacloud", "atlascloud", "zenmux", "nanogpt"]) assert.ok(ids.includes(`"${id}"`), `${id} listed`);
  assert.equal(brain.PROVIDER_CATALOG.custom.displayName, "Custom (OpenAI-compatible)");
  console.log("   ✓\n");

  console.log("=== Step 193 passed ===");
} finally {
  server.close();
}
process.exit(0);
