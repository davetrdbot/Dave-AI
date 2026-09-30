import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The trader's list (live, 30 Sep): "scan skipped" posted to Live every 2 minutes all night; the
 * backup pair group couldn't be turned off; plus two ideas taken from Hermes Agent -- Dave stops
 * retrying a call that keeps failing and explains why, and past conversations are searched by
 * words, not only the exact phrase.
 */

const workDir = mkdtempSync(join(tmpdir(), "dave-step192-"));
process.chdir(workDir);
process.env.DAVE_DATA_ROOT = join(workDir, "data");

const { ToolRegistry, adaptTools, AgentLoop } = await import("../src/index.js");
const { publishSkipOnce, noteScanResumed } = await import("../src/telegram-bot-server.js");
const { activityAfter } = await import("../src/activity-bus.js");
const { recordTurn, searchSessions } = await import("@dave/memory");
const { clearFallbackGroup, ensureGroupsUsable, getActiveGroupInfo, setFallbackGroup } = await import("@dave/trading");

try {
  console.log("[1] 'Scan skipped' reaches Live once per reason, not every tick\n");
  const U = "skip-user";
  for (let i = 0; i < 5; i++) publishSkipOnce(U, "EA is not connected, no live data to analyze");
  publishSkipOnce(U, "an unanswered question is still pending (asked 3m ago)");
  publishSkipOnce(U, "an unanswered question is still pending (asked 5m ago)"); // same reason, new number
  let events = activityAfter(U, 0).filter((e) => e.kind === "cycle_skip");
  assert.equal(events.length, 2, "one line per distinct reason");
  noteScanResumed(U);
  noteScanResumed(U);
  const resumed = activityAfter(U, 0).filter((e) => e.kind === "log" && (e.data as { text?: string }).text === "Back to scanning");
  assert.equal(resumed.length, 1, "one 'back to scanning' when scans run again");
  publishSkipOnce(U, "EA is not connected, no live data to analyze");
  events = activityAfter(U, 0).filter((e) => e.kind === "cycle_skip");
  assert.equal(events.length, 3, "after scanning resumed, a new outage is shown again");
  console.log("   ✓\n");

  console.log("[2] Loop guard: the same failing call isn't run a 3rd time; Dave is told to explain\n");
  let runs = 0;
  const registry = new ToolRegistry();
  registry.register(
    adaptTools(
      [
        {
          name: "get_price",
          description: "price",
          parameters: { type: "object", properties: { symbol: { type: "string" } } },
          execute: async () => {
            runs++;
            throw new Error("EA is offline");
          },
        },
      ],
      {}
    )
  );
  let call = 0;
  let lastToolResult = "";
  const provider = {
    async generate(req: { messages: { role: string; content?: string }[] }) {
      const lastTool = req.messages.filter((m) => m.role === "tool").at(-1);
      if (lastTool?.content) lastToolResult = lastTool.content;
      call++;
      if (call <= 3) return { text: "", toolCalls: [{ id: `c${call}`, name: "get_price", arguments: { symbol: "VOL_10" } }] };
      return { text: "I couldn't get the price: MT5 is offline." };
    },
  };
  const loop = new AgentLoop(provider as never, registry);
  const result = await loop.run([{ role: "user", content: "price of VOL_10?" }], { timeoutMs: 5_000 });
  assert.equal(result.status, "done");
  assert.equal(runs, 2, "the tool really ran twice, not three times");
  assert.match(lastToolResult, /not_retried/);
  assert.match(lastToolResult, /EA is offline/, "the real error is passed on so Dave can explain it");
  console.log("   ✓\n");

  console.log("[3] Session search by words in any order, best first, with date and snippet\n");
  const S = "search-user";
  recordTurn(S, "user", "Move the stop loss on gold to breakeven please");
  recordTurn(S, "dave", "Done -- XAUUSD stop is at entry now.");
  recordTurn(S, "user", "What is the spread on VOL_10?");
  const hits = searchSessions(S, "gold stop loss");
  assert.equal(hits.length, 1);
  assert.match(hits[0].turn.text, /stop loss on gold/);
  assert.ok(hits[0].date.endsWith("Z") && hits[0].snippet.includes("gold"));
  assert.equal(searchSessions(S, "stop loss on gold")[0].index, 0, "the exact phrase still works");
  assert.equal(searchSessions(S, "silver").length, 0);
  console.log("   ✓\n");

  console.log("[4] The backup pair group can be turned off, and stays off\n");
  const G = "group-user";
  ensureGroupsUsable(G);
  assert.ok(getActiveGroupInfo(G).fallbackGroup, "a default backup group to begin with");
  clearFallbackGroup(G);
  ensureGroupsUsable(G);
  assert.equal(getActiveGroupInfo(G).fallbackGroup, null, "'None' is not quietly replaced by the default");
  setFallbackGroup(G, "fallback");
  assert.equal(getActiveGroupInfo(G).fallbackGroup?.id, "fallback");
  console.log("   ✓\n");

  console.log("=== step192: ALL ASSERTIONS PASSED ===");
} finally {
  process.chdir(tmpdir());
  rmSync(workDir, { recursive: true, force: true });
}
process.exit(0);
