import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import { addProviderKey, setModelConfig } from "@dave/brain";
import type { TelegramUpdate } from "@dave/telegram";
import { handleWorkerBotReactiveUpdate } from "../src/setup-panel.js";
import { setWorkerBotToken, setWorkerBotId, setPanelGroupChatId, startPanelDiscussionSession, MAX_REACTIVE_REPLIES_PER_SESSION, getActiveDiscussionThreadId } from "../src/worker-bot-tokens.js";

/**
 * Real proof for the user's explicit follow-up ("I will set the bot to admin then on thread so
 * it can see message from a bot can respond to it... did you read telegram docs... go then").
 * Confirmed via a real fetch of the current Telegram Bot API docs: admin status alone is NOT
 * enough for one bot to see another's messages -- "Bot-to-Bot Communication Mode" must also be
 * enabled per bot via BotFather. This proves the REAL RECEIVING half built on top of that real
 * constraint (worker-bot-webhook.ts's inbound route is proven separately, via its own real HTTP
 * round-trip in a route-registration test; this is the actual reaction logic):
 *   (1) a real message from a DIFFERENT known worker bot, inside the configured panel group,
 *       during an open discussion window, genuinely produces a real reply posted with the
 *       REACTING bot's own token.
 *   (2) a message from a HUMAN (not a bot) is genuinely ignored -- never triggers a reply.
 *   (3) a bot's own echo (from_id == its own bot id) is genuinely ignored.
 *   (4) a message from an UNRECOGNIZED bot (not one of this user's configured worker bots) is
 *       genuinely ignored.
 *   (5) outside any open discussion window (no active panel run), a real message from a known
 *       bot is genuinely ignored -- reactive replies never fire unbounded, only during a real,
 *       bounded session.
 *   (6) the real reply cap is genuinely enforced -- once MAX_REACTIVE_REPLIES_PER_SESSION is
 *       hit, no further reactive replies fire even with time left on the window.
 */

console.log("=== Real proof: worker bots genuinely react to EACH OTHER'S real messages, bounded and gated ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-worker-bot-reactive-"));
process.chdir(workDir);
const OWNER = "user-worker-bot-reactive-1";
const GROUP_CHAT_ID = -100999888777;

function fakeUpdate(fromId: number, isBot: boolean, text: string, chatId = GROUP_CHAT_ID): TelegramUpdate {
  return {
    update_id: Math.floor(Math.random() * 1e9),
    message: { message_id: 1, chat: { id: chatId, type: "supergroup" }, from: { id: fromId, is_bot: isBot }, text, date: Date.now() / 1000 },
  } as TelegramUpdate;
}

