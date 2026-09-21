import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Two real things, both reported by the trader in the same message.
 *
 * 1. THE REPEATING-MESSAGES BUG, in their own timeline: "what's my balance" at 10:01, "wassup" at
 *    10:53, "pending orders" at 10:58, then "hello" -- "it just as if the message send previously
 *    was sent now, so it keeps like telling me your balance is this pending orders is this that".
 *    They had already had this addressed in the PROMPT and suspected it was really technical. It
 *    was: the pending-delegation queue had no notion of age and was drained only by a button tap.
 *    A delegation prompt's buttons stay tappable in Telegram forever and the busy flag that made
 *    the prompt self-heals after 15 minutes, so a message queued at 10:01 was never answered, just
 *    sat on disk -- and got replayed, in full, whenever that stale button was finally tapped.
 *
 * 2. THE EXPORT AUTOMATION: "this add that above to be like a automation so when this come it
 *    automatically read through this then create a knowledge" -- the weekly export announced a
 *    filename and did nothing else with the dataset.
 */

const workDir = mkdtempSync(join(tmpdir(), "dave-step144-"));
process.env.DAVE_DATA_ROOT = workDir;

const { addPendingDelegation, getPendingDelegationQueue, clearPendingDelegation, collapseQueuedMessages, PENDING_DELEGATION_MAX_AGE_MS } = await import("../src/delegation.js");
const { buildExportReviewPrompt, composeReviewMessage, reviewWeeklyExport } = await import("../src/weekly-export-review.js");

const OWNER = "trader-1";
const CHAT = 5150;
const MIN = 60_000;
const queuePath = join(workDir, "data", "agent-loop", OWNER, "pending-delegation.json");
const repoRoot = join(import.meta.dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(repoRoot, p), "utf8");

console.log("=== Stale queued messages no longer replay + weekly export becomes knowledge ===\n");

console.log("[1] A queued message is stamped with when it actually arrived...\n");
clearPendingDelegation(OWNER);
addPendingDelegation(OWNER, { text: "what's my balance", chatId: CHAT });
const [fresh] = getPendingDelegationQueue(OWNER);
assert.equal(typeof fresh.receivedAt, "number", "receivedAt must be recorded");
assert.ok(Math.abs(Date.now() - fresh.receivedAt) < 5_000, "it must be the real arrival time");
console.log("    confirmed: receivedAt stamped at arrival");

console.log("\n[2] THE REAL BUG: the trader's exact timeline no longer replays...\n");
clearPendingDelegation(OWNER);
const now = Date.now();
// Their real timeline. 10:01 queued while busy and was never answered; the rest came much later.
addPendingDelegation(OWNER, { text: "what's my balance", chatId: CHAT, receivedAt: now - 57 * MIN }); // 10:01
addPendingDelegation(OWNER, { text: "wassup", chatId: CHAT, receivedAt: now - 5 * MIN }); // 10:53
addPendingDelegation(OWNER, { text: "pending orders", chatId: CHAT, receivedAt: now - 0.5 * MIN }); // 10:58
const live = getPendingDelegationQueue(OWNER);
const texts = live.map((q) => q.text);
assert.ok(!texts.includes("what's my balance"), "the 57-minute-old message must NOT come back -- this is the whole bug");
assert.deepEqual(texts, ["wassup", "pending orders"], "only what they are genuinely still waiting on");
console.log(`    confirmed: 3 queued, ${live.length} still live -- the 57-min-old balance question is gone`);

console.log("\n[3] The boundary is real and exact, not approximate...\n");
clearPendingDelegation(OWNER);
addPendingDelegation(OWNER, { text: "just inside", chatId: CHAT, receivedAt: Date.now() - (PENDING_DELEGATION_MAX_AGE_MS - 30_000) });
addPendingDelegation(OWNER, { text: "just outside", chatId: CHAT, receivedAt: Date.now() - (PENDING_DELEGATION_MAX_AGE_MS + 30_000) });
assert.deepEqual(getPendingDelegationQueue(OWNER).map((q) => q.text), ["just inside"]);
assert.equal(PENDING_DELEGATION_MAX_AGE_MS, 15 * MIN, "tied to the user-turn busy ceiling deliberately");
console.log(`    confirmed: cutoff is exactly ${PENDING_DELEGATION_MAX_AGE_MS / MIN} minutes`);

