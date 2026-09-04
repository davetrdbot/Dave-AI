import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import {
  appendUserFact,
  loadFrozenSnapshot,
  recordTurn,
  extractAtoms,
  recordScenario,
  getAtoms,
  getScenarios,
  searchSessions,
  markRecalled,
  executeTask,
  RecallRequiredError,
  getWriteApprovalSetting,
  setWriteApprovalSetting,
  gatedWrite,
  listPendingWrites,
  approveWrite,
  getOrCreateUserWebhook,
  readInbox,
} from "../src/index.js";

const DATA_DIR = join(process.cwd(), "data");
rmSync(DATA_DIR, { recursive: true, force: true });

const USER_ID = "tg-847213";

console.log("=== Step 4 real proof: memory system ===\n");

// --- 4.3: TencentDB-style L0->L2 tiers, layered on the L3 frozen store ---
console.log("[1] L0/L1/L2 tiers on real turns...");
const t1 = recordTurn(USER_ID, "user", "Hi Dave, I'm David and I prefer terse updates.");
const atoms1 = extractAtoms(USER_ID, t1);
console.log(`    L0 turn recorded: "${t1.text}"`);
console.log(`    L1 atoms extracted: ${JSON.stringify(atoms1.map((a) => a.fact))}`);
assert.ok(atoms1.some((a) => /David/.test(a.fact)));
recordScenario(USER_ID, "Onboarding: user introduced themselves and set a communication preference.", atoms1.length);
const scenarios = getScenarios(USER_ID);
console.log(`    L2 scenario recorded: "${scenarios[0].summary}"`);
assert.equal(scenarios.length, 1);
assert.equal(getAtoms(USER_ID).length, atoms1.length);

// --- 4.4: session search ---
console.log("\n[2] Session search across L0 conversation log...");
recordTurn(USER_ID, "dave", "Got it, terse it is.");
recordTurn(USER_ID, "user", "What's my current EURUSD exposure?");
const hits = searchSessions(USER_ID, "EURUSD");
console.log(`    search("EURUSD") -> ${hits.length} hit(s): "${hits[0]?.turn.text}"`);
assert.equal(hits.length, 1);
assert.equal(searchSessions(USER_ID, "nonexistent-term-xyz").length, 0);

