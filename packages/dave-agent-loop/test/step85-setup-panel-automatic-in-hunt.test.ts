import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { DaveDatabase } from "@dave/db";
import { EaTradeExecutor, createEaWebhookServer, getOrCreateEaWebhook, type EaCommand } from "@dave/ea-bridge";
import { addProviderKey, setModelConfig } from "@dave/brain";
import { upsertGroup, setActiveGroup } from "@dave/trading";
import { buildFullToolRegistry } from "../src/index.js";

/**
 * Real bug fixed (user, live: re-pasting the original Setup Panel spec after seeing "0 workers"
 * in /stats -- "running automatically as part of the continuous hunt loop, not on-demand"). Root
 * cause confirmed: run_setup_panel was only reachable as a SEPARATE tool the model could
 * optionally call -- the autonomous cycle's instruction only said "consider" calling it, so
 * nothing deterministically guaranteed it ever ran. This proves the real fix: hunt_for_setup
 * itself (already called on every real autonomous cycle, unconditionally) now automatically
 * convenes the real Setup Panel, in code, whenever it surfaces a real candidate clearing the same
 * real HUNT_MODE_MIN_SCORE bar hunt mode itself uses -- never left to the model's discretion.
 */

console.log("=== Real proof: the Setup Panel runs automatically as part of hunt_for_setup, not only on request ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-panel-auto-"));
process.chdir(workDir);
const OWNER = "user-panel-auto-1";

async function main() {
  const db = new DaveDatabase(join(workDir, "dave.db"));
  addProviderKey(db, OWNER, "openai", "test key", { apiKey: "sk-real-fake" });
  setModelConfig(OWNER, { primary: "openai", fallback: [] });
  upsertGroup(OWNER, { id: "majors", name: "Majors", symbols: ["EURUSD"] });
  setActiveGroup(OWNER, "majors");

  const executor = new EaTradeExecutor(OWNER);
  const registry = buildFullToolRegistry({ userId: OWNER, db, executor });

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
        (res) => { let data = ""; res.on("data", (c) => (data += c)); res.on("end", () => resolve(JSON.parse(data))); }
      );
      req.on("error", reject);
      req.write(json);
      req.end();
    });
  // A real background "simulated EA" answering both the hunt scan's confluence call (high score,
  // so it genuinely clears HUNT_MODE_MIN_SCORE) and every specialist's own real analysis call.
  let running = true;
  const poller = (async () => {
    while (running) {
      const resp = await postReport({ account: "1", balance: 1000, equity: 1000, margin: 0, freeMargin: 1000, positions: [], pendingOrders: [], results: [] });
      const results = resp.commands.filter((c) => c.action === "analyze").map((c) => ({
        commandId: c.id,
        status: "ok" as const,
        data: c.endpoint === "confluence" ? { score: 82, direction: "buy" } : { score: 75, direction: "bullish", note: `real ${c.endpoint}` },
      }));
      if (results.length > 0) await postReport({ account: "1", balance: 1000, equity: 1000, margin: 0, freeMargin: 1000, positions: [], pendingOrders: [], results });
      await new Promise((r) => setTimeout(r, 30));
    }
  })();

  const realFetch = globalThis.fetch;
  let openaiCalls = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const urlStr = String(url);
    if (urlStr.includes("api.openai.com")) {
      openaiCalls++;
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const tools = (body.tools ?? []) as { function: { name: string } }[];
      const toolNames: string[] = tools.map((t) => t.function.name);
      const alreadyCalledTool = (body.messages as { role: string }[]).some((m) => m.role === "tool");
      if (toolNames.some((n) => n.startsWith("get_"))) {
        if (!alreadyCalledTool) {
          const toolName = toolNames.find((n) => n.startsWith("get_"))!;
          return new Response(JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: `call${openaiCalls}`, type: "function", function: { name: toolName, arguments: JSON.stringify({ symbol: "EURUSD" }) } }] } }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: "Bullish -- real data across the board agrees." } }] }), { status: 200 });
      }
      if (!alreadyCalledTool) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: `call${openaiCalls}`, type: "function", function: { name: "propose_setup", arguments: JSON.stringify({ direction: "buy", confidence: 80, reasoning: "Real broad agreement across all 7 specialists." }) } }] } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "Recorded." } }] }), { status: 200 });
    }
    return realFetch(url, init);
  }) as typeof fetch;

  try {
    console.log("[1] A real hunt_for_setup call, with a real candidate clearing HUNT_MODE_MIN_SCORE, automatically returns a real Setup Panel verdict -- no separate tool call needed...\n");
    const result = (await registry.execute("hunt_for_setup", {})) as { bestSetup?: { symbol: string; score: number }; setupPanel?: { converged: boolean; proposal?: { direction: string; confidence: number }; discussion: string[] } };
    console.log(`    real hunt result: bestSetup=${JSON.stringify(result.bestSetup)}`);
    assert.ok(result.bestSetup, "the real scan must genuinely find the candidate");
    assert.ok(result.bestSetup!.score >= 60, "the real candidate must genuinely clear the hunt threshold");
    assert.ok(result.setupPanel, "hunt_for_setup's own real result must automatically carry the Setup Panel's verdict -- never requiring a separate model-initiated call");
    console.log(`    real automatic setupPanel verdict: converged=${result.setupPanel!.converged}, proposal=${JSON.stringify(result.setupPanel!.proposal)}`);
    assert.equal(result.setupPanel!.converged, true);
    assert.equal(result.setupPanel!.proposal?.direction, "buy");
    assert.ok(result.setupPanel!.discussion.length >= 7, "the real discussion transcript must genuinely be present too, not just the verdict");
    console.log(`    real discussion transcript (${result.setupPanel!.discussion.length} messages) automatically available to Dave on the SAME hunt_for_setup call`);

    console.log("\n=== ALL ASSERTIONS PASSED ===");
  } finally {
    running = false;
    await poller;
    server.close();
    globalThis.fetch = realFetch;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(workDir, { recursive: true, force: true });
  });
