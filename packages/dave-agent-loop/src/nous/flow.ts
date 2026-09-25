import { coloredButton, keyboard, type InlineKeyboardMarkup } from "@dave/telegram";
import type { CommandRouterDeps } from "../command-router.js";
import { getNousConfig, listNousTrades, updateNousConfig, type NousChat } from "./store.js";
import { cancelNousLogin, isNousListening, listNousDialogs, nousLoginBegin, nousLoginCode, nousLoginPassword, nousLogout, stopNousListener } from "./userbot.js";
import { applyNousUpdate, closeNousTrade, ensureNousListening, nousDepsFor, nousLots, placeNousSignal, skipNousSignal, skipNousUpdate } from "./service.js";

/**
 * /nous -- set up and control Nous from Telegram. Like /mt5, the login is a fixed button-and-reply
 * flow handled before any message reaches the model: the api hash, the login code and the
 * two-step password are deleted from the chat the moment they're read and never enter the
 * conversation history.
 */

type Step = "apiId" | "apiHash" | "phone" | "code" | "password" | "lots" | "age";
interface Pending {
  step: Step;
  apiId?: number;
  apiHash?: string;
  at: number;
}
const pending = new Map<string, Pending>();
const PENDING_TTL_MS = 10 * 60_000;
/** The last dialog list shown, so a tap can carry a short index instead of a long chat id. */
const shownDialogs = new Map<string, NousChat[]>();
const PAGE = 8;

const key = (deps: CommandRouterDeps, chatId: number) => `${deps.userId}:${chatId}`;

function menu(userId: string): { text: string; markup: InlineKeyboardMarkup } {
  const c = getNousConfig(userId);
  const loggedIn = !!c.sessionEnc;
  const open = listNousTrades(userId).length;
  const lines = [
    "<b>Nous -- copy trading from your signal channels</b>",
    loggedIn ? `Telegram: ✅ ${escapeHtml(c.account ?? "connected")}${isNousListening(userId) ? " · listening" : " · not listening"}` : "Telegram: not connected",
    `Reading: ${c.chats.length ? escapeHtml(c.chats.map((x) => x.title).join(", ")) : "no channels picked yet"}`,
    `Approval: ${c.autoApprove ? "⚡ auto-approve ON -- signals are placed without asking" : "asks you Yes / No for every signal"}`,
    `Lots per signal: ${nousLots(userId)} · ignores signals older than ${c.maxAgeMinutes} min`,
    `Rules: TP1 first; at TP1 the stop goes to entry and the target to TP2. Losing 5 min or margin stretched → Dave checks if it's still valid.`,
    open ? `Open Nous trades: ${open}` : "",
  ].filter(Boolean);
  const rows = [[coloredButton(loggedIn ? "Reconnect Telegram" : "Connect Telegram", "green", "nous:login")]];
  if (loggedIn) rows.push([coloredButton("Pick channels & groups", "blue", "nous:chats:0")]);
  rows.push([coloredButton(c.autoApprove ? "Auto-approve: ON" : "Auto-approve: OFF", c.autoApprove ? "red" : "blue", "nous:auto"), coloredButton("Lot size", "blue", "nous:lots")]);
  rows.push([coloredButton("Max signal age", "blue", "nous:age"), coloredButton("Refresh", "blue", "nous:menu")]);
  if (loggedIn) rows.push([coloredButton("Log out of Telegram", "red", "nous:logout")]);
  return { text: lines.join("\n"), markup: keyboard(rows) };
}

export async function handleNous(deps: CommandRouterDeps, chatId: number, editMessageId?: number): Promise<void> {
  const m = menu(deps.userId);
  const params = { chat_id: chatId, text: m.text, parse_mode: "HTML" as const, reply_markup: m.markup };
  if (editMessageId) await deps.client.editMessageText({ ...params, message_id: editMessageId }).catch(() => deps.client.sendMessage(params));
  else await deps.client.sendMessage(params);
}

const LOGIN_HELP =
  "<b>Connect your Telegram to Nous</b>\n" +
  "Nous reads your signal channels by logging in as you -- a bot can't read channels you only follow. It only reads the channels and groups you pick next, never your private chats.\n\n" +
  "First you need your own API ID (free, one minute):\n" +
  "1. Open <b>my.telegram.org</b> in your browser and log in with your phone number.\n" +
  "2. Tap <b>API development tools</b>, fill in any app name (e.g. <code>Nous</code>) and short name, and create it.\n" +
  "3. You'll see <b>App api_id</b> (a number) and <b>App api_hash</b> (letters and numbers).\n\n" +
  "Send the <b>api_id</b> now.";

