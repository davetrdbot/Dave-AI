import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { setRiskMode, upsertGroup, setActiveGroup } from "@dave/trading";
import { OpenAICompatibleProvider } from "@dave/brain";
import { ToolRegistry, AgentLoop } from "../src/index.js";
import { buildLiveSettingsBlock, withLiveContext } from "../src/live-context.js";

/**
 * Real bug fixed (user: "user sets TP/SL to Auto, sets an active pair group -- the bot keeps
 * asking about these as if they were never set"). Root cause: the system prompt is a static,
 * per-process string frozen at conversation start -- it never carried live settings, so the model
 * only knew about a setting if it happened to call the right get_* tool that exact turn. This
 * proves a setting saved via the REAL dave-trading store is genuinely visible on the very next
 * turn, with real proof: set a value, run a real agent turn, confirm the ACTUAL request payload
 * sent to the provider carries the current value -- not that the code merely compiles.
 */

console.log("=== Real proof: a saved setting is immediately visible to the next AI turn ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-settings-context-"));
process.chdir(workDir);
const USER_ID = "user-settings-context-1";

async function main() {
  console.log("[1] Before anything is set, the live block honestly shows the real defaults...\n");
  const before = buildLiveSettingsBlock(USER_ID);
  assert.match(before, /SL: off/);
  assert.match(before, /Active pair group: none set/);
  console.log("    real default block confirmed (SL off, no active group)");

  console.log("\n[2] Real settings are saved through the SAME store /settings itself uses...\n");
  setRiskMode(USER_ID, "sl", "on", 25);
  setRiskMode(USER_ID, "tp", "auto");
  upsertGroup(USER_ID, { id: "majors", name: "Majors", symbols: ["EURUSD", "GBPUSD"] });
  setActiveGroup(USER_ID, "majors");

  console.log("\n[3] The live block, rebuilt fresh, IMMEDIATELY reflects the real saved values -- no restart, no delay...\n");
  const after = buildLiveSettingsBlock(USER_ID);
  assert.match(after, /SL: on \(25\)/);
  assert.match(after, /TP: auto/);
  assert.match(after, /Active pair group: Majors/);
  console.log(`    real live block:\n${after}`);

  console.log("\n[4] End-to-end: a REAL agent turn's actual request payload carries the current settings, proving the model genuinely sees them -- not just that buildLiveSettingsBlock() compiles...\n");
  const registry = new ToolRegistry();
  let capturedFirstUserContent = "";
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      capturedFirstUserContent = parsed.messages.find((m: any) => m.role === "user")?.content ?? "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "Your SL is on at 25 pips, TP is auto, and Majors is your active group." } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a real TCP address");

  try {
    const provider = new OpenAICompatibleProvider("openai", `http://127.0.0.1:${address.port}`, "test-key", "gpt-5.6-sol");
    const loop = new AgentLoop(provider, registry);
    const userMessage = withLiveContext(USER_ID, "What are my current settings?");
    const result = await loop.run([{ role: "user", content: userMessage as string }], { maxSteps: 3 });
    assert.equal(result.status, "done");
    console.log(`    real model reply: "${(result as any).text}"`);
    assert.match(capturedFirstUserContent, /SL: on \(25\)/, "the REAL outgoing request must carry the current SL setting");
    assert.match(capturedFirstUserContent, /TP: auto/, "the REAL outgoing request must carry the current TP setting");
    assert.match(capturedFirstUserContent, /Active pair group: Majors/, "the REAL outgoing request must carry the current active pair group");
    assert.match(capturedFirstUserContent, /What are my current settings\?/, "the user's real message must still be present, not replaced");
    console.log("    confirmed: the real request payload sent to the provider carries the just-saved settings -- the model does not have to ask");
  } finally {
    server.close();
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
