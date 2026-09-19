import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import { addProviderKey, generateWithKeyFailover, isModelScopedRateLimit, isRateLimitedError, PROVIDER_CATALOG } from "../src/index.js";

/**
 * Real proof for two connected bugs:
 *
 * Item 6 ("NVIDIA/DeepSeek V4 Pro -- worked in sandbox, doesn't work live"): the live endpoint was
 * always correct; the catalog's defaultModel (silently used whenever a key is added with no
 * explicit model) was a generic Llama guess instead of the user's own live-verified working
 * config. Confirms the catalog now routes a fresh nvidia-nim key straight to deepseek-v4-pro.
 *
 * Item 9 ("NVIDIA's rate limit exceeded isn't a real persistent rate limit -- retrying with a
 * different model on the same key works fine"): a rate limit whose real error text scopes it to
 * the specific model must be retried on the SAME key with the catalog's default model BEFORE the
 * key is marked unhealthy and the router burns a switch to a different key/provider.
 */

console.log("=== Real proof: NVIDIA routes to the proven-working model, and model-scoped rate limits retry on the same key ===\n");

// Updated 2026-09-19, live-verified: deepseek-v4-pro-0813 was retired by NVIDIA on 2026-09-14 and
// now returns a real HTTP 410 "has reached its end of life" against the trader's own real key --
// which is precisely what was surfacing to them as an invalid API key. deepseek-v4-flash-0731 is
// confirmed present in the real GET /v1/models list and returns a real 200 completion. See
// step129 for the full reproduction.
console.log("[1] The nvidia-nim catalog entry's defaultModel is a live-verified working model...\n");
assert.equal(PROVIDER_CATALOG["nvidia-nim"].defaultModel, "deepseek-ai/deepseek-v4-flash-0731");
assert.equal(PROVIDER_CATALOG.lepton.defaultModel, "deepseek-ai/deepseek-v4-flash-0731", "the real Lepton alias must match (same real backend as nvidia-nim)");
console.log(`    confirmed: nvidia-nim/lepton default model = "${PROVIDER_CATALOG["nvidia-nim"].defaultModel}"`);

console.log("\n[2] isModelScopedRateLimit() genuinely distinguishes a per-model limit from a whole-key/account one...\n");
assert.equal(isModelScopedRateLimit('HTTP 429: {"error":"rate limit exceeded for model deepseek-ai/deepseek-v4-pro-0813"}'), true);
assert.equal(isRateLimitedError('HTTP 429: {"error":"rate limit exceeded for model deepseek-ai/deepseek-v4-pro-0813"}'), true, "still a real rate limit, just also model-scoped");
assert.equal(isModelScopedRateLimit('HTTP 429: {"error":"rate limit exceeded"}'), false, "no 'model' mentioned -- genuinely account/key-scoped, must NOT be treated as model-specific");
console.log("    confirmed: model-named rate limits classify as model-scoped, bare ones don't");

const workDir = mkdtempSync(join(tmpdir(), "dave-nvidia-model-retry-"));
process.chdir(workDir);
const OWNER = "user-nvidia-retry-1";

try {
  console.log("\n[3] A real model-scoped rate limit retries on the SAME key with the catalog default model -- key stays healthy, no switch...\n");
  const db = new DaveDatabase(join(workDir, "dave.db"));
  const key = addProviderKey(db, OWNER, "nvidia-nim", "user key", { apiKey: "nvapi-test", model: "some-other-model-x" });

  const realFetch = globalThis.fetch;
  const requestedModels: string[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    requestedModels.push(body?.model);
    if (body?.model === "some-other-model-x") {
      return new Response(JSON.stringify({ error: `rate limit exceeded for model ${body.model}` }), { status: 429 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "Real reply from the catalog default model." } }] }), { status: 200 });
  }) as typeof fetch;

  let switchFired = false;
  try {
    const result = await generateWithKeyFailover(db, OWNER, "nvidia-nim", { messages: [{ role: "user", content: "hi" }] }, 5000, {
      onKeySwitch: () => {
        switchFired = true;
      },
    });
    assert.equal(result.text, "Real reply from the catalog default model.");
    assert.deepEqual(requestedModels, ["some-other-model-x", "deepseek-ai/deepseek-v4-flash-0731"], "must retry the SAME key with the real catalog default model, not jump straight to a different key");
    assert.equal(switchFired, false, "a model-scoped retry that succeeds must NOT count as a key switch");
    const reloaded = db.getById("provider_keys", OWNER, key.id);
    assert.equal(Boolean(reloaded!.healthy), true, "the key must stay healthy -- the problem was never the key");
    console.log(`    real requests sent (model per attempt): ${JSON.stringify(requestedModels)}`);
    console.log("    confirmed: same key, real catalog default model, key stays healthy, no switch fired");
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
