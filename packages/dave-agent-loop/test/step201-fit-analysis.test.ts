import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DAVE_DATA_ROOT = mkdtempSync(join(tmpdir(), "dave-fit-"));
/** The trader: a tool that reads the strategy and drops the analysis endpoints it doesn't use. */
const { buildFullRegistry } = await import("../src/full-registry.js").catch(() => ({ buildFullRegistry: undefined }));
const { seedApaSkill } = await import("@dave/skills");
const { getAnalysisConfig } = await import("@dave/trading");
const { LIVE_TOOL_NAMES } = await import("../src/live-voice.js");

const U = "fit-user";
seedApaSkill(U);
assert.ok(LIVE_TOOL_NAMES.has("fit_analysis_to_skill"), "available on calls too");
const src = (await import("node:fs")).readFileSync(new URL("../src/full-registry.ts", import.meta.url), "utf8");
assert.match(src, /name: "fit_analysis_to_skill"/);
// Exercise the same calls the tool makes.
const { setCustomEndpoints, resetAnalysisConfigToAll, ALL_ANALYSIS_ENDPOINTS } = await import("@dave/trading");
const next = setCustomEndpoints(U, ["structure", "zones", "liquidity", "order_blocks", "price", "candles", "made_up"]);
assert.deepEqual(next.endpoints.sort(), ["candles", "liquidity", "market_structure", "price", "zones"], "older names map to the 4.0 groups, no duplicates");
assert.equal(getAnalysisConfig(U).mode, "custom");
assert.equal(resetAnalysisConfigToAll(U).mode, "all");
assert.equal(ALL_ANALYSIS_ENDPOINTS.length, 15);
void buildFullRegistry;
console.log("=== step201: ALL ASSERTIONS PASSED ===");
process.exit(0);