export async function handleNousCallback(deps: CommandRouterDeps, chatId: number, data: string, messageId?: number): Promise<void> {
  const k = key(deps, chatId);
  const say = (text: string, markup?: InlineKeyboardMarkup) => deps.client.sendMessage({ chat_id: chatId, text, parse_mode: "HTML", reply_markup: markup });
  const nous = nousDepsFor(deps.userId);

  const [, action, arg] = data.split(":");
  switch (action) {
    case "menu":
      return handleNous(deps, chatId, messageId);
    case "login":
      await stopNousListener(deps.userId); // a new login replaces the old session's connection
      pending.set(k, { step: "apiId", at: Date.now() });
      await say(LOGIN_HELP);
      return;
    case "auto": {
      const c = getNousConfig(deps.userId);
      updateNousConfig(deps.userId, { autoApprove: !c.autoApprove });
      await say(!c.autoApprove ? "⚡ Auto-approve is ON -- Nous places every fresh, still-valid signal without asking. It still skips old signals and ones whose entry has passed." : "Auto-approve is OFF -- Nous asks you Yes / No for every signal.");
      return handleNous(deps, chatId, messageId);
    }
    case "lots":
      pending.set(k, { step: "lots", at: Date.now() });
      await say(`Lots per copied signal? (now ${nousLots(deps.userId)}; e.g. <code>0.05</code>. Send <code>auto</code> to use Dave's fixed lot, or 0.01 when that's off.)`);
      return;
    case "age":
      pending.set(k, { step: "age", at: Date.now() });
      await say(`Ignore signals older than how many minutes? (now ${getNousConfig(deps.userId).maxAgeMinutes}; 1 to 60)`);
      return;
    case "logout":
      await nousLogout(deps.userId);
      await say("Logged out -- Nous stopped reading and the session is gone from Telegram's Devices list too.");
      return handleNous(deps, chatId);
    case "chats":
      return showDialogs(deps, chatId, Number(arg) || 0, messageId);
    case "t": {
      // toggle one chat: nous:t:<index>:<page>
      const [, , idx, page] = data.split(":");
      const chat = shownDialogs.get(k)?.[Number(idx)];
      if (!chat) return showDialogs(deps, chatId, 0, messageId);
      const c = getNousConfig(deps.userId);
      const on = c.chats.some((x) => x.id === chat.id);
      updateNousConfig(deps.userId, { chats: on ? c.chats.filter((x) => x.id !== chat.id) : [...c.chats, chat] });
      return showDialogs(deps, chatId, Number(page) || 0, messageId, true);
    }
    case "done": {
      const c = getNousConfig(deps.userId);
      let listening = false;
      try {
        listening = await ensureNousListening(deps.userId);
      } catch (err) {
        await say(`⚠️ ${escapeHtml(err instanceof Error ? err.message : String(err))}`);
      }
      await say(
        c.chats.length
          ? `📡 Nous is ${listening ? "now reading" : "set to read"}: ${escapeHtml(c.chats.map((x) => x.title).join(", "))}.\nNew signals will come here as a card to approve${c.autoApprove ? " (auto-approve is ON, so they'll be placed straight away)" : ""}.`
          : "No channels picked -- Nous won't read anything until you pick some.",
      );
      return;
    }
    case "y":
      if (nous && arg) await placeNousSignal(nous, arg);
      return;
    case "n":
      if (nous && arg) await skipNousSignal(nous, arg);
      return;
    case "uy":
      if (nous && arg) await applyNousUpdate(nous, arg);
      return;
    case "un":
      if (nous && arg) await skipNousUpdate(nous, arg);
      return;
    case "c":
      if (nous && arg) await closeNousTrade(nous, arg);
      return;
    case "k":
      await say(`👍 Keeping #${escapeHtml(arg ?? "")} open. I'll check again if it keeps losing.`);
      if (messageId) await deps.client.editMessageReplyMarkup({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
      return;
  }
}

async function showDialogs(deps: CommandRouterDeps, chatId: number, page: number, messageId?: number, edit = false): Promise<void> {
  const k = key(deps, chatId);
  let dialogs = shownDialogs.get(k);
  if (!dialogs || !edit) {
    try {
      dialogs = await listNousDialogs(deps.userId);
    } catch (err) {
      await deps.client.sendMessage({ chat_id: chatId, text: `⚠️ ${escapeHtml(err instanceof Error ? err.message : String(err))}`, parse_mode: "HTML" });
      return;
    }
    shownDialogs.set(k, dialogs);
  }
  const chosen = new Set(getNousConfig(deps.userId).chats.map((c) => c.id));
  const pages = Math.max(1, Math.ceil(dialogs.length / PAGE));
  const p = Math.min(Math.max(page, 0), pages - 1);
  const rows = dialogs.slice(p * PAGE, p * PAGE + PAGE).map((d, i) => [
    coloredButton(`${chosen.has(d.id) ? "✅" : "▫️"} ${d.kind === "channel" ? "📢" : "👥"} ${d.title}`.slice(0, 60), chosen.has(d.id) ? "green" : "neutral", `nous:t:${p * PAGE + i}:${p}`),
  ]);
  const nav = [];
  if (p > 0) nav.push(coloredButton("⬅️ Prev", "blue", `nous:chats:${p - 1}`));
  if (p < pages - 1) nav.push(coloredButton("Next ➡️", "blue", `nous:chats:${p + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([coloredButton("Done", "green", "nous:done")]);
  const text = `<b>Pick the signal channels & groups</b> (${chosen.size} picked) -- page ${p + 1}/${pages}\nOnly channels 📢 and groups 👥 are listed; your private chats are never read.`;
  const params = { chat_id: chatId, text, parse_mode: "HTML" as const, reply_markup: keyboard(rows) };
  if (edit && messageId) await deps.client.editMessageText({ ...params, message_id: messageId }).catch(() => undefined);
  else await deps.client.sendMessage(params);
}

/** The reply half of the flow. Returns true when the message belonged to it. */
export async function tryHandleNousEntry(deps: CommandRouterDeps, chatId: number, text: string, messageId: number): Promise<boolean> {
  const k = key(deps, chatId);
  const p = pending.get(k);
  if (!p) return false;
  if (Date.now() - p.at > PENDING_TTL_MS) {
    pending.delete(k);
    return false;
  }
  const value = text.trim();
  if (value.startsWith("/")) {
    pending.delete(k);
    cancelNousLogin(deps.userId);
    return false;
  }
  const say = (t: string) => deps.client.sendMessage({ chat_id: chatId, text: t, parse_mode: "HTML" });
  const forget = () => deps.client.deleteMessage({ chat_id: chatId, message_id: messageId }).catch(() => undefined);
  switch (p.step) {
    case "apiId": {
      const apiId = Number(value);
      if (!Number.isInteger(apiId) || apiId <= 0) {
        await say("The api_id is a number only (e.g. <code>1234567</code>). Send it again.");
        return true;
      }
      pending.set(k, { step: "apiHash", apiId, at: Date.now() });
      await say("Now the <b>api_hash</b>. I'll delete your message as soon as I've read it.");
      return true;
    }
    case "apiHash":
      await forget();
      if (!/^[0-9a-f]{32}$/i.test(value)) {
        await say("That doesn't look like an api_hash (32 letters and numbers). Send it again.");
        return true;
      }
      pending.set(k, { ...p, step: "phone", apiHash: value, at: Date.now() });
      await say("Got it (deleted). Now your <b>phone number</b> with country code, e.g. <code>+2348012345678</code>.");
      return true;
    case "phone": {
      const phone = value.replace(/[\s-]/g, "");
      if (!/^\+?\d{7,15}$/.test(phone)) {
        await say("Send the number with the country code, e.g. <code>+2348012345678</code>.");
        return true;
      }
      try {
        await nousLoginBegin(deps.userId, p.apiId!, p.apiHash!, phone);
      } catch (err) {
        pending.delete(k);
        await say(`⚠️ Telegram refused: ${escapeHtml(err instanceof Error ? err.message : String(err))}\nCheck the api_id/api_hash and start again from /nous.`);
        return true;
      }
      pending.set(k, { ...p, step: "code", at: Date.now() });
      await say(
        "Telegram just sent you a login code (in the Telegram app, from 'Telegram').\n\n" +
          "⚠️ Type it <b>with spaces between the digits</b>, like <code>1 2 3 4 5</code> -- Telegram cancels a code that's sent as a plain number in any chat. I'll delete it right away.",
      );
      return true;
    }
    case "code":
      await forget();
      try {
        const step = await nousLoginCode(deps.userId, value);
        if (!step.done) {
          pending.set(k, { ...p, step: "password", at: Date.now() });
          await say("Your account has two-step verification. Send that <b>password</b> (deleted right away).");
          return true;
        }
        pending.delete(k);
        await say(`✅ Connected as ${escapeHtml(step.account)}. Now pick the channels and groups to read.`);
        await showDialogs(deps, chatId, 0);
      } catch (err) {
        await say(`⚠️ ${escapeHtml(err instanceof Error ? err.message : String(err))}`);
        if (/expired/i.test(String(err))) pending.delete(k);
      }
      return true;
    case "password":
      await forget();
      try {
        const step = await nousLoginPassword(deps.userId, value);
        pending.delete(k);
        if (step.done) {
          await say(`✅ Connected as ${escapeHtml(step.account)}. Now pick the channels and groups to read.`);
          await showDialogs(deps, chatId, 0);
        }
      } catch (err) {
        await say(`⚠️ ${escapeHtml(err instanceof Error ? err.message : String(err))} Send it again.`);
      }
      return true;
    case "lots": {
      if (/^auto$/i.test(value)) {
        updateNousConfig(deps.userId, { lots: undefined });
      } else {
        const lots = Number(value.replace(",", "."));
        if (!(lots >= 0.01 && lots <= 100)) {
          await say("A lot size from 0.01 to 100, please (or <code>auto</code>).");
          return true;
        }
        updateNousConfig(deps.userId, { lots: Math.round(lots * 100) / 100 });
      }
      pending.delete(k);
      await say(`✅ Lots per copied signal: ${nousLots(deps.userId)}.`);
      return true;
    }
    case "age": {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 60) {
        await say("A whole number of minutes from 1 to 60.");
        return true;
      }
      pending.delete(k);
      updateNousConfig(deps.userId, { maxAgeMinutes: n });
      await say(`✅ Nous ignores signals older than ${n} min.`);
      return true;
    }
  }
  return false;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
