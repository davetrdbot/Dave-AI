import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { DaveDatabase } from "@dave/db";
import type { Provider, CompletionRequest, CompletionResult, ToolCall } from "@dave/brain";
import type { TradeExecutor } from "@dave/trading";
import { upsertGroup, setActiveGroup } from "@dave/trading";
import { addE2BKey } from "@dave/e2b";
import { getOrCreateEaWebhook, createEaWebhookServer, type EaCommand } from "@dave/ea-bridge";
import { runAutonomousTick } from "../src/autonomous-tick.js";
import { getTickState } from "../src/autonomous-tick-state.js";

/**
 * The trader asked whether run_script reaches "mode 2, the autonomous loop aspect". It did not,
 * and could not: autonomous-tick.ts makes a SINGLE forced model call carrying exactly ONE tool
 * (the decision tool), so it is not an agent loop and putting run_script in the core tool list had
 * no effect there at all.
 *
 * This proves the fix: RUN_SCRIPT is a bounded ACTION on that same one decision tool -- the same
 * shape as the CONSULT_JOURNAL and REQUEST_CANDLES escape hatches already there -- so the "one
 * structured decision per tick" architecture is never reopened into a free multi-tool loop, and a
 * script costs exactly one extra round trip, only on the cycles where the model asks for one.
 *
 * Runs a REAL script against REAL E2B when E2B_TEST_KEY is set; the structural guarantees (bound,
 * repeat-guard, failure handling) are proven either way.
 */

console.log("=== RUN_SCRIPT: real compute inside the autonomous trading tick ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-tick-script-"));
process.chdir(workDir);
process.env.DAVE_DATA_ROOT = workDir;

const realFetch = globalThis.fetch;
const LIVE_KEY = process.env.E2B_TEST_KEY;

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
        // Real-shaped synthetic-pair data -- the kind of thing only this terminal has.
        await postReport({
          ...heartbeat,
          results: [{ commandId: cmd.id, status: "ok", data: { price: { bid: 196800, ask: 196802 }, volatility: { atr: 420 }, closes: [196740, 196755, 196810, 196795, 196830] } }],
        }).catch(() => undefined);
      }
      await new Promise((r) => setTimeout(r, 30));
    }
  })();
  return { stop: async () => { running = false; await loop; await ready; server.close(); } };
}

function mockToolProvider(decisions: Record<string, unknown>[]): { provider: Provider; calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = [];
  let i = 0;
  const provider: Provider = {
    name: "mock",
    generate: async (req: CompletionRequest): Promise<CompletionResult> => {
      calls.push(req);
      const args = decisions[Math.min(i, decisions.length - 1)];
      i++;
      const toolCalls: ToolCall[] = [{ id: `call-${i}`, name: "submit_trading_decision", arguments: args }];
      return { text: "", provider: "mock", latencyMs: 1, toolCalls };
    },
  };
  return { provider, calls };
}

const executor: TradeExecutor = {
  openOrder: async () => ({ ticket: "T" }), modifyOrder: async () => {}, closePosition: async () => ({ closedLots: 0, remainingLots: 0 }),
  deletePendingOrder: async () => {}, listOpenPositions: async () => [], listPendingOrders: async () => [],
};
const userText = (req: CompletionRequest) => String(req.messages.find((m) => m.role === "user")!.content);

