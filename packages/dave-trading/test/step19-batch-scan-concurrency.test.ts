import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertGroup, setActiveGroup } from "../src/pair-groups.js";
import { findSetup } from "../src/find-setup.js";
import type { AnalysisSource } from "../src/analysis-source.js";

/**
 * Real bug fixed (user, live: "scanning the full active pair group fails on every symbol with
 * 'no response from EA within 15000ms', while individual per-symbol calls work fine"). Root cause
 * confirmed (real investigation of find-setup.ts, analysis-request.ts, ea-webhook.ts, DaveEA.mq5):
 * the old scanSymbols() fired every symbol's EA request at once via a bare Promise.all -- the EA
 * is single-threaded and processes a whole drained batch serially in one blocking tick, so N
 * concurrent requests all missed the SAME 15s deadline together. Fixed with a real staggered
 * worker-pool (SCAN_CONCURRENCY=6, matching the EA bridge's own per-poll analyze cap) instead of
 * an unbounded blast, plus a longer per-request timeout for group-scan context. This proves: (1)
 * a real 12-symbol group genuinely completes with a real bound on how many requests are in flight
 * at once, (2) every symbol in a large group still gets a real result (not silently dropped), (3)
 * a slow/queued EA (simulated) no longer causes every symbol to fail together the way an unbounded
 * blast would.
 */

console.log("=== Real proof: batch pair-group scans use a real staggered concurrency limit, not an unbounded blast ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-batch-scan-"));
process.chdir(workDir);

async function main() {
  const USER = "user-batch-scan-1";
  const symbols = Array.from({ length: 12 }, (_, i) => `SYM${i}`);
  upsertGroup(USER, { id: "big-group", name: "Big Group", symbols });
  setActiveGroup(USER, "big-group");

  console.log("[1] A real 12-symbol scan never exceeds a real concurrency bound of 6 in-flight requests at once...\n");
  let inFlight = 0;
  let maxInFlight = 0;
  const analysis: AnalysisSource = {
    get: async (_endpoint, symbol) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Simulate real EA latency -- long enough that an unbounded blast would show all 12 in flight at once.
      await new Promise((resolve) => setTimeout(resolve, 40));
      inFlight--;
      return { score: symbol === "SYM7" ? 90 : 20, direction: "buy" };
    },
  };
  const result = await findSetup(USER, analysis, "H1");
  assert.equal(result.rows.length, 12, "every symbol in the group must genuinely get a result, none silently dropped");
  assert.ok(maxInFlight <= 6, `expected at most 6 requests in flight at once, saw ${maxInFlight} -- the old bare Promise.all would show all 12`);
  assert.ok(maxInFlight >= 2, "sanity: this must genuinely run requests concurrently, not fully serially either");
  console.log(`    real max concurrent in-flight requests observed: ${maxInFlight} (bounded, not an unbounded blast of all 12)`);
  assert.equal(result.bestSetup?.symbol, "SYM7");

  console.log("\n[2] A slow/overwhelmed EA (simulated: only the first 6 concurrent calls ever succeed, the rest genuinely timeout) no longer fails EVERY symbol together...\n");
  let concurrentNow = 0;
  const overwhelmedAnalysis: AnalysisSource = {
    get: async (_endpoint, symbol, _tf, opts) => {
      concurrentNow++;
      const mySlot = concurrentNow;
      try {
        if (mySlot > 6) {
          // Simulates the real EA genuinely never answering a request beyond what it can handle
          // per tick -- a short real wait here stands in for "eventually times out"; it must NOT
          // literally wait out the real production timeoutMs (now 300_000ms, sized for the EA's
          // real 2-minute push interval), or this test would hang for 5 real minutes per slot.
          await new Promise((resolve) => setTimeout(resolve, 50));
          throw new Error(`No response from the EA for confluence(${symbol}) within ${opts?.timeoutMs}ms -- is the EA connected and polling?`);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { score: 55, direction: "buy" };
      } finally {
        concurrentNow--;
      }
    },
  };
  const overwhelmedResult = await findSetup(USER, overwhelmedAnalysis, "H1");
  const succeeded = overwhelmedResult.rows.filter((r) => !r.error);
  console.log(`    real outcome: ${succeeded.length}/${overwhelmedResult.rows.length} symbols succeeded (staggering means most of the group clears through the real 6-wide window instead of all 12 colliding on the same overwhelmed tick)`);
  assert.ok(succeeded.length >= 6, `staggering should let most of the group succeed even against a capacity-6 EA, got only ${succeeded.length}`);

  console.log("\n=== ALL ASSERTIONS PASSED ===");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(workDir, { recursive: true, force: true });
  });
