import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEaWebhookServer, getOrCreateEaWebhook, enqueueCommand, type EaCommand } from "../src/ea-webhook.js";

/**
 * Real bug fixed (user, live: a full pair-group scan timed out on EVERY symbol while single-
 * symbol calls worked fine). Root cause confirmed: the EA is single-threaded and processes a
 * whole drained command batch serially in ONE blocking tick -- handing it a big burst of
 * "analyze" commands at once meant it fell behind on all of them together. This proves the real
 * bridge-side half of the fix: drainQueue() now caps how many "analyze" commands go out per
 * poll (MAX_ANALYZE_COMMANDS_PER_POLL = 6), leaving the rest genuinely queued for the EA's next
 * poll -- while trade commands (open/modify/close/delete_pending) are NEVER capped or delayed by
 * a pending scan, since those are latency-sensitive and rare.
 */

console.log("=== Real proof: the EA bridge caps analyze commands per poll, never trade commands ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-analyze-cap-"));
process.chdir(workDir);

async function heartbeat(base: string, path: string) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account: "1", balance: 1000, equity: 1000, margin: 0, freeMargin: 1000, positions: [], pendingOrders: [], results: [] }),
  });
  return res.json() as Promise<{ commands: EaCommand[] }>;
}

async function main() {
  const USER = "user-analyze-cap-1";
  const hook = getOrCreateEaWebhook(USER);
  const server = createEaWebhookServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a real bound port");
  const base = `http://127.0.0.1:${address.port}`;

  try {
    console.log("[1] Enqueue 10 real 'analyze' commands (a big group scan) plus 2 real trade commands...\n");
    for (let i = 0; i < 10; i++) {
      enqueueCommand(USER, { id: `analyze-${i}`, action: "analyze", endpoint: "confluence", symbol: `SYM${i}`, timeframe: "H1" });
    }
    enqueueCommand(USER, { id: "trade-open-1", action: "open", symbol: "EURUSD", type: "buy", lots: 0.1 });
    enqueueCommand(USER, { id: "trade-close-1", action: "close", ticket: "12345" });

    console.log("[2] The first real poll returns AT MOST 6 analyze commands, but BOTH trade commands, uncapped...\n");
    const first = await heartbeat(base, hook.path);
    const firstAnalyze = first.commands.filter((c) => c.action === "analyze");
    const firstTrades = first.commands.filter((c) => c.action !== "analyze");
    assert.ok(firstAnalyze.length <= 6, `expected at most 6 analyze commands in one poll, got ${firstAnalyze.length}`);
    assert.equal(firstTrades.length, 2, "trade commands must never be capped or delayed behind a scan");
    console.log(`    real first poll: ${firstAnalyze.length} analyze + ${firstTrades.length} trade command(s) (trade commands never held back)`);

    console.log("\n[3] The rest of the analyze commands genuinely stayed queued and arrive on the NEXT poll...\n");
    const second = await heartbeat(base, hook.path);
    const secondAnalyze = second.commands.filter((c) => c.action === "analyze");
    const totalAnalyzeSeen = firstAnalyze.length + secondAnalyze.length;
    assert.equal(totalAnalyzeSeen, 10, `all 10 analyze commands must genuinely be delivered across polls, saw ${totalAnalyzeSeen}`);
    console.log(`    real second poll: ${secondAnalyze.length} more analyze command(s) -- ${totalAnalyzeSeen}/10 delivered total across 2 real polls`);

    console.log("\n=== ALL ASSERTIONS PASSED ===");
  } finally {
    server.close();
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