console.log("\n[4] A tap on a long-dead button finds nothing -- so nothing is replayed...\n");
clearPendingDelegation(OWNER);
addPendingDelegation(OWNER, { text: "what's my balance", chatId: CHAT, receivedAt: Date.now() - 60 * MIN });
assert.equal(getPendingDelegationQueue(OWNER).length, 0, "an all-stale queue must read as empty");
// telegram-bot-server's delegate: handler already handles length===0 by telling the user it's no
// longer waiting -- so expiry alone is what makes the stale tap harmless.
const serverSrc = read("packages/dave-agent-loop/src/telegram-bot-server.ts");
assert.ok(serverSrc.includes("That request is no longer waiting"), "the empty-queue path must still exist for a stale tap to land on");
console.log("    confirmed: stale tap sees an empty queue and says so instead of answering an hour-old question");

console.log("\n[5] A file written before this fix existed cannot replay either...\n");
mkdirSync(join(workDir, "data", "agent-loop", OWNER), { recursive: true });
writeFileSync(queuePath, JSON.stringify([{ text: "old-format message", chatId: CHAT }]), "utf8");
assert.equal(getPendingDelegationQueue(OWNER).length, 0, "an entry with no receivedAt is from a previous deploy -- older than any live turn");
writeFileSync(queuePath, JSON.stringify({ text: "ancient single-object shape", chatId: CHAT }), "utf8");
assert.equal(getPendingDelegationQueue(OWNER).length, 0, "the legacy single-object shape must not replay either");
console.log("    confirmed: undated and legacy-shape entries both treated as expired");

console.log("\n[6] Genuinely concurrent messages STILL queue and are still answered together...\n");
// The fix must not break the real feature: messages that arrive while Dave is actually busy.
clearPendingDelegation(OWNER);
addPendingDelegation(OWNER, { text: "check EURUSD", chatId: CHAT });
addPendingDelegation(OWNER, { text: "and GBPUSD", chatId: CHAT });
const collapsed = collapseQueuedMessages(getPendingDelegationQueue(OWNER));
assert.equal(collapsed.length, 1, "one turn per chat, not one per message");
assert.equal(collapsed[0].count, 2);
assert.match(collapsed[0].text, /check EURUSD[\s\S]*and GBPUSD/, "real order preserved");
assert.match(collapsed[0].text, /answer them together in ONE reply/, "the anti-repetition instruction survives");
console.log("    confirmed: real backlog still collapses into ONE answer, in order");

console.log("\n[7] The weekly export now genuinely turns into knowledge...\n");
const result = { path: join(workDir, "exports", "2026-09-20.json"), tradeCount: 167, skipCount: 2, hypothesisCount: 0, exportedAt: Date.now() };
const prompt = buildExportReviewPrompt(result, '{"trades":[{"symbol":"VOL_80","pnl":12.4}]}', true);
assert.match(prompt, /167 trades, 2 skips/, "the real counts must reach the model");
assert.match(prompt, /run_script/, "it must be told to MEASURE, not eyeball");
assert.match(prompt, /knowledge_draft/, "…and to actually write knowledge");
assert.match(prompt, /knowledge_list/, "…after checking what it already knows, so it doesn't duplicate");
assert.match(prompt, /sample size/i, "a lesson without a sample size is an anecdote");
assert.match(prompt, /write NOTHING/, "'nothing solid enough' must be an allowed outcome -- a wrong lesson is worse than none");
assert.match(prompt, /export\.json/, "the dataset must be attached as a real file, not pasted in");
console.log("    confirmed: prompt measures first, checks for duplicates, carries sample size, may write nothing");

