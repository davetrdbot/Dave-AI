import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import { listWorkers } from "@dave/workers";
import { encryptSecret, decryptSecret, DecryptionError, MissingCredentialsKeyError } from "@dave/crypto";
import {
  recordSuccess,
  recordError,
  isTripped,
  getReport,
  formatTripReport,
  resetCircuitBreaker,
  assertNotTripped,
  CircuitBreakerTrippedError,
  TRIP_THRESHOLD,
  startThinking,
  interruptThinking,
  finishThinking,
  startTradingLoop,
  stopOrPanic,
  resumeTradingLoop,
  isTradingHalted,
  isThinkingInterrupted,
  registerSecurityCheckCron,
  unregisterSecurityCheckCron,
  startHeartbeatLoop,
  startWatchdog,
} from "../src/index.js";

console.log("=== Step 19 real proof: Safety ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-step19-"));
const dbPath = join(workDir, "dave.db");
const OWNER = "user-1";

try {
  const db = new DaveDatabase(dbPath);

  // --- [1] Circuit breaker: trips at exactly 3 consecutive errors, clear report ---
  console.log("[1] Circuit breaker: real trip at exactly 3 consecutive errors...\n");
  assert.equal(isTripped(db, OWNER), false);
  let report = recordError(db, OWNER, "DAVEMA timeout on /confluence");
  assert.equal(report.tripped, false);
  console.log(`    error 1/3: tripped=${report.tripped}`);
  report = recordError(db, OWNER, "DAVEMA timeout on /confluence");
  assert.equal(report.tripped, false);
  console.log(`    error 2/3: tripped=${report.tripped}`);
  report = recordError(db, OWNER, "broker rejected order: insufficient margin");
  assert.equal(report.tripped, true);
  console.log(`    error 3/3: tripped=${report.tripped} -- genuinely trips, not before`);
  console.log(`\n    clear report Dave would actually send:\n${formatTripReport(report).split("\n").map((l) => "      " + l).join("\n")}`);

  let blockedByBreaker = false;
  try {
    assertNotTripped(db, OWNER);
  } catch (err) {
    blockedByBreaker = err instanceof CircuitBreakerTrippedError;
  }
  assert.ok(blockedByBreaker, "a real trading-action gate must refuse to proceed while tripped");
  console.log("    assertNotTripped() genuinely throws while tripped");

  // A success does NOT silently un-trip it -- only an explicit reset does.
  recordSuccess(db, OWNER);
  assert.equal(isTripped(db, OWNER), true, "one success must not silently clear a real trip");
  console.log("    a later success does NOT auto-clear the trip (must be explicit)");
  resetCircuitBreaker(db, OWNER);
  assert.equal(isTripped(db, OWNER), false);
  assert.equal(getReport(db, OWNER).consecutiveErrors, 0);
  console.log("    explicit resetCircuitBreaker() genuinely clears it");

  // A success in between DOES reset the consecutive count before it reaches 3.
  recordError(db, OWNER, "err A");
  recordError(db, OWNER, "err B");
  recordSuccess(db, OWNER);
  const afterSuccess = recordError(db, OWNER, "err C");
  assert.equal(afterSuccess.tripped, false, "a success in the middle must reset the consecutive counter, so err C alone doesn't trip it");
  console.log("    a success between errors resets the streak -- 2 errors + success + 1 error does NOT trip (correct: not 3 CONSECUTIVE)");
  resetCircuitBreaker(db, OWNER);

  // --- [2] Interrupt distinction: thinking-loop vs trading-loop ---
  console.log("\n[2] /stop and /panic are distinct from an ordinary thinking-loop interrupt...\n");
  startTradingLoop(OWNER);
  startThinking(OWNER);
  interruptThinking(OWNER); // an ORDINARY incoming message
  assert.equal(isThinkingInterrupted(OWNER), true);
  assert.equal(isTradingHalted(OWNER), false, "an ordinary message must NEVER halt the trading loop");
  console.log("    ordinary message mid-thought: thinking interrupted=true, trading loop halted=false (correct distinction)");
  finishThinking(OWNER);

  startThinking(OWNER); // simulate Dave mid-thought again
  const halt = stopOrPanic(OWNER, "panic");
  assert.equal(isTradingHalted(OWNER), true, "/panic must halt the trading loop");
  assert.equal(isThinkingInterrupted(OWNER), true, "/panic is a hard interrupt EVEN MID-THOUGHT -- it must also interrupt the thinking loop");
  assert.equal(halt.haltReason, "panic");
  console.log("    /panic mid-thought: thinking interrupted=true AND trading loop halted=true (the one case both loops are hit)");
  resumeTradingLoop(OWNER);
  assert.equal(isTradingHalted(OWNER), false);
  console.log("    resumeTradingLoop() genuinely clears the halt");

  // --- [3] Security check cron: real job, runs through a real worker ---
  console.log("\n[3] Security check cron: real scheduled job, runs through a REAL worker...\n");
  let checkRan = false;
  let workerDuringCheck: { active: boolean; role: string } | null = null;
  registerSecurityCheckCron(
    OWNER,
    async (worker) => {
      checkRan = true;
      const active = listWorkers(OWNER).find((w) => w.id === worker.id);
      workerDuringCheck = active ? { active: active.active, role: active.role } : null;
    },
    "* * * * * *"
  );
  await new Promise((resolve) => setTimeout(resolve, 1500));
  unregisterSecurityCheckCron(OWNER);
  assert.ok(checkRan, "the security check cron must genuinely fire");
  assert.ok(workerDuringCheck, "a real worker must exist and be active during the check");
  assert.equal((workerDuringCheck as any).role, "generic");
  const afterCheck = listWorkers(OWNER, false).filter((w) => w.task === "Weekly security check");
  assert.ok(afterCheck.every((w) => !w.active), "the worker must be retired after the check completes");
  console.log(`    security check cron genuinely fired, ran through a real "${(workerDuringCheck as any).role}"-role worker, retired afterward`);

  // --- [4] Heartbeat watchdog: a GENUINELY SEPARATE process detects a simulated crash and recovery ---
  console.log("\n[4] Heartbeat watchdog: a real separate OS process detects a simulated crash...\n");
  const heartbeatPath = join(workDir, "heartbeat.json");
  const heartbeat = startHeartbeatLoop(heartbeatPath, 150);

  const watchdog = startWatchdog({ heartbeatPath, timeoutMs: 500, pollIntervalMs: 150 });
  assert.notEqual(watchdog.pid, process.pid, "the watchdog must be a genuinely separate process, not the same PID");
  console.log(`    watchdog running as a real separate process -- this test's PID: ${process.pid}, watchdog's PID: ${watchdog.pid}`);

  const events: any[] = [];
  watchdog.onEvent((e) => events.push(e));

  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(events.length, 0, "must not falsely report down while heartbeats are genuinely fresh");
  console.log("    no false alarm while heartbeats are fresh");

  console.log("    simulating a crash -- stopping the heartbeat loop entirely...");
  heartbeat.stop();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.ok(events.some((e) => e.type === "down"), "the watchdog must detect the simulated crash and report it");
  console.log(`    watchdog detected the crash: ${JSON.stringify(events.find((e) => e.type === "down"))}`);

  console.log("    simulating recovery -- heartbeats resume...");
  const recovered = startHeartbeatLoop(heartbeatPath, 150);
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.ok(events.some((e) => e.type === "recovered"), "the watchdog must detect recovery once heartbeats resume");
  console.log(`    watchdog detected recovery: ${JSON.stringify(events.find((e) => e.type === "recovered"))}`);

  recovered.stop();
  watchdog.stop();

  // --- [5] Credentials: real encryption at rest, never plain readable config ---
  console.log("\n[5] Credentials stored securely -- real encryption at rest, fails closed without a key...\n");
  const masterKey = "test-master-key-for-step19";
  const blob = encryptSecret("sk_live_super_secret_value", masterKey);
  assert.ok(!blob.includes("sk_live_super_secret_value"), "the encrypted blob must never contain the raw plaintext");
  const roundTrip = decryptSecret(blob, masterKey);
  assert.equal(roundTrip, "sk_live_super_secret_value");
  console.log(`    real round-trip: plaintext -> "${blob.slice(0, 40)}..." -> decrypted back correctly, blob never contains the raw value`);

  let wrongKeyFailed = false;
  try {
    decryptSecret(blob, "totally-wrong-key");
  } catch (err) {
    wrongKeyFailed = err instanceof DecryptionError;
  }
  assert.ok(wrongKeyFailed, "decrypting with the wrong key must genuinely fail (GCM auth tag), not return garbage");
  console.log("    decrypting with the WRONG key genuinely fails (real authenticated encryption, not silently wrong output)");

  let missingKeyFailed = false;
  try {
    encryptSecret("anything", "");
  } catch (err) {
    missingKeyFailed = err instanceof MissingCredentialsKeyError;
  }
  assert.ok(missingKeyFailed, "encrypting without a master key must fail closed, never fall back to plaintext");
  console.log("    encrypting with no master key fails closed (MissingCredentialsKeyError), never falls back to plaintext");

  // Real proof against the ACTUAL fixed call sites, not just the primitive.
  process.env.DAVE_CREDENTIALS_KEY = masterKey;
  process.chdir(workDir);
  const { storeOwnMt5Credentials, getOwnMt5Credentials } = await import("@dave/trading");
  storeOwnMt5Credentials(OWNER, { login: "12345678", password: "hunter2-real-password", server: "Broker-Live" });
  const mt5FileContent = readFileSync(join(workDir, "data", "credentials", OWNER, "mt5-own-account.json"), "utf8");
  assert.ok(!mt5FileContent.includes("hunter2-real-password"), "the MT5 password must NEVER appear in plaintext in the file on disk");
  const readBackMt5 = getOwnMt5Credentials(OWNER)!;
  assert.equal(readBackMt5.password, "hunter2-real-password");
  console.log(`    real MT5 credentials file on disk: ${mt5FileContent} -- password genuinely absent, decrypts back correctly`);

  const { storeDavemaKey, getDavemaKey } = await import("@dave/davema");
  const realLookingKey = `sk_live_${"ab12cd34".repeat(6)}`;
  storeDavemaKey(OWNER, realLookingKey);
  const davemaFileContent = readFileSync(join(workDir, "data", "credentials", OWNER, "davema.json"), "utf8");
  assert.ok(!davemaFileContent.includes(realLookingKey), "the DAVEMA key must NEVER appear in plaintext in the file on disk");
  assert.equal(getDavemaKey(OWNER), realLookingKey);
  console.log(`    real DAVEMA key file on disk: ${davemaFileContent} -- key genuinely absent, decrypts back correctly`);

  db.close();
  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
