import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import { TelegramClient } from "@dave/telegram";
import { dispatchCallback, dispatchCommand, type CommandRouterDeps } from "../src/command-router.js";
import { getTradingLoopIntervalMinutes } from "../src/trading-loop.js";

/**
 * Real bug fixed (the trader, live, furious: a real Telegram screenshot showed "Scan loop
 * interval: every 5 min (compulsory -- not user-adjustable)" with literally zero buttons visible
 * on the screen). Traced to command-router.ts's tradingIntervalKeyboard(): its own doc comment
 * claimed a real button-based picker existed, but the function actually returned `keyboard([])`
 * -- empty -- while the real `tradinginterval:<minutes>` callback handler a few hundred lines
 * below was always fully wired to setAutonomousTradingIntervalMinutes(). The buttons pointing at
 * that handler simply never existed. This proves the fix end to end: the screen now carries real,
 * tappable preset buttons, and tapping one genuinely changes the persisted interval -- through the
 * exact same real dispatchCallback() path a real Telegram tap goes through, not a direct function
 * call bypassing the UI layer.
 */

console.log("=== Real proof: the Autonomous Trading settings screen has real, tappable interval buttons, not an empty keyboard ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-trading-interval-keyboard-"));
process.chdir(workDir);
const OWNER = "user-trading-interval-keyboard-1";
const CHAT_ID = 424242;

const db = new DaveDatabase(join(workDir, "dave.db"));
const client = new TelegramClient("000000:fake-token-for-transport-mock");
const routerDeps: CommandRouterDeps = { db, client, userId: OWNER, publicBaseUrl: "https://dave.example.com" };

const sentPayloads: Record<string, unknown>[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const method = String(url).split("/").pop() ?? "";
  const body = init?.body ? JSON.parse(init.body as string) : {};
  if (method === "sendMessage" || method === "editMessageText" || method === "answerCallbackQuery") sentPayloads.push(body);
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
}) as typeof fetch;

try {
  console.log("[1] Opening the real Autonomous Trading settings screen (settings:tradinginterval)...\n");
  sentPayloads.length = 0;
  await dispatchCallback(routerDeps, { id: "cb0", data: "settings:tradinginterval", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  const opened = sentPayloads.find((p) => typeof p.text === "string" && (p.text as string).includes("Autonomous Trading"));
  assert.ok(opened, "the real screen must actually render");
  const keyboardRows = (opened!.reply_markup as { inline_keyboard: unknown[][] } | undefined)?.inline_keyboard ?? [];
  const allButtons = keyboardRows.flat() as { text: string; callback_data: string }[];
  console.log(`    real buttons on screen: ${allButtons.map((b) => b.text).join(", ")}`);
  const intervalButtons = allButtons.filter((b) => b.callback_data?.startsWith("tradinginterval:"));
  assert.ok(intervalButtons.length >= 6, `must have real preset buttons wired to tradinginterval: -- found only ${intervalButtons.length} (this is exactly the bug: it used to be zero)`);
  assert.ok(!(opened!.text as string).includes("compulsory"), "the stale, false 'compulsory -- not user-adjustable' text must be gone");

  console.log("\n[2] Tapping a real preset button (2 min) genuinely changes the persisted interval, through the real callback path...\n");
  sentPayloads.length = 0;
  await dispatchCallback(routerDeps, { id: "cb1", data: "tradinginterval:2", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  assert.equal(getTradingLoopIntervalMinutes(OWNER), 2, "the real persisted interval must genuinely update from a real button tap");
  const confirmed = sentPayloads.find((p) => typeof p.text === "string" && (p.text as string).includes("every 2 min"));
  assert.ok(confirmed, "a real confirmation naming the new interval must be sent");
  console.log(`    real confirmation: "${confirmed!.text}"`);

  console.log("\n[3] Re-opening the screen shows the NEW current value and marks the matching button as selected...\n");
  sentPayloads.length = 0;
  await dispatchCallback(routerDeps, { id: "cb2", data: "settings:tradinginterval", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  const reopened = sentPayloads.find((p) => typeof p.text === "string" && (p.text as string).includes("Autonomous Trading"));
  assert.ok((reopened!.text as string).includes("every 2 min"), "the real current value must be reflected, not stuck at the old default");
  const reopenedButtons = ((reopened!.reply_markup as { inline_keyboard: unknown[][] }).inline_keyboard.flat() as { text: string }[]);
  assert.ok(reopenedButtons.some((b) => b.text.includes("✅") && b.text.includes("2 min")), "the currently-active interval must be visibly marked selected");
  console.log(`    real, up-to-date screen: "${(reopened!.text as string).split("\n").join(" | ")}"`);

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  globalThis.fetch = realFetch;
  rmSync(workDir, { recursive: true, force: true });
}
process.exit(0);
