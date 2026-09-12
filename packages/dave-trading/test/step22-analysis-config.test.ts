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
  toggleTimeframe,
  toggleEndpoint,
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

  // Real gap fixed (user, live: "didn't I tell you to make the endpoints and timeframes in the
  // analysis scope UI" -- a typed-reply capture is not a real tappable UI). These prove the real
  // per-item toggle a Telegram button now drives.
  console.log("\n[7] Tapping a single timeframe toggle button genuinely narrows by exactly one, from the real full default, not from empty...\n");
  const afterReset = resetAnalysisConfigToAll(USER);
  assert.equal(afterReset.mode, "all");
  const toggledOff = toggleTimeframe(USER, "m3");
  assert.equal(toggledOff.mode, "custom");
  assert.deepEqual(toggledOff.timeframes.sort(), ALL_ANALYSIS_TIMEFRAMES.filter((t) => t !== "M3").sort(), "toggling one off from ALL must narrow by exactly one, not wipe the rest");
  console.log(`    confirmed: toggled M3 off from ALL -- ${toggledOff.timeframes.length} of ${ALL_ANALYSIS_TIMEFRAMES.length} remain`);

  console.log("\n[8] Tapping the same timeframe again genuinely toggles it back on...\n");
  const toggledBackOn = toggleTimeframe(USER, "M3");
  assert.ok(toggledBackOn.timeframes.includes("M3"), "toggling the same timeframe again must add it back");
  console.log("    confirmed: M3 toggled back on");

  console.log("\n[9] Toggling down to the last remaining timeframe is refused -- the scope can never go empty...\n");
  resetAnalysisConfigToAll(USER);
  let onlyOneLeft = getAnalysisConfig(USER);
  for (const tf of ALL_ANALYSIS_TIMEFRAMES.slice(1)) onlyOneLeft = toggleTimeframe(USER, tf);
  assert.equal(onlyOneLeft.timeframes.length, 1, "all but one should now be toggled off");
  const refused = toggleTimeframe(USER, onlyOneLeft.timeframes[0]);
  assert.equal(refused.timeframes.length, 1, "toggling off the LAST remaining timeframe must be refused, never leaving an empty scope");
  console.log(`    confirmed: the last remaining timeframe (${refused.timeframes[0]}) cannot be toggled off`);

  console.log("\n[10] The same real toggle behavior applies to endpoints...\n");
  resetAnalysisConfigToAll(USER);
  const epToggledOff = toggleEndpoint(USER, "TREND");
  assert.equal(epToggledOff.mode, "custom");
  assert.ok(!epToggledOff.endpoints.includes("trend"), "toggling trend off must genuinely remove it");
  assert.equal(epToggledOff.endpoints.length, ALL_ANALYSIS_ENDPOINTS.length - 1, "must narrow by exactly one endpoint, not wipe the rest");
  const epToggledBackOn = toggleEndpoint(USER, "trend");
  assert.ok(epToggledBackOn.endpoints.includes("trend"), "toggling the same endpoint again must add it back");
  console.log(`    confirmed: endpoint toggle narrows/restores by exactly one, same real behavior as timeframes`);

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
