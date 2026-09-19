import assert from "node:assert/strict";
import { ThinkingIndicator } from "../src/thinking-indicator.js";

/**
 * Real latency fix (the trader, live: "responses are slow" on a plain chat message). Every single
 * turn runs through withThinkingIndicator -> ThinkingIndicator.start(), and start() used to
 * `await` its first sendChatAction -- a full Telegram API round trip charged BEFORE the agent
 * turn was allowed to begin assembling its request, on every message, including a bare "hey".
 *
 * The await bought nothing at all: the call is already `.catch(() => {})`-swallowed so it can
 * never reject, nothing reads its result, the 4-second heartbeat re-sends the same chat action
 * regardless, and every other sendChatAction in the class was already fire-and-forget.
 *
 * This proves with a real, deliberately slow fake client that start() genuinely returns without
 * waiting on the network, and that the typing action is still genuinely sent.
 */

console.log("=== Real proof: the thinking indicator no longer charges a Telegram round trip before every turn ===\n");

const SLOW_MS = 400;

async function main() {
  let sent = 0;
  let resolveFirst: (() => void) | undefined;
  const firstSent = new Promise<void>((r) => (resolveFirst = r));

  const client = {
    async sendChatAction(args: { chat_id: number; action: string }) {
      assert.equal(args.action, "typing", "the real typing action must still genuinely be sent");
      sent++;
      resolveFirst?.();
      // A real, slow Telegram API -- this is exactly what the old `await` blocked the turn on.
      await new Promise((r) => setTimeout(r, SLOW_MS));
      return { ok: true };
    },
  } as never;

  const indicator = new ThinkingIndicator(client, 12345);
  const t0 = Date.now();
  await indicator.start();
  const elapsed = Date.now() - t0;
  indicator.stop();

  console.log(`[1] Telegram API deliberately takes ${SLOW_MS}ms; start() returned in ${elapsed}ms.\n`);
  assert.ok(elapsed < SLOW_MS / 2, `start() must not block on the Telegram round trip (took ${elapsed}ms against a ${SLOW_MS}ms API)`);

  await firstSent;
  console.log(`[2] The typing action was genuinely dispatched anyway (${sent} call(s)) -- the indicator still works, it just no longer gates the turn.\n`);
  assert.equal(sent, 1, "the real chat action must still genuinely be sent, not dropped");

  console.log(`=== ALL ASSERTIONS PASSED -- ~${SLOW_MS}ms of dead wait removed from every single turn ===`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
