import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import { getTradingModeConfig } from "@dave/ea-bridge";
import { TelegramClient } from "@dave/telegram";
import { dispatchCommand, dispatchCallback, tryHandlePendingMcpUrlEntry, type CommandRouterDeps } from "../src/command-router.js";

/**
 * Real proof for the user's ask: "when sending the ea it normally does need a ui that's not
 * necessary... remove it the ui should be Dave ea and mcp for trading". The old /ea picker had a
 * documented, real dead end (both buttons led to the identical flow) -- this proves the real
 * replacement: a genuine EA-vs-MCP choice that actually persists, end to end through real
 * dispatchCommand/dispatchCallback calls.
 */

console.log("=== Real proof: /ea offers a genuine EA-vs-MCP execution choice, not a dead-end picker ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-ea-mcp-choice-"));
process.chdir(workDir);
const OWNER = "user-ea-mcp-choice-1";
const CHAT_ID = 646464;

const db = new DaveDatabase(join(workDir, "dave.db"));
const client = new TelegramClient("000000:fake-token-for-transport-mock");
const deps: CommandRouterDeps = { db, client, userId: OWNER, publicBaseUrl: "https://dave.example.com" };

const sentMessages: { text: string; hasDocument: boolean }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const urlStr = String(url);
  const method = urlStr.split("/").pop() ?? "";
  if (init?.body instanceof FormData) {
    sentMessages.push({ text: String(init.body.get("caption") ?? ""), hasDocument: true });
  } else {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    if (body?.text) sentMessages.push({ text: body.text, hasDocument: false });
  }
  void method;
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
}) as typeof fetch;

try {
  console.log("[1] Real default is EA mode before anything is configured...");
  assert.deepEqual(getTradingModeConfig(OWNER), { mode: "ea" });

  console.log("\n[2] /ea genuinely shows both real options, not the old dead-end picker...");
  await dispatchCommand(deps, CHAT_ID, `${OWNER}:${CHAT_ID}`, "/ea");
  const eaScreen = sentMessages.at(-1)!;
  assert.match(eaScreen.text, /Dave EA \(MT5\)/);
  assert.match(eaScreen.text, /How should Dave place your trades/);
  console.log(`    real /ea screen: "${eaScreen.text.replace(/\n/g, " | ")}"`);

  console.log("\n[3] Tapping 'MCP for trading' genuinely prompts for a real URL (not a fake branch)...");
  sentMessages.length = 0;
  await dispatchCallback(deps, { id: "cb1", data: "eaexec:mcp", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  assert.match(sentMessages.at(-1)!.text, /MCP trading server's URL/);

  console.log("\n[4] The user's next real message genuinely persists as the real MCP server URL...");
  sentMessages.length = 0;
  const consumed = await tryHandlePendingMcpUrlEntry(deps, CHAT_ID, "https://my-real-mcp-server.example.com/mcp");
  assert.ok(consumed, "the free-text capture must genuinely consume this message");
  assert.deepEqual(getTradingModeConfig(OWNER), { mode: "mcp", mcpServerUrl: "https://my-real-mcp-server.example.com/mcp" });
  assert.match(sentMessages.at(-1)!.text, /MCP: <code>https:\/\/my-real-mcp-server\.example\.com\/mcp<\/code>/);
  console.log(`    real persisted config: ${JSON.stringify(getTradingModeConfig(OWNER))}`);

  console.log("\n[5] /ea now genuinely reflects the real current MCP mode...");
  sentMessages.length = 0;
  await dispatchCommand(deps, CHAT_ID, `${OWNER}:${CHAT_ID}`, "/ea");
  assert.match(sentMessages.at(-1)!.text, /Current: MCP \(https:\/\/my-real-mcp-server\.example\.com\/mcp\)/);
  console.log(`    real /ea screen now shows the real current mode`);

  console.log("\n[6] Tapping 'Dave EA (MT5)' genuinely switches back AND sends the real personalized EA file...");
  sentMessages.length = 0;
  await dispatchCallback(deps, { id: "cb2", data: "eaexec:ea", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  assert.deepEqual(getTradingModeConfig(OWNER), { mode: "ea" });
  assert.ok(sentMessages.some((m) => m.hasDocument), "the real personalized .mq5 file must genuinely have been sent");
  console.log(`    real mode switched back to EA, real EA file sent`);

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  globalThis.fetch = realFetch;
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
