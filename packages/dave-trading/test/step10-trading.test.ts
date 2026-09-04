import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  ORDER_TYPES,
  resolveEntryPrice,
  validateOrder,
  getRiskSettings,
  setRiskMode,
  OnModeRequiresValueError,
  proposeProtectedLimitChange,
  approveProtectedLimitChange,
  upsertGroup,
  setActiveGroup,
  setFallbackGroup,
  getActiveGroupInfo,
  handleExtremeConditions,
  processPriceTick,
  newPosition,
  enableBreakevenTrailing,
  type Position,
  type TradeExecutor,
  tradeExecute,
  tradeModify,
  partialClose,
  deletePendingOrder,
  deleteAllPendingOrders,
  setTradingMode,
  getTradingMode,
  TradingSkillsModeRequiresSkillError,
  saveSkill,
  listSkills,
  storeOwnMt5Credentials,
  setAccountChoice,
  getAccountChoice,
  getMaskedOwnMt5Credentials,
  findSetup,
  TRADING_TOOLS,
  type ToolContext,
} from "../src/index.js";
import { DavemaClient } from "@dave/davema";

const DATA_DIR = join(process.cwd(), "data");
rmSync(DATA_DIR, { recursive: true, force: true });

console.log("=== Step 10 real proof: trading engine ===\n");
const USER_ID = "tg-847213";

// --- 10.2: all 6 order types + entry price resolution ---
console.log("[1] All 6 real order types, entry price resolution never silently fails...");
console.log(`    ${ORDER_TYPES.join(", ")}`);
assert.deepEqual(ORDER_TYPES, ["buy", "sell", "buy_limit", "sell_limit", "buy_stop", "sell_stop"]);

for (const type of ["buy", "sell"] as const) {
  const r = resolveEntryPrice({ type });
  assert.equal(r.resolved, true, `${type} market orders resolve without a price`);
}
const explicitPrice = resolveEntryPrice({ type: "buy_limit", price: 1.085 });
console.log(`    buy_limit with explicit price -> ${JSON.stringify(explicitPrice)}`);
assert.deepEqual(explicitPrice, { resolved: true, price: 1.085, source: "explicit" });

const calculated = resolveEntryPrice({ type: "buy_limit" }, { referencePrice: 1.09, offsetPips: 20, pipSize: 0.0001 });
console.log(`    buy_limit with reference+offset -> ${JSON.stringify(calculated)}`);
assert.equal(calculated.resolved, true);
if (calculated.resolved) assert.ok(Math.abs(calculated.price - 1.088) < 1e-9);

const needsPrompt = resolveEntryPrice({ type: "sell_stop" });
console.log(`    sell_stop with nothing given -> ${JSON.stringify(needsPrompt)}`);
assert.deepEqual(needsPrompt, { resolved: false, needsPrompt: true, reason: "sell_stop needs an entry price and none was given or calculable -- ask the user for one." });

console.log("\n[1b] validateOrder rejects a pending order missing a price rather than silently accepting it...");
const invalid = validateOrder({ symbol: "EURUSD", type: "buy_stop", lots: 0.1 });
console.log(`    errors: ${JSON.stringify(invalid)}`);
assert.ok(invalid.length > 0);

// --- 10.1: SL/TP/lot Off/On/Auto, "On" always requires a real value ---
console.log("\n[2] SL/TP/lot risk modes: 'On' is enforced to require a real user value...");
let threwOnModeError = false;
try {
  setRiskMode(USER_ID, "sl", "on"); // no value
} catch (err) {
  threwOnModeError = err instanceof OnModeRequiresValueError;
}
console.log(`    setRiskMode(..., "on") with no value -> threw OnModeRequiresValueError: ${threwOnModeError}`);
assert.equal(threwOnModeError, true);

setRiskMode(USER_ID, "sl", "on", 25);
const settings = getRiskSettings(USER_ID);
console.log(`    after setRiskMode("sl", "on", 25) -> ${JSON.stringify(settings)}`);
assert.equal(settings.slMode, "on");
assert.equal(settings.slValue, 25);

