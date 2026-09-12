import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getAnalysisConfig,
  setCustomTimeframes,
  setCustomEndpoints,
  resetAnalysisConfigToAll,
  filterSuiteToConfig,
  ALL_ANALYSIS_TIMEFRAMES,
  ALL_ANALYSIS_ENDPOINTS,
} from "../src/analysis-config.js";

/**
 * Real feature (user, live: "add a feature in the settings that the user can configure the get
 * all analysis so they will select among endpoints... and the timeframe, and a default button to
 * send all"). Proves: default is genuinely "all" (matches today's real behavior, nothing narrowed
 * until the user deliberately does so), a custom subset is honored, filterSuiteToConfig is a
 * real no-op in "all" mode, and "Send All" genuinely resets back.
 */

console.log("=== Real proof: user-configurable analysis scope (endpoints + timeframes) ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-analysis-config-"));
process.chdir(workDir);
const USER = "user-analysis-config-1";

try {
  console.log("[1] A fresh user's config is genuinely 'all' -- every real timeframe and endpoint, matching today's default behavior...\n");
  const initial = getAnalysisConfig(USER);
  assert.equal(initial.mode, "all");
  assert.deepEqual(initial.timeframes, [...ALL_ANALYSIS_TIMEFRAMES]);
  assert.deepEqual(initial.endpoints, [...ALL_ANALYSIS_ENDPOINTS]);
  console.log(`    confirmed: default mode=all, ${initial.timeframes.length} timeframes, ${initial.endpoints.length} endpoints`);

  console.log("\n[2] filterSuiteToConfig is a genuine no-op in 'all' mode -- nothing narrowed by default...\n");
  const rawSuite = { trend: { bias: "BULL" }, momentum: { rsi: 61 }, ichimoku: { cloudPosition: "above" } };
  assert.deepEqual(filterSuiteToConfig(rawSuite, initial), rawSuite);
  console.log("    confirmed: full suite passes through unchanged when mode=all");

  console.log("\n[3] A real custom timeframe subset is genuinely honored, switching mode to custom...\n");
  const tfResult = setCustomTimeframes(USER, ["m1", "h1"]);
  assert.equal(tfResult.mode, "custom");
  assert.deepEqual(tfResult.timeframes, ["M1", "H1"]);
  console.log(`    confirmed: custom timeframes = ${tfResult.timeframes.join(", ")}`);

  console.log("\n[4] A real custom endpoint subset genuinely narrows what filterSuiteToConfig keeps...\n");
  const epResult = setCustomEndpoints(USER, ["trend", "ichimoku"]);
  assert.deepEqual(epResult.endpoints, ["trend", "ichimoku"]);
  const filtered = filterSuiteToConfig(rawSuite, epResult);
  assert.deepEqual(filtered, { trend: { bias: "BULL" }, ichimoku: { cloudPosition: "above" } });
  assert.ok(!("momentum" in filtered), "an unselected endpoint must genuinely be dropped");
  console.log(`    confirmed: filtered suite keeps only ${Object.keys(filtered).join(", ")}`);

  console.log("\n[5] An invalid entry is silently dropped, never crashes, and falls back to the prior list if everything was invalid...\n");
  const invalidResult = setCustomTimeframes(USER, ["not-a-real-timeframe"]);
  assert.deepEqual(invalidResult.timeframes, ["M1", "H1"], "an all-invalid entry must keep the prior real list, not empty it out");
  console.log("    confirmed: garbage input never empties the real list");

  console.log("\n[6] 'Send All' (the settings reset button) genuinely restores the full default...\n");
  const reset = resetAnalysisConfigToAll(USER);
  assert.equal(reset.mode, "all");
  assert.deepEqual(reset.endpoints, [...ALL_ANALYSIS_ENDPOINTS]);
  console.log("    confirmed: reset restores every real endpoint and timeframe");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
