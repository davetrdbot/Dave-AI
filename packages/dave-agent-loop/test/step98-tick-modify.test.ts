import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { DaveDatabase } from "@dave/db";
import type { Provider, CompletionRequest, CompletionResult, ToolCall } from "@dave/brain";
import type { TradeExecutor } from "@dave/trading";
import { upsertGroup, setActiveGroup } from "@dave/trading";
import { getOrCreateEaWebhook, createEaWebhookServer, type EaCommand } from "@dave/ea-bridge";
import { runAutonomousTick } from "../src/autonomous-tick.js";

/**
 * Real proof for the new MODIFY decision action: adjusts SL/TP on a real, currently-open
 * position through the real tradeModify()/executor.modifyOrder() seam -- no placeholder logic,
 * no fabricated success. Covers: (a) a genuine call with the right ticket/sl/tp and a real
 * old->new notification, (b) clean rejection of an unknown ticket (no tradeModify call, no
 * crash), and (c) newSl/newTp null vs. omitted are handled distinctly, matching
 * tradeModify's/modifyOrder's own real "absent = unchanged, null = remove" semantics.
 */

console.log("=== Real proof: the MODIFY decision action adjusts SL/TP on a real open position ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-tick-modify-"));
process.chdir(workDir);

const realFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;

function startSimulatedEa(userId: string, priceBySymbol: Record<string, { bid: number; ask: number; atr?: number }>) {
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
        const p = priceBySymbol[cmd.symbol] ?? { bid: 1, ask: 1.0002, atr: 0.001 };
        await postReport({ ...heartbeat, results: [{ commandId: cmd.id, status: "ok", data: { price: p, volatility: { atr: p.atr ?? 0.001 } } }] }).catch(() => undefined);
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
    name: "claude",
    generate: async (req: CompletionRequest): Promise<CompletionResult> => {
      calls.push(req);
      const args = decisions[Math.min(i, decisions.length - 1)];
      i++;
      const toolName = req.tools?.[0]?.name ?? "submit_trading_decision";
      const toolCalls: ToolCall[] = [{ id: `call-${i}`, name: toolName, arguments: args }];
      return { text: "", provider: "claude", latencyMs: 1, toolCalls };
    },
  };
  return { provider, calls };
}

/** Posts a heartbeat carrying a real open position so getLastKnownState reflects it before the
 *  tick runs -- same pattern step97 uses for DELETE_TICKET/PARTIAL_CLOSE. */
async function seedOpenPosition(userId: string, position: { ticket: string; symbol: string; type: string; lots: number; openPrice: number; sl?: number; tp?: number }) {
  const webhook = getOrCreateEaWebhook(userId);
  const server = createEaWebhookServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => {
    const body = JSON.stringify({ type: "heartbeat", account: "1", balance: 1000, positions: [position], pendingOrders: [] });
    const req = request({ hostname: "127.0.0.1", port, path: webhook.path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => { res.on("data", () => {}); res.on("end", () => resolve()); });
    req.on("error", reject); req.write(body); req.end();
  });
  server.close();
}

