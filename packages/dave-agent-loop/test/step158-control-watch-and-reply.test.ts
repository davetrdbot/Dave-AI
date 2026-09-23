import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workDir = mkdtempSync(join(tmpdir(), "dave-control-watch-"));
process.env.DAVE_DATA_ROOT = workDir;

const { takeControlNotices, describeControlNotice, controlNoticesPath } = await import("../src/control-notices.js");
const botControl = await import("../../dave-admin/server/bot-control.js");
const { isAutonomousTradingEnabled } = await import("../src/autonomous-trading-state.js");
const { endedWithOwnMessage } = await import("../src/telegram-bot-server.js");

/**
 * Three live bugs from the trader's report:
 *   1. "start trading" in the app wrote a flag the bot never acted on and said nothing in Telegram;
 *   2. Dave's closing self-talk ("I've replied. Waiting for the user...") arrived as a second message.
 * (The third -- a stale busy marker after a redeploy -- is a one-line boot-time clear.)
 */

console.log("=== Step 158: app start/stop reaches the bot and the chat; no self-talk after a reply ===\n");

const USER = "default";

console.log("[1] The app's writer and the bot's reader agree on the file\n");
assert.equal(botControl.controlNoticesPath(USER), controlNoticesPath(USER), "same path on both sides of the process boundary");

botControl.setBotRunning(USER, true, "app");
assert.equal(isAutonomousTradingEnabled(USER), true, "the flag the bot's loop reads is on");
botControl.setExecutionEnabled(USER, false, "app");
let notices = takeControlNotices(USER);
assert.deepEqual(notices.map((n) => [n.event, n.source]), [["trading-started", "app"], ["execution-off", "app"]]);
assert.match(describeControlNotice(notices[0]), /turned on from the app/);
assert.equal(takeControlNotices(USER).length, 0, "a notice is delivered once, then cleared");
console.log("   ✓ start + watch-only from the app become two Telegram lines, delivered once\n");

console.log("[2] Setting a value it already has is not news\n");
botControl.setBotRunning(USER, true, "app");
assert.equal(takeControlNotices(USER).length, 0);
botControl.setBotRunning(USER, false, "web");
notices = takeControlNotices(USER);
assert.equal(notices.length, 1);
assert.match(describeControlNotice(notices[0]), /turned off from the web panel/);
botControl.setBotRunning(USER, true); // no source: an internal write, never announced
assert.equal(takeControlNotices(USER).length, 0);
console.log("   ✓ only real changes with a known source are announced\n");

console.log("[3] A turn that ends by sending its own message sends nothing more\n");
const step = (toolName: string, isError = false) => ({ toolName, isError });
assert.equal(endedWithOwnMessage([step("get_live_state"), step("send_telegram")]), true, "the live bug: reply by tool, then self-talk");
assert.equal(endedWithOwnMessage([step("tg_rich_blocks")]), true);
assert.equal(endedWithOwnMessage([step("send_telegram"), step("get_all_analysis")]), false, "an early heads-up, then real work: the final answer still goes out");
assert.equal(endedWithOwnMessage([step("send_telegram", true)]), false, "a failed send is not an answer");
assert.equal(endedWithOwnMessage([]), false, "a plain text answer is always sent");
console.log("   ✓ only the last step decides, and a failed send never swallows the answer\n");

console.log("=== Step 158 passed ===");
process.exit(0);