console.log("\n[2b] Protected limits (max open trades / max daily loss) require a SEPARATE fresh approval...");
const proposal = proposeProtectedLimitChange(USER_ID, "maxOpenTrades", 5, "user asked to raise from 3 to 5");
console.log(`    proposed: ${JSON.stringify(proposal)}`);
assert.equal(getRiskSettings(USER_ID).maxOpenTrades, undefined, "must NOT be applied just by proposing it");
approveProtectedLimitChange(USER_ID, proposal.id);
console.log(`    after explicit approval -> maxOpenTrades = ${getRiskSettings(USER_ID).maxOpenTrades}`);
assert.equal(getRiskSettings(USER_ID).maxOpenTrades, 5);

// --- 10.5/10.6: pair groups, active+fallback exclusivity, extreme-condition switching ---
console.log("\n[3] Pair groups: exactly one active + one fallback, auto-switch on extreme conditions...");
upsertGroup(USER_ID, { id: "majors", name: "Majors", symbols: ["EURUSD", "GBPUSD", "USDJPY"] });
upsertGroup(USER_ID, { id: "synthetics", name: "Synthetics", symbols: ["BOOM_100", "CRASH_200"] });
setActiveGroup(USER_ID, "majors");
setFallbackGroup(USER_ID, "synthetics");
const info1 = getActiveGroupInfo(USER_ID);
console.log(`    active: ${info1.activeGroup?.name}, fallback: ${info1.fallbackGroup?.name}`);
assert.equal(info1.activeGroup?.id, "majors");
assert.equal(info1.fallbackGroup?.id, "synthetics");

console.log("\n[3b] Extreme conditions detected -> auto-switch to fallback...");
const switchResult = handleExtremeConditions(USER_ID, true);
console.log(`    ${JSON.stringify(switchResult)}`);
assert.equal(switchResult.switched, true);
assert.equal(switchResult.newActiveGroupId, "synthetics");
const info2 = getActiveGroupInfo(USER_ID);
console.log(`    active group is now: ${info2.activeGroup?.name} (paused=${info2.pausedForExtremeConditions})`);
assert.equal(info2.activeGroup?.id, "synthetics", "the group that was active during extreme conditions must no longer be active");
assert.equal(info2.pausedForExtremeConditions, true);

// --- 10.9: breakeven and trailing stops -- OPT-IN, not automatic ---
console.log("\n[4] Breakeven/trailing is opt-in per position, NOT automatic on a normal trade...");
const config = { slAtTp1: 1.085, slAtTp2: 1.09, slAtTp3: 1.095 };
const priceSequence = [1.086, 1.089, 1.09, 1.0925, 1.095, 1.098, 1.1, 1.101];

console.log("[4a] A normal, freshly-placed position (no opt-in) gets NO SL movement, ever...");
let normalPosition: Position = newPosition({ id: "pos-normal", direction: "buy", entry: 1.085, sl: 1.08, tp1: 1.09, tp2: 1.095, tp3: 1.1 });
assert.equal(normalPosition.breakevenTrailingEnabled, false, "newPosition() must default this off");
for (const price of priceSequence) {
  const result = processPriceTick(normalPosition, price, config);
  normalPosition = result.position;
  assert.equal(result.slChanged, false, `price ${price} must not move SL on a position that never opted in`);
}
console.log(`    SL after the full price run: ${normalPosition.sl} (unchanged from ${1.08}) -- confirmed real no-op`);
assert.equal(normalPosition.sl, 1.08);

console.log("\n[4b] Dave can explicitly opt a position in -- 'if it wishes', a deliberate per-position choice...");
let position: Position = enableBreakevenTrailing(
  newPosition({ id: "pos-1", direction: "buy", entry: 1.085, sl: 1.08, tp1: 1.09, tp2: 1.095, tp3: 1.1 })
);
assert.equal(position.breakevenTrailingEnabled, true);
for (const price of priceSequence) {
  const result = processPriceTick(position, price, config);
  position = result.position;
  if (result.slChanged) console.log(`    price ${price} -> stage ${result.stage}, SL moved to ${position.sl}`);
}
assert.equal(position.sl, 1.095, "once opted in, SL must have progressed through breakeven -> TP2 lock -> TP3 lock");
assert.equal(position.tp1Hit && position.tp2Hit && position.tp3Hit, true);

