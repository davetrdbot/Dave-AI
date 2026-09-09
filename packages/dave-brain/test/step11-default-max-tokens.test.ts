import assert from "node:assert/strict";
import { createServer } from "node:http";
import { OpenAICompatibleProvider } from "../src/providers.js";

/**
 * Real bug fixed (user: "I said not only that model other model too... check for bugs in the
 * code and fix it based on the providers and others"). Every provider defaulted `max_tokens` to
 * 512 whenever the caller didn't pass one -- and dave-agent-loop, the only real production
 * caller, NEVER passes `maxTokens` at all, so every real request everywhere used 512
 * unconditionally, regardless of which model was configured. Confirmed live against Gemini's real
 * OpenAI-compat endpoint with a real key: a Gemini 3-family "thinking" model (reasoning on by
 * default) burned the ENTIRE 512-token-scale budget on internal reasoning and returned genuinely
 * empty visible text; a larger budget completed normally. This is not specific to the one model
 * string fixed earlier -- it risks the same starvation on ANY reasoning-capable model on ANY
 * provider. This proves the real default sent on the wire is now a real, higher ceiling.
 */

console.log("=== Real proof: the real default max_tokens sent on the wire is no longer a starvation-prone 512 ===\n");

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
  assert.equal(capturedBody.max_tokens, 4096, "the real default sent on the wire must be a real, higher ceiling, not the old starvation-prone 512");
  console.log(`    real max_tokens sent on the wire: ${capturedBody.max_tokens}`);

  console.log("\n[2] An explicit maxTokens the caller DOES pass is still honored, never overridden...\n");
  await provider.generate({ messages: [{ role: "user", content: "hi" }], maxTokens: 30 }, 5000);
  assert.equal(capturedBody.max_tokens, 30);
  console.log(`    real explicit override still respected: ${capturedBody.max_tokens}`);

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  server.close();
}

process.exit(0);
