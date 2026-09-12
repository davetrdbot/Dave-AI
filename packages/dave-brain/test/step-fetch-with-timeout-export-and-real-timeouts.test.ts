import assert from "node:assert/strict";
import * as http from "node:http";
import { fetchWithTimeout } from "../src/index.js";
import { LocalAirLLMProcessManager } from "../src/railway-model-loader.js";
import { fetchAvailableModels } from "../src/model-fetch.js";
import { PROVIDER_CATALOG } from "../src/provider-catalog.js";

/**
 * Real proof for the audit gap: railway-model-loader.ts and model-fetch.ts used to make raw,
 * un-abortable `fetch()` calls with no timeout of their own. Both now go through the shared
 * `fetchWithTimeout` helper (now exported from the package's public surface instead of staying
 * private to providers.ts), and both genuinely time out against a real server that hangs and
 * never responds -- not a faked/resolved promise.
 */

console.log("=== Real proof: fetchWithTimeout is exported, and both fixed call sites genuinely time out ===\n");

console.log("[1] fetchWithTimeout is genuinely importable from the package's public surface (index.ts)...\n");
assert.equal(typeof fetchWithTimeout, "function");
console.log("    confirmed: fetchWithTimeout is a function, exported via ../src/index.js\n");

/** A real server that accepts the connection but never calls res.end() -- the only honest way
 * to prove a timeout actually fires, rather than mocking a promise that resolves on its own. */
function startHangingServer(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, _res) => {
      // Deliberately never respond -- res.end() is never called.
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

async function main() {
  console.log("[2] LocalAirLLMProcessManager.waitForHealth() times out against a real hanging /health server...\n");
  {
    const { server, port } = await startHangingServer();
    try {
      const mgr = new LocalAirLLMProcessManager(process.cwd(), port);
      const start = Date.now();
      // waitForHealth's own outer deadline is set deliberately far shorter than the 5s
      // per-request health-check timeout inside railway-model-loader.ts, and the poll loop only
      // re-checks its deadline BETWEEN iterations -- so the one in-flight fetch this triggers
      // must itself abort on its own for waitForHealth to ever return at all. Before this fix,
      // a raw `fetch()` here had no timeout of its own and would never settle against a server
      // that never responds -- this call would hang indefinitely (well past 5s), not return in
      // ~5s the way it does now.
      const result = await mgr.waitForHealth(100);
      const elapsed = Date.now() - start;
      assert.equal(result.healthy, false, "a server that never responds must never report healthy");
      assert.ok(elapsed < 6000, `the per-request fetch must abort at ~its own 5s timeout, not hang forever (took ${elapsed}ms)`);
      console.log(`    confirmed: waitForHealth() returned {healthy:false} in ${elapsed}ms against a server that never responds\n`);
    } finally {
      server.close();
    }
  }

  console.log("[3] fetchAvailableModels() times out against a real hanging /models-shaped server...\n");
  {
    const { server, port } = await startHangingServer();
    try {
      // Pick any real catalog entry with a real modelsPath and no manual-entry override, so the
      // raw-fetch path this test targets is genuinely exercised.
      const providerName = Object.keys(PROVIDER_CATALOG).find((k) => {
        const e = (PROVIDER_CATALOG as Record<string, { manualModelEntry?: boolean; modelsPath?: string }>)[k];
        return !e.manualModelEntry && !!e.modelsPath;
      });
      assert.ok(providerName, "expected at least one real catalog entry with an auto-fetchable models endpoint");

      const start = Date.now();
      const result = await fetchAvailableModels(
        providerName as never,
        { apiKey: "test-key", baseUrlOverride: `http://127.0.0.1:${port}` },
        500,
      );
      const elapsed = Date.now() - start;
      assert.equal(result.manualEntryRequired, false);
      assert.ok(result.error, "a hung connection must surface as the same kind of failure a dead connection already produces (an error string), not hang or throw uncaught");
      assert.ok(elapsed < 2000, `fetchAvailableModels must time out near its own timeoutMs bound, not hang forever (took ${elapsed}ms)`);
      console.log(`    confirmed: fetchAvailableModels() returned error="${result.error}" in ${elapsed}ms against a server that never responds\n`);
    } finally {
      server.close();
    }
  }

  console.log("=== All fetchWithTimeout export/timeout assertions passed ===");
}

main().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
