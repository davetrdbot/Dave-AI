import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { DaveDatabase } from "@dave/db";
import { generateWithKeyFailover, getModelConfig } from "../src/index.js";

console.log("=== Real bug fixed: default primary \"airllm\" failed on every fresh account ===\n");
console.log(
  "Every real /providers, /models and provider-detail screen (command-router.ts) tells the user\n" +
    "airllm is 'self-hosted via AIRLLM_BASE_URL -- no stored key needed'. But generateWithKeyFailover\n" +
    "(the ONLY real runtime path a chat/tick request takes -- see provider-selection.ts) used to\n" +
    "unconditionally require listProviderKeys(...).length > 0 first, with no airllm exception.\n" +
    "provider-router.ts's DEFAULT_CONFIG is { primary: \"airllm\", fallback: [] } -- the real config\n" +
    "every brand-new account starts on -- so EVERY message on a fresh install failed immediately\n" +
    "with 'no stored keys for provider \"airllm\"', before ever reaching the network.\n"
);

const workDir = mkdtempSync(join(tmpdir(), "dave-airllm-no-key-"));
const dbPath = join(workDir, "dave.db");

try {
  const db = new DaveDatabase(dbPath);
  const freshUserId = "brand-new-user";

  console.log("[1] A brand-new user's real default model config is primary=airllm, fallback=[]...");
  const config = getModelConfig(freshUserId);
  console.log(`    ${JSON.stringify(config)}`);
  assert.equal(config.primary, "airllm");
  assert.deepEqual(config.fallback, []);

  console.log("\n[2] Real regression check: airllm must never throw \"no stored keys\" -- it has none by design.");
  const deadServer = createServer((_req, res) => void res); // never responds
  await new Promise<void>((resolve) => deadServer.listen(0, resolve));
  const deadPort = (deadServer.address() as { port: number }).port;
  const savedBaseUrl = process.env.AIRLLM_BASE_URL;
  process.env.AIRLLM_BASE_URL = `http://127.0.0.1:${deadPort}`;
  try {
    await generateWithKeyFailover(db, freshUserId, "airllm", { messages: [{ role: "user", content: "hi" }] }, 300);
    assert.fail("expected a real timeout error from the dead server");
  } catch (err) {
    const message = (err as Error).message;
    console.log(`    threw: ${message}`);
    assert.ok(!message.includes("no stored keys"), "must reach the real network call, not the key-required gate");
    assert.match(message, /timed out/);
  } finally {
    deadServer.close();
    if (savedBaseUrl === undefined) delete process.env.AIRLLM_BASE_URL;
    else process.env.AIRLLM_BASE_URL = savedBaseUrl;
  }

  console.log("\n[3] Real success path: a real self-hosted AirLLM responds, with zero stored keys for this user.");
  const okServer = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text: "hello from self-hosted airllm" }));
    });
  });
  await new Promise<void>((resolve) => okServer.listen(0, resolve));
  const okPort = (okServer.address() as { port: number }).port;
  process.env.AIRLLM_BASE_URL = `http://127.0.0.1:${okPort}`;
  try {
    const result = await generateWithKeyFailover(db, freshUserId, "airllm", { messages: [{ role: "user", content: "hi" }] }, 2000);
    console.log(`    result: ${JSON.stringify(result)}`);
    assert.equal(result.provider, "airllm");
    assert.equal(result.text, "hello from self-hosted airllm");
  } finally {
    okServer.close();
    if (savedBaseUrl === undefined) delete process.env.AIRLLM_BASE_URL;
    else process.env.AIRLLM_BASE_URL = savedBaseUrl;
  }

  db.close();
  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
