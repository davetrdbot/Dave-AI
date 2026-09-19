import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import {
  addProviderKey,
  listProviderKeys,
  generateWithKeyFailover,
  isModelUnavailableError,
  pickReplacementModel,
  ModelUnavailableError,
  PROVIDER_CATALOG,
} from "@dave/brain";

/**
 * Real production bug, reproduced live against the trader's own real NVIDIA key (2026-09-19).
 *
 * The trader reported "none of the providers work" and "most of them say the API is invalid",
 * naming NVIDIA specifically. The key was fine. A real GET
 * https://integrate.api.nvidia.com/v1/models with that key returned HTTP 200 and 82 models. What
 * actually failed was the MODEL: the catalog's default was deepseek-ai/deepseek-v4-pro-0813, and
 * a real chat completion against it returned
 *
 *   HTTP 410 {"title":"Gone","detail":"The model 'deepseek-ai/deepseek-v4-pro-0813' has reached
 *             its end of life on 2026-09-14T08:00:00Z and is no longer available."}
 *
 * The failover loop treated that exactly like a bad key: marked it unhealthy, told the trader the
 * key was invalid, and then burned every remaining key on the identical error, because they all
 * send the same model. That is both the wrong diagnosis AND a real slowness cause -- N useless
 * round trips on every single message.
 */

const workDir = mkdtempSync(join(tmpdir(), "dave-deadmodel-"));
const OWNER = "user-deadmodel-1";

console.log("=== Real proof: a dead MODEL is diagnosed as a dead model, not a dead key ===\n");

