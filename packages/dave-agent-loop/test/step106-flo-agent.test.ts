import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { Provider, CompletionRequest, CompletionResult, ToolCall } from "@dave/brain";
import { OpenAICompatibleProvider } from "@dave/brain";
import { getOrCreateEaWebhook, createEaWebhookServer, type EaCommand } from "@dave/ea-bridge";
import { consultFlo } from "../src/flo-agent.js";
import { abortTurn } from "../src/turn-abort.js";
import type { TickDecision } from "../src/autonomous-tick.js";

/** A minimal, real simulated EA -- so a real analysis tool call (e.g. get_trend) Flo makes
 *  actually resolves quickly instead of hanging on requestAnalysis's own real, much longer
 *  default round-trip timeout (there is no real MT5 EA connected in this test). */
function startSimulatedEa(userId: string) {
  const webhook = getOrCreateEaWebhook(userId);
  const server = createEaWebhookServer();
  let port = 0;
  const ready = new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => { port = (server.address() as { port: number }).port; resolve(); }));
  const postReport = (body: unknown): Promise<{ commands: EaCommand[] }> =>
    new Promise((resolve, reject) => {
      const json = JSON.stringify(body);
      const req = request(
        { hostname: "127.0.0.1", port, path: webhook.path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(json) } },
        (res) => { let data = ""; res.on("data", (c) => (data += c)); res.on("end", () => resolve(JSON.parse(data))); }
      );
      req.on("error", reject);
      req.write(json);
      req.end();
    });
  let running = true;
  const loop = (async () => {
    await ready;
    while (running) {
      const heartbeat = { type: "heartbeat", account: "123", balance: 1000, positions: [], pendingOrders: [] };
      const resp = await postReport(heartbeat).catch(() => ({ commands: [] as EaCommand[] }));
      for (const cmd of resp.commands) {
        if (cmd.action !== "analyze") continue;
        await postReport({ ...heartbeat, results: [{ commandId: cmd.id, status: "ok", data: { price: { bid: 1.1, ask: 1.1002 }, volatility: { atr: 0.001 } } }] }).catch(() => undefined);
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  })();
  return { stop: async () => { running = false; await loop; await ready; server.close(); } };
}

/**
 * Real proof for Flo, the second, independent AI that reviews every trade before it fires
 * ("Two-step trading"). Flo is architecturally a sibling of Journal (journal-agent.ts) -- this
 * proves its own registry is genuinely scoped (analysis-only, never get_all_analysis, never a
 * trading tool), it never auto-approves on a genuine failure to conclude (step cap hit), and a
 * hung Flo consult can genuinely be cancelled early via the same real turn-abort.ts mechanism
 * Journal already uses.
 */

console.log("=== Real proof: Flo's registry scope, honest fallback, and abortability ===\n");

const SAMPLE_DECISION: TickDecision = {
  action: "BUY",
  symbol: "EURUSD",
  sl: 1.09,
  tp: 1.12,
  lots: 0.1,
  confidence: 78,
  reason: "Bullish structure, momentum confirms",
  strategyTag: "ICT OB",
};

async function main() {
  console.log("[1] Flo's own registry genuinely excludes get_all_analysis and every trading tool, and genuinely includes the individual analysis endpoints...\n");
  {
    const seenRequests: CompletionRequest[] = [];
    const provider: Provider = {
      name: "mock",
      generate: async (req: CompletionRequest): Promise<CompletionResult> => {
        seenRequests.push(req);
        const toolCalls: ToolCall[] = [{ id: "c1", name: "flo_decision", arguments: { approve: true, reason: "Real structure and momentum both confirm -- nothing genuinely wrong found." } }];
        return { text: "", provider: "mock", latencyMs: 1, toolCalls };
      },
    };
    const verdict = await consultFlo({ userId: "user-flo-registry-1", provider }, SAMPLE_DECISION);
    assert.equal(verdict.approved, true);
    assert.ok(seenRequests.length >= 1, "Flo must genuinely call the provider at least once");
    const toolNames = new Set((seenRequests[0].tools ?? []).map((t) => t.name));

    // Explicitly excluded -- never registered at all, not merely unused.
    for (const excluded of ["get_all_analysis", "trade_execute", "full_close", "partial_close", "delete_pending_order", "trade_modify", "ping_ea", "get_live_state", "get_account_balance"]) {
      assert.equal(toolNames.has(excluded), false, `Flo's registry must NOT include "${excluded}"`);
    }
    // Genuinely includes real individual analysis endpoints.
    for (const included of ["get_trend", "get_momentum", "get_order_blocks", "get_inducement", "get_candles", "get_wyckoff", "get_premium_discount", "get_structure"]) {
      assert.equal(toolNames.has(included), true, `Flo's registry must include the real analysis endpoint "${included}"`);
    }
    // The one small conclusion tool Flo must call.
    assert.equal(toolNames.has("flo_decision"), true, "Flo's registry must include its own flo_decision conclusion tool");
    console.log(`    confirmed: Flo's registry has ${toolNames.size} real tools -- no get_all_analysis, no trading tools, includes the individual analysis endpoints + flo_decision`);
  }

  console.log("\n[2] Flo genuinely never auto-approves when it fails to reach a real conclusion (step cap hit, flo_decision never called)...\n");
  {
    const OWNER = "user-flo-cap-1";
    const ea = startSimulatedEa(OWNER);
    let calls = 0;
    const stubbornProvider: Provider = {
      name: "mock",
      generate: async (req: CompletionRequest): Promise<CompletionResult> => {
        calls++;
        // Always calls a real analysis tool, never flo_decision -- would loop forever without a cap.
        const firstRealTool = req.tools?.find((t) => t.name !== "flo_decision");
        const toolCalls: ToolCall[] = firstRealTool ? [{ id: `c${calls}`, name: firstRealTool.name, arguments: { symbol: "EURUSD" } }] : [];
        return { text: "", provider: "mock", latencyMs: 1, toolCalls };
      },
    };
    const verdict = await consultFlo({ userId: OWNER, provider: stubbornProvider }, SAMPLE_DECISION);
    assert.equal(verdict.approved, false, "a genuine failure to conclude must NEVER auto-approve -- declining is the safe direction for real money");
    assert.match(verdict.reason, /could not reach a real conclusion/i, `must be the honest, clearly-labeled fallback reason (got: "${verdict.reason}")`);
    assert.ok(calls <= 9, `must genuinely stop within a small, bounded number of calls, not loop forever (got ${calls} calls)`);
    console.log(`    confirmed: ${calls} calls, then honest decline-by-default fallback: "${verdict.reason}"`);
    await ea.stop();
  }

  console.log("\n[3] A real, genuinely HUNG Flo consult can be cancelled early via abortTurn(ownerUserId) -- the same /stop mechanism already proven for Journal...\n");
  {
    let requestWasAborted = false;
    const hangingServer = createServer((req) => {
      req.on("aborted", () => {
        requestWasAborted = true;
      });
      // Deliberately never responds -- simulates Flo's own provider call genuinely hanging.
    });
    await new Promise<void>((resolve) => hangingServer.listen(0, "127.0.0.1", resolve));
    const port = (hangingServer.address() as { port: number }).port;
    const hangingProvider = new OpenAICompatibleProvider("groq", `http://127.0.0.1:${port}`, "test-key", "model");

    const OWNER = "user-flo-abort-1";
    const started = Date.now();
    const consultPromise = consultFlo({ userId: OWNER, provider: hangingProvider }, SAMPLE_DECISION);

    // Give the real HTTP request time to actually reach the server before cancelling it.
    await new Promise((r) => setTimeout(r, 200));
    const wasCancelled = abortTurn(OWNER);
    assert.equal(wasCancelled, true, "abortTurn(ownerUserId) must report it genuinely found and cancelled Flo's own in-flight consult -- proving consultFlo registered it via beginTurn");

    const verdict = await consultPromise;
    const elapsed = Date.now() - started;

    console.log(`    consultFlo resolved after ${elapsed}ms with verdict: approved=${verdict.approved}, reason="${verdict.reason}"`);
    assert.ok(elapsed < 5_000, `consultFlo must resolve promptly once cancelled, nowhere near the ~4 minute default overall deadline (took ${elapsed}ms)`);
    assert.equal(verdict.approved, false, "a cancelled consult must NEVER read as an approval");
    assert.match(verdict.reason, /could not reach a real conclusion/i, `an aborted consult must return the same honest, clearly-labeled fallback -- never something that looks like a real approval (got: "${verdict.reason}")`);

    // Give the server a moment to observe the real socket abort.
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(requestWasAborted, true, "the real underlying HTTP request to Flo's provider must genuinely be aborted, not merely abandoned by the caller");
    console.log(`    confirmed: cancelled in ${elapsed}ms, honest decline-by-default fallback returned, underlying HTTP request genuinely aborted=${requestWasAborted}`);

    await new Promise<void>((resolve) => hangingServer.close(() => resolve()));
  }

  console.log("\n=== ALL ASSERTIONS PASSED ===");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
