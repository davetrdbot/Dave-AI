import assert from "node:assert/strict";
import { OpenAICompatibleProvider, ProviderError } from "../src/providers.js";
import { PROVIDER_CATALOG } from "../src/provider-catalog.js";

/**
 * Two real, live-reported bugs, both hit through nscale:
 *
 * 1. Every autonomous trading cycle crashed with the provider's own error body:
 *    HTTP 400 INVALID_TOOL_CHOICE -- 'Supported tool_choice values are "auto" and "none" currently'.
 *    The tick forces tool_choice to the named decision tool, and this class always sent the full
 *    OpenAI named-function shape.
 * 2. "nscale provider it just says ✅ Done." -- "✅ Done." is telegram-bot-server's fallback for an
 *    EMPTY final text. nscale's default model is DeepSeek-R1-Distill-Qwen-32B, a reasoning model
 *    that returns its answer in `reasoning_content` with `content` empty; this class only ever read
 *    `content`, so the whole reply was discarded.
 */

const realFetch = globalThis.fetch;
interface Captured { url: string; body: Record<string, unknown> }

function mockFetch(responder: (call: Captured, n: number) => { status: number; json: unknown }) {
  const calls: Captured[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : {};
    const captured: Captured = { url: String(url), body };
    calls.push(captured);
    const r = responder(captured, calls.length);
    return new Response(typeof r.json === "string" ? r.json : JSON.stringify(r.json), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

const okReply = (message: Record<string, unknown>) => ({ status: 200, json: { choices: [{ message }] } });
const NSCALE_400 = JSON.stringify({
  error: { code: "400", error_type: "INVALID_TOOL_CHOICE", message: 'Supported tool_choice values are "auto" and "none" currently.', param: "tool_choice" },
});
const req = {
  messages: [{ role: "user" as const, content: "decide" }],
  tools: [{ name: "decide_trade", description: "d", parameters: { type: "object", properties: {} } }],
  toolChoice: { name: "decide_trade" },
};

console.log("=== nscale: tool_choice shape + reasoning-only replies ===\n");

try {
  console.log("[1] The catalog marks nscale auto-only (its server rejects the named form)...\n");
  assert.equal(PROVIDER_CATALOG.nscale.toolChoiceStyle, "auto-only");
  assert.equal(PROVIDER_CATALOG.openai.toolChoiceStyle, undefined, "every other provider keeps the default named shape");
  console.log("    confirmed: nscale=auto-only, openai untouched");

  console.log("\n[2] An auto-only provider sends tool_choice:\"auto\" -- never the named object...\n");
  {
    const calls = mockFetch(() => okReply({ content: "ok" }));
    const p = new OpenAICompatibleProvider("nscale", "https://x/v1", "k", "m", "/chat/completions", "bearer", "auto-only");
    await p.generate(req, 5000);
    assert.equal(calls[0].body.tool_choice, "auto", `must send the plain string, got ${JSON.stringify(calls[0].body.tool_choice)}`);
    assert.ok(Array.isArray(calls[0].body.tools) && (calls[0].body.tools as unknown[]).length === 1, "the tool itself is still sent");
    console.log("    confirmed: tool_choice=\"auto\", tool still present");
  }

  console.log("\n[3] The default (named) style is unchanged -- no regression for other providers...\n");
  {
    const calls = mockFetch(() => okReply({ content: "ok" }));
    const p = new OpenAICompatibleProvider("openai", "https://x/v1", "k", "m");
    await p.generate(req, 5000);
    assert.deepEqual(calls[0].body.tool_choice, { type: "function", function: { name: "decide_trade" } });
    console.log("    confirmed: named shape preserved");
  }

  console.log("\n[4] An UNCATALOGUED provider that rejects the named form self-heals: one retry with \"auto\"...\n");
  {
    const calls = mockFetch((c, n) => (n === 1 ? { status: 400, json: NSCALE_400 } : okReply({ content: "recovered" })));
    const p = new OpenAICompatibleProvider("groq", "https://x/v1", "k", "m");
    const out = await p.generate(req, 5000);
    assert.equal(calls.length, 2, "exactly one retry");
    assert.deepEqual(calls[0].body.tool_choice, { type: "function", function: { name: "decide_trade" } }, "first attempt: named");
    assert.equal(calls[1].body.tool_choice, "auto", "retry: auto");
    assert.equal(out.text, "recovered");
    console.log("    confirmed: 400 on named -> retried with auto -> succeeded");
  }

  console.log("\n[5] An UNRELATED 400 is NOT retried and still surfaces as a real error...\n");
  {
    const calls = mockFetch(() => ({ status: 400, json: { error: { message: "model not found" } } }));
    const p = new OpenAICompatibleProvider("groq", "https://x/v1", "k", "m");
    await assert.rejects(() => p.generate(req, 5000), ProviderError, "an unrelated 400 must still throw");
    assert.equal(calls.length, 1, "must NOT retry an unrelated 400");
    console.log("    confirmed: no retry, error preserved");
  }

  console.log("\n[6] A reasoning-only reply (content empty, reasoning_content set) is no longer dropped...\n");
  {
    mockFetch(() => okReply({ content: "", reasoning_content: "VOL_80 swept the low and reclaimed the FVG, so I'd go long." }));
    const p = new OpenAICompatibleProvider("nscale", "https://x/v1", "k", "m", "/chat/completions", "bearer", "auto-only");
    const out = await p.generate({ messages: [{ role: "user", content: "hi" }] }, 5000);
    assert.match(out.text, /reclaimed the FVG/, "the reasoning must become the reply instead of an empty string");
    console.log("    confirmed: reasoning_content used when content is empty");
  }
  {
    mockFetch(() => okReply({ content: null, reasoning: "GPT-OSS style field." }));
    const p = new OpenAICompatibleProvider("nscale", "https://x/v1", "k", "m");
    const out = await p.generate({ messages: [{ role: "user", content: "hi" }] }, 5000);
    assert.equal(out.text, "GPT-OSS style field.", "the `reasoning` spelling is handled too");
    console.log("    confirmed: `reasoning` spelling handled, content:null handled");
  }

  console.log("\n[7] A normal reply that DOES fill content is never overridden by reasoning...\n");
  {
    mockFetch(() => okReply({ content: "the real answer", reasoning_content: "internal chain of thought" }));
    const p = new OpenAICompatibleProvider("nscale", "https://x/v1", "k", "m");
    const out = await p.generate({ messages: [{ role: "user", content: "hi" }] }, 5000);
    assert.equal(out.text, "the real answer", "content wins whenever it is non-empty");
    console.log("    confirmed: content always wins -- reasoning is strictly a fallback");
  }

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  globalThis.fetch = realFetch;
}
process.exit(0);
