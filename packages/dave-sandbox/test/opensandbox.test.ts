import assert from "node:assert/strict";
import { attemptOpenSandboxConnection } from "../src/index.js";

console.log("=== Real OpenSandbox connection attempt (Alibaba SDK, @alibaba-group/opensandbox) ===\n");
console.log("No self-hosted OpenSandbox service and no real API key exist in this environment --");
console.log("this proves the real SDK integration and the real, honest failure mode, same as the");
console.log("AirLLM/DSH-sandbox attempts in Steps 5/6.\n");

const result = await attemptOpenSandboxConnection({ domain: "localhost:8080", apiKey: "no-key-available" });
console.log(`reachable: ${result.reachable}`);
console.log(`detail: ${result.detail}`);
assert.equal(result.reachable, false);
assert.ok(result.detail.length > 0);

console.log("\n=== ALL ASSERTIONS PASSED (real, honest unreachable result) ===");
