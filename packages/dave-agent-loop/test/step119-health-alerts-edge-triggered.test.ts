import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eaConnectionAlert, cycleErrorAlert, clearCycleErrorAlert } from "../src/health-alerts.js";

/**
 * Real bug class fixed (the trader, live: "find bugs this bot"). Five separate failure modes --
 * EA offline, cycle throwing, watchdog firing, EA reconnecting, manual SL/TP edit -- were all
 * genuinely DETECTED and then reported to nothing but a server console, so a bot that had stopped
 * trading still looked alive to its owner.
 *
 * This proves the half that could have made the cure worse than the disease: the SAME trader had
 * just reported the bot "disturbing" him, so an alert that fired once per cycle while a condition
 * persisted would be a regression, not a fix. Every alert here must be EDGE-triggered.
 */

const workDir = mkdtempSync(join(tmpdir(), "dave-health-alerts-"));
process.env.DAVE_DATA_ROOT = workDir;
const USER = "user-health-1";

console.log("=== Real proof: health alerts fire on state CHANGES, never once per cycle ===\n");

try {
  console.log("[1] A bot that boots and finds the EA already connected has no news to report...\n");
  assert.equal(eaConnectionAlert(USER, true, 0), null, "the first observation of a HEALTHY connection must be recorded silently");
  console.log("    confirmed: silent on first healthy observation -- no 'everything is fine' spam at boot");

  console.log("\n[2] The EA going offline genuinely alerts -- once...\n");
  const firstDown = eaConnectionAlert(USER, false, 240);
  assert.ok(firstDown, "the transition to disconnected must genuinely alert");
  assert.match(firstDown, /lost MT5/, "the alert must actually say MT5 was lost");
  assert.match(firstDown, /4m ago/, "the real staleness must be shown to the owner, humanised");
  console.log(`    real alert: ${JSON.stringify(firstDown.split("\n")[0])}`);

  console.log("\n[3] The SAME outage on nine more cycles stays silent -- this is the anti-spam guarantee...\n");
  for (let cycle = 0; cycle < 9; cycle++) {
    assert.equal(eaConnectionAlert(USER, false, 300 + cycle * 60), null, "an ONGOING outage must never re-alert per cycle");
  }
  console.log("    confirmed: 9 further cycles with the EA still offline produced ZERO additional messages");

  console.log("\n[4] Recovery genuinely alerts, exactly once...\n");
  const recovered = eaConnectionAlert(USER, true, 2);
  assert.ok(recovered, "the transition back to connected must genuinely alert");
  assert.match(recovered, /back online/, "the recovery alert must actually say it's back");
  assert.equal(eaConnectionAlert(USER, true, 2), null, "a still-healthy EA must not keep announcing itself");
  console.log(`    real alert: ${JSON.stringify(recovered)} -- then silent again`);

  console.log("\n[5] A crashing cycle genuinely alerts, and an IDENTICAL repeat stays quiet...\n");
  const firstErr = cycleErrorAlert(USER, new Error("401 invalid x-api-key"), 1_000);
  assert.ok(firstErr, "a thrown cycle must genuinely reach the owner");
  assert.match(firstErr, /not placing any trades/, "the owner must be told trading has actually stopped");
  assert.equal(cycleErrorAlert(USER, new Error("401 invalid x-api-key"), 60_000), null, "the same failure a minute later must not re-alert");
  console.log(`    real alert: ${JSON.stringify(firstErr.split("\n")[0])} -- repeat suppressed`);

  console.log("\n[6] A genuinely DIFFERENT failure still gets through immediately, inside the same window...\n");
  const differentErr = cycleErrorAlert(USER, new Error("ECONNREFUSED talking to the provider"), 61_000);
  assert.ok(differentErr, "a new KIND of failure must never be swallowed by another failure's repeat window");
  console.log(`    real alert: ${JSON.stringify(differentErr.split("\n")[0])}`);

  console.log("\n[7] Errors differing only by numbers are the SAME failure, not a licence to spam...\n");
  assert.ok(cycleErrorAlert(USER, new Error("rate limited, retry in 30s"), 200_000), "first rate-limit alert gets through");
  assert.equal(
    cycleErrorAlert(USER, new Error("rate limited, retry in 47s"), 260_000),
    null,
    "the same failure with a different number in it must NOT read as a brand-new failure"
  );
  console.log("    confirmed: 'retry in 30s' and 'retry in 47s' are correctly treated as one ongoing failure");

  console.log("\n[8] An ongoing failure still reminds the owner once an hour, rather than going silent forever...\n");
  const reminder = cycleErrorAlert(USER, new Error("rate limited, retry in 52s"), 200_000 + 61 * 60 * 1000);
  assert.ok(reminder, "a still-broken bot must genuinely remind its owner eventually");
  assert.match(reminder, /still happening/, "the reminder must honestly say this is ongoing, not read as a fresh incident");
  console.log(`    real reminder after an hour: ${JSON.stringify(reminder.split("\n")[0])}`);

  console.log("\n[9] A cycle that genuinely recovers resets the memory, so the NEXT failure alerts immediately...\n");
  clearCycleErrorAlert(USER);
  const afterRecovery = cycleErrorAlert(USER, new Error("rate limited, retry in 55s"), 200_000 + 62 * 60 * 1000);
  assert.ok(afterRecovery, "after a healthy cycle, the same failure recurring is genuinely new news");
  assert.doesNotMatch(afterRecovery, /still happening/, "a failure after a real recovery is a fresh incident, not an ongoing one");
  console.log("    confirmed: a successful cycle clears the dedup, so a relapse is reported at once");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
