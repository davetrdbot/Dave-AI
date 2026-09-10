import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEaWebhookServer, getOrCreateEaWebhook } from "@dave/ea-bridge";
import { buildLiveSettingsBlock } from "../src/live-context.js";

/**
 * Real proof for item 5 (user: "leverage is STILL not appearing in what the bot receives from
 * the EA... re-verify the EA-side payload actually includes it, and that the bot-side parser
 * actually reads and stores it"). Leverage was already reachable via the get_account_balance
 * tool, but that's tool-gated (only shows up on a turn where the model happens to call it) -- the
 * real, durable fix is surfacing it proactively in the live-settings block every turn, same
 * pattern as every other live setting (live-context.ts). This drives a REAL webhook POST (the
 * exact shape the EA sends) through the real webhook server, then confirms buildLiveSettingsBlock
 * -- what Dave ACTUALLY sees prepended to every real user turn -- genuinely includes it.
 */

console.log("=== Real proof: EA-reported leverage is proactively visible in Dave's live context every turn ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-leverage-context-"));
process.chdir(workDir);
const USER = "user-leverage-context-1";

async function main() {
  console.log("[1] Before any EA report, the live context is honest that no account data exists yet...\n");
  const before = buildLiveSettingsBlock(USER);
  assert.match(before, /Account: no EA report received yet/);
  console.log("    confirmed honest default");

  console.log("\n[2] A real EA report (the exact shape the MT5 EA sends, leverage included) is posted to the real webhook server...\n");
  const hook = getOrCreateEaWebhook(USER);
  const server = createEaWebhookServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a real bound port");
  try {
    const res = await fetch(`http://127.0.0.1:${address.port}${hook.path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account: "12345", balance: 5000, equity: 5100, margin: 200, freeMargin: 4900, leverage: 1000, positions: [], pendingOrders: [], results: [] }),
    });
    await res.json();
  } finally {
    server.close();
  }

  console.log("\n[3] The live-settings block Dave sees on the VERY NEXT turn genuinely includes the real leverage, not just balance...\n");
  const after = buildLiveSettingsBlock(USER);
  console.log(`    ${after.split("\n").find((l) => l.startsWith("Account:"))}`);
  assert.match(after, /Account:.*leverage 1:1000/, "leverage must genuinely be visible in the live context, proactively, every turn");
  assert.match(after, /balance 5000/);
  assert.match(after, /equity 5100/);

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
