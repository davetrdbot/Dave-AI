import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const workDir = mkdtempSync(join(tmpdir(), "dave-deviceapi-"));
process.env.DAVE_DATA_ROOT = workDir;

const { createPairingCode, redeemPairingCode, verifyDeviceToken, listDevices, revokeDevice, PairingCodeInvalidError, PAIRING_CODE_TTL_MS } =
  await import("../server/device-auth.js");
const botControl = await import("../server/bot-control.js");

/**
 * Stage 1 of the mobile app: the device API.
 *
 * Section 1 is the important one and is deliberately not a behaviour test. Next 16.3.4's
 * middleware has no `runtime` option (checked against the installed type definition), so it runs
 * on the Edge, where there is no `node:fs` and therefore no way to read the paired-device file.
 * The real token check has to live in each route instead -- which means a new route under
 * /api/app/ that forgets to wrap itself is open to anyone who sends the word "Bearer". That is
 * the kind of gap nobody notices until it matters, so it is enforced mechanically here rather
 * than left to whoever adds the next route remembering.
 */

console.log("=== Step 155: device API auth, pairing, and cross-process bot control ===\n");

const USER = "user-device-1";

// ---------------------------------------------------------------------------
console.log("[1] Every /api/app route is behind the auth guard -- enforced, not remembered\n");

const deviceApiDir = join(here, "..", "app", "api", "app");
assert.ok(existsSync(deviceApiDir), "the device API directory exists");

/** The one route that legitimately has no guard: it is how a device gets its token. */
const BOOTSTRAP_ROUTES = new Set(["pair"]);

const routeDirs = readdirSync(deviceApiDir, { withFileTypes: true }).filter((d) => d.isDirectory());
assert.ok(routeDirs.length > 0, "there is at least one device route to check");

let guarded = 0;
for (const dir of routeDirs) {
  const routeFile = join(deviceApiDir, dir.name, "route.ts");
  assert.ok(existsSync(routeFile), `${dir.name} has a route.ts`);
  const source = readFileSync(routeFile, "utf8");

  if (BOOTSTRAP_ROUTES.has(dir.name)) {
    // The bootstrap route must NOT be guarded (it would be unreachable), but it must still be
    // protected by the pairing code -- so assert it actually redeems one rather than just
    // handing out a token.
    assert.ok(!source.includes("withDevice"), `${dir.name} is the bootstrap route and must not require a token`);
    assert.ok(source.includes("redeemPairingCode"), `${dir.name} must still require a valid pairing code`);
    console.log(`   - ${dir.name}: bootstrap, protected by the pairing code`);
    continue;
  }

  assert.ok(source.includes("withDevice"), `app/api/app/${dir.name}/route.ts must wrap its handlers in withDevice()`);
  // A handler exported without the wrapper would be reachable even if another one in the same
  // file uses it, so check every exported HTTP method individually.
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
    const exported = new RegExp(`export\\s+(?:const|async\\s+function|function)\\s+${method}\\b`).test(source);
    if (!exported) continue;
    assert.ok(
      new RegExp(`export\\s+const\\s+${method}\\s*=\\s*withDevice\\(`).test(source),
      `app/api/app/${dir.name}/route.ts exports ${method} but does not wrap it in withDevice()`
    );
  }
  guarded++;
  console.log(`   - ${dir.name}: guarded`);
}
assert.ok(guarded > 0, "at least one guarded device route exists");
console.log(`   ✓ ${guarded} guarded + ${BOOTSTRAP_ROUTES.size} bootstrap route checked\n`);

// ---------------------------------------------------------------------------
console.log("[2] Pairing: single-use, expiring, and the token is never stored in the clear\n");

const { code } = createPairingCode(USER);
assert.equal(code.length, 6, "the code is short enough to type on a phone");
assert.ok(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(code), `no ambiguous characters in "${code}" -- it is typed by hand`);

const { token, device } = redeemPairingCode(USER, code, "Pixel");
assert.ok(token.length >= 40, "the token is long enough that guessing is hopeless");
assert.equal(device.label, "Pixel");
console.log(`   ✓ code ${code} redeemed for a ${token.length}-char token`);

// The whole point of hashing: the stored state must not contain anything replayable.
const statePath = join(workDir, "data", "device-auth", USER, "state.json");
const rawState = readFileSync(statePath, "utf8");
assert.ok(!rawState.includes(token), "the raw token must NEVER appear in the stored state");
assert.ok(rawState.includes("tokenHash"), "only its hash is kept");
console.log("   ✓ stored state contains the hash, not the token");

// Single use.
assert.throws(() => redeemPairingCode(USER, code, "Second phone"), PairingCodeInvalidError, "a code must not work twice");
console.log("   ✓ the same code cannot be redeemed twice");

// Expiry, driven by a real stale timestamp rather than by waiting.
{
  const expiredUser = "user-device-expired";
  const { code: oldCode } = createPairingCode(expiredUser);
  const p = join(workDir, "data", "device-auth", expiredUser, "state.json");
  const state = JSON.parse(readFileSync(p, "utf8"));
  state.pending.createdAt = Date.now() - PAIRING_CODE_TTL_MS - 1000;
  const { writeFileSync } = await import("node:fs");
  writeFileSync(p, JSON.stringify(state), "utf8");
  assert.throws(() => redeemPairingCode(expiredUser, oldCode, "Late phone"), PairingCodeInvalidError, "an expired code must be refused");
  console.log("   ✓ an expired code is refused\n");
}

// ---------------------------------------------------------------------------
console.log("[3] Token verification, and per-device revocation\n");

