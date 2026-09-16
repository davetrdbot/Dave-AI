import assert from "node:assert/strict";
import { OpenAICompatibleProvider, stripInlineToolCallMarkers } from "../src/providers.js";

/**
 * Real bug fixed (trader, live, with real pasted proof -- this exact string appeared as visible
 * bot text in Telegram):
 *   "Margin's at $56, equity down to $61 vs balance $80 -- you've got positions underwater.
 *    Checking what's open.<|toolcallssectionbegin|><|toolcallbegin|>call06f079ade1a8495e8511f748
 *    <|toolcallargumentbegin|>{}<|toolcallend|><|toolcallssectionend|>"
 *
 * Root cause: some open-weight models served through the generic OpenAI-compatible
 * `/chat/completions` path (added in commit 98cd706's 9-new-providers expansion -- Kimi-K2-family
 * models are reachable through several of them, e.g. Moonshot/Kimi directly, and Fireworks/Baseten
 * as open-weight hosts) emit a tool call as raw templated text tokens INSIDE `message.content`
 * instead of populating the structured `message.tool_calls` field. `OpenAICompatibleProvider`
 * only ever read the structured field and returned `message.content` verbatim as `text` -- there
 * was no code anywhere in the repo that recognized or stripped this marker family.
 *
 * This test feeds the trader's EXACT pasted string back through a real `OpenAICompatibleProvider`
 * (via a mocked fetch returning it as `message.content` with no `tool_calls`), and asserts the raw
 * `<|toolcall...|>` tokens never appear anywhere in the final `text` handed back to the caller
 * (which is what reaches Telegram).
 */

console.log("=== Real proof: raw inline tool-call marker tokens never leak into user-visible text ===\n");

const REAL_TRADER_PASTE =
  "Margin's at $56, equity down to $61 vs balance $80 — you've got positions underwater. Checking what's open." +
  "<|toolcallssectionbegin|><|toolcallbegin|>call06f079ade1a8495e8511f748<|toolcallargumentbegin|>{}<|toolcallend|><|toolcallssectionend|>";

console.log("[1] The trader's exact pasted string, through a real OpenAICompatibleProvider.generate()...\n");
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: REAL_TRADER_PASTE } }],
      }),
      { status: 200 }
    )) as typeof fetch;

  try {
    const provider = new OpenAICompatibleProvider("moonshot" as never, "http://fake-host.invalid", "fake-key", "kimi-k2-test");
    const result = await provider.generate({ messages: [{ role: "user", content: "what's my margin?" }] }, 5000);
    console.log(`    real returned text: ${JSON.stringify(result.text)}`);
    assert.ok(!result.text.includes("<|"), "no raw '<|...|>' marker token may ever appear in user-visible text");
    assert.ok(!result.text.includes("toolcall"), "no raw 'toolcall' marker fragment may ever appear in user-visible text");
    assert.ok(result.text.includes("Margin's at $56"), "the real, legitimate leading reply text must still be preserved");
    assert.ok(result.text.includes("Checking what's open."), "the real, legitimate leading reply text must still be preserved");
    // This specific real segment (a bare opaque id with no `functions.NAME` in it, and an empty
    // `{}` payload with no recoverable arguments) is genuinely unparseable into a real tool name --
    // honestly reported as unresolved rather than silently invented.
    console.log(`    toolCalls: ${JSON.stringify(result.toolCalls)}`);
  } finally {
    globalThis.fetch = realFetch;
  }
}
console.log("\n[1] PASSED\n");

console.log("[2] stripInlineToolCallMarkers() directly on the trader's exact string...\n");
{
  const { text, toolCalls } = stripInlineToolCallMarkers(REAL_TRADER_PASTE);
  assert.ok(!text.includes("<|"), "no raw marker token");
  assert.ok(text.startsWith("Margin's at $56"), "legitimate text preserved, markers stripped from the tail");
  assert.equal(toolCalls, undefined, "no function name was recoverable from a bare opaque id -- honestly not fabricated into a real ToolCall");
}
console.log("\n[2] PASSED\n");

console.log("[3] A real, well-formed inline tool call (documented Kimi-K2 shape, with a real functions.NAME) IS parsed into a real, executable ToolCall...\n");
{
  const wellFormed =
    "Sure, let me check.<|tool_calls_section_begin|>" +
    '<|tool_call_begin|>functions.get_open_positions:0<|tool_call_argument_begin|>{"symbol":"EURUSD"}<|tool_call_end|>' +
    "<|tool_calls_section_end|>";
  const { text, toolCalls } = stripInlineToolCallMarkers(wellFormed);
  console.log(`    text: ${JSON.stringify(text)}, toolCalls: ${JSON.stringify(toolCalls)}`);
  assert.ok(!text.includes("<|"), "no raw marker token even when a real tool call was successfully parsed out");
  assert.ok(toolCalls && toolCalls.length === 1, "a well-formed segment with a real function name and valid JSON must become a real ToolCall");
  assert.equal(toolCalls![0].name, "get_open_positions");
  assert.deepEqual(toolCalls![0].arguments, { symbol: "EURUSD" });
}
console.log("\n[3] PASSED\n");

console.log("[4] Plain text with no markers at all passes through completely untouched...\n");
{
  const plain = "Your balance is $80, equity $61.";
  const { text, toolCalls } = stripInlineToolCallMarkers(plain);
  assert.equal(text, plain);
  assert.equal(toolCalls, undefined);
}
console.log("\n[4] PASSED\n");

console.log("=== ALL ASSERTIONS PASSED -- raw tool-call tokens never leak into chat ===");
process.exit(0);
