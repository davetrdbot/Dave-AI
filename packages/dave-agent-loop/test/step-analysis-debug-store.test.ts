import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordAnalysisFetch, getRecentAnalysisFetches, MAX_ANALYSIS_DEBUG_ENTRIES, type AnalysisDebugEntry } from "../src/analysis-debug-store.js";

/**
 * Real proof for the user-visible half of "confirm get_all_analysis genuinely fetches the full
 * suite": recordAnalysisFetch/getRecentAnalysisFetches genuinely round-trip real data through a
 * real file on disk (DAVE_DATA_ROOT-rooted, same pattern as busy-state.ts/self-pause.ts) without
 * truncation or mutation, and the rolling cap at MAX_ANALYSIS_DEBUG_ENTRIES genuinely drops the
 * oldest entry once a 6th is recorded, most-recent-first on read.
 */

console.log("=== Real proof: analysis-debug-store round-trips and caps correctly ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-analysis-debug-"));
process.env.DAVE_DATA_ROOT = workDir;
const USER = "user-analysis-debug-1";

try {
  console.log("[1] Empty store is honest before anything is recorded...");
  assert.deepEqual(getRecentAnalysisFetches(USER), []);

  console.log("\n[2] A real entry, with a real nested rawSuite (44-key-shaped), round-trips without truncation or mutation...");
  const bigEndpointKeys = Array.from({ length: 44 }, (_, i) => `endpoint_${i}`);
  const rawSuite = {
    M1: Object.fromEntries(bigEndpointKeys.map((k) => [k, { value: Math.random(), nested: { a: 1, b: [1, 2, 3] } }])),
    H1: Object.fromEntries(bigEndpointKeys.map((k) => [k, { value: Math.random(), nested: { a: 2, b: [4, 5, 6] } }])),
  };
  const entry: AnalysisDebugEntry = {
    symbol: "EURUSD",
    timeframesRequested: ["M1", "M5", "H1", "H4"],
    timeframesReceived: ["M1", "H1"], // M5/H4 genuinely failed this cycle -- a real mismatch
    endpointKeysPerTimeframe: { M1: bigEndpointKeys, H1: bigEndpointKeys },
    totalPayloadBytes: Buffer.byteLength(JSON.stringify(rawSuite), "utf8"),
    fetchedAt: Date.now(),
    rawSuite,
  };
  recordAnalysisFetch(USER, entry);
  const [readBack] = getRecentAnalysisFetches(USER);
  assert.deepEqual(readBack, entry, "the real recorded entry must round-trip byte-for-byte, no truncation or mutation");
  assert.equal(readBack.timeframesRequested.length, 4);
  assert.equal(readBack.timeframesReceived.length, 2);
  assert.deepEqual((readBack.rawSuite as typeof rawSuite).M1, rawSuite.M1, "rawSuite's real nested content must survive untouched");
  console.log(`    real round-tripped entry: symbol=${readBack.symbol}, requested=${readBack.timeframesRequested.join(",")}, received=${readBack.timeframesReceived.join(",")}`);

  console.log("\n[3] Recording a 6th entry genuinely drops the oldest, keeping only the real last 5, most-recent-first...");
  for (let i = 0; i < 5; i++) {
    recordAnalysisFetch(USER, {
      symbol: `SYM${i}`,
      timeframesRequested: ["M1"],
      timeframesReceived: ["M1"],
      endpointKeysPerTimeframe: { M1: ["trend"] },
      totalPayloadBytes: 10,
      fetchedAt: Date.now() + i,
      rawSuite: { M1: { trend: i } },
    });
  }
  const all = getRecentAnalysisFetches(USER);
  console.log(`    real symbols after 6 total recordings, most-recent-first: ${all.map((e) => e.symbol).join(", ")}`);
  assert.equal(all.length, MAX_ANALYSIS_DEBUG_ENTRIES, "must be capped at the real rolling limit");
  assert.equal(all[0].symbol, "SYM4", "most recent entry must be first");
  assert.equal(all.at(-1)!.symbol, "SYM0", "the oldest surviving entry after the drop");
  assert.ok(!all.some((e) => e.symbol === "EURUSD"), "the original EURUSD entry (now the 1st of 6) must genuinely have been dropped as the oldest");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  delete process.env.DAVE_DATA_ROOT;
  rmSync(workDir, { recursive: true, force: true });
}