console.log("\n[4c] SL never moves backward even if a stage's target would be worse than the current SL...");
let posGuard: Position = enableBreakevenTrailing(newPosition({ id: "pos-2", direction: "buy", entry: 1.085, sl: 1.087, tp1: 1.09 }));
const guardResult = processPriceTick(posGuard, 1.09, { slAtTp1: 1.08 /* worse than current sl 1.087 */, slAtTp2: 1.09, slAtTp3: 1.095 });
console.log(`    SL before: 1.087, TP1 target 1.08 (worse) -> slChanged: ${guardResult.slChanged}, sl stays: ${guardResult.position.sl}`);
assert.equal(guardResult.slChanged, false);
assert.equal(guardResult.position.sl, 1.087);

// --- 10.3: partial close, remove SL/TP, delete pending orders ---
console.log("\n[5] Partial close, SL/TP removal, and pending-order deletion via a real fake executor...");
const calls: { method: string; args: unknown[] }[] = [];
const fakeExecutor: TradeExecutor = {
  openOrder: async (order) => {
    calls.push({ method: "openOrder", args: [order] });
    return { ticket: "T1" };
  },
  modifyOrder: async (ticket, changes) => {
    calls.push({ method: "modifyOrder", args: [ticket, changes] });
  },
  closePosition: async (ticket, lots) => {
    calls.push({ method: "closePosition", args: [ticket, lots] });
    return { closedLots: lots ?? 1.0, remainingLots: lots ? 1.0 - lots : 0 };
  },
  deletePendingOrder: async (ticket) => {
    calls.push({ method: "deletePendingOrder", args: [ticket] });
  },
  listOpenPositions: async () => [],
  listPendingOrders: async () => [
    { ticket: "P1", symbol: "EURUSD" },
    { ticket: "P2", symbol: "XAUUSD" },
  ],
};

const opened = await tradeExecute(fakeExecutor, { symbol: "EURUSD", type: "buy", lots: 0.5 });
console.log(`    opened: ${JSON.stringify(opened)}`);
const partial = await partialClose(fakeExecutor, "T1", 0.3);
console.log(`    partial close 0.3 of 1.0 lots -> ${JSON.stringify(partial)}`);
assert.equal(partial.closedLots, 0.3);
assert.equal(partial.remainingLots, 0.7);

await tradeModify(fakeExecutor, "T1", { sl: null, tp: null });
console.log(`    tradeModify with sl:null, tp:null -> removes both`);
assert.deepEqual(calls[calls.length - 1].args, ["T1", { sl: null, tp: null }]);

const deleteAllResult = await deleteAllPendingOrders(fakeExecutor);
console.log(`    deleteAllPendingOrders -> deleted: ${JSON.stringify(deleteAllResult.deleted)}`);
assert.deepEqual(deleteAllResult.deleted, ["P1", "P2"]);

// --- 10.4: trading mode ---
console.log("\n[6] Trading mode: Auto vs Trading Skills (locked to one taught pattern)...");
assert.equal(getTradingMode(USER_ID).mode, "auto", "defaults to auto");
let threwSkillModeError = false;
try {
  setTradingMode(USER_ID, "trading-skills"); // no skill id
} catch (err) {
  threwSkillModeError = err instanceof TradingSkillsModeRequiresSkillError;
}
assert.equal(threwSkillModeError, true);
setTradingMode(USER_ID, "trading-skills", "skill-1");
console.log(`    trading mode: ${JSON.stringify(getTradingMode(USER_ID))}`);
assert.deepEqual(getTradingMode(USER_ID), { mode: "trading-skills", lockedSkillId: "skill-1" });

// --- 10.7: machine-readable trading skill storage ---
console.log("\n[7] Trading skill storage (system only -- no skill content authored here)...");
saveSkill(USER_ID, { id: "skill-1", name: "Liquidity sweep + FVG", taughtFrom: "video", description: "taught by the user", rules: { note: "opaque to this module" }, createdAt: Date.now() });
const skills = listSkills(USER_ID);
console.log(`    ${skills.length} skill(s) stored: ${skills.map((s) => s.name).join(", ")}`);
assert.equal(skills.length, 1);

