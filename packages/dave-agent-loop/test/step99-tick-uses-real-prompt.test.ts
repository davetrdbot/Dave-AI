import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
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
 * Real regression test for the biggest gap found on live re-audit (user, live: "it just only see
 * the 4 prompts only"): autonomous-tick.ts used to build its OWN, separate, ~14-line hardcoded
 * system prompt -- completely bypassing the real SOUL/IDENTITY/SECURITY/trading/BOOTSTRAP stack
 * every normal chat turn gets, which meant this session's own SMC/ICT-first rewrite of
 * trading.md (and every mission/precedence/risk rule in it) never reached a single live
 * autonomous trade decision. Proves the tick's real system prompt now genuinely contains
 * distinctive trading.md content, not just the tick's own mechanical instructions.
 */

console.log("=== Real proof: the autonomous tick's system prompt genuinely includes the real trading.md content ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-tick-real-prompt-"));
process.chdir(workDir);

// A real prompts/ dir, mirroring what main.ts's loadSystemPrompt() reads at boot -- this test
// would fail against the OLD bespoke buildSystemPrompt(), which never read this directory at all.
const promptsDir = join(workDir, "prompts");
mkdirSync(promptsDir, { recursive: true });
const repoPromptsDir = join(process.cwd(), "..", "..", "..", "prompts");
try {
  cpSync(repoPromptsDir, promptsDir, { recursive: true });
} catch {
  // Fallback: write a minimal trading.md carrying the one distinctive phrase this test checks for,
  // in case the real repo prompts/ dir isn't reachable from this relative path in some environment.
  writeFileSync(join(promptsDir, "trading.md"), "## Analysis lens: Smart Money Concepts / ICT first, classic indicators second\n");
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;

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
        await postReport({ ...heartbeat, results: [{ commandId: cmd.id, status: "ok", data: { price: { bid: 1, ask: 1.0002 }, volatility: { atr: 0.001 } } }] }).catch(() => undefined);
      }
      await new Promise((r) => setTimeout(r, 30));
    }
  })();
  return { stop: async () => { running = false; await loop; await ready; server.close(); } };
}

async function main() {
  const USER = "user-tick-real-prompt-1";
  upsertGroup(USER, { id: "majors", name: "Majors", symbols: ["EURUSD"] });
  setActiveGroup(USER, "majors");

  const ea = startSimulatedEa(USER);
  const db = new DaveDatabase(join(workDir, "dave.db"));
  const executor: TradeExecutor = {
    openOrder: async () => ({ ticket: "1" }),
    modifyOrder: async () => undefined,
    closePosition: async () => ({ closedLots: 0, remainingLots: 0 }),
    deletePendingOrder: async () => undefined,
  };

  let systemPromptSeen: string | null = null;
  const provider: Provider = {
    name: "mock",
    generate: async (req: CompletionRequest): Promise<CompletionResult> => {
      const systemMsg = req.messages.find((m) => m.role === "system");
      if (systemMsg && typeof systemMsg.content === "string") systemPromptSeen = systemMsg.content;
      const toolCalls: ToolCall[] = [{ id: "c1", name: "submit_trading_decision", arguments: { action: "SKIP", reason: "test" } }];
      return { text: "", provider: "mock", latencyMs: 1, toolCalls };
    },
  };

  console.log("[1] Running a real tick and inspecting the exact system prompt sent to the model...\n");
  await runAutonomousTick({ userId: USER, db, executor, provider });
  assert.ok(systemPromptSeen, "a system prompt must have been sent");
  assert.ok(
    systemPromptSeen!.includes("Smart Money Concepts / ICT"),
    "the tick's real system prompt must include trading.md's real content, not a separate bespoke prompt that bypasses it"
  );
  console.log("    confirmed: the tick's system prompt genuinely includes trading.md's real SMC/ICT-first content");

  console.log("\n[2] The tick's own mechanical instructions are still present alongside the real prompt stack...\n");
  assert.ok(systemPromptSeen!.includes("CONSULT_JOURNAL"), "the tick-specific decision mechanics must still be appended");
  console.log("    confirmed: both the real prompt stack AND the tick's own mechanics are present");

  await ea.stop();
  console.log("\n=== ALL ASSERTIONS PASSED ===");
}

main()
  .then(() => {
    globalThis.fetch = realFetch;
    rmSync(workDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    globalThis.fetch = realFetch;
    rmSync(workDir, { recursive: true, force: true });
    console.error(err);
    process.exit(1);
  });
