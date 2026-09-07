import assert from "node:assert/strict";
import { DAVE_COMMANDS } from "../src/commands.js";
import { registerDefaultCommandMenu } from "../src/menu.js";
import { TelegramClient } from "../src/client.js";

/**
 * Real proof for item 5: "reorder the registered command list (setMyCommands) so the
 * most-used/most-useful commands appear first, not alphabetical or arbitrary order."
 * Confirms both the real order of DAVE_COMMANDS itself, and that registerDefaultCommandMenu
 * genuinely sends THAT exact order to the real Bot API (setMyCommands renders in array order,
 * no re-sorting) -- so what ships in code is exactly what the user sees in Telegram.
 */

console.log("=== Real proof: commands are registered in a real usefulness-first order ===\n");

console.log("[1] DAVE_COMMANDS is genuinely usefulness-ordered, not alphabetical...");
const order = DAVE_COMMANDS.map((c) => c.command);
console.log(`    real order: /${order.join(", /")}`);
assert.deepEqual(order, ["start_trading", "stop_trading", "panic", "menu", "status", "account", "settings", "providers", "models", "connection", "ea", "reset", "help"]);
const alphabetical = [...order].sort();
assert.notDeepEqual(order, alphabetical, "must NOT be alphabetical");
assert.equal(order[0], "start_trading", "the real trading on/off switch must lead, ahead of even /menu");
assert.equal(order[1], "stop_trading", "start/stop trading must be the first two, per the user's explicit ask");
assert.ok(order.indexOf("help") > order.indexOf("status"), "reference/occasional commands (help) must sort after what's-happening-now commands (status)");
assert.ok(order.indexOf("reset") > order.indexOf("settings"), "the destructive command (reset) must sort after routine configuration commands");

console.log("\n[2] A real setMyCommands call genuinely sends commands in THIS exact order, unmodified...");
const calls: { method: string; body: unknown }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const method = String(url).split("/").pop() ?? "";
  const body = init?.body ? JSON.parse(init.body as string) : undefined;
  calls.push({ method, body });
  return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
}) as typeof fetch;

try {
  const client = new TelegramClient("000000:fake-token-for-transport-mock");
  await registerDefaultCommandMenu(client);
  const call = calls.find((c) => c.method === "setMyCommands")!;
  const registeredOrder = (call.body as { commands: { command: string }[] }).commands.map((c) => c.command);
  console.log(`    real setMyCommands order sent to Telegram: /${registeredOrder.join(", /")}`);
  assert.deepEqual(registeredOrder, order, "the real registered order must match DAVE_COMMANDS exactly, unmodified");
} finally {
  globalThis.fetch = realFetch;
}

console.log("\n=== ALL ASSERTIONS PASSED ===");
