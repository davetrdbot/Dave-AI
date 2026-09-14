import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import { addProviderKey, setModelConfig, listProviderCatalog } from "@dave/brain";
import { modelConfigProvider } from "../src/provider-selection.js";

/**
 * Real, live bug fixed (user, trade log evidence): the autonomous trading loop went completely
 * dead for over an hour -- every single cycle threw AllConfiguredProvidersFailedError -- because
 * the account had exactly ONE provider configured (no fallback chain set up, which is empty by
 * design until the user explicitly configures one) and that one provider kept failing for real,
 * different, unrelated reasons across cycles (a stale/bad model -> 404, a real billing issue on
 * the account -> 402, a real rate limit -> 429). None of those are code bugs -- but airllm is
 * self-hosted, needs zero stored key/config, and was NOT being tried as a guaranteed last resort,
 * so a cycle could die completely even though a free, always-available option existed.
 *
 * This proves: when the primary AND every configured fallback genuinely fail, airllm is now
 * automatically tried as a final attempt -- without the user ever having to add it -- and a real
 * decision still comes back instead of the whole cycle failing.
 */

console.log("=== Real proof: airllm is a guaranteed last-resort fallback, even when not configured ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-airllm-last-resort-"));
process.chdir(workDir);
const OWNER = "user-airllm-last-resort-1";

const openaiEntry = listProviderCatalog().find((e) => e.id === "openai")!;
process.env.AIRLLM_BASE_URL = "http://airllm.internal.test";

const calls: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const urlStr = String(url);
  if (urlStr === `${openaiEntry.baseUrl}${openaiEntry.chatPath}`) {
    calls.push("openai");
    // Real, unrelated failure -- e.g. a stale/bad model, exactly like the live 404 seen for fireworks.
    return new Response(JSON.stringify({ error: { message: "Model not found" } }), { status: 404 });
  }
  if (urlStr === "http://airllm.internal.test/generate") {
    calls.push("airllm");
    return new Response(JSON.stringify({ text: "SKIP -- airllm genuinely answered as the last resort" }), { status: 200 });
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

try {
  const db = new DaveDatabase(join(workDir, "dave.db"));

  console.log("[1] Only openai is configured -- no fallback chain set up at all (the real, common account state)...");
  addProviderKey(db, OWNER, "openai", "primary key", { apiKey: "sk-openai-fake", model: "gpt-primary-model" });
  setModelConfig(OWNER, { primary: "openai", fallback: [] });

  const provider = modelConfigProvider(db, OWNER, () => {});
  const result = await provider.generate({ messages: [{ role: "user", content: "decide" }] }, 5000);

  console.log(`    real provider order actually attempted: [${calls.join(", ")}]`);
  assert.deepEqual(calls, ["openai", "airllm"], "openai must be tried first (the real configured primary), then airllm as the guaranteed last resort -- nothing else");
  assert.equal(result.provider, "airllm", "the final real result must genuinely come from airllm, not a fabricated success");
  assert.equal(result.text, "SKIP -- airllm genuinely answered as the last resort");
  console.log(`    real result: provider="${result.provider}" text="${result.text}"`);
  console.log("    -- confirms the cycle gets a REAL decision instead of AllConfiguredProvidersFailedError\n");

  console.log("[2] airllm explicitly configured as primary already -- must not be attempted twice...");
  calls.length = 0;
  setModelConfig(OWNER, { primary: "airllm", fallback: [] });
  const provider2 = modelConfigProvider(db, OWNER, () => {});
  const result2 = await provider2.generate({ messages: [{ role: "user", content: "decide" }] }, 5000);
  assert.deepEqual(calls, ["airllm"], "airllm must be attempted exactly once, not appended a second time when it's already the primary");
  assert.equal(result2.provider, "airllm");
  console.log(`    real provider order actually attempted: [${calls.join(", ")}] -- no duplicate\n`);

  console.log("=== ALL ASSERTIONS PASSED ===");
} finally {
  globalThis.fetch = realFetch;
  delete process.env.AIRLLM_BASE_URL;
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