assert.equal(verifyDeviceToken(USER, token), true, "the real token is accepted");
assert.equal(verifyDeviceToken(USER, "not-the-token"), false, "a wrong token is rejected");
assert.equal(verifyDeviceToken(USER, ""), false, "an empty token is rejected");
// A token is per-user: the same string must not unlock a different user's data.
assert.equal(verifyDeviceToken("someone-else", token), false, "a token does not work for another user");
console.log("   ✓ accepted / rejected / scoped to its user");

// A second device, so revocation can be shown to be surgical rather than a reset.
const { code: code2 } = createPairingCode(USER);
const { token: token2, device: device2 } = redeemPairingCode(USER, code2, "Tablet");
assert.equal(listDevices(USER).length, 2);
assert.ok(!JSON.stringify(listDevices(USER)).includes("tokenHash"), "the devices list must not leak hashes to the UI");

assert.equal(revokeDevice(USER, device.id), true);
assert.equal(verifyDeviceToken(USER, token), false, "the revoked device is locked out");
assert.equal(verifyDeviceToken(USER, token2), true, "...and the other one still works, which is the point of per-device tokens");
assert.equal(revokeDevice(USER, device2.id), true);
assert.equal(revokeDevice(USER, "no-such-device"), false, "revoking something that is not there reports false rather than throwing");
console.log("   ✓ one device revoked, the other unaffected\n");

// ---------------------------------------------------------------------------
console.log("[4] Bot control writes the files the BOT actually reads\n");

// This is the sync check the bot-control header promises. The admin process and the bot process
// share these files by path and shape alone -- nothing imports anything -- so a drift here would
// mean the app's stop button writes a file the bot never reads, and reports success anyway.
const botSrc = readFileSync(join(here, "..", "..", "dave-agent-loop", "src", "autonomous-trading-state.ts"), "utf8");
assert.ok(
  botSrc.includes('"data", "trading", userId, "autonomous-trading-enabled.json"'),
  "the bot still reads data/trading/<user>/autonomous-trading-enabled.json -- update bot-control.ts if this moved"
);
assert.ok(
  botSrc.includes('"data", "trading", userId, "autonomous-execution-enabled.json"'),
  "the bot still reads data/trading/<user>/autonomous-execution-enabled.json"
);
assert.equal(botControl.tradingFlagPath(USER, "autonomous-trading-enabled"), join(workDir, "data", "trading", USER, "autonomous-trading-enabled.json"));
console.log("   ✓ paths match the bot-side module");

// Defaults must match the bot's, or the two processes disagree about a fresh install.
assert.ok(botSrc.includes("if (!existsSync(path)) return false;"), "the bot defaults trading-enabled to FALSE");
assert.equal(botControl.isBotRunning("brand-new-user"), false, "so a fresh user must not read as running");
assert.equal(botControl.isExecutionEnabled("brand-new-user"), true, "execution defaults TRUE, or a fresh install would silently never trade");
console.log("   ✓ defaults match (running=false, execution=true)");

botControl.setBotRunning(USER, true);
assert.equal(botControl.isBotRunning(USER), true);
assert.equal(JSON.parse(readFileSync(botControl.tradingFlagPath(USER, "autonomous-trading-enabled"), "utf8")), true, "written as a bare boolean, which is what the bot parses");
botControl.setBotRunning(USER, false);
assert.equal(botControl.isBotRunning(USER), false);
console.log("   ✓ start/stop round-trips in the bot's own format");

// The interval bounds are the ones the bot enforces.
assert.equal(botControl.setIntervalMinutes(USER, 3), 3);
assert.equal(botControl.getIntervalMinutes(USER), 3);
assert.throws(() => botControl.setIntervalMinutes(USER, 0), botControl.InvalidIntervalError);
assert.throws(() => botControl.setIntervalMinutes(USER, 61), botControl.InvalidIntervalError);
assert.throws(() => botControl.setIntervalMinutes(USER, 2.5), botControl.InvalidIntervalError, "a fractional interval is refused, not silently floored");
console.log("   ✓ interval bounds enforced\n");

// ---------------------------------------------------------------------------
console.log("[5] The trading loop actually re-reads the stop flag on every tick\n");

// Without this, the stop button writes a file nothing consults and reports success anyway --
// the trader would believe they were flat while the bot kept trading.
const loopSrc = readFileSync(join(here, "..", "..", "dave-agent-loop", "src", "trading-loop.ts"), "utf8");
assert.ok(loopSrc.includes("isAutonomousTradingEnabled"), "trading-loop.ts must consult the persisted flag");
const pollTick = loopSrc.slice(loopSrc.indexOf("function pollTick"), loopSrc.indexOf("function pollTick") + 1800);
assert.ok(pollTick.includes("if (!isAutonomousTradingEnabled(ownerUserId)) return;"), "the check must be inside pollTick, so it runs every tick and not once at boot");
console.log("   ✓ pollTick consults it every tick\n");

// ---------------------------------------------------------------------------
console.log("[6] A corrupt state file fails CLOSED\n");

{
  const brokenUser = "user-device-broken";
  createPairingCode(brokenUser);
  const p = join(workDir, "data", "device-auth", brokenUser, "state.json");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(p, "{ this is not json", "utf8");
  // The dangerous failure would be an exception that a caller catches as "allow", or a parse
  // that yields undefined and is then treated as truthy.
  assert.equal(verifyDeviceToken(brokenUser, "anything"), false, "a corrupt file must never authenticate anyone");
  assert.deepEqual(listDevices(brokenUser), [], "and must read as no devices, not as an error");
  console.log("   ✓ corrupt state authenticates nobody\n");
}

console.log("=== All sections passed ===");
