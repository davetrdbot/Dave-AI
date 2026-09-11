import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  DAVE_COMMANDS,
  isDaveCommand,
  parseCommand,
  fmt,
  table,
  coloredButton,
  settingsScreen,
  personalizeEaFile,
  botProfilePhotoInstructions,
  TelegramClient,
  TelegramError,
} from "../src/index.js";

const DATA_DIR = join(process.cwd(), "data");
rmSync(DATA_DIR, { recursive: true, force: true });

console.log("=== Step 8 real proof: Telegram Bot Core ===\n");
console.log("No live bot token is configured yet (deferred per your call to test with a real bot later).");
console.log("This proves every buildable piece for real: command registry, real HTML formatting output,");
console.log("real button/keyboard JSON shapes, real .mq5 personalization against Step 4's real webhook");
console.log("infra, and one real (unauthenticated) network round-trip to the actual Telegram API proving");
console.log("this client genuinely talks to api.telegram.org, not a stub.\n");

// --- 8.1: the 9 original screen commands, plus /menu, plus the 3 real trading on/off/kill commands ---
console.log("[1] Exactly the required commands, nothing else...");
const names = DAVE_COMMANDS.map((c) => c.command).sort();
console.log(`    ${names.join(", ")}`);
assert.deepEqual(names, ["account", "connection", "ea", "help", "menu", "models", "panic", "providers", "reset", "settings", "start_trading", "status", "stop_trading", "trades"].sort());
assert.equal(isDaveCommand("/status"), true);
assert.equal(isDaveCommand("/notacommand"), false);
assert.equal(isDaveCommand("just chatting"), false);
const parsed = parseCommand("/settings some args here");
console.log(`    parseCommand("/settings some args here") -> ${JSON.stringify(parsed)}`);
assert.deepEqual(parsed, { command: "settings", args: "some args here" });

// --- 8.2: real rich formatting output ---
console.log("\n[2] Real HTML formatting output for every required type...");
console.log(`    bold:                  ${fmt.bold("EURUSD long")}`);
console.log(`    italic:                ${fmt.italic("unconfirmed")}`);
console.log(`    underline:             ${fmt.underline("important")}`);
console.log(`    strikethrough:         ${fmt.strikethrough("old SL")}`);
console.log(`    spoiler:               ${fmt.spoiler("entry: 1.0850")}`);
console.log(`    code:                  ${fmt.code("BUY 0.5 lots")}`);
console.log(`    pre:                   ${fmt.pre("multi\\nline")}`);
console.log(`    blockquote:            ${fmt.blockquote("reasoning here")}`);
console.log(`    expandable blockquote: ${fmt.expandableBlockquote("long reasoning here")}`);
console.log(`    link:                  ${fmt.link("Dave", "https://example.com")}`);
console.log(`    mention:               ${fmt.mention("David", 847213)}`);
console.log(`    customEmoji:           ${fmt.customEmoji("📈", "5368324170671202286")}`);
console.log(`    heading:               ${fmt.heading("Trade Summary")}`);
console.log(`    list:                  ${fmt.list(["SL set", "TP set"]).replace("\n", " | ")}`);
assert.equal(fmt.bold("x"), "<b>x</b>");
assert.equal(fmt.spoiler("x"), "<tg-spoiler>x</tg-spoiler>");
assert.equal(fmt.expandableBlockquote("x"), "<blockquote expandable>x</blockquote>");
assert.equal(fmt.mention("David", 1), '<a href="tg://user?id=1">David</a>');
assert.equal(fmt.bold("<script>"), "<b>&lt;script&gt;</b>", "must escape user content to avoid breaking HTML parse_mode");

console.log("\n[2b] Table rendering (no native Telegram table -- monospace <pre>, the real workaround)...");
const tbl = table(["Pair", "Side", "Lots"], [["EURUSD", "BUY", "0.50"], ["XAUUSD", "SELL", "0.10"]]);
console.log(tbl);
assert.match(tbl, /<pre>/);
assert.match(tbl, /EURUSD/);