console.log("\n[8] A missing export fails honestly instead of inventing a review...\n");
const missing = await reviewWeeklyExport({ db: {} as never, client: {} as never, ownerUserId: OWNER, chatId: CHAT }, result);
assert.equal(missing.status, "export_missing");
assert.equal(missing.knowledgeAdded, 0);
assert.match(missing.summary, /not on disk/);
console.log("    confirmed: reports the real reason, writes no knowledge");

console.log("\n[9] The message the trader sees carries the findings, not just a filename...\n");
const written = composeReviewMessage(result, { status: "written", knowledgeAdded: 2, summary: "Longs into London ran 71% over 31 trades; shorts after 14:00 UTC lost money over 22." });
assert.match(written, /167 trades, 2 skips/, "the original export notice must survive");
assert.match(written, /Wrote 2 new knowledge entries/);
assert.match(written, /71%/, "the actual finding must reach them");
const nothing = composeReviewMessage(result, { status: "nothing_to_learn", knowledgeAdded: 0, summary: "Only 6 trades this week -- too few to draw a rule from." });
assert.match(nothing, /Nothing this week was solid enough/, "an honest empty week must read as honest, not as a failure");
const failed = composeReviewMessage(result, { status: "failed", knowledgeAdded: 0, summary: "provider timeout" });
assert.match(failed, /couldn't finish reviewing it/);
assert.match(failed, /167 trades/, "even on failure they still get the export notice they relied on");
console.log("    confirmed: findings, honest-nothing, and failure all read correctly");

console.log("\n[10] The automation is genuinely WIRED to the cron, not just written...\n");
const handlerSrc = read("packages/dave-agent-loop/src/feedback-loop-handler.ts");
assert.ok(handlerSrc.includes("reviewWeeklyExport("), "the export cron must actually call the review");
assert.ok(handlerSrc.includes("composeReviewMessage(result, outcome)"), "…and send the reviewed message");
assert.ok(/\.catch\(/.test(handlerSrc), "a cron callback must never leave an unhandled rejection -- that kills the process");
assert.ok(handlerSrc.includes('sendToPrimaryChat(deps, composeExportMessage(result), "weekly export")'), "the plain export notice must survive as a fallback if the review blows up");
const reviewSrc = read("packages/dave-agent-loop/src/weekly-export-review.ts");
assert.ok(!/maxSteps/.test(reviewSrc), "the review runs uncapped like every other real agent run here");
assert.ok(reviewSrc.includes('E2B_TOOLS.find((t) => t.name === "run_script")'), "it gets run_script only -- not key management");
console.log("    confirmed: wired to the cron, crash-safe, falls back to the plain notice, uncapped");

console.log("\n[11] Dave is actually TOLD about the capabilities, not just given them...\n");
// The trader's point: "register the tools and also update the prompt of its tool". A core tool
// Dave has never been told about is one he does not reach for -- start_background_check was core
// and wired, but appeared nowhere in the prompt, so only the cheap mark_level was ever described.
const identity = read("prompts/IDENTITY.md");
const { CORE_TOOL_NAMES } = await import("../src/tool-selection.js");
for (const name of ["run_script", "list_user_files", "send_file_to_user", "start_background_check", "create_subagent"]) {
  assert.ok(identity.includes(name), `the prompt must actually name ${name} -- an undescribed tool goes unused`);
}
for (const name of ["run_script", "list_user_files", "send_file_to_user", "start_background_check"]) {
  assert.ok(CORE_TOOL_NAMES.includes(name), `${name} must be core so it is reachable every turn`);
}
// The prompt must explain the SCRIPT half of a background check, not just that the tool exists.
assert.match(identity, /script[\s\S]{0,400}every single tick/i, "the prompt must explain that a check's script re-runs each tick");
assert.match(identity, /run it instead/, "…and that a figure worked out in his head should be computed instead");
assert.match(identity, /Every worker can write and run real code/, "…and that workers can run code too");
console.log("    confirmed: all 5 capabilities named in the prompt and core-reachable");

console.log("\n=== ALL ASSERTIONS PASSED ===");
process.exit(0);