try {
  const db = new DaveDatabase(join(workDir, "dave.db"));

  console.log("[a] MODIFY on a real open ticket genuinely calls tradeModify (executor.modifyOrder) with the right ticket/sl/tp, and the outcome/notification reflects real old->new values...\n");
  {
    const OWNER = "user-modify-1";
    upsertGroup(OWNER, { id: "majors", name: "Majors", symbols: ["EURUSD"] });
    setActiveGroup(OWNER, "majors");
    const modifyCalls: { ticket: string; changes: { sl?: number | null; tp?: number | null } }[] = [];
    const executor: TradeExecutor = {
      openOrder: async () => ({ ticket: "T" }),
      modifyOrder: async (ticket, changes) => { modifyCalls.push({ ticket, changes }); },
      closePosition: async () => ({ closedLots: 0, remainingLots: 0 }),
      deletePendingOrder: async () => {}, listOpenPositions: async () => [], listPendingOrders: async () => [],
    };
    await seedOpenPosition(OWNER, { ticket: "700", symbol: "GBPUSD", type: "buy", lots: 0.1, openPrice: 1.27, sl: 1.26, tp: 1.29 });
    const ea = startSimulatedEa(OWNER, { EURUSD: { bid: 1.08, ask: 1.0802 } });
    const { provider } = mockToolProvider([{ action: "MODIFY", ticket: "700", newSl: 1.265, newTp: 1.30, reason: "tightening stop, extending target" }]);
    try {
      const outcome = await runAutonomousTick({ userId: OWNER, db, executor, provider });
      console.log(`    real outcome: ${JSON.stringify(outcome)}`);
      assert.equal(outcome.action, "MODIFY", "the tick's outcome must be MODIFY");
      assert.equal(modifyCalls.length, 1, "tradeModify must genuinely call executor.modifyOrder exactly once");
      assert.equal(modifyCalls[0].ticket, "700", "the real ticket must reach modifyOrder");
      assert.equal(modifyCalls[0].changes.sl, 1.265, "the real new SL must reach modifyOrder");
      assert.equal(modifyCalls[0].changes.tp, 1.30, "the real new TP must reach modifyOrder");
      assert.ok(outcome.notable, "a real MODIFY must be notable (worth messaging the user)");
      assert.match(outcome.message!, /#700/, "the notification must name the real ticket");
      assert.match(outcome.message!, /1\.26.*1\.265/, "the notification must show the real old SL -> new SL");
      assert.match(outcome.message!, /1\.29.*1\.3/, "the notification must show the real old TP -> new TP");
      console.log("    confirmed: real tradeModify call with correct ticket/sl/tp, real old->new values in the notification");
    } finally {
      await ea.stop();
    }
  }

  console.log("\n[b] MODIFY targeting a ticket that is NOT a real open position is rejected cleanly -- no tradeModify call, no crash, a clear logged reason...\n");
  {
    const OWNER = "user-modify-2";
    upsertGroup(OWNER, { id: "majors", name: "Majors", symbols: ["EURUSD"] });
    setActiveGroup(OWNER, "majors");
    const modifyCalls: unknown[] = [];
    const executor: TradeExecutor = {
      openOrder: async () => ({ ticket: "T" }),
      modifyOrder: async (ticket, changes) => { modifyCalls.push({ ticket, changes }); },
      closePosition: async () => ({ closedLots: 0, remainingLots: 0 }),
      deletePendingOrder: async () => {}, listOpenPositions: async () => [], listPendingOrders: async () => [],
    };
    const ea = startSimulatedEa(OWNER, { EURUSD: { bid: 1.08, ask: 1.0802 } });
    const { provider } = mockToolProvider([{ action: "MODIFY", ticket: "999999", newSl: 1.0, reason: "nonexistent ticket" }]);
    try {
      const outcome = await runAutonomousTick({ userId: OWNER, db, executor, provider });
      console.log(`    real outcome: ${JSON.stringify(outcome)}`);
      assert.equal(outcome.action, "NONE", "an unknown ticket must be a clean SKIP-style outcome, not MODIFY");
      assert.equal(modifyCalls.length, 0, "tradeModify must never be called for a ticket that isn't a real open position");
      assert.equal(outcome.notable, false);
      console.log("    confirmed: MODIFY on an unknown ticket rejected cleanly with no real tradeModify call");
    } finally {
      await ea.stop();
    }
  }

  console.log("\n[c] newSl/newTp explicitly null (remove) vs. omitted (leave unchanged) are handled distinctly, matching tradeModify's real semantics...\n");
  {
    const OWNER = "user-modify-3";
    upsertGroup(OWNER, { id: "majors", name: "Majors", symbols: ["EURUSD"] });
    setActiveGroup(OWNER, "majors");
    const modifyCalls: { ticket: string; changes: { sl?: number | null; tp?: number | null } }[] = [];
    const executor: TradeExecutor = {
      openOrder: async () => ({ ticket: "T" }),
      modifyOrder: async (ticket, changes) => { modifyCalls.push({ ticket, changes }); },
      closePosition: async () => ({ closedLots: 0, remainingLots: 0 }),
      deletePendingOrder: async () => {}, listOpenPositions: async () => [], listPendingOrders: async () => [],
    };
    await seedOpenPosition(OWNER, { ticket: "800", symbol: "GBPUSD", type: "sell", lots: 0.1, openPrice: 1.27, sl: 1.28, tp: 1.25 });
    const ea = startSimulatedEa(OWNER, { EURUSD: { bid: 1.08, ask: 1.0802 } });
    // Explicit null for newSl (remove SL), newTp genuinely omitted (leave TP unchanged).
    const { provider } = mockToolProvider([{ action: "MODIFY", ticket: "800", newSl: null, reason: "removing the stop, leaving TP alone" }]);
    try {
      const outcome = await runAutonomousTick({ userId: OWNER, db, executor, provider });
      console.log(`    real outcome: ${JSON.stringify(outcome)}`);
      assert.equal(outcome.action, "MODIFY");
      assert.equal(modifyCalls.length, 1);
      assert.equal(modifyCalls[0].changes.sl, null, "explicit null newSl must reach modifyOrder as a real null (remove), not 0 or undefined");
      assert.equal(modifyCalls[0].changes.tp, undefined, "omitted newTp must reach modifyOrder as genuinely undefined (leave unchanged), never null");
      assert.match(outcome.message!, /SL 1\.28.*none/, "the notification must show the SL was genuinely removed");
      assert.ok(!outcome.message!.split("\n")[0].includes("TP"), "an unchanged (genuinely omitted) TP must not be reported as if it were touched");
      console.log(`    confirmed: null->remove and omitted->unchanged are distinct all the way to modifyOrder -- changes=${JSON.stringify(modifyCalls[0].changes)}`);
    } finally {
      await ea.stop();
    }
  }

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  globalThis.fetch = realFetch;
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
