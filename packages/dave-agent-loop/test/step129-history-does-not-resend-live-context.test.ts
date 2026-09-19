import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompletionMessage } from "@dave/brain";

/**
 * Real, MEASURED latency bug fixed (the trader, live: "responses are slow" on a plain chat
 * message). Traced with a real end-to-end harness against a local fake provider, not by reading:
 * one plain "hey dave, how's it going?" uploads 94,757 bytes (~23.7k tokens) before the model
 * emits a single token -- 67,911 of that the frozen system prompt, 26,049 the 70 core tool
 * schemas. That floor is a product decision. What is NOT a product decision is that the floor
 * GROWS without bound over a session:
 *
 *   1. live-context.ts deliberately rebuilds a fresh settings/clock/memory/knowledge block every
 *      turn and prepends it to the user's message -- correct. But that message was then persisted
 *      verbatim into conversation history and re-uploaded on every subsequent turn. Measured: the
 *      block is 663 chars bare, and 30,172 chars once an active strategy skill is set (its full
 *      body is embedded). With ~30 user turns retained under MAX_MESSAGES=60 that is ~884 KB /
 *      ~226k tokens of STALE duplicates on every single request -- twenty-nine old snapshots of
 *      settings and a "NOW:" clock line from hours ago, presented to the model as if current.
 *   2. Raw tool results were stored whole. A real `get_all_analysis` suite is ~24 KB (measured
 *      against the EA's own A_All shape, ea/DaveEA.mq5), so one analysis call kept charging ~6k
 *      tokens on every later chat message, for market data that is stale the moment the next
 *      candle prints.
 *
 * This proves, through a real DB save/load round trip, that exactly ONE fresh live-context copy
 * ever reaches the model, that a history already bloated by the deployed build heals itself on
 * the next message (no /reset required), and that the person's own words are never touched.
 */

console.log("=== Real proof: history stops re-uploading stale live context and raw tool results ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-history-bloat-"));
process.env.DAVE_DATA_ROOT = workDir;
const USER_ID = "user-history-bloat-1";

