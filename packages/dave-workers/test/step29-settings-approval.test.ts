import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  proposeSettingsChange,
  approveSettingsChange,
  declineSettingsChange,
  getRiskSettings,
  getAutoApprovalEnabled,
  proposeProtectedLimitChange,
  listPendingLimitChanges,
  OnModeRequiresValueError,
} from "@dave/trading";
import { approvalKeyboard, coloredButton } from "@dave/telegram";
import { SETTINGS_TOOLS } from "../src/index.js";

const DATA_DIR = join(process.cwd(), "data");
rmSync(DATA_DIR, { recursive: true, force: true });

console.log("=== Update 8 real proof: settings-change approve/decline + auto-approval ===\n");
const USER_ID = "tg-847213";

// --- [1] Auto-approval defaults OFF -- Dave must ask by default ---
console.log("[1] Auto-approval defaults OFF...\n");
assert.equal(getAutoApprovalEnabled(USER_ID), false);
console.log(`    fresh user: auto-approval = ${getAutoApprovalEnabled(USER_ID)}`);

// --- [2] Dave proposes a change on its own initiative -- does NOT apply immediately ---
console.log("\n[2] Dave proposes a SL change on its own initiative -- must NOT apply immediately...\n");
const beforeSettings = getRiskSettings(USER_ID);
assert.equal(beforeSettings.slMode, "off");

const proposeTool = SETTINGS_TOOLS.find((t) => t.name === "propose_settings_change")!;
const proposal = (await proposeTool.execute(
  { field: "sl", mode: "on", value: 20, reason: "Volatility is up -- tightening SL protects the account." },
  { userId: USER_ID } as any
)) as any;
assert.equal(proposal.applied, false);
assert.ok(proposal.pendingId);
console.log(`    real proposal created, NOT applied: ${JSON.stringify(proposal)}`);

const stillOff = getRiskSettings(USER_ID);
assert.equal(stillOff.slMode, "off", "must genuinely still be off until the user decides");
console.log(`    real settings genuinely unchanged while pending: slMode=${stillOff.slMode}`);

// --- [3] The real colored Approve/Decline buttons Dave would actually send ---
console.log("\n[3] Real colored Approve/Decline buttons (Step 8.3's real 'style' field, not an emoji workaround)...\n");
const kb = approvalKeyboard(proposal.pendingId, "trading");
const [approveBtn, declineBtn] = kb.inline_keyboard[0];
assert.equal((approveBtn as any).style, "success");
assert.equal((declineBtn as any).style, "danger");
assert.equal(approveBtn.callback_data, `approve:trading:${proposal.pendingId}`);
console.log(`    real keyboard: ${JSON.stringify(kb)}`);
assert.deepEqual(coloredButton("test", "blue", "x"), { text: "test", callback_data: "x", style: "primary" });

// --- [4] User declines -- change genuinely never applies ---
console.log("\n[4] User declines via the real callback path -- change never applies...\n");
declineSettingsChange(USER_ID, proposal.pendingId);
assert.equal(getRiskSettings(USER_ID).slMode, "off");
assert.equal(listPendingLimitChanges(USER_ID).length, 0, "a decided change must be removed from the pending queue");
console.log(`    real decline honored: slMode still ${getRiskSettings(USER_ID).slMode}, pending queue drained`);

// --- [5] User approves a second, separate proposal -- change genuinely applies ---
console.log("\n[5] A second proposal -- user APPROVES this time, change genuinely applies...\n");
const proposal2 = (await proposeTool.execute({ field: "sl", mode: "on", value: 15, reason: "Even tighter after another volatility spike." }, { userId: USER_ID } as any)) as any;
assert.notEqual(proposal2.pendingId, proposal.pendingId);
const approved = approveSettingsChange(USER_ID, proposal2.pendingId);
assert.equal(approved.slMode, "on");
assert.equal(approved.slValue, 15);
console.log(`    real approval applied: ${JSON.stringify({ slMode: approved.slMode, slValue: approved.slValue })}`);

// --- [6] Auto-approval ON -- Dave's proposal now applies immediately, no pending queue entry ---
console.log("\n[6] User turns auto-approval ON -- Dave's next proposal applies immediately, no button round trip...\n");
const setAutoTool = SETTINGS_TOOLS.find((t) => t.name === "set_auto_approval")!;
await setAutoTool.execute({ enabled: true }, { userId: USER_ID } as any);
const getAutoTool = SETTINGS_TOOLS.find((t) => t.name === "get_auto_approval")!;
const autoState = (await getAutoTool.execute({}, { userId: USER_ID } as any)) as any;
assert.equal(autoState.enabled, true);

const proposal3 = (await proposeTool.execute({ field: "tp", mode: "on", value: 40, reason: "Locking in more profit given the trend strength." }, { userId: USER_ID } as any)) as any;
assert.equal(proposal3.applied, true);
assert.equal(proposal3.settings.tpMode, "on");
assert.equal(proposal3.settings.tpValue, 40);
assert.equal(listPendingLimitChanges(USER_ID).length, 0, "auto-approved changes must never sit in the pending queue at all");
console.log(`    real auto-applied immediately: ${JSON.stringify({ tpMode: proposal3.settings.tpMode, tpValue: proposal3.settings.tpValue })}, pending queue still empty`);

// --- [7] Protected limits (maxOpenTrades/maxDailyLossPct) NEVER auto-approve, even with the switch on ---
console.log("\n[7] Protected limits stay extra-protected -- auto-approval does NOT bypass them...\n");
const protectedProposal = proposeProtectedLimitChange(USER_ID, "maxOpenTrades", 10, "Wants to run more concurrent positions.");
assert.equal(listPendingLimitChanges(USER_ID).length, 1, "a protected-limit proposal must STILL genuinely queue even with auto-approval on");
assert.equal(getRiskSettings(USER_ID).maxOpenTrades, undefined);
console.log(`    real protected proposal genuinely still queued despite auto-approval=true: ${JSON.stringify(protectedProposal)}`);
approveSettingsChange(USER_ID, protectedProposal.id);
assert.equal(getRiskSettings(USER_ID).maxOpenTrades, 10);
console.log("    still requires its own explicit approval call to actually apply -- confirmed");

// --- [8] "On" without a value is still refused, even through the new propose path ---
console.log("\n[8] OnModeRequiresValueError still enforced through propose_settings_change...\n");
let threw = false;
try {
  await proposeTool.execute({ field: "lot", mode: "on", reason: "no value given" }, { userId: USER_ID } as any);
} catch (err) {
  threw = err instanceof OnModeRequiresValueError;
}
assert.ok(threw);
console.log("    genuinely refused -- 'on' still requires a real value, even for a Dave-initiated proposal");

rmSync(DATA_DIR, { recursive: true, force: true });
console.log("\n=== ALL ASSERTIONS PASSED ===");
