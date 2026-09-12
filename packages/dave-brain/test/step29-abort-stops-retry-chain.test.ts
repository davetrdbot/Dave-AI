import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import { addProviderKey, generateWithKeyFailover } from "../src/index.js";

/**
 * Real bug fixed (user, live: "/stop" cancelled one in-flight call, but the bot kept "thinking"
 * regardless -- root-caused to this exact file). An external abort mid-call used to be caught by
 * generateWithKeyFailover's per-key retry loop and treated identically to "this key just failed" --
 * so it dutifully moved on to try the NEXT key with a brand-new network call instead of genuinely
 * stopping. With several configured keys/providers, an abort could get silently swallowed and
 * retried through the ENTIRE chain before ever actually stopping. Proves the real fix: an already-
 * aborted signal makes the loop stop immediately, never touching the next key.
 */

console.log("=== Real proof: an external abort stops the key/provider retry chain instead of being swallowed and retried ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-abort-retry-chain-"));
process.chdir(workDir);
const OWNER = "user-abort-chain-1";

try {
  const db = new DaveDatabase(join(workDir, "dave.db"));
  addProviderKey(db, OWNER, "deepseek", "first key", { apiKey: "key-1" });
  addProviderKey(db, OWNER, "deepseek", "second key", { apiKey: "key-2" });

  const realFetch = globalThis.fetch;
  let requestCount = 0;
  const keysHit: string[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    requestCount++;
    keysHit.push((init?.headers as Record<string, string>)?.authorization ?? "");
    // Simulates a genuinely hung upstream call -- only resolves (rejects) on a real abort,
    // exactly like Node's real fetch does when its signal fires.
    return await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  }) as typeof fetch;

  try {
    const controller = new AbortController();
    const runPromise = generateWithKeyFailover(db, OWNER, "deepseek", { messages: [{ role: "user", content: "hi" }] }, 60_000, {}, controller.signal);
    await new Promise((r) => setTimeout(r, 100));
    controller.abort();

    let threw = false;
    try {
      await runPromise;
    } catch (err) {
      threw = true;
      assert.ok(err instanceof Error, "a genuine abort must surface as a real rejection, not silently resolve");
    }
    assert.equal(threw, true, "the abort must genuinely propagate out, not be swallowed by the retry loop");
    assert.equal(requestCount, 1, "must have made exactly ONE real request -- the abort must stop the chain, never reach the second key");
    console.log(`    real requests made before genuinely stopping: ${requestCount} (second key never touched)`);
    console.log("    confirmed: an external abort stops the whole retry chain instead of being retried through it");
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