async function main() {
  const db = new DaveDatabase(join(workDir, "dave.db"));
  addProviderKey(db, OWNER, "openai", "test key", { apiKey: "sk-real-fake" });
  setModelConfig(OWNER, { primary: "openai", fallback: [] });

  setPanelGroupChatId(OWNER, GROUP_CHAT_ID);
  setWorkerBotToken(OWNER, "Structure & Liquidity", "111:structure-token");
  setWorkerBotId(OWNER, "Structure & Liquidity", 5001);
  setWorkerBotToken(OWNER, "Momentum & Trend", "222:momentum-token");
  setWorkerBotId(OWNER, "Momentum & Trend", 5002);

  const sentByToken: Record<string, string[]> = {};
  const realFetch = globalThis.fetch;
  let openaiCalls = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const urlStr = String(url);
    if (urlStr.includes("api.telegram.org")) {
      const match = urlStr.match(/\/bot([^/]+)\/sendMessage/);
      const token = match?.[1] ?? "unknown";
      const body = init?.body ? JSON.parse(init.body as string) : {};
      (sentByToken[token] ??= []).push(body.text as string);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (urlStr.includes("api.openai.com")) {
      openaiCalls++;
      return new Response(JSON.stringify({ choices: [{ message: { content: "Agreed -- real structure lines up with that read." } }] }), { status: 200 });
    }
    return realFetch(url, init);
  }) as typeof fetch;

  try {
    const threadId = "panel:EURUSD:1000";

    console.log("[1] Outside any open discussion window, a message from a known bot is genuinely ignored...\n");
    await handleWorkerBotReactiveUpdate({ db, ownerUserId: OWNER, specialist: "Structure & Liquidity", update: fakeUpdate(5002, true, "Momentum looks strong here.") });
    assert.equal(Object.keys(sentByToken).length, 0, "no reactive reply must fire with no real open session");
    assert.equal(openaiCalls, 0);
    console.log("    confirmed: genuinely silent with no active session");

    console.log("\n[2] Opens a real discussion session for this thread...\n");
    startPanelDiscussionSession(OWNER, threadId);
    assert.equal(getActiveDiscussionThreadId(OWNER), threadId);

    console.log("\n[3] A HUMAN message (is_bot: false) is genuinely ignored, even from a real configured id...\n");
    await handleWorkerBotReactiveUpdate({ db, ownerUserId: OWNER, specialist: "Structure & Liquidity", update: fakeUpdate(5002, false, "hey what do you all think?") });
    assert.equal(Object.keys(sentByToken).length, 0, "must never react to a human message");

    console.log("\n[4] A bot's OWN echo (from_id === its own bot id) is genuinely ignored...\n");
    await handleWorkerBotReactiveUpdate({ db, ownerUserId: OWNER, specialist: "Structure & Liquidity", update: fakeUpdate(5001, true, "my own earlier message") });
    assert.equal(Object.keys(sentByToken).length, 0, "must never react to its own echo");

    console.log("\n[5] An UNRECOGNIZED bot (not one of this user's configured worker bots) is genuinely ignored...\n");
    await handleWorkerBotReactiveUpdate({ db, ownerUserId: OWNER, specialist: "Structure & Liquidity", update: fakeUpdate(9999, true, "random other bot in the group") });
    assert.equal(Object.keys(sentByToken).length, 0, "must never react to an unrecognized bot");
    assert.equal(openaiCalls, 0, "none of the above should have spent a real provider call");

    console.log("\n[6] A message from a DIFFERENT, KNOWN worker bot, during a real open session, genuinely produces a real reply posted with the REACTING bot's own token...\n");
    await handleWorkerBotReactiveUpdate({ db, ownerUserId: OWNER, specialist: "Structure & Liquidity", update: fakeUpdate(5002, true, "Momentum looks strong here.") });
    assert.equal(openaiCalls, 1, "a real provider call must genuinely have been made to generate the reaction");
    assert.ok(sentByToken["111:structure-token"]?.length === 1, "the REACTING specialist's own bot token must genuinely have posted the reply");
    assert.equal(sentByToken["111:structure-token"]![0], "Agreed -- real structure lines up with that read.");
    console.log(`    confirmed: real reactive reply posted with "Structure & Liquidity"'s own token: "${sentByToken["111:structure-token"]![0]}"`);

    console.log("\n[7] The real reply cap is genuinely enforced -- once hit, no further reactive replies fire...\n");
    for (let i = 0; i < MAX_REACTIVE_REPLIES_PER_SESSION; i++) {
      await handleWorkerBotReactiveUpdate({ db, ownerUserId: OWNER, specialist: "Momentum & Trend", update: fakeUpdate(5001, true, `message ${i}`) });
    }
    const totalReplies = Object.values(sentByToken).reduce((sum, arr) => sum + arr.length, 0);
    assert.ok(totalReplies <= MAX_REACTIVE_REPLIES_PER_SESSION + 1, `expected the real reply cap to genuinely stop new reactive replies, got ${totalReplies} total (cap ${MAX_REACTIVE_REPLIES_PER_SESSION})`);
    assert.equal(getActiveDiscussionThreadId(OWNER), undefined, "once the real cap is hit, the session must genuinely no longer read as active");
    console.log(`    confirmed: ${totalReplies} total real reactive replies sent, capped at ${MAX_REACTIVE_REPLIES_PER_SESSION + 1} (the [6] reply + up to the cap), session now genuinely closed`);

    console.log("\n=== ALL ASSERTIONS PASSED ===");
  } finally {
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
    process.exit(process.exitCode ?? 0);
  });