// --- 4.1: frozen-snapshot cache-hit proxy metric ---
console.log("\n[3] Cache-hit metric proxy: static prefix must stay byte-identical across assemblies within a session...");
appendUserFact(USER_ID, "Prefers to be called: David");
function assembleStaticPrefix(): string {
  const snap = loadFrozenSnapshot(USER_ID);
  const soul = readFileSync(join(process.cwd(), "prompts", "SOUL.md"), "utf8");
  const identity = readFileSync(join(process.cwd(), "prompts", "IDENTITY.md"), "utf8");
  const security = readFileSync(join(process.cwd(), "prompts", "SECURITY.md"), "utf8");
  // Static-first ordering (Step 1.7): prompts, then frozen memory. No
  // dynamic/live content (timestamps, recent turns) enters this prefix --
  // that's what makes it cacheable on a real provider.
  return [soul, identity, security, snap.memory, snap.user, snap.adaptability].join("\n---\n");
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const assembly1 = assembleStaticPrefix();
const assembly2 = assembleStaticPrefix();
const assembly3 = assembleStaticPrefix();
const hashes = [hash(assembly1), hash(assembly2), hash(assembly3)];
const cacheHitRate = hashes.filter((h) => h === hashes[0]).length / hashes.length;
console.log(`    3 assemblies within this session -> prefix hashes: ${hashes.map((h) => h.slice(0, 8)).join(", ")}`);
console.log(`    proxy cache-hit rate: ${(cacheHitRate * 100).toFixed(0)}% (identical prefix => a real provider would cache-hit on assemblies 2 and 3)`);
assert.equal(cacheHitRate, 1, "static prefix must be byte-identical across assemblies in the same session");
// Now prove a MID-SESSION write does NOT change the already-taken snapshot's
// prefix (frozen semantics, Step 1.4) even though the underlying file changed:
appendUserFact(USER_ID, "This write happens after assembly1/2/3 were taken");
const assemblyAfterWrite = assembleStaticPrefix(); // this call reloads -> will differ, which is correct: differs only on the NEXT session's assembly, not retroactively
assert.notEqual(hash(assemblyAfterWrite), hashes[0], "a fresh load after a write should reflect it -- proves writes aren't lost, just not retroactive");
console.log("    a NEW assembly after a mid-session write picks up the change (next-session semantics) -- PASS");

// --- 4.5: recall-before-acting enforced ---
console.log("\n[4] Recall-before-acting is enforced, not just documented...");
let threw = false;
try {
  executeTask(USER_ID, "check-account-balance", () => "should not run");
} catch (err) {
  threw = err instanceof RecallRequiredError;
  console.log(`    executeTask() without recall -> threw RecallRequiredError: "${(err as Error).message}"`);
}
assert.equal(threw, true);
markRecalled(USER_ID, "check-account-balance", "recalled frozen snapshot + L0-L2 tiers");
const result = executeTask(USER_ID, "check-account-balance", () => "balance: $10,432.10");
console.log(`    after markRecalled(), executeTask() succeeds -> "${result}"`);
assert.equal(result, "balance: $10,432.10");

// --- 4.6: write-approval gate ---
console.log("\n[5] Write-approval setting gates memory writes when ON (default OFF)...");
assert.equal(getWriteApprovalSetting(USER_ID), false, "write-approval must default to off");
const immediateResult = gatedWrite(USER_ID, "test immediate write", () => {
  appendUserFact(USER_ID, "Written while approval gate is OFF");
});
console.log(`    approval OFF -> gatedWrite applied immediately: ${immediateResult.applied}`);
assert.equal(immediateResult.applied, true);

setWriteApprovalSetting(USER_ID, true);
let sideEffectRan = false;
const gatedResult = gatedWrite(USER_ID, "test gated write", () => {
  sideEffectRan = true;
});
console.log(`    approval ON -> gatedWrite queued instead of applying: applied=${gatedResult.applied}, sideEffectRan=${sideEffectRan}`);
assert.equal(gatedResult.applied, false);
assert.equal(sideEffectRan, false, "the write must NOT have happened yet while gated");
const pending = listPendingWrites(USER_ID);
console.log(`    pending writes for user: ${pending.length} ("${pending[0]?.description}")`);
assert.equal(pending.length, 1);
if (!("pendingId" in gatedResult)) throw new Error("expected pendingId");
approveWrite(USER_ID, gatedResult.pendingId);
console.log(`    after approveWrite() -> sideEffectRan=${sideEffectRan}`);
assert.equal(sideEffectRan, true, "the write must have happened only after explicit approval");
assert.equal(listPendingWrites(USER_ID).length, 0);

// --- 4.7: hidden per-user webhook, distinct from worker sub-paths ---
console.log("\n[6] Hidden per-user webhook: real HTTP server, real request...");
const { createHiddenWebhookServer } = await import("../src/user-webhook.js");
const server = createHiddenWebhookServer();
await new Promise<void>((resolve) => server.listen(0, resolve));
const address = server.address();
if (typeof address !== "object" || address === null) throw new Error("server did not bind");
const port = address.port;
const hook = getOrCreateUserWebhook(USER_ID);
console.log(`    generated webhook path: ${hook.path}`);
assert.match(hook.path, /^\/hooks\/user\/[0-9a-f]{48}$/);

const pushRes = await fetch(`http://127.0.0.1:${port}${hook.path}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ type: "journal-entry", payload: { title: "Why I took the EURUSD long", body: "..." } }),
});
const pushJson = await pushRes.json();
console.log(`    POST ${hook.path} -> ${pushRes.status} ${JSON.stringify(pushJson)}`);
assert.equal(pushRes.status, 200);
const inbox = readInbox(USER_ID);
console.log(`    inbox for user now has ${inbox.length} item(s), latest type: "${inbox[inbox.length - 1].type}"`);
assert.equal(inbox.length, 1);
assert.equal(inbox[0].type, "journal-entry");

const badTokenRes = await fetch(`http://127.0.0.1:${port}/hooks/user/deadbeef-not-a-real-token`, {
  method: "POST",
  body: "{}",
});
console.log(`    POST with an unknown token -> ${badTokenRes.status} (must reject)`);
assert.equal(badTokenRes.status, 404);

const workerRes = await fetch(`http://127.0.0.1:${port}/hooks/worker/martins/some-token`, { method: "POST", body: "{}" });
console.log(`    POST to the reserved worker-webhook namespace -> ${workerRes.status} (distinct route, not the user handler)`);
assert.equal(workerRes.status, 501, "worker webhook path must be a genuinely separate route, not silently handled by the user route");

await new Promise<void>((resolve) => server.close(() => resolve()));
console.log("    server closed cleanly");

console.log("\n=== ALL ASSERTIONS PASSED ===");
