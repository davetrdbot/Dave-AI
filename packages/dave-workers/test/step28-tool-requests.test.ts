import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  createWorker,
  toolsForWorkerWithGrants,
  requestTool,
  decideToolRequest,
  listPendingToolRequests,
  listToolRequestsForWorker,
  getGrantedToolNames,
  ToolRequestNotFoundError,
  WORKER_TOOL_REQUEST_TOOLS,
  DAVE_TOOL_REQUEST_TOOLS,
  type ToolDefinition as WorkerScopedToolDefinition,
} from "../src/index.js";

const DATA_DIR = join(process.cwd(), "data");
rmSync(DATA_DIR, { recursive: true, force: true });

console.log("=== Update 7 real proof: worker tool requests (real grant/deny exchange) ===\n");
const OWNER = "tg-847213";

// A tool the worker was NOT given up front -- standing in for "another
// package's tool" (e.g. Update 5's generate_image), kept local here so
// this test has no cross-package dependency.
const EXTRA_TOOL: ToolDefinition = {
  name: "generate_image",
  description: "Generate an image (not given to this worker by default).",
  parameters: { type: "object", properties: {} },
  execute: async () => ({ url: "https://example.com/fake.png" }),
};
interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (...args: any[]) => Promise<unknown>;
}
const CATALOG: ToolDefinition[] = [EXTRA_TOOL];

// --- [1] A worker starts WITHOUT the extra tool -- Dave didn't guess it upfront ---
console.log("[1] A fresh worker genuinely does not have a tool Dave never gave it...\n");
const worker = createWorker(OWNER, { name: "Priya", assignment: "fixed", role: "journal", task: "Journal trades" });
const before = toolsForWorkerWithGrants(worker, CATALOG as any);
assert.ok(!before.some((t) => t.name === "generate_image"), "must NOT have the tool before any request/grant");
console.log(`    worker "${worker.name}"'s real tool list: ${before.map((t) => t.name).join(", ")} -- no generate_image`);

// --- [2] Worker requests the tool it realizes it needs, mid-task ---
console.log("\n[2] Worker calls request_tool mid-task -- a real request, not a silent block...\n");
const requestTool2 = WORKER_TOOL_REQUEST_TOOLS.find((t) => t.name === "request_tool")!;
const request = (await requestTool2.execute(
  { toolName: "generate_image", reason: "The user wants a visual chart annotation attached to this trade journal entry." },
  { ownerUserId: OWNER, workerId: worker.id }
)) as any;
assert.equal(request.status, "pending");
console.log(`    real request created: id=${request.id}, tool="${request.toolName}", status=${request.status}`);
console.log(`    reason given: "${request.reason}"`);

// --- [3] Still unavailable while pending -- Dave hasn't decided yet ---
console.log("\n[3] Still unavailable while the request is pending...\n");
const duringPending = toolsForWorkerWithGrants(worker, CATALOG as any);
assert.ok(!duringPending.some((t) => t.name === "generate_image"));
console.log("    correctly still absent -- a pending request does not grant access on its own");

// --- [4] Dave sees the pending request and DENIES it first ---
console.log("\n[4] Dave sees it via list_pending_tool_requests and denies it...\n");
const listPendingTool = DAVE_TOOL_REQUEST_TOOLS.find((t) => t.name === "list_pending_tool_requests")!;
const pending = (await listPendingTool.execute({}, { ownerUserId: OWNER })) as any[];
assert.equal(pending.length, 1);
assert.equal(pending[0].id, request.id);
console.log(`    Dave's real pending list: ${JSON.stringify(pending.map((r) => ({ id: r.id, tool: r.toolName })))}`);

const decideTool = DAVE_TOOL_REQUEST_TOOLS.find((t) => t.name === "decide_tool_request")!;
const denied = (await decideTool.execute({ requestId: request.id, granted: false }, { ownerUserId: OWNER })) as any;
assert.equal(denied.status, "denied");
assert.ok(denied.decidedAt !== null);
console.log(`    real decision recorded: status=${denied.status}, decidedAt=${denied.decidedAt}`);