// --- 8.3: colored buttons (real native "style" field, corrected during audit) ---
console.log("\n[3] Colored inline buttons -- real native `style` field (danger/success/primary)...");
const confirmBtn = coloredButton("Confirm trade", "green", "trade:confirm");
const cancelBtn = coloredButton("Cancel", "red", "trade:cancel");
console.log(`    ${JSON.stringify(confirmBtn)}`);
console.log(`    ${JSON.stringify(cancelBtn)}`);
assert.equal(confirmBtn.style, "success");
assert.equal(cancelBtn.style, "danger");
assert.equal(confirmBtn.text, "Confirm trade", "no emoji-prefix workaround needed now that style is real");

console.log("\n[3b] callback_data length is validated against Telegram's real 1-64 byte limit...");
let rejected = false;
try {
  coloredButton("x", "blue", "a".repeat(65));
} catch {
  rejected = true;
}
assert.equal(rejected, true);

// --- 8.4: settings-screen pattern ---
console.log("\n[4] Settings-screen pattern: two per row, live state, checkmark, Back row...");
const screen = settingsScreen(
  [
    [{ label: "SL: Off", callbackData: "sl:off", active: false }, { label: "SL: On", callbackData: "sl:on", active: true }],
    [{ label: "TP: Off", callbackData: "tp:off", active: true }, { label: "TP: On", callbackData: "tp:on", active: false }],
  ],
  "settings:back"
);
console.log(`    ${JSON.stringify(screen)}`);
assert.equal(screen.inline_keyboard.length, 3, "2 option rows + 1 back row");
assert.equal(screen.inline_keyboard[0].length, 2, "two buttons per row");
assert.match(screen.inline_keyboard[0][1].text, /^✅/, "the active option must carry the checkmark");
assert.equal(screen.inline_keyboard[2][0].text, "⬅️ Back");

// --- 8.5: personalized .mq5 using Step 4's real webhook infra ---
console.log("\n[5] Personalized EA file -- real template, real webhook URL + token substitution...");
const USER_ID = "tg-847213";
const ea = personalizeEaFile(USER_ID, "https://dave.example.com");
console.log(`    webhookUrl: ${ea.webhookUrl}`);
console.log(`    token:      ${ea.token}`);
assert.match(ea.webhookUrl, /^https:\/\/dave\.example\.com\/hooks\/ea\/DAVE-tg-847213-[0-9A-F]{8}$/, "must use the real EA-bridge webhook (/hooks/ea/<token>), not the generic hidden webhook -- that mismatch was the real /account-shows-nothing bug -- and the real DAVE-<userId>-<suffix> revocable token format");
assert.ok(!ea.content.includes("{{WEBHOOK_URL}}"), "no leftover placeholders");
assert.ok(!ea.content.includes("{{TOKEN}}"), "no leftover placeholders");
assert.ok(ea.content.includes(ea.webhookUrl), "the real URL must actually be in the file");
assert.ok(ea.content.includes(ea.token), "the real token must actually be in the file");
console.log("    no leftover template placeholders, real values present in the generated file");

// --- 8.7: honest profile-photo boundary ---
console.log("\n[6] Bot profile photo (8.7) -- honest about the real API boundary...");
const instructions = botProfilePhotoInstructions();
console.log(`    "${instructions}"`);
assert.match(instructions, /BotFather/);
assert.match(instructions, /doesn't exist/);

// --- Real network round-trip to the actual Telegram API ---
console.log("\n[7] Real HTTP round-trip to the real api.telegram.org (invalid token, proves genuine integration)...");
const client = new TelegramClient("000000:invalid-token-for-real-network-test");
let telegramError: TelegramError | undefined;
try {
  await client.getMe();
} catch (err) {
  if (err instanceof TelegramError) telegramError = err;
}
console.log(`    real response from Telegram's real servers: ${telegramError?.message}`);
assert.ok(telegramError, "a real call to the real API must come back as a real, typed error for an invalid token");
assert.equal(telegramError!.errorCode, 401);

console.log(
  "\n    NOTE: full live-message rendering (what the formatting/buttons/reply-with-quote actually look\n" +
    "    like in a real chat) is deferred until you provide a real bot token, per your instruction to\n" +
    "    test that later. Every piece above is real, buildable proof in the meantime -- not a mock."
);

rmSync(DATA_DIR, { recursive: true, force: true });

console.log("\n=== ALL ASSERTIONS PASSED ===");
