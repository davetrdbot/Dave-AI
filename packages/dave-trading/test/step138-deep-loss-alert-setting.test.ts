import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DAVE_DATA_ROOT = mkdtempSync(join(tmpdir(), "dave-deeploss-"));

const {
  getDeepLossAlertPercent,
  getDeepLossAlertProgress,
  setDeepLossAlertPercent,
  DEFAULT_DEEP_LOSS_PROGRESS,
  InvalidDeepLossAlertError,
} = await import("../src/deep-loss-alert-store.js");
const { TRADING_TOOLS } = await import("../src/tools.js");
const { getSettingsLog } = await import("../src/settings-log.js");

/**
 * The trader: "set the deep loss alert -- but default should be 50%". Proves the default, that it's
 * settable per-user as a percent, the bounds, that it lands in the settings log (so Dave can see it
 * was set), and that both the get/set tools are wired.
 */

const USER = "user-deeploss-1";
const tool = (n: string) => {
  const t = TRADING_TOOLS.find((x) => x.name === n);
  assert.ok(t, `${n} exists`);
  return t!;
};
const ctx = { userId: USER } as never;

console.log("=== Deep-loss alert level: settable, default 50% ===\n");

try {
  console.log("[1] Default is 50% when nothing was ever set...\n");
  assert.equal(getDeepLossAlertPercent(USER), 50, "default percent is 50");
  assert.equal(getDeepLossAlertProgress(USER), 0.5, "default fraction is 0.5");
  assert.equal(DEFAULT_DEEP_LOSS_PROGRESS, 0.5);
  console.log("    confirmed: 50% / 0.5 by default");

  console.log("\n[2] Setting it to 40% persists as both percent and fraction...\n");
  const res = setDeepLossAlertPercent(USER, 40);
  assert.equal(res.deepLossPercent, 40);
  assert.equal(res.deepLossProgress, 0.4);
  assert.equal(getDeepLossAlertPercent(USER), 40, "reads back 40 fresh from disk");
  assert.equal(getDeepLossAlertProgress(USER), 0.4);
  console.log("    confirmed: 40% persisted and re-read");

  console.log("\n[3] The change is written to the settings log Dave can inspect...\n");
  const log = getSettingsLog(USER);
  const entry = log.find((e) => e.field === "deepLossAlertPercent");
  assert.ok(entry, "a deepLossAlertPercent entry is in the settings log");
  assert.equal(entry!.newValue, 40, "the log records the new value");
  console.log("    confirmed: settings-log entry deepLossAlertPercent -> 40");

  console.log("\n[4] Out-of-range values are rejected, not silently clamped...\n");
  assert.throws(() => setDeepLossAlertPercent(USER, 0), InvalidDeepLossAlertError, "0% rejected");
  assert.throws(() => setDeepLossAlertPercent(USER, 100), InvalidDeepLossAlertError, "100% rejected");
  assert.throws(() => setDeepLossAlertPercent(USER, -5), InvalidDeepLossAlertError, "negative rejected");
  assert.equal(getDeepLossAlertPercent(USER), 40, "a rejected set leaves the last good value intact");
  console.log("    confirmed: 0/100/negative rejected; last good value (40) preserved");

  console.log("\n[5] The get/set tools are wired and go through the same store...\n");
  const setOut = (await tool("set_deep_loss_alert").execute({ percent: 70 }, ctx)) as { deepLossPercent: number };
  assert.equal(setOut.deepLossPercent, 70);
  const getOut = (await tool("get_deep_loss_alert").execute({}, ctx)) as { deepLossPercent: number };
  assert.equal(getOut.deepLossPercent, 70, "get tool reflects the set tool");
  assert.equal(getDeepLossAlertProgress(USER), 0.7, "store agrees with the tools");
  console.log("    confirmed: set_deep_loss_alert(70) -> get_deep_loss_alert = 70");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
  process.exit(0);
} catch (err) {
  console.error("FAILED:", err);
  process.exit(1);
}