try {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    // Telegram only; E2B must go over a real socket.
    if (String(url).includes("api.telegram.org")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    return realFetch(url as never, init);
  }) as typeof fetch;

  const db = new DaveDatabase(join(workDir, "dave.db"));

  console.log("[1] RUN_SCRIPT is a real action on the ONE decision tool -- not a second tool...\n");
  {
    const OWNER = "tick-script-schema";
    upsertGroup(OWNER, { id: "syn", name: "Syn", symbols: ["VOL_80"] });
    setActiveGroup(OWNER, "syn");
    const ea = startSimulatedEa(OWNER);
    const { provider, calls } = mockToolProvider([{ action: "SKIP", reason: "nothing" }]);
    try {
      await runAutonomousTick({ userId: OWNER, db, executor, provider });
      const req = calls[0];
      assert.equal(req.tools?.length, 1, "the tick must still send exactly ONE tool -- the architecture stays closed");
      assert.equal(req.tools![0].name, "submit_trading_decision");
      const params = req.tools![0].parameters as { properties: Record<string, { enum?: string[]; description?: string }> };
      assert.ok(params.properties.action.enum?.includes("RUN_SCRIPT"), "RUN_SCRIPT must be an action value");
      assert.ok(params.properties.script, "…with a real script field alongside it");
      assert.ok(params.properties.scriptLanguage, "…and a language field");
      assert.match(params.properties.script.description ?? "", /market\.json/, "the script must be told where its data is");
      assert.match(params.properties.script.description ?? "", /no public API/i, "…and warned not to fetch a synthetic from the internet");
      console.log("    confirmed: still 1 tool; RUN_SCRIPT is an action on it, with script + language");
    } finally { await ea.stop(); }
  }

  console.log("\n[2] A missing script never hangs the cycle -- it re-decides honestly...\n");
  {
    const OWNER = "tick-script-missing";
    upsertGroup(OWNER, { id: "syn", name: "Syn", symbols: ["VOL_80"] });
    setActiveGroup(OWNER, "syn");
    const ea = startSimulatedEa(OWNER);
    const { provider, calls } = mockToolProvider([
      { action: "RUN_SCRIPT", reason: "want a number" }, // no script supplied
      { action: "SKIP", reason: "decided without it" },
    ]);
    try {
      const outcome = await runAutonomousTick({ userId: OWNER, db, executor, provider });
      assert.equal(calls.length, 2, "exactly one re-decision");
      assert.match(userText(calls[1]), /no script was provided/, "the model must be told plainly what happened");
      assert.equal(outcome.action, "NONE");
      console.log("    confirmed: re-decided once, told the real reason, cycle completed");
    } finally { await ea.stop(); }
  }

  console.log("\n[3] A REPEAT RUN_SCRIPT falls back to SKIP -- the bound is real, no loop...\n");
  {
    const OWNER = "tick-script-repeat";
    upsertGroup(OWNER, { id: "syn", name: "Syn", symbols: ["VOL_80"] });
    setActiveGroup(OWNER, "syn");
    const ea = startSimulatedEa(OWNER);
    const { provider, calls } = mockToolProvider([
      { action: "RUN_SCRIPT", reason: "one", script: "print(1)" },
      { action: "RUN_SCRIPT", reason: "again", script: "print(2)" }, // must NOT run a second time
    ]);
    try {
      const outcome = await runAutonomousTick({ userId: OWNER, db, executor, provider });
      assert.equal(calls.length, 2, "exactly two model calls -- never a third");
      assert.match(userText(calls[1]), /do not run another script/, "the re-ask must forbid a second script");
      assert.equal(outcome.action, "NONE", "a repeat must resolve to SKIP, not loop");
      const recorded = getTickState(OWNER).recentDecisions.map((d) => d.action);
      assert.ok(recorded.includes("RUN_SCRIPT"), "the real RUN_SCRIPT step must be recorded in the decision history");
      console.log(`    confirmed: bounded to one script, repeat -> SKIP (recorded: ${recorded.join(", ")})`);
    } finally { await ea.stop(); }
  }

  console.log("\n[4] A cycle with no RUN_SCRIPT costs NOTHING extra -- no sandbox, one call...\n");
  {
    const OWNER = "tick-script-unused";
    upsertGroup(OWNER, { id: "syn", name: "Syn", symbols: ["VOL_80"] });
    setActiveGroup(OWNER, "syn");
    const ea = startSimulatedEa(OWNER);
    const { provider, calls } = mockToolProvider([{ action: "SKIP", reason: "nothing here" }]);
    try {
      const started = Date.now();
      await runAutonomousTick({ userId: OWNER, db, executor, provider });
      assert.equal(calls.length, 1, "an ordinary cycle must still be a single model call");
      assert.ok(!userText(calls[0]).includes("YOUR SCRIPT'S REAL OUTPUT"), "no script output on a cycle that never asked");
      console.log(`    confirmed: 1 model call, no sandbox, ${Date.now() - started}ms -- the feature is free when unused`);
    } finally { await ea.stop(); }
  }

  if (!LIVE_KEY) {
    console.log("\n[5] SKIPPED -- no E2B_TEST_KEY set, so the real sandbox round trip is NOT verified here.\n");
  } else {
    console.log("\n[5] LIVE: a real script runs against the real suite and its REAL output drives the decision...\n");
    const OWNER = "tick-script-live";
    upsertGroup(OWNER, { id: "syn", name: "Syn", symbols: ["VOL_80"] });
    setActiveGroup(OWNER, "syn");
    addE2BKey(db, OWNER, "live", LIVE_KEY);
    const ea = startSimulatedEa(OWNER);
    const { provider, calls } = mockToolProvider([
      {
        action: "RUN_SCRIPT",
        reason: "need the real closes above 196740 counted, not eyeballed",
        scriptLanguage: "python",
        script: [
          "import json, os",
          "d = json.load(open(os.environ['DAVE_IN_DIR'] + '/market.json'))",
          "print('SYMBOL_FROM_FILE:', d['symbol'])",
          "blob = json.dumps(d)",
          "print('HAS_REAL_EA_DATA:', '196800' in blob or '196740' in blob)",
          "print('COMPUTED:', round(196830 - 196740, 2))",
        ].join("\n"),
      },
      { action: "SKIP", reason: "read the script output, staying out" },
    ]);
    try {
      const started = Date.now();
      const outcome = await runAutonomousTick({ userId: OWNER, db, executor, provider });
      assert.equal(calls.length, 2, "one script, one re-decision");
      const reask = userText(calls[1]);
      console.log(`    real round trip took ${Date.now() - started}ms`);
      assert.match(reask, /YOUR SCRIPT'S REAL OUTPUT \(exit code 0/, "the real exit code must reach the model");
      assert.match(reask, /SYMBOL_FROM_FILE: VOL_80/, "market.json must genuinely carry the symbol being analysed");
      assert.match(reask, /HAS_REAL_EA_DATA: True/, "…and the REAL EA data for it -- this is the synthetic-pair path working");
      assert.match(reask, /COMPUTED: 90/, "a real computation must come back");
      assert.equal(outcome.action, "NONE");
      console.log("    confirmed: real sandbox, real EA data in market.json, real output steering the decision");
    } finally { await ea.stop(); }
  }

  console.log("\n=== ALL ASSERTIONS PASSED ===");
  if (!LIVE_KEY) console.log("\n(Set E2B_TEST_KEY to also verify the real sandbox round trip.)");
  db.close();
} finally {
  globalThis.fetch = realFetch;
  process.chdir(tmpdir());
  rmSync(workDir, { recursive: true, force: true });
}
process.exit(0);