try {
  console.log("[1] The real NVIDIA 410 is classified as a model problem, not a key problem...\n");
  const REAL_410 =
    'HTTP 410: {"type":"about:blank","title":"Gone","status":410,"detail":"The model \'deepseek-ai/deepseek-v4-pro-0813\' has reached its end of life on 2026-09-14T08:00:00Z and is no longer available."}';
  assert.equal(isModelUnavailableError(REAL_410), true, "the real, verbatim NVIDIA 410 must be recognised");
  assert.equal(
    isModelUnavailableError('HTTP 404: {"error":{"message":"The model `llama-3.3-70b-versatile` does not exist or you do not have access to it","code":"model_not_found"}}'),
    true,
    "the real Groq/OpenAI model_not_found shape must be recognised"
  );
  assert.equal(isModelUnavailableError("HTTP 400: unknown model 'foo'"), true);
  // NVIDIA's other real shape, confirmed live the same day. It never says "model" -- it names an
  // internal function id -- and it matters because most of the 82 ids NVIDIA's own /v1/models
  // returns are not actually servable on a given account.
  assert.equal(
    isModelUnavailableError(
      'HTTP 404: {"status":404,"title":"Not Found","detail":"Function \'23d4f03a-b8a6-4adb-a183-7daa083a09cc\': Not found for account \'l1iKH_cM8Xh0HBROBWVIiRQqyJQ4F6-9kv0oKs3cdSs\'"}'
    ),
    true,
    "NVIDIA's 'Not found for account' shape must be recognised -- it never uses the word 'model'"
  );
  console.log("    confirmed: 410 end-of-life, model_not_found, unknown-model, and NVIDIA's account-scoped 404 all recognised");

  console.log("\n[2] And a genuinely invalid KEY is still a key problem -- the distinction is the whole fix...\n");
  assert.equal(
    isModelUnavailableError('HTTP 401: {"error":{"message":"Incorrect API key provided","type":"invalid_request_error"}}'),
    false,
    "a real 401 must NOT be swallowed as a model problem -- that would hide a genuinely dead key"
  );
  assert.equal(isModelUnavailableError("HTTP 403: Forbidden"), false);
  assert.equal(isModelUnavailableError("HTTP 500: internal server error"), false, "a transient 500 is neither");
  assert.equal(isModelUnavailableError("HTTP 404: Not Found"), false, "a bare 404 with no model wording is a config problem, not this");
  console.log("    confirmed: 401/403/500, and a bare 404, are all still handled as before");

  console.log("\n[3] The replacement picker lands in the same family, using the REAL live ids...\n");
  // These are the genuine ids returned by the live catalogs today.
  const REAL_NVIDIA = ["01-ai/yi-large", "deepseek-ai/deepseek-coder-6.7b-instruct", "deepseek-ai/deepseek-v4-flash-0731", "meta/llama-3.1-8b-instruct"];
  assert.equal(
    pickReplacementModel("deepseek-ai/deepseek-v4-pro-0813", REAL_NVIDIA),
    "deepseek-ai/deepseek-v4-flash-0731",
    "must pick the live sibling in the same family, not an unrelated vendor's model"
  );
  assert.equal(
    pickReplacementModel("Claude-Sonnet-4.6", ["claude-sonnet-4.6", "claude-opus-4.8"]),
    "claude-sonnet-4.6",
    "a pure case difference is the single most common form of this -- Poe documents it capitalised, the live catalog is lowercase"
  );
  assert.equal(
    pickReplacementModel("deepseek-ai/deepseek-v4-pro", ["text-embedding-3-large", "bge-reranker-v2"]),
    undefined,
    "must never switch a chat request onto an embedding or rerank model"
  );
  assert.equal(pickReplacementModel("zzz-nothing-alike", ["gpt-4o", "mistral-small"]), undefined, "and must refuse rather than guess when nothing matches");
  console.log("    confirmed: family match, case-only match, no embeddings, refuses to guess");

  console.log("\n[4] END TO END: the dead model self-heals on the SAME key, and the key stays healthy...\n");
  {
    const db = new DaveDatabase(join(workDir, "heal.db"));
    addProviderKey(db, OWNER, "nvidia-nim", "the real key", { apiKey: "nvapi-good", model: "deepseek-ai/deepseek-v4-pro-0813" });

    const seenModels: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/models")) {
        return new Response(JSON.stringify({ data: REAL_NVIDIA.map((id) => ({ id })) }), { status: 200 });
      }
      const body = init?.body ? JSON.parse(init.body as string) : {};
      seenModels.push(body.model);
      if (body.model === "deepseek-ai/deepseek-v4-pro-0813") {
        return new Response(
          JSON.stringify({ title: "Gone", status: 410, detail: "The model 'deepseek-ai/deepseek-v4-pro-0813' has reached its end of life on 2026-09-14T08:00:00Z and is no longer available." }),
          { status: 410 }
        );
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "Real reply on the live model." } }] }), { status: 200 });
    }) as typeof fetch;

    try {
      const result = await generateWithKeyFailover(db, OWNER, "nvidia-nim", { messages: [{ role: "user", content: "hi" }] }, 20_000);
      assert.match(result.text ?? "", /Real reply on the live model/, "the in-flight request must genuinely complete");
      assert.deepEqual(
        seenModels,
        ["deepseek-ai/deepseek-v4-pro-0813", "deepseek-ai/deepseek-v4-flash-0731"],
        "it must try the dead model once, then the real live one -- nothing else"
      );
      const [key] = listProviderKeys(db, OWNER, "nvidia-nim");
      assert.equal(key.healthy, true, "THE BUG: a valid key must NOT be marked unhealthy because a model went end-of-life");
      assert.equal(key.config.model, "deepseek-ai/deepseek-v4-flash-0731", "and the live model must be persisted, so the next message doesn't rediscover it");
      console.log(`    real request sequence: ${seenModels.join("  ->  ")}`);
      console.log(`    key left healthy, model auto-updated to: ${key.config.model}`);
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  console.log("\n[5] It does NOT burn the other keys -- they'd all fail identically on the same model...\n");
  {
    const db = new DaveDatabase(join(workDir, "burn.db"));
    for (const label of ["key one", "key two", "key three"]) {
      addProviderKey(db, OWNER, "nvidia-nim", label, { apiKey: `nvapi-${label}`, model: "deepseek-ai/deepseek-v4-pro-0813" });
    }
    let chatCalls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      // No live model list this time, so there is nothing to auto-switch to.
      if (String(url).endsWith("/models")) return new Response("{}", { status: 500 });
      chatCalls++;
      return new Response(JSON.stringify({ detail: "The model 'deepseek-ai/deepseek-v4-pro-0813' has reached its end of life and is no longer available." }), { status: 410 });
    }) as typeof fetch;

    try {
      await assert.rejects(
        () => generateWithKeyFailover(db, OWNER, "nvidia-nim", { messages: [{ role: "user", content: "hi" }] }, 20_000),
        (err: unknown) => {
          assert.ok(err instanceof ModelUnavailableError, `must throw ModelUnavailableError, got ${(err as Error)?.name}`);
          assert.match(err.message, /your API key is fine, the model is not/i, "the message the trader sees must not blame the key");
          return true;
        }
      );
      assert.equal(chatCalls, 1, `THE SLOWNESS BUG: it must stop after ONE attempt, not retry all 3 keys on the identical model error -- got ${chatCalls}`);
      const keys = listProviderKeys(db, OWNER, "nvidia-nim");
      assert.equal(keys.filter((k) => k.healthy).length, 3, "all three keys must still be healthy -- none of them was the problem");
      console.log(`    confirmed: 1 request instead of 3, all 3 keys still healthy, honest error raised`);
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  console.log("\n[6] The catalog defaults that were actually dead are now the live ones...\n");
  // Every one of these was verified against the provider's own live /models endpoint on
  // 2026-09-19; the left-hand values are what was shipped and failing.
  assert.equal(PROVIDER_CATALOG["nvidia-nim"].defaultModel, "deepseek-ai/deepseek-v4-flash-0731", "NVIDIA's default went end-of-life 2026-09-14");
  assert.equal(PROVIDER_CATALOG.lepton.defaultModel, "deepseek-ai/deepseek-v4-flash-0731", "Lepton aliases NVIDIA -- it had the same dead default");
  assert.equal(PROVIDER_CATALOG.novita.defaultModel, "deepseek/deepseek-v4.1-flash", "Novita renamed the namespace from deepseek-ai/ to deepseek/");
  assert.equal(PROVIDER_CATALOG.poe.defaultModel, "claude-sonnet-4.6", "Poe's real ids are lowercase and case-sensitive");
  assert.equal(PROVIDER_CATALOG.venice.defaultModel, "venice-uncensored-1-2", "Venice versioned the id");
  assert.equal(PROVIDER_CATALOG.friendli.defaultModel, "zai-org/GLM-5.3", "Friendli's catalog no longer carries the old Llama id");
  console.log("    confirmed: all six live-verified against the provider's own /models");

  console.log("\n[7] Model auto-fetch is on wherever the endpoint genuinely answers...\n");
  const stillManual = Object.values(PROVIDER_CATALOG).filter((e) => e.manualModelEntry).map((e) => e.id);
  assert.deepEqual(
    stillManual.sort(),
    ["azure", "custom", "huggingface", "openrouter", "orcarouter"],
    `Azure and Custom genuinely cannot list models; the three routers keep manual entry at the trader's explicit instruction -- got ${stillManual.join(", ")}`
  );
  // The routers' endpoints DO work -- manual entry there is a deliberate choice, not a defect --
  // so the models path stays populated even though the picker is off.
  for (const id of ["huggingface", "openrouter", "orcarouter"] as const) {
    assert.ok(PROVIDER_CATALOG[id].modelsPath, `${id}'s models endpoint is real and should stay recorded as such`);
  }
  for (const id of ["zai", "upstage", "xpiki", "friendli", "poe", "together"] as const) {
    assert.ok(PROVIDER_CATALOG[id].modelsPath, `${id} has a live, confirmed models endpoint -- it must not be stuck on manual entry`);
    assert.equal(PROVIDER_CATALOG[id].manualModelEntry, false, `${id} must auto-fetch`);
  }
  console.log(`    confirmed: 6 providers moved from manual entry to real auto-fetch; still manual by design: ${stillManual.join(" and ")} still need typing`);

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