const afterDeny = toolsForWorkerWithGrants(worker, CATALOG as any);
assert.ok(!afterDeny.some((t) => t.name === "generate_image"), "a denied request must genuinely NOT grant the tool");
console.log("    correctly still absent after a real denial");

// --- [5] Worker requests again (a fresh request, e.g. task genuinely needs it later); Dave GRANTS this time ---
console.log("\n[5] A second, separate request -- Dave grants it this time...\n");
const request2 = (await requestTool2.execute(
  { toolName: "generate_image", reason: "Now genuinely needed for the weekly summary chart." },
  { ownerUserId: OWNER, workerId: worker.id }
)) as any;
assert.notEqual(request2.id, request.id, "must be a genuinely separate request, not reusing the denied one");

const granted = (await decideTool.execute({ requestId: request2.id, granted: true }, { ownerUserId: OWNER })) as any;
assert.equal(granted.status, "granted");
console.log(`    real grant recorded: id=${granted.id}, status=${granted.status}`);

// --- [6] LIVE update: the worker's tool access reflects the grant on the very next check, no restart ---
console.log("\n[6] Real LIVE update -- the worker's tool list reflects the grant immediately...\n");
const afterGrant = toolsForWorkerWithGrants(worker, CATALOG as any);
assert.ok(afterGrant.some((t) => t.name === "generate_image"), "the granted tool must genuinely now be available");
const grantedTool = afterGrant.find((t) => t.name === "generate_image")!;
const callResult = await grantedTool.execute({}, {} as any);
assert.deepEqual(callResult, { url: "https://example.com/fake.png" });
console.log(`    "generate_image" is now genuinely callable through the worker's real tool list: ${JSON.stringify(callResult)}`);
console.log(`    base tools untouched: ${afterGrant.filter((t) => t.name !== "generate_image").map((t) => t.name).join(", ")} still present`);

// --- [7] getGrantedToolNames() directly, and check_my_tool_requests from the worker's own side ---
console.log("\n[7] Direct grant lookup + worker's own status check agree with each other...\n");
assert.deepEqual(getGrantedToolNames(OWNER, worker.id), ["generate_image"]);
const checkTool = WORKER_TOOL_REQUEST_TOOLS.find((t) => t.name === "check_my_tool_requests")!;
const myRequests = (await checkTool.execute({}, { ownerUserId: OWNER, workerId: worker.id })) as any[];
assert.equal(myRequests.length, 2);
assert.deepEqual(
  myRequests.map((r) => r.status).sort(),
  ["denied", "granted"]
);
console.log(`    worker's own view of its requests: ${JSON.stringify(myRequests.map((r) => ({ id: r.id, status: r.status })))}`);

// --- [8] A decision is final -- deciding an already-decided request is refused ---
console.log("\n[8] A decision is final -- re-deciding an already-decided request is refused...\n");
let refused = false;
try {
  await decideTool.execute({ requestId: request2.id, granted: false }, { ownerUserId: OWNER });
} catch (err) {
  refused = err instanceof Error && err.message.includes("already decided");
}
assert.ok(refused);
console.log("    genuinely refused -- a decision cannot be silently flipped after the fact");

console.log("\n[8b] Deciding an unknown request id fails honestly, typed...\n");
let notFound = false;
try {
  await decideTool.execute({ requestId: "nonexistent", granted: true }, { ownerUserId: OWNER });
} catch (err) {
  notFound = err instanceof ToolRequestNotFoundError;
}
assert.ok(notFound);
console.log("    real, typed ToolRequestNotFoundError");

// --- [9] Different worker's requests stay isolated ---
console.log("\n[9] A second worker's requests/grants stay isolated from the first...\n");
const worker2 = createWorker(OWNER, { name: "Kenji", assignment: "temporary", role: "generic", task: "Scan for setups" });
assert.deepEqual(getGrantedToolNames(OWNER, worker2.id), []);
assert.equal(listToolRequestsForWorker(OWNER, worker2.id).length, 0);
console.log(`    "${worker2.name}" genuinely has zero requests/grants -- "${worker.name}"'s grant did not leak across`);

rmSync(DATA_DIR, { recursive: true, force: true });
console.log("\n=== ALL ASSERTIONS PASSED ===");
