import assert from "node:assert/strict";

/**
 * AWS Bedrock with an Amazon Bedrock API key (the console's long-term key), region eu-north-1:
 * Bearer auth on Converse, models listed from the control plane (foundation models + the "eu."
 * inference profiles), and the Converse request rules (alternating turns, tool results merged,
 * pictures, cache points only where the model accepts them).
 */
const { BedrockProvider, buildConverseBody, bedrockSupportsCaching } = await import("../src/providers.js");
const { buildProvider } = await import("../src/provider-factory.js");
const { fetchAvailableModels } = await import("../src/model-fetch.js");
const { keyLineConfig, pickReplacementModel, isModelUnavailableError } = await import("../src/provider-keys.js");

console.log("=== Step 167: Bedrock with an API key, eu-north-1 ===\n");

const calls: { url: string; init: RequestInit }[] = [];
const realFetch = globalThis.fetch;
let reply: (url: string) => Response = () => new Response("{}", { status: 200 });
globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
  calls.push({ url: String(url), init });
  return reply(String(url));
}) as typeof fetch;

console.log("[1] A pasted key line: the key, optionally a region after it");
assert.deepEqual(keyLineConfig("bedrock", "ABSKxyz"), { apiKey: "ABSKxyz" });
assert.deepEqual(keyLineConfig("bedrock", "ABSKxyz eu-west-1"), { apiKey: "ABSKxyz", region: "eu-west-1" });
assert.deepEqual(keyLineConfig("bedrock", "ABSKxyz not-a-region"), { apiKey: "ABSKxyz" });
assert.deepEqual(keyLineConfig("openai", "sk-1 2"), { apiKey: "sk-1 2" }, "other providers: untouched");
console.log("   ✓\n");

console.log("[2] Converse with the key as Bearer, at eu-north-1 by default");
reply = () =>
  new Response(JSON.stringify({ output: { message: { content: [{ text: "pong" }, { toolUse: { toolUseId: "t1", name: "get_price", input: { symbol: "XAUUSD" } } }] } }, usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } }), { status: 200 });
const p = buildProvider("bedrock", { apiKey: "ABSK-secret", model: "eu.anthropic.claude-sonnet-5" });
const out = await p.generate({ messages: [{ role: "user", content: "ping" }] }, 5000);
assert.equal(calls[0].url, "https://bedrock-runtime.eu-north-1.amazonaws.com/model/eu.anthropic.claude-sonnet-5/converse");
assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer ABSK-secret");
assert.equal(out.text, "pong");
assert.deepEqual(out.toolCalls, [{ id: "t1", name: "get_price", arguments: { symbol: "XAUUSD" } }]);
assert.deepEqual(out.tokenUsage, { promptTokens: 12, completionTokens: 3, totalTokens: 15 });
// IAM keys still sign with SigV4
calls.length = 0;
await new BedrockProvider("AKIAEXAMPLE", "secretsecret", "eu-north-1", "amazon.nova-pro-v1:0").generate({ messages: [{ role: "user", content: "hi" }] }, 5000);
assert.match((calls[0].init.headers as Record<string, string>).authorization, /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/\d{8}\/eu-north-1\/bedrock\/aws4_request/);
console.log("   ✓\n");

console.log("[3] Converse's rules: alternating turns, tool results merged into one user turn, pictures, no blank text");
const body = buildConverseBody(
  {
    messages: [
      { role: "system", content: "You are Dave." },
      { role: "user", content: [{ type: "text", text: "read this" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] },
      { role: "assistant", content: "", toolCalls: [{ id: "a", name: "get_price", arguments: { symbol: "XAUUSD" } }, { id: "b", name: "get_price", arguments: { symbol: "EURUSD" } }] },
      { role: "tool", toolCallId: "a", content: "2350" },
      { role: "tool", toolCallId: "b", content: "1.08" },
    ],
    tools: [{ name: "get_price", description: "price", parameters: { type: "object" } }],
  },
  "amazon.nova-pro-v1:0",
) as { system: unknown[]; messages: { role: string; content: Record<string, unknown>[] }[] };
assert.deepEqual(body.messages.map((m) => m.role), ["user", "assistant", "user"], "two tool results share one user turn");
assert.deepEqual(body.messages[0].content[1], { image: { format: "png", source: { bytes: "AAAA" } } });
assert.equal(body.messages[1].content.length, 2, "blank assistant text dropped, both toolUse kept");
assert.equal(body.messages[2].content.filter((c) => "toolResult" in c).length, 2);
assert.ok(bedrockSupportsCaching("eu.anthropic.claude-sonnet-5") && bedrockSupportsCaching("amazon.nova-pro-v1:0"));
assert.ok(!bedrockSupportsCaching("meta.llama3-70b-instruct-v1:0"));
const llama = buildConverseBody({ messages: [{ role: "system", content: "s" }, { role: "user", content: "hi" }] }, "meta.llama3-70b-instruct-v1:0") as { system: unknown[]; messages: { content: unknown[] }[] };
assert.ok(!JSON.stringify(llama).includes("cachePoint"), "no cache points for models that reject them");
console.log("   ✓\n");

console.log("[4] Fetch models: the eu. inference profiles first, then on-demand text models; LEGACY/embeddings left out");
calls.length = 0;
reply = (url) =>
  url.includes("/inference-profiles")
    ? new Response(JSON.stringify({ inferenceProfileSummaries: [{ inferenceProfileId: "eu.anthropic.claude-sonnet-5", status: "ACTIVE" }, { inferenceProfileId: "eu.amazon.nova-pro-v1:0", status: "ACTIVE" }] }), { status: 200 })
    : new Response(
        JSON.stringify({
          modelSummaries: [
            { modelId: "amazon.nova-lite-v1:0", inferenceTypesSupported: ["ON_DEMAND"], outputModalities: ["TEXT"] },
            { modelId: "anthropic.claude-sonnet-5", inferenceTypesSupported: ["INFERENCE_PROFILE"], outputModalities: ["TEXT"] },
            { modelId: "old.model-v1", inferenceTypesSupported: ["ON_DEMAND"], outputModalities: ["TEXT"], modelLifecycle: { status: "LEGACY" } },
          ],
        }),
        { status: 200 },
      );
const listed = await fetchAvailableModels("bedrock", { apiKey: "ABSK-secret" });
assert.deepEqual(listed.models, ["eu.anthropic.claude-sonnet-5", "eu.amazon.nova-pro-v1:0", "amazon.nova-lite-v1:0"]);
assert.ok(calls.every((c) => c.url.startsWith("https://bedrock.eu-north-1.amazonaws.com/")), "the control plane, same region");
assert.ok(calls.every((c) => (c.init.headers as Record<string, string>).authorization === "Bearer ABSK-secret"));
console.log("   ✓\n");

console.log("[5] A model that needs its eu. profile is recovered automatically, not blamed on the key");
assert.ok(isModelUnavailableError("HTTP 400: ValidationException: Invocation of model ID anthropic.claude-sonnet-5 with on-demand throughput isn't supported. Retry your request with the ID or ARN of an inference profile"));
assert.ok(isModelUnavailableError("HTTP 400: ValidationException: The provided model identifier is invalid."));
assert.ok(!isModelUnavailableError("HTTP 403: AccessDeniedException: authentication failed"));
assert.equal(pickReplacementModel("anthropic.claude-sonnet-5", listed.models), "eu.anthropic.claude-sonnet-5");
console.log("   ✓\n");

globalThis.fetch = realFetch;
console.log("=== ALL ASSERTIONS PASSED ===");
