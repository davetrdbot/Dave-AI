import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { OpenAICompatibleProvider } from "@dave/brain";
import { ToolRegistry, adaptTools, AgentLoop } from "../src/index.js";
import { beginTurn, endTurn, abortTurn } from "../src/turn-abort.js";

/**
 * Real bug fixed (user, live: a turn got stuck "thinking"/"typing" forever, burning real API
 * credit -- changing the AI Response Timeout setting, `/stop`, and `/reset` all did nothing).
 * Proves the real fix: AgentLoop.run() now has an overall wall-clock deadline distinct from the
 * per-call timeoutMs, a real external `signal` genuinely cancels an in-flight call (not just stop
 * being awaited), and turn-abort.ts's beginTurn/abortTurn/endTurn is the real, wired path
 * telegram-bot-server.ts's /stop and /reset now use.
 */

console.log("=== Real proof: a stuck turn can genuinely be capped and cancelled ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-turn-abort-"));

try {
  process.chdir(workDir);
  const registry = new ToolRegistry();
  registry.register(adaptTools([{ name: "noop", description: "does nothing", parameters: { type: "object", properties: {} }, execute: async () => ({ ok: true }) }], {}));

  // --- [1] A provider call that never responds within a real, short overallTimeoutMs is
  //         genuinely cut off -- "aborted"/"deadline", not left hanging forever. ---
  console.log("[1] A stuck provider call is genuinely capped by the real overall-turn deadline...\n");
  const stuckServer = createServer((_req, _res) => {
    // Deliberately never responds -- simulates a genuinely hung upstream call.
  });
  await new Promise<void>((resolve) => stuckServer.listen(0, resolve));
  const stuckPort = (stuckServer.address() as any).port;
  const stuckProvider = new OpenAICompatibleProvider("groq", `http://127.0.0.1:${stuckPort}`, "test-key", "model");
  const stuckLoop = new AgentLoop(stuckProvider, registry);

  const started = Date.now();
  const deadlineResult = await stuckLoop.run([{ role: "user", content: "go" }], { overallTimeoutMs: 500, timeoutMs: 60_000 });
  const elapsed = Date.now() - started;
  assert.equal(deadlineResult.status, "aborted");
  assert.equal((deadlineResult as any).reason, "deadline");
  assert.ok(elapsed < 55_000, `must return near the real 500ms overall deadline, not wait out the 60s per-call timeout (took ${elapsed}ms)`);
  console.log(`    real overall deadline enforced: status=${deadlineResult.status}, reason=${(deadlineResult as any).reason}, returned after ${elapsed}ms (per-call timeout was 60s)`);
  await new Promise<void>((resolve) => stuckServer.close(() => resolve()));

  // --- [2] A real external abort (the exact mechanism /stop and /reset now use) genuinely
  //         cancels the in-flight call, not just stops the caller from awaiting it. ---
  console.log("\n[2] A real external abortTurn() genuinely cancels an in-flight call...\n");
  let requestWasAborted = false;
  const OWNER = "user-abort-1";
  const hangingServer = createServer((req, res) => {
    req.on("aborted", () => {
      requestWasAborted = true;
    });
    // Never responds on its own -- only a real abort ends this request.
  });
  await new Promise<void>((resolve) => hangingServer.listen(0, resolve));
  const hangingPort = (hangingServer.address() as any).port;
  const hangingProvider = new OpenAICompatibleProvider("groq", `http://127.0.0.1:${hangingPort}`, "test-key", "model");
  const hangingLoop = new AgentLoop(hangingProvider, registry);

  const controller = beginTurn(OWNER);
  const runPromise = hangingLoop.run([{ role: "user", content: "go" }], { overallTimeoutMs: 60_000, timeoutMs: 60_000, signal: controller.signal });
  // Give the real HTTP request time to actually reach the server before cancelling it.
  await new Promise((r) => setTimeout(r, 200));
  const wasCancelled = abortTurn(OWNER);
  assert.equal(wasCancelled, true, "abortTurn must report it genuinely found and cancelled a real in-flight turn");
  const cancelResult = await runPromise;
  assert.equal(cancelResult.status, "aborted");
  assert.equal((cancelResult as any).reason, "cancelled");
  // Give the server a moment to observe the real socket abort.
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(requestWasAborted, true, "the real underlying HTTP request must genuinely be aborted, not just abandoned by the caller (this is what actually stops token billing)");
  console.log(`    real cancel: status=${cancelResult.status}, reason=${(cancelResult as any).reason}, underlying request genuinely aborted=${requestWasAborted}`);
  endTurn(OWNER, controller);
  await new Promise<void>((resolve) => hangingServer.close(() => resolve()));

  // --- [3] abortTurn on a user with no in-flight turn is honest, never throws ---
  console.log("\n[3] abortTurn() on a user with nothing running returns false, never throws...\n");
  const noneResult = abortTurn("user-with-no-turn");
  assert.equal(noneResult, false);
  console.log("    confirmed: false, no throw");

  // --- [4] A normal, fast-completing run is completely unaffected (regression) ---
  console.log("\n[4] A normal, fast-completing run behaves exactly as before -- additive, not a regression...\n");
  let callCount = 0;
  const fastServer = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      callCount++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "All good." } }] }));
    });
  });
  await new Promise<void>((resolve) => fastServer.listen(0, resolve));
  const fastPort = (fastServer.address() as any).port;
  const fastProvider = new OpenAICompatibleProvider("groq", `http://127.0.0.1:${fastPort}`, "test-key", "model");
  const fastLoop = new AgentLoop(fastProvider, registry);
  const fastResult = await fastLoop.run([{ role: "user", content: "hi" }], { overallTimeoutMs: 60_000 });
  assert.equal(fastResult.status, "done");
  assert.equal((fastResult as any).text, "All good.");
  assert.equal(callCount, 1);
  console.log(`    real, unaffected normal run: status=${fastResult.status}, text="${(fastResult as any).text}"`);
  await new Promise<void>((resolve) => fastServer.close(() => resolve()));

  // --- [5] beginTurn() called twice for the same user tracks two genuinely independent
  //         controllers -- starting the second must NOT abort the first (this is the real
  //         concurrency bug: a user's own chat message, a delegated worker task, and an
  //         autonomous tick's Journal consult can all be in flight at once under the same
  //         userId). ---
  console.log("\n[5] Two concurrent beginTurn() calls for the same user are genuinely independent...\n");
  const CONCURRENT_OWNER = "user-concurrent-1";
  const controllerA = beginTurn(CONCURRENT_OWNER);
  const controllerB = beginTurn(CONCURRENT_OWNER);
  assert.notEqual(controllerA, controllerB, "beginTurn must return a distinct controller each call");
  assert.equal(controllerA.signal.aborted, false, "starting a second turn must NOT abort the first, still-genuinely-running turn");
  assert.equal(controllerB.signal.aborted, false);
  console.log("    confirmed: second beginTurn() did not touch the first controller");

  // --- [6] abortTurn() aborts BOTH controllers for that user (the correct /stop behavior --
  //         kill everything running for that user, not just one turn). ---
  console.log("\n[6] abortTurn() aborts every in-flight controller for the user...\n");
  const abortedBoth = abortTurn(CONCURRENT_OWNER);
  assert.equal(abortedBoth, true);
  assert.equal(controllerA.signal.aborted, true, "abortTurn must abort every controller tracked for this user");
  assert.equal(controllerB.signal.aborted, true);
  console.log("    confirmed: both controllers aborted by a single abortTurn() call");
  endTurn(CONCURRENT_OWNER, controllerA);
  endTurn(CONCURRENT_OWNER, controllerB);

  // --- [7] endTurn() removing one controller from a two-controller set leaves the other one
  //         still tracked and abortable (no cross-talk, no accidental clobber of the Set). ---
  console.log("\n[7] endTurn() on one of two controllers leaves the other still tracked...\n");
  const PARTIAL_OWNER = "user-partial-1";
  const controllerC = beginTurn(PARTIAL_OWNER);
  const controllerD = beginTurn(PARTIAL_OWNER);
  endTurn(PARTIAL_OWNER, controllerC);
  assert.equal(controllerC.signal.aborted, false, "endTurn must never abort the controller it removes");
  const stillTracked = abortTurn(PARTIAL_OWNER);
  assert.equal(stillTracked, true, "the remaining controller D must still be tracked and abortable after C was ended");
  assert.equal(controllerD.signal.aborted, true, "abortTurn must have aborted the still-tracked controller D");
  assert.equal(controllerC.signal.aborted, false, "the already-ended controller C must remain untouched by a later abortTurn for the same user");
  endTurn(PARTIAL_OWNER, controllerD);
  const nothingLeft = abortTurn(PARTIAL_OWNER);
  assert.equal(nothingLeft, false, "once both controllers are ended, abortTurn for that user must report false");
  console.log("    confirmed: removing one controller never disturbs the other; set is fully drained after both end");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