async function main() {
  const { DaveDatabase } = await import("@dave/db");
  const { saveConversationHistory, loadConversationHistory, MAX_STORED_TOOL_RESULT_CHARS } = await import("../src/conversation-store.js");
  const { withLiveContext, buildLiveSettingsBlock, LIVE_CONTEXT_OPEN, LIVE_CONTEXT_CLOSE } = await import("../src/live-context.js");
  const { createSkill } = await import("@dave/skills");
  const { setActiveStrategySkill } = await import("@dave/trading");

  const db = new DaveDatabase(join(workDir, "dave.db"));

  // A real, realistically-sized strategy skill -- this is what makes the block genuinely large.
  const content = Array.from({ length: 180 }, (_, i) => `- Rule ${i}: wait for the D1 sweep of the prior session high, then an M3 CHoCH, then enter at the 62-79% OTE with the stop beyond the sweep wick.`).join("\n");
  const skill = createSkill(USER_ID, { name: "HTF Sweep", description: "HTF liquidity sweep", content });
  setActiveStrategySkill(USER_ID, skill.id);

  const block = buildLiveSettingsBlock(USER_ID);
  assert.ok(block.includes(content), "the real skill body must genuinely be in the live block -- otherwise this test isn't measuring the real cost");
  console.log(`[1] Real live-context block with an active strategy skill: ${block.length} chars (~${Math.round(block.length / 4)} tokens) -- this rides on EVERY user message.\n`);

  // ---- The real shape runAgentTurn produces: 12 turns, each a wrapped user message. ----
  const history: CompletionMessage[] = [{ role: "system", content: "SYSTEM" }];
  for (let i = 0; i < 12; i++) {
    history.push({ role: "user", content: withLiveContext(USER_ID, `message number ${i}`) });
    history.push({ role: "assistant", content: `reply ${i}` });
  }
  const bytesIfStoredRaw = Buffer.byteLength(JSON.stringify(history));

  saveConversationHistory(db, USER_ID, history);
  const reloaded = loadConversationHistory(db, USER_ID);
  const bytesStored = Buffer.byteLength(JSON.stringify(reloaded));

  console.log(`[2] 12 real turns, stored the OLD way: ${bytesIfStoredRaw} bytes re-uploaded on the next message.`);
  console.log(`    Stored now: ${bytesStored} bytes -- ${(bytesIfStoredRaw / bytesStored).toFixed(1)}x smaller, ${bytesIfStoredRaw - bytesStored} bytes (~${Math.round((bytesIfStoredRaw - bytesStored) / 4)} tokens) no longer sent on every turn.\n`);

  assert.ok(bytesStored * 10 < bytesIfStoredRaw, `saved history must be dramatically smaller (was ${bytesIfStoredRaw}, is ${bytesStored})`);
  assert.equal(reloaded.length, history.length, "no message may be dropped -- only the injected block is removed");
  for (let i = 0; i < 12; i++) {
    const msg = reloaded[1 + i * 2];
    assert.equal(msg.role, "user");
    assert.equal(msg.content, `message number ${i}`, "the person's own words must survive byte-for-byte");
    assert.ok(!String(msg.content).includes(LIVE_CONTEXT_OPEN), "no live-context sentinel may remain in stored history");
    assert.ok(!String(msg.content).includes(content), "no copy of the strategy skill body may remain in stored history");
  }
  console.log("[3] Every one of the 12 real user messages kept its exact original text, with zero copies of the skill body left behind.\n");

  // ---- Legacy heal: a history written by the DEPLOYED build has NO sentinels at all. ----
  const legacyWrapped = `${block}\n\nwhat's my current risk setting?`;
  const legacyHistory: CompletionMessage[] = [
    { role: "system", content: "SYSTEM" },
    { role: "user", content: legacyWrapped },
    { role: "assistant", content: "ok" },
  ];
  db.createTable("conversation_history", [{ name: "messages_json", type: "TEXT" }]);
  const legacyKey = `${USER_ID}-legacy`;
  db.insert("conversation_history", legacyKey, { messages_json: JSON.stringify(legacyHistory) });
  const healed = loadConversationHistory(db, legacyKey);
  assert.equal(healed[1].content, "what's my current risk setting?", "a pre-fix history must heal on the very next load, with no /reset");
  console.log(`[4] A history written by the OLD build (no sentinels, ${legacyWrapped.length} chars on that one message) healed on load to ${String(healed[1].content).length} chars -- no /reset needed.\n`);

  // ---- Raw tool results: a real get_all_analysis-sized payload. ----
  const bigResult = JSON.stringify({ suite: Array.from({ length: 900 }, (_, i) => ({ endpoint: `e${i}`, value: 1.23456, signal: "BULLISH" })) });
  assert.ok(bigResult.length > 20_000, "this must genuinely be analysis-sized to be a real proof");
  const toolHistory: CompletionMessage[] = [
    { role: "system", content: "SYSTEM" },
    { role: "user", content: "analyse EURUSD" },
    { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "get_all_analysis", arguments: { symbol: "EURUSD" } }] },
    { role: "tool", toolCallId: "call_1", content: bigResult },
    { role: "assistant", content: "Here's the read." },
  ];
  const toolKey = `${USER_ID}-tools`;
  saveConversationHistory(db, toolKey, toolHistory);
  const toolReloaded = loadConversationHistory(db, toolKey);
  const stored = String(toolReloaded[3].content);
  console.log(`[5] A real ${bigResult.length}-char analysis result is stored as ${stored.length} chars -- ~${Math.round((bigResult.length - stored.length) / 4)} tokens no longer re-sent on every later chat message.\n`);
  assert.ok(stored.length < bigResult.length, "an oversized tool result must genuinely be truncated in storage");
  assert.ok(stored.startsWith(bigResult.slice(0, MAX_STORED_TOOL_RESULT_CHARS)), "the retained head must be the real, unaltered start of the result");
  assert.match(stored, /call the tool again if you need this now/, "the model must be told plainly to re-fetch rather than reason off a stale snapshot");
  assert.equal(toolReloaded[3].toolCallId, "call_1", "truncation must never disturb the tool_call_id pairing");

  // A SMALL tool result must be left completely alone.
  const smallKey = `${USER_ID}-small`;
  saveConversationHistory(db, smallKey, [
    { role: "user", content: "balance?" },
    { role: "assistant", content: "", toolCalls: [{ id: "c2", name: "get_account_balance", arguments: {} }] },
    { role: "tool", toolCallId: "c2", content: JSON.stringify({ balance: 10000 }) },
  ]);
  const smallReloaded = loadConversationHistory(db, smallKey);
  assert.equal(smallReloaded[2].content, JSON.stringify({ balance: 10000 }), "a small tool result must survive byte-for-byte");
  console.log("[6] A small tool result (an account balance) survives byte-for-byte -- only genuinely oversized payloads are touched.\n");

  console.log("=== ALL ASSERTIONS PASSED ===");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(workDir, { recursive: true, force: true });
  });
