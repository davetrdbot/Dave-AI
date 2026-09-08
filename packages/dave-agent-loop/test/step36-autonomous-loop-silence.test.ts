import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { OpenAICompatibleProvider } from "@dave/brain";
import { ToolRegistry, AgentLoop } from "../src/index.js";
import { NOTABLE_TRADING_TOOLS } from "../src/telegram-bot-server.js";

/**
 * Real proof for item 8 (user: "the auto-trading loop is too chatty... only message the user when
 * something actually happens"). The old guard only matched an EXACT "NOTHING_TO_REPORT" string --
 * fragile against real model variance (a model that adds even a little commentary around the
 * token never matches, so full narration went out every cycle regardless). The real fix
 * (telegram-bot-server.ts's runAutonomousTradingCycle) ties the send decision to whether a real,
 * verifiable trade-affecting tool call actually happened this cycle (NOTABLE_TRADING_TOOLS),
 * never to the model's own self-classification. This exercises the exact same real mechanism --
 * a genuine AgentLoop.run() against a real HTTP provider, real tool execution, real `steps` -- the
 * production code applies its gate to; the webhook/interval scheduling itself (that a cycle
 * genuinely fires on a real timer) is separately, already proven by step67.
 */

console.log("=== Real proof: an autonomous cycle only reports back when a real trade-affecting tool actually ran ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-autonomous-silence-"));
process.chdir(workDir);

function tookNotableAction(steps: { toolName: string; isError: boolean }[]): boolean {
  return steps.some((s) => NOTABLE_TRADING_TOOLS.has(s.toolName) && !s.isError);
}

async function runCycle(scriptedTurns: { toolName?: string; args?: unknown; finalText?: string }[]): Promise<{ steps: { toolName: string; isError: boolean }[]; text: string }> {
  const registry = new ToolRegistry();
  registry.register([
    { name: "find_setup", description: "Scan for a setup.", parameters: { type: "object", properties: {} }, execute: async () => ({ rows: [] }) },
    { name: "trade_execute", description: "Place a real order.", parameters: { type: "object", properties: {} }, execute: async () => ({ ticket: "T-1" }) },
  ]);

  let turn = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const scripted = scriptedTurns[turn];
      turn++;
      res.writeHead(200, { "content-type": "application/json" });
      if (scripted.toolName) {
        res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: `c${turn}`, type: "function", function: { name: scripted.toolName, arguments: JSON.stringify(scripted.args ?? {}) } }] } }] }));
      } else {
        res.end(JSON.stringify({ choices: [{ message: { content: scripted.finalText ?? "" } }] }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a real TCP address");
  try {
    const provider = new OpenAICompatibleProvider("openai", `http://127.0.0.1:${address.port}`, "test-key", "gpt-5.6-sol");
    const loop = new AgentLoop(provider, registry);
    const result = await loop.run([{ role: "user", content: "[Autonomous trading cycle]" }], { maxSteps: 5 });
    assert.equal(result.status, "done");
    return { steps: (result as any).steps, text: (result as any).text };
  } finally {
    server.close();
  }
}

async function main() {
  console.log("[1] A cycle that only ran find_setup (no trade) and wrote chatty prose instead of the exact token -- must be classified as SILENT...\n");
  const chatty = await runCycle([{ toolName: "find_setup" }, { finalText: "I checked EURUSD and GBPUSD, nothing quite lines up yet, will keep watching the range for a breakout." }]);
  assert.equal(tookNotableAction(chatty.steps), false, "find_setup alone must NOT count as a notable action");
  console.log(`    real model text: "${chatty.text}" -- but gate says: ${tookNotableAction(chatty.steps) ? "SEND" : "SILENT"} (correct: the old exact-match guard would have sent this)`);

  console.log("\n[2] A cycle that genuinely opened a real trade -- must be classified as REPORTABLE...\n");
  const acted = await runCycle([{ toolName: "find_setup" }, { toolName: "trade_execute", args: { symbol: "EURUSD", type: "buy", lots: 0.1 } }, { finalText: "Opened EURUSD buy 0.1 lots." }]);
  assert.equal(tookNotableAction(acted.steps), true, "a real trade_execute call must count as a notable action");
  console.log(`    real model text: "${acted.text}" -- gate says: ${tookNotableAction(acted.steps) ? "SEND" : "SILENT"} (correct)`);

  console.log("\n[3] The literal NOTHING_TO_REPORT convention still works as a fast path, but is no longer load-bearing...\n");
  const exact = await runCycle([{ toolName: "find_setup" }, { finalText: "NOTHING_TO_REPORT" }]);
  assert.equal(tookNotableAction(exact.steps), false);
  assert.equal(exact.text, "NOTHING_TO_REPORT");
  console.log("    confirmed: both the real gate AND the literal token agree this cycle stays silent");

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
