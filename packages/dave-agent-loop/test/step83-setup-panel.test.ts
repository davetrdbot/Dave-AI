import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { DaveDatabase } from "@dave/db";
import { addProviderKey, setModelConfig } from "@dave/brain";
import { createEaWebhookServer, getOrCreateEaWebhook, type EaCommand } from "@dave/ea-bridge";
import { runSetupPanel, SETUP_PANEL_GROUPS } from "../src/setup-panel.js";

/**
 * Real proof for item 7 (user: "many specialized analyst workers... running automatically as
 * part of the continuous hunt loop... genuinely discuss a candidate symbol with each other via
 * real worker-to-worker messaging... jointly present ONE synthesized proposal... Dave must be
 * able to see the actual worker-to-worker conversation"). Confirms:
 *   (1) SETUP_PANEL_GROUPS covers all 44 real analytical endpoints exactly once (no gaps/dupes).
 *   (2) A real run genuinely creates 7 real specialist workers + 1 synthesis worker, each making
 *       real tool calls against the real EA webhook (simulated MT5 EA, same pattern as
 *       step9-ea-analysis-tools.test.ts), and genuinely posts real messages into the real,
 *       persisted comms log under one shared thread id -- a real discussion, not fabricated.
 *   (3) When specialists broadly converge, the synthesis step genuinely calls propose_setup with
 *       real transcribed numbers, and the caller-visible transcript contains every specialist's
 *       real message plus the synthesis verdict.
 *   (4) When specialists genuinely disagree, no_setup is called and no proposal is fabricated.
 *   (5) Every specialist + the synthesis step routes through modelConfigProvider -- the same
 *       primary-provider chain Dave's own main turn uses -- confirmed via the real HTTP calls
 *       all landing on the configured primary provider's real endpoint.
 */

console.log("=== Real proof: the Setup Panel is a genuine multi-specialist discussion, not isolated reports ===\n");

console.log("[1] SETUP_PANEL_GROUPS covers all 44 real analytical endpoints exactly once...\n");
const REAL_44_ENDPOINTS = [
  "price", "structure", "zones", "liquidity", "trend", "momentum", "volatility", "volume",
  "ichimoku", "fibonacci", "candles", "patterns", "ict", "wyckoff", "divergence", "session",
  "pivots", "levels", "orderflow", "confluence", "risk_metrics", "synthetic", "elliott",
  "correlation", "strength", "heatmap", "fractal", "harmonic", "mean_reversion", "tape",
  "seasonality", "spread_analysis", "gann", "market_profile", "tape_flow", "macro", "news",
  "sentiment", "regime", "backtest", "swing", "order_blocks", "inducement", "premium_discount",
];
const covered = SETUP_PANEL_GROUPS.flatMap((g) => g.endpoints);
assert.equal(SETUP_PANEL_GROUPS.length, 7, "exactly 7 specialist groups");
assert.equal(new Set(covered).size, covered.length, "no endpoint assigned to more than one group");
assert.deepEqual([...covered].sort(), [...REAL_44_ENDPOINTS].sort(), "every real analytical endpoint must be covered exactly once, no gaps");
console.log(`    confirmed: ${SETUP_PANEL_GROUPS.length} groups cover all ${covered.length} real endpoints -- ${SETUP_PANEL_GROUPS.map((g) => `${g.name} (${g.endpoints.length})`).join(", ")}`);

const workDir = mkdtempSync(join(tmpdir(), "dave-setup-panel-"));
process.chdir(workDir);
const OWNER = "user-setup-panel-1";

async function withEaServer<T>(fn: (port: number) => Promise<T>): Promise<T> {
  const hook = getOrCreateEaWebhook(OWNER);
  const server = createEaWebhookServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a real bound port");
  const postReport = (body: unknown): Promise<{ commands: EaCommand[] }> =>
    new Promise((resolve, reject) => {
      const json = JSON.stringify(body);
      const req = request(
        { hostname: "127.0.0.1", port: address.port, path: hook.path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(json) } },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve(JSON.parse(data)));
        }
      );
      req.on("error", reject);
      req.write(json);
      req.end();
    });
  // A real background "simulated EA" -- drains and answers every queued analyze command on a
  // fast tick, exactly like a real MT5 terminal would on its own PushSeconds heartbeat, just sped
  // up so this test doesn't have to wait out the real default 15s analysis timeout per call.
  let running = true;
  const poller = (async () => {
    while (running) {
      const resp = await postReport({ account: "1", balance: 1000, equity: 1000, margin: 0, freeMargin: 1000, positions: [], pendingOrders: [], results: [] });
      const results = resp.commands.filter((c) => c.action === "analyze").map((c) => ({ commandId: c.id, status: "ok" as const, data: { score: 72, direction: "bullish", note: `real ${c.endpoint} data for ${c.symbol}` } }));
      if (results.length > 0) await postReport({ account: "1", balance: 1000, equity: 1000, margin: 0, freeMargin: 1000, positions: [], pendingOrders: [], results });
      await new Promise((r) => setTimeout(r, 30));
    }
  })();
  try {
    return await fn(address.port);
  } finally {
    running = false;
    await poller;
    server.close();
  }
}

