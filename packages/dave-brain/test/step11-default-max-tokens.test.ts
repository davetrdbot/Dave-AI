import assert from "node:assert/strict";
import { createServer } from "node:http";
import { OpenAICompatibleProvider } from "../src/providers.js";

/**
 * Real bug fixed (user: "I said not only that model other model too... check for bugs in the
 * code and fix it based on the providers and others"), then further corrected per the user's
 * explicit follow-up: "4096, remove that, they should be no limitations for token I didn't ask
 * you for this." A hardcoded default (originally 512, briefly 4096) silently capped every real
 * request that didn't explicitly pass `maxTokens` -- which is EVERY real production call, since
 * dave-agent-loop never sets it. Confirmed live earlier that 512 genuinely starves a Gemini
 * "thinking" model's visible output. Per the user's explicit instruction, no default is imposed
 * at all anymore -- `max_tokens` is only ever sent when the caller genuinely passes one; omitted,
 * each provider's own real API default (typically that model's own real max output) applies.
 */

console.log("=== Real proof: no hardcoded max_tokens default is ever imposed -- only an explicit caller value is sent ===\n");

let capturedBody: any;
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    capturedBody = JSON.parse(raw);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;

try {
  console.log("[1] No maxTokens passed (the real production call shape -- dave-agent-loop never sets it)...\n");
  const provider = new OpenAICompatibleProvider("gemini", `http://127.0.0.1:${port}`, "test-key", "gemini-flash-latest");
  await provider.generate({ messages: [{ role: "user", content: "hi" }] }, 5000);
  assert.ok(!("max_tokens" in capturedBody), "max_tokens must be genuinely ABSENT from the request, not filled with any invented default");
  console.log(`    real request body keys: ${JSON.stringify(Object.keys(capturedBody))} -- no max_tokens field at all`);

  console.log("\n[2] An explicit maxTokens the caller DOES pass is still honored, never overridden or dropped...\n");
  await provider.generate({ messages: [{ role: "user", content: "hi" }], maxTokens: 30 }, 5000);
  assert.equal(capturedBody.max_tokens, 30);
  console.log(`    real explicit value still respected: ${capturedBody.max_tokens}`);

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  server.close();
}

process.exit(0);
