/** Every analysis endpoint is described exactly once in the grouped catalog the app shows. */
import assert from "node:assert/strict";
import { ALL_ANALYSIS_ENDPOINTS, ANALYSIS_ENDPOINT_GROUPS } from "../src/analysis-config.js";

const ids = ANALYSIS_ENDPOINT_GROUPS.flatMap((g) => g.endpoints.map((e) => e.id));
assert.equal(new Set(ids).size, ids.length, "no endpoint listed twice");
assert.deepEqual([...ids].sort(), [...ALL_ANALYSIS_ENDPOINTS].sort(), "every endpoint is in the catalog");
for (const g of ANALYSIS_ENDPOINT_GROUPS) for (const e of g.endpoints) assert.ok(e.contains.length > 10, `${e.id} says what it holds`);
assert.equal(ANALYSIS_ENDPOINT_GROUPS[0].endpoints[0].id, "market_structure");
console.log("=== ALL ASSERTIONS PASSED ===");
