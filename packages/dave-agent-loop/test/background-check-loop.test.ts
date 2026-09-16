import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import { EaTradeExecutor } from "@dave/ea-bridge";
import { addProviderKey, setModelConfig } from "@dave/brain";
import { TelegramClient } from "@dave/telegram";
import { createBackgroundCheck, getBackgroundCheck } from "@dave/workers";
import { startBackgroundCheckPolling, stopBackgroundCheckPolling } from "../src/background-check-loop.js";

/**
 * Real, end-to-end proof for the background-check tool category: a real setInterval-backed
 * poller (registerPollingCheck, dave-db) driving a real multi-turn AgentLoop tick against a
 * mocked-at-the-HTTP-layer provider (same technique step72's worker-execution-engine test uses),
 * ending in a real Telegram message. `checkEveryMs` here is deliberately set BELOW
 * MIN_CHECK_EVERY_MS by constructing the `BackgroundCheck` record directly rather than through
 * the `start_background_check` tool -- that floor is a real, separately-proven contract of
 * `createBackgroundCheck` itself (background-check-tools.test.ts); this test's job is proving the
 * polling/tick/notify mechanism, which needs a fast interval to run in real wall-clock time.
 */
console.log("=== Real proof: the background-check polling engine actually runs ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-bg-check-"));
process.chdir(workDir);
const OWNER = "user-bg-check-1";
const CHAT_ID = 424242;

function waitFor(predicate: () => boolean, timeoutMs = 10_000, intervalMs = 20): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

const telegramMessages: string[] = [];
let openaiCallCount = 0;
let expiryTestActive = false; // toggled once the "met" scenario is done, so the expiry scenario's real openai calls (there should be none) are distinguishable

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const urlStr = String(url);

  if (urlStr.includes("api.telegram.org")) {
    const method = urlStr.split("/").pop() ?? "";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    if (method === "setWebhook" || method === "setMyCommands" || method === "setMyDescription" || method === "setMyShortDescription") {
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }
    if (body?.text) telegramMessages.push(body.text as string);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  }

  if (urlStr.includes("api.openai.com")) {
    openaiCallCount++;
    if (expiryTestActive) throw new Error("the expiry path must NEVER reach the provider -- the deadline check happens first");
    if (openaiCallCount === 1) {
      // The tick's real agent-loop run genuinely calls report_check_result -- not a hardcoded
      // "price >= X" comparator; this response is what a real reasoning round over `whatToCheck`
      // would produce.
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "call1",
                    type: "function",
                    function: { name: "report_check_result", arguments: JSON.stringify({ met: true, summary: "XAUUSD swept 2380.10 at the London open and reversed to 2384 within 15 minutes." }) },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "Reported the real finding." } }] }), { status: 200 });
  }

  return realFetch(url as any, init as any);
}) as typeof fetch;

async function main() {
  const db = new DaveDatabase(join(workDir, "dave.db"));
  addProviderKey(db, OWNER, "openai", "bg-check key", { apiKey: "sk-openai-fake", model: "gpt-bg-check-model" });
  setModelConfig(OWNER, { primary: "openai", fallback: [] });

  const executor = new EaTradeExecutor(OWNER);
  const client = new TelegramClient("000000:fake-token-for-transport-mock");
  const loopDeps = { db, ownerUserId: OWNER, analysis: {} as any, executor, client, chatId: CHAT_ID };

  // --- [1] a check firing resurfaces the original reason verbatim, alongside the real outcome ---
  console.log("[1] A check whose condition is genuinely met fires: Telegram gets BOTH the original reason AND the real outcome...");
  const REASON = "watching for XAUUSD to sweep the 2380 low before considering a reversal entry";
  const check = createBackgroundCheck(OWNER, { reason: REASON, whatToCheck: "has XAUUSD swept 2380 and reversed", maxDurationMs: 60_000 });
  startBackgroundCheckPolling(loopDeps, { ...check, checkEveryMs: 30 });

  await waitFor(() => getBackgroundCheck(OWNER, check.id)?.status === "met");
  const met = getBackgroundCheck(OWNER, check.id)!;
  console.log(`    real openai calls this tick: ${openaiCallCount} (report_check_result -> final text)`);
  assert.equal(openaiCallCount, 2, "a genuine two-turn round trip: the tool call, then the model's final text");
  assert.equal(met.status, "met");
  assert.match(met.outcome ?? "", /2380\.10/, "the real, concrete outcome must be captured, not a vague restatement");

  const metMessage = telegramMessages.find((m) => m.includes("2380.10"));
  assert.ok(metMessage, "the real Telegram message for the fired check must exist");
  assert.ok(metMessage!.includes(REASON), "the ORIGINAL reason must be resurfaced verbatim in the real notification");
  assert.ok(metMessage!.includes("2380.10"), "the real outcome must also be in the same notification");
  console.log(`    real Telegram message:\n    ---\n    ${metMessage!.replace(/\n/g, "\n    ")}\n    ---`);

  // --- [2] stop_background_check-equivalent: stopping cancels the real timer ---
  console.log("\n[2] Stopping a check tears down its real timer -- no further ticks ever fire...");
  const stopMe = createBackgroundCheck(OWNER, { reason: "will be cancelled", whatToCheck: "anything", maxDurationMs: 60_000 });
  let stopTicks = 0;
  startBackgroundCheckPolling({ ...loopDeps, client: { sendMessage: async () => { stopTicks++; return { message_id: 1 } as any; } } as any }, { ...stopMe, checkEveryMs: 30 });
  stopBackgroundCheckPolling(stopMe.id);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(stopTicks, 0, "no tick should ever fire once the poll is stopped");

  // --- [3] a check exceeding maxDurationMs auto-expires and notifies, WITHOUT ever calling the provider ---
  console.log("\n[3] A check whose deadline passes auto-expires and notifies -- never runs forever, never even needs a real tick...");
  expiryTestActive = true;
  const openaiCallsBeforeExpiry = openaiCallCount;
  const EXPIRE_REASON = "watching EURUSD for a breakout that never came";
  // maxDurationMs deliberately far shorter than checkEveryMs (rather than racing them close
  // together) so the very first real tick already finds the deadline passed -- deterministic,
  // not a timing race against when exactly the interval fires.
  const expiring = createBackgroundCheck(OWNER, { reason: EXPIRE_REASON, whatToCheck: "did EURUSD break 1.0950", maxDurationMs: 5 });
  startBackgroundCheckPolling(loopDeps, { ...expiring, checkEveryMs: 30 });

  await waitFor(() => getBackgroundCheck(OWNER, expiring.id)?.status === "expired");
  const expired = getBackgroundCheck(OWNER, expiring.id)!;
  assert.equal(expired.status, "expired");
  assert.equal(openaiCallCount, openaiCallsBeforeExpiry, "the deadline path must never reach the provider at all");
  const expiredMessage = telegramMessages.find((m) => m.includes(EXPIRE_REASON) && /timed out/i.test(m));
  assert.ok(expiredMessage, "a real timeout notification, including the original reason, must reach the user");
  console.log(`    real Telegram timeout message:\n    ---\n    ${expiredMessage!.replace(/\n/g, "\n    ")}\n    ---`);

  console.log("\n=== ALL ASSERTIONS PASSED ===");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    globalThis.fetch = realFetch;
    process.chdir(tmpdir());
    rmSync(workDir, { recursive: true, force: true });
  });
