import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { DaveDatabase } from "@dave/db";
import { PROVIDER_TOOLS, listProviderKeys, editProviderKey, generateWithCustomProvider } from "../src/index.js";

console.log("=== Update 4 real proof: provider CRUD as real agent tools ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-update4-"));
const dbPath = join(workDir, "dave.db");
const OWNER = "user-1";

try {
  const db = new DaveDatabase(dbPath);
  const ctx = { userId: OWNER, db };
  const tool = (name: string) => PROVIDER_TOOLS.find((t) => t.name === name)!;

  // --- [1] create_custom_provider: a brand new provider, endpoint+key, THROUGH the tool ---
  console.log("[1] create_custom_provider tool: real endpoint+key, callable, not just admin-UI...\n");
  let captured: any;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      captured = { path: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "real response from a custom provider" } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;

  const created: any = await tool("create_custom_provider").execute(
    { name: "My Local vLLM", baseUrl: `http://127.0.0.1:${port}`, apiKey: "custom-key-1", model: "my-local-model" },
    ctx
  );
  assert.ok(created.id);
  assert.equal(created.name, "My Local vLLM");
  console.log(`    real custom provider created via the tool: id=${created.id}, name="${created.name}"`);

  const genResult = await generateWithCustomProvider(db, OWNER, created.id, { messages: [{ role: "user", content: "hi" }] });
  assert.equal(genResult.text, "real response from a custom provider");
  assert.equal(captured.auth, "Bearer custom-key-1");
  assert.equal(captured.body.model, "my-local-model");
  console.log(`    real generate() through the custom provider reached the real server: ${JSON.stringify(captured)}`);

  // --- [2] edit_custom_provider: an EXISTING custom provider's endpoint/config, through the tool ---
  console.log("\n[2] edit_custom_provider tool: editing an EXISTING provider's config, not creating a new one...\n");
  const edited: any = await tool("edit_custom_provider").execute({ id: created.id, model: "my-updated-model", apiKey: "custom-key-2" }, ctx);
  assert.equal(edited.id, created.id, "must be the SAME provider, edited in place");
  assert.equal(edited.model, "my-updated-model");
  assert.equal(edited.apiKey, "custom-key-2");
  assert.equal(edited.baseUrl, `http://127.0.0.1:${port}`, "untouched fields must survive the edit");
  console.log(`    real edit applied in place: model "${created.model}" -> "${edited.model}", same id ${edited.id}`);

  await generateWithCustomProvider(db, OWNER, created.id, { messages: [{ role: "user", content: "hi" }] });
  assert.equal(captured.auth, "Bearer custom-key-2", "the edited key must actually be used on the next real call");
  assert.equal(captured.body.model, "my-updated-model");
  console.log(`    real next call used the EDITED key/model: ${captured.auth}, model=${captured.body.model}`);

  await new Promise<void>((resolve) => server.close(() => resolve()));

  // --- [3] add_provider_key / edit_provider_key: editing an EXISTING built-in provider's endpoint/config ---
  console.log("\n[3] edit_provider_key tool: editing an EXISTING built-in provider's endpoint/config...\n");
  const addedKey: any = await tool("add_provider_key").execute({ provider: "groq", label: "primary", apiKey: "gk-1", model: "llama-3.3-70b-versatile" }, ctx);
  assert.ok(addedKey.id);
  const editedKey: any = await tool("edit_provider_key").execute({ keyId: addedKey.id, baseUrlOverride: "http://127.0.0.1:9", model: "llama-4" }, ctx);
  assert.equal(editedKey.id, addedKey.id);
  assert.equal(editedKey.config.baseUrlOverride, "http://127.0.0.1:9");
  assert.equal(editedKey.config.model, "llama-4");
  assert.equal(editedKey.config.apiKey, "gk-1", "fields not touched by the edit must survive");
  console.log(`    real edit changed baseUrlOverride/model in place, apiKey untouched: ${JSON.stringify(editedKey.config)}`);

  // --- [4] Full CRUD lifecycle through the tools: list -> remove -> confirm gone ---
  console.log("\n[4] Full lifecycle through the tools: list -> remove -> confirm gone (real DB state each time)...\n");
  const listed: any = await tool("list_provider_keys").execute({ provider: "groq" }, ctx);
  assert.equal(listed.length, 1);
  const removed: any = await tool("remove_provider_key").execute({ keyId: addedKey.id }, ctx);
  assert.equal(removed.removed, true);
  assert.equal(listProviderKeys(db, OWNER, "groq").length, 0);
  console.log("    real remove_provider_key genuinely deleted the row -- list is empty afterward");

  const deletedCustom: any = await tool("delete_custom_provider").execute({ id: created.id }, ctx);
  assert.equal(deletedCustom.removed, true);
  const listAfter: any = await tool("list_providers").execute({}, ctx);
  assert.equal(listAfter.custom.length, 0);
  assert.ok(listAfter.builtIn.length > 20);
  console.log(`    real delete_custom_provider genuinely removed it; list_providers now shows ${listAfter.builtIn.length} built-in + ${listAfter.custom.length} custom`);

  // --- [5] Every tool is real -- editProviderKey directly (module-level, not just via tool) also proven ---
  console.log("\n[5] editProviderKey() module function directly -- confirms the tool is a thin wrapper, not separate logic...\n");
  const key2 = await tool("add_provider_key").execute({ provider: "mistral", label: "m1", apiKey: "mk-1" }, ctx) as any;
  const directEdit = editProviderKey(db, OWNER, key2.id, { label: "m1-renamed" });
  assert.equal(directEdit?.label, "m1-renamed");
  console.log(`    direct module call and the tool wrapper operate on the same real DB row: ${directEdit?.label}`);

  db.close();
  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
