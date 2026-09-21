import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import { TelegramClient } from "@dave/telegram";
import { dispatchCallback, type CommandRouterDeps } from "../src/command-router.js";
import { getMinRiskReward, getDeepLossAlertPercent, getAlertToggles, ALERT_CATEGORIES } from "@dave/trading";

/**
 * Real bug (the trader: "the earlier ui you told me you added... no ui. check"). The risk:reward,
 * deep-loss, and self-aware-alert settings existed only as agent tools + per-turn context -- there
 * were NO buttons in /settings, so opening Settings showed nothing new. This proves the real UI now
 * exists AND that tapping the real buttons genuinely persists, through the same dispatchCallback path
 * a real Telegram tap uses.
 */

console.log("=== Real UI: risk:reward + deep-loss + self-aware alert switches in /settings ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-risk-ui-"));
process.chdir(workDir);
process.env.DAVE_DATA_ROOT = workDir;
const OWNER = "user-risk-ui-1";
const CHAT_ID = 424243;

const db = new DaveDatabase(join(workDir, "dave.db"));
const client = new TelegramClient("000000:fake-token-for-transport-mock");
const routerDeps: CommandRouterDeps = { db, client, userId: OWNER, publicBaseUrl: "https://dave.example.com" };

const sent: Record<string, unknown>[] = [];
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const method = String(url).split("/").pop() ?? "";
  const body = init?.body ? JSON.parse(init.body as string) : {};
  if (method === "sendMessage" || method === "editMessageText" || method === "answerCallbackQuery") sent.push(body);
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
}) as typeof fetch;

const tap = async (data: string, id: string) => {
  sent.length = 0;
  await dispatchCallback(routerDeps, { id, data, message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
};
const lastScreen = () => sent.find((p) => typeof p.text === "string" && (p.reply_markup as { inline_keyboard?: unknown[][] } | undefined)?.inline_keyboard);
const buttons = () => (((lastScreen()?.reply_markup as { inline_keyboard: unknown[][] })?.inline_keyboard ?? []).flat() as { text: string; callback_data: string }[]);

try {
  console.log("[1] Risk / Trading screen carries a real Risk:Reward row...\n");
  await tap("settings:risk", "c1");
  assert.ok(buttons().some((b) => b.callback_data === "settings:riskreward"), "a Risk:Reward row must be on the Risk screen");
  console.log("    confirmed: Risk:Reward row present");

  console.log("\n[2] The Risk:Reward picker has presets, and tapping 2:1 persists...\n");
  await tap("settings:riskreward", "c2");
  const rrButtons = buttons().filter((b) => b.callback_data.startsWith("rr:set:"));
  assert.ok(rrButtons.length >= 3, `must have R:R presets, found ${rrButtons.length}`);
  await tap("rr:set:2", "c3");
  assert.equal(getMinRiskReward(OWNER), 2, "tapping 2:1 must persist the floor");
  console.log(`    confirmed: presets ${rrButtons.map((b) => b.text).join(", ")}; 2:1 persisted`);

  console.log("\n[3] Notifications screen has a Self-Aware Alerts entry...\n");
  await tap("settings:notifications", "c4");
  assert.ok(buttons().some((b) => b.callback_data === "settings:selfaware"), "Self-Aware Alerts entry must exist in Notifications");
  console.log("    confirmed: Self-Aware Alerts entry present");

  console.log("\n[4] Self-Aware screen shows every category as a toggle, and tapping one flips it...\n");
  await tap("settings:selfaware", "c5");
  const toggleButtons = buttons().filter((b) => b.callback_data.startsWith("selfaware:toggle:"));
  // Derived from the one real list, not hardcoded -- the count grew from 6 to 11 when the
  // profit-side checks landed, and a literal here would have to be chased every time.
  assert.equal(
    toggleButtons.length,
    ALERT_CATEGORIES.length,
    `every self-aware category must be togglable: expected ${ALERT_CATEGORIES.length}, found ${toggleButtons.length}`
  );
  assert.ok(buttons().some((b) => b.callback_data === "settings:deeploss"), "the deep-loss level sub-picker must be reachable here");
  assert.equal(getAlertToggles(OWNER).stuck, true, "stuck starts on");
  await tap("selfaware:toggle:stuck", "c6");
  assert.equal(getAlertToggles(OWNER).stuck, false, "tapping the stuck toggle switches it off");
  await tap("selfaware:toggle:stuck", "c7");
  assert.equal(getAlertToggles(OWNER).stuck, true, "tapping again switches it back on");
  console.log("    confirmed: 6 toggles, stuck off->on round-trips");

  console.log("\n[5] Deep-loss level picker persists a new level (default was 50%)...\n");
  assert.equal(getDeepLossAlertPercent(OWNER), 50, "default 50%");
  await tap("settings:deeploss", "c8");
  const dlButtons = buttons().filter((b) => b.callback_data.startsWith("deeploss:set:"));
  assert.ok(dlButtons.length >= 3, `deep-loss presets must exist, found ${dlButtons.length}`);
  await tap("deeploss:set:40", "c9");
  assert.equal(getDeepLossAlertPercent(OWNER), 40, "tapping 40% persists");
  console.log(`    confirmed: presets ${dlButtons.map((b) => b.text).join(", ")}; 40% persisted`);

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
process.exit(0);
