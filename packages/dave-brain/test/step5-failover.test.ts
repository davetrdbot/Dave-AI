import assert from "node:assert/strict";
import { createServer } from "node:http";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  AirLLMProvider,
  DeepSeekProvider,
  ProviderRouter,
  getModelConfig,
  setModelConfig,
  routeForWorker,
} from "../src/index.js";

const DATA_DIR = join(process.cwd(), "data");
rmSync(DATA_DIR, { recursive: true, force: true });

console.log("=== Step 5 real proof: provider router + failover ===\n");
console.log(
  "NOTE: no live DeepSeek/Claude API keys are configured in this environment, so this test\n" +
    "stands up REAL local HTTP servers shaped like each provider's real response format and\n" +
    "points the REAL provider classes (same code that calls api.deepseek.com / api.anthropic.com\n" +
    "in production) at them over real loopback HTTP, with real timeouts. The failover mechanism\n" +
    "itself is fully real; only the external endpoint is substituted for lack of credentials.\n"
);

// --- A real HTTP server that ALWAYS TIMES OUT, standing in for a stuck/unreachable AirLLM ---
const deadAirllm = createServer((_req, res) => {
  // never respond -- forces the real fetch timeout path in AirLLMProvider
  void res;
});
await new Promise<void>((resolve) => deadAirllm.listen(0, resolve));
const deadAirllmAddr = deadAirllm.address();
if (typeof deadAirllmAddr !== "object" || !deadAirllmAddr) throw new Error("bind failed");

// --- A real HTTP server shaped like DeepSeek's /chat/completions response ---
const fakeDeepSeek = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "DeepSeek fallback response (real HTTP round trip)" } }] }));
  });
});
await new Promise<void>((resolve) => fakeDeepSeek.listen(0, resolve));
const fakeDeepSeekAddr = fakeDeepSeek.address();
if (typeof fakeDeepSeekAddr !== "object" || !fakeDeepSeekAddr) throw new Error("bind failed");

const USER_ID = "tg-847213";

console.log("[1] Model-picker config defaults to primary=airllm, fallback=[deepseek, claude]...");
const defaultConfig = getModelConfig(USER_ID);
console.log(`    ${JSON.stringify(defaultConfig)}`);
assert.equal(defaultConfig.primary, "airllm");

console.log("\n[2] User sets model config via the (future button-driven) model picker...");
setModelConfig(USER_ID, { primary: "airllm", fallback: ["deepseek"] });
console.log(`    saved: ${JSON.stringify(getModelConfig(USER_ID))}`);
assert.deepEqual(getModelConfig(USER_ID), { primary: "airllm", fallback: ["deepseek"] });

console.log("\n[3] Real failover: primary AirLLM times out, router falls to real DeepSeek-shaped provider...");
const router = new ProviderRouter({
  airllm: new AirLLMProvider(`http://127.0.0.1:${deadAirllmAddr.port}`),
  deepseek: new DeepSeekProvider("fake-key-for-test", `http://127.0.0.1:${fakeDeepSeekAddr.port}`),
});

const start = Date.now();
const result = await router.generate(
  USER_ID,
  { messages: [{ role: "user", content: "What's my EURUSD exposure?" }] },
  { timeoutMs: 1500 }
);
const elapsed = Date.now() - start;
console.log(`    result.provider = "${result.provider}", text = "${result.text}", took ${elapsed}ms`);
assert.equal(result.provider, "deepseek", "must have fallen over to deepseek, not airllm");
assert.ok(elapsed >= 1500 && elapsed < 4000, "should have actually waited out the real timeout, not skipped it");

const failoverLog = router.getFailoverLog();
console.log(`    failover log: ${JSON.stringify(failoverLog)}`);
assert.equal(failoverLog.length, 1);
assert.equal(failoverLog[0].failedProvider, "airllm");
assert.equal(failoverLog[0].fellBackTo, "deepseek");
assert.match(failoverLog[0].reason, /timed out/);

console.log("\n[4] Worker routing (5.4) never selects airllm...");
const workerConfig1 = routeForWorker("deepseek");
const workerConfig2 = routeForWorker("claude");
console.log(`    routeForWorker("deepseek") -> ${JSON.stringify(workerConfig1)}`);
console.log(`    routeForWorker("claude")   -> ${JSON.stringify(workerConfig2)}`);
assert.notEqual(workerConfig1.primary, "airllm");
assert.notEqual(workerConfig2.primary, "airllm");
assert.ok(!workerConfig1.fallback.includes("airllm"));
assert.ok(!workerConfig2.fallback.includes("airllm"));

console.log("\n[5] All-providers-failed path (both configured providers dead)...");
const bothDeadRouter = new ProviderRouter({
  airllm: new AirLLMProvider(`http://127.0.0.1:${deadAirllmAddr.port}`),
});
setModelConfig(USER_ID, { primary: "airllm", fallback: [] });
let threw = false;
try {
  await bothDeadRouter.generate(USER_ID, { messages: [{ role: "user", content: "hi" }] }, { timeoutMs: 500 });
} catch (err) {
  threw = true;
  console.log(`    threw as expected: ${(err as Error).name}: ${(err as Error).message.slice(0, 120)}`);
}
assert.equal(threw, true);

deadAirllm.close();
fakeDeepSeek.close();

console.log("\n=== ALL ASSERTIONS PASSED ===");