// --- 10.8: MT5 account choice, own credentials stored securely ---
console.log("\n[8] MT5 account selection + secure credential storage for the user's own account...");
assert.equal(getAccountChoice(USER_ID), "dave-default", "defaults to Dave's own account");
let threwNoCredsError = false;
try {
  setAccountChoice(USER_ID, "own-account");
} catch {
  threwNoCredsError = true;
}
assert.equal(threwNoCredsError, true, "cannot select own-account before storing credentials for it");
storeOwnMt5Credentials(USER_ID, { login: "12345678", password: "super-secret-pw", server: "Broker-Live" });
setAccountChoice(USER_ID, "own-account");
console.log(`    account choice: ${getAccountChoice(USER_ID)}`);
console.log(`    masked credentials (safe to display): ${JSON.stringify(getMaskedOwnMt5Credentials(USER_ID))}`);
assert.equal(getAccountChoice(USER_ID), "own-account");
assert.deepEqual(getMaskedOwnMt5Credentials(USER_ID), { login: "12345678", server: "Broker-Live" });

// --- 10.10: find-a-setup, real on-demand DAVEMA scan ---
console.log("\n[9] 'Find me a setup' -- real on-demand scan of the active pair group via live DAVEMA...");
const client = new DavemaClient(undefined); // no valid key -- real 401s prove the real call path fires
const scan = await findSetup(USER_ID, client, "H1");
console.log(`    scanned group: "${scan.groupName}", ${scan.rows.length} symbol(s)`);
for (const row of scan.rows) console.log(`      ${row.symbol}: ${row.error ? `error: ${row.error}` : `score ${row.score}`}`);
assert.equal(scan.groupName, "Synthetics", "the CURRENT active group (post extreme-condition switch) is what gets scanned");
assert.equal(scan.rows.length, 2);
assert.ok(scan.rows.every((r) => r.error?.includes("401")), "real live calls were made -- real 401s without a key, not fabricated data");

// --- Agentic tool exposure: these are real, callable tools, not just plain functions behind a /command ---
console.log("\n[10] Trading actions are exposed as real, agent-callable tools -- Dave can reach for them itself...");
console.log(`    ${TRADING_TOOLS.length} tools registered: ${TRADING_TOOLS.map((t) => t.name).join(", ")}`);
assert.ok(TRADING_TOOLS.find((t) => t.name === "find_setup"), "find_setup must be a real callable tool, not only reachable via a /command");
const findSetupTool = TRADING_TOOLS.find((t) => t.name === "find_setup")!;
console.log(`    find_setup.description: "${findSetupTool.description}"`);
assert.match(findSetupTool.description, /on your own initiative/i, "the tool's own description must say Dave can use it unprompted");

const toolExecutor: TradeExecutor = {
  openOrder: async (order) => ({ ticket: `TOOL-${order.symbol}` }),
  modifyOrder: async () => {},
  closePosition: async (_t, lots) => ({ closedLots: lots ?? 1, remainingLots: 0 }),
  deletePendingOrder: async () => {},
  listOpenPositions: async () => [],
  listPendingOrders: async () => [],
};
const ctx: ToolContext = { userId: USER_ID, davema: client, executor: toolExecutor };

console.log("\n[10a] Calling find_setup THROUGH the tool manifest (not the raw function) returns a real result...");
const toolScanResult = (await findSetupTool.execute({ timeframe: "H1" }, ctx)) as { groupName: string | null };
console.log(`    result via tool call: groupName="${toolScanResult.groupName}"`);
assert.equal(toolScanResult.groupName, "Synthetics");

console.log("\n[10b] Calling trade_execute through the manifest actually reaches the executor...");
const tradeExecuteTool = TRADING_TOOLS.find((t) => t.name === "trade_execute")!;
const toolOpenResult = (await tradeExecuteTool.execute({ symbol: "EURUSD", type: "buy", lots: 0.2 }, ctx)) as { ticket: string };
console.log(`    result via tool call: ${JSON.stringify(toolOpenResult)}`);
assert.equal(toolOpenResult.ticket, "TOOL-EURUSD");

console.log("\n[10c] Every tool declares a real JSON-schema parameter shape (not free-form)...");
for (const tool of TRADING_TOOLS) {
  assert.equal(tool.parameters.type, "object", `${tool.name} must declare a real object schema`);
}
console.log("    all tools declare object-typed parameter schemas");

rmSync(DATA_DIR, { recursive: true, force: true });

console.log("\n=== ALL ASSERTIONS PASSED ===");