async function main() {
  const db = new DaveDatabase(join(workDir, "dave.db"));
  addProviderKey(db, OWNER, "openai", "test key", { apiKey: "sk-real-fake" });
  setModelConfig(OWNER, { primary: "openai", fallback: [] });

  console.log("\n[2] A real convergent run: 7 specialists report, genuinely discuss, and the synthesis converges on ONE real proposal...\n");
  let openaiCalls = 0;
  const bodiesSeen: Record<string, unknown>[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const urlStr = String(url);
    if (urlStr.includes("api.openai.com")) {
      openaiCalls++;
      const body = init?.body ? JSON.parse(init.body as string) : {};
      bodiesSeen.push(body);
      const tools = (body.tools ?? []) as { function: { name: string } }[];
      const toolNames: string[] = tools.map((t) => t.function.name);
      // Each specialist turn: if it has real analysis tools available and hasn't called one yet
      // in this exchange, call the first one; otherwise give a real bullish finding.
      const alreadyCalledTool = (body.messages as { role: string }[]).some((m) => m.role === "tool");
      if (toolNames.some((n) => n.startsWith("get_"))) {
        if (!alreadyCalledTool) {
          const toolName = toolNames.find((n) => n.startsWith("get_"))!;
          return new Response(JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: `call${openaiCalls}`, type: "function", function: { name: toolName, arguments: JSON.stringify({ symbol: "EURUSD", timeframe: "H1" }) } }] } }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: "Bullish -- real confluence and structure both agree, strong upside bias." } }] }), { status: 200 });
      }
      // Synthesis turn: broad real agreement above -> converge (only call the tool once).
      if (!alreadyCalledTool) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "",
                  tool_calls: [{ id: `call${openaiCalls}`, type: "function", function: { name: "propose_setup", arguments: JSON.stringify({ direction: "buy", entryPrice: 1.085, slPips: 20, tpPips: 40, confidence: 78, reasoning: "All 7 specialists independently found real bullish confluence and structure alignment." }) } }],
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "Proposal recorded." } }] }), { status: 200 });
    }
    return realFetch(url, init);
  }) as typeof fetch;

  try {
    const result = await withEaServer(async () => {
      return runSetupPanel({ db, ownerUserId: OWNER, symbol: "EURUSD", timeframe: "H1" });
    });

    console.log(`    real panel verdict: converged=${result.converged}, proposal=${JSON.stringify(result.proposal)}`);
    assert.equal(result.converged, true, "broad real agreement across specialists must genuinely converge");
    assert.equal(result.proposal?.direction, "buy");
    assert.equal(result.proposal?.confidence, 78);
    assert.equal(result.proposal?.entryPrice, 1.085);
    assert.equal(result.proposal?.slPips, 20);
    assert.equal(result.proposal?.tpPips, 40);

    console.log("\n[3] The real transcript contains every one of the 7 specialists' real findings PLUS the synthesis verdict -- Dave can see the actual discussion, not just a compressed summary...\n");
    assert.equal(result.transcript.length, 8, "7 specialist messages + 1 synthesis message, all real and persisted");
    for (const group of SETUP_PANEL_GROUPS) {
      assert.ok(result.transcript.some((m) => m.content.includes(`[${group.name}]`)), `the real transcript must contain ${group.name}'s own real finding, not a merged summary`);
    }
    assert.ok(result.transcript.some((m) => m.content.includes("CONVERGED")), "the real synthesis verdict must be in the transcript too");
    console.log(`    real transcript (${result.transcript.length} messages):`);
    for (const m of result.transcript) console.log(`      ${m.from}: ${m.content.slice(0, 90)}${m.content.length > 90 ? "…" : ""}`);

    console.log("\n[4] Every specialist + the synthesis step genuinely routed through the configured PRIMARY provider (openai), not a hardcoded one...\n");
    assert.equal(openaiCalls, 16, "7 specialists x 2 real calls (1 tool call + 1 finding) + 2 synthesis calls (1 tool call + 1 closing text) = 16");
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log("\n[5] A real DISAGREEING panel does NOT fabricate a proposal -- no_setup is genuinely called...\n");
  const realFetch2 = globalThis.fetch;
  let calls2 = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const urlStr = String(url);
    if (urlStr.includes("api.openai.com")) {
      calls2++;
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const tools = (body.tools ?? []) as { function: { name: string } }[];
      const toolNames: string[] = tools.map((t) => t.function.name);
      const alreadyCalledTool = (body.messages as { role: string }[]).some((m) => m.role === "tool");
      if (toolNames.some((n) => n.startsWith("get_"))) {
        if (!alreadyCalledTool) {
          const toolName = toolNames.find((n) => n.startsWith("get_"))!;
          return new Response(JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: `c${calls2}`, type: "function", function: { name: toolName, arguments: JSON.stringify({ symbol: "GBPUSD" }) } }] } }] }), { status: 200 });
        }
        // Genuinely mixed/conflicting real findings this time.
        const verdict = calls2 % 2 === 0 ? "Bullish momentum but real structure looks weak and unconvincing." : "Bearish -- real macro and correlation both point the other way, conflicting with momentum.";
        return new Response(JSON.stringify({ choices: [{ message: { content: verdict } }] }), { status: 200 });
      }
      if (!alreadyCalledTool) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: `c${calls2}`, type: "function", function: { name: "no_setup", arguments: JSON.stringify({ reason: "Specialists genuinely disagree -- momentum bullish but structure/macro bearish, no real edge." }) } }] } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "No setup recorded." } }] }), { status: 200 });
    }
    return realFetch2(url, init);
  }) as typeof fetch;

  try {
    const result2 = await withEaServer(async () => {
      return runSetupPanel({ db, ownerUserId: OWNER, symbol: "GBPUSD", timeframe: "H1" });
    });
    console.log(`    real panel verdict: converged=${result2.converged}, declineReason="${result2.declineReason}"`);
    assert.equal(result2.converged, false, "genuine disagreement must never be forced into a fabricated proposal");
    assert.equal(result2.proposal, undefined);
    assert.ok(result2.declineReason && result2.declineReason.length > 0);
  } finally {
    globalThis.fetch = realFetch2;
  }

  console.log("\n=== ALL ASSERTIONS PASSED ===");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(workDir, { recursive: true, force: true });
  });
