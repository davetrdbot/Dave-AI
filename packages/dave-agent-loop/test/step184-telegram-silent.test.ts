import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.DAVE_DATA_ROOT = mkdtempSync(join(tmpdir(), "dave-silent-"));

// A stand-in Bot API that records every method that reaches it.
const hits: string[] = [];
const server = createServer((req, res) => {
  const method = String(req.url).split("/").pop()!;
  hits.push(method);
  req.resume();
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, result: method === "getMe" ? { id: 1, username: "dave_bot" } : { message_id: 42 } }));
  });
});
await new Promise<void>((r) => server.listen(0, r));
process.env.TELEGRAM_API_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const { TelegramClient, setTelegramSilenced, getTelegramSilence } = await import("@dave/telegram");
const { withLiveContext } = await import("../src/live-context.js");

const bot = new TelegramClient("TEST:bot");
bot.silenceable = true;
const other = new TelegramClient("TEST:other");

// Off by default: everything goes through.
assert.equal(getTelegramSilence().silent, false);
assert.equal((await bot.sendMessage({ chat_id: 5, text: "hi" })).message_id, 42);
assert.deepEqual(hits, ["sendMessage"]);

// Silenced: the bot's own client sends nothing, but reads still work.
hits.length = 0;
const s = setTelegramSilenced(true);
assert.equal(s.silent, true);
assert.ok(s.since);
const muted = await bot.sendMessage({ chat_id: 5, text: "should never arrive" });
assert.equal(muted.message_id, 0, "a muted send looks like a sent message to its caller");
await bot.editMessageText({ chat_id: 5, message_id: 0, text: "edit" });
await bot.sendChatAction({ chat_id: 5, action: "typing" });
await bot.sendDocument({ chat_id: 5, document: { buffer: Buffer.from("x"), filename: "a.txt" } });
await bot.pinChatMessage({ chat_id: 5, message_id: 1 });
assert.deepEqual(hits, [], "no outbound call reached Telegram");
await bot.getMe();
assert.deepEqual(hits, ["getMe"], "reading still works");

// Pairing codes and the admin panel use their own clients -- never muted.
hits.length = 0;
await other.sendMessage({ chat_id: 5, text: "your code" });
assert.deepEqual(hits, ["sendMessage"]);

// Dave is told, so he answers in the app instead of calling send_telegram.
const ctx = withLiveContext("silent-user", "hello");
assert.match(typeof ctx === "string" ? ctx : JSON.stringify(ctx), /TELEGRAM IS SILENCED/);

// Back on: sends again straight away.
hits.length = 0;
setTelegramSilenced(false);
await bot.sendMessage({ chat_id: 5, text: "back" });
assert.deepEqual(hits, ["sendMessage"]);
assert.doesNotMatch(String(withLiveContext("silent-user", "hello")), /TELEGRAM IS SILENCED/);

server.close();
console.log("step184 telegram silent: ok");
