import { coloredButton, keyboard, type InlineKeyboardMarkup } from "@dave/telegram";
import {
  getMt5CloudAgent,
  mt5CloudStatus,
  mt5CloudConnect,
  mt5CloudSettings,
  mt5CloudRestart,
  describeMt5CloudStatus,
  parseMarketWatch,
  type Mt5CloudStatus,
} from "@dave/ea-bridge";
import { getActiveGroupInfo } from "@dave/trading";
import type { CommandRouterDeps } from "./command-router.js";

/**
 * /mt5 -- MetaTrader 5 in Dave's own container, set up from Telegram (the trader: "the bot asks
 * you MT5 credentials and logs in, then loads the EA, and the MT5 settings can be adjusted").
 *
 * Credentials never go near the model: this is a fixed button-and-reply flow, handled before any
 * message reaches the agent loop. The password message is deleted the moment it's read, is held
 * only in this process's memory until it's sent to the container, and is never written to the
 * conversation history or to disk on the bot side (the container keeps it -- it has to, to log in).
 */

type Step = "login" | "password" | "server" | "symbol" | "push" | "marketwatch";
interface Pending {
  step: Step;
  login?: string;
  password?: string;
  at: number;
}

/** Process memory only, on purpose -- see the header. Expires so a half-finished flow can't
 *  swallow an unrelated message hours later. */
const pending = new Map<string, Pending>();
const PENDING_TTL_MS = 10 * 60_000;

function key(deps: CommandRouterDeps, chatId: number): string {
  return `${deps.userId}:${chatId}`;
}

function menu(status: Mt5CloudStatus | undefined, hasAgent: boolean): InlineKeyboardMarkup {
  if (!hasAgent) return keyboard([[coloredButton("Refresh", "blue", "mt5c:refresh")]]);
  const rows = [[coloredButton(status?.configured ? "Change account" : "Connect account", "green", "mt5c:connect")]];
  if (status?.configured) {
    rows.push([coloredButton("Market Watch pairs", "blue", "mt5c:mw")]);
    rows.push([coloredButton("Chart symbol", "blue", "mt5c:symbol"), coloredButton("Timeframe", "blue", "mt5c:period")]);
    rows.push([coloredButton("Report interval", "blue", "mt5c:push"), coloredButton("Restart MT5", "blue", "mt5c:restart")]);
  }
  rows.push([coloredButton("Refresh", "blue", "mt5c:refresh")]);
  return keyboard(rows);
}

const SETUP_TEXT =
  "<b>MT5 in Dave's container</b>\n" +
  "MetaTrader 5 runs next to me with my EA already attached, so you don't need a Windows VPS.\n\n" +
  "It isn't set up on this server yet: the MT5 service has to be added next to me first (mt5/README.md). Once it is, all you do here is enter your MT5 login, password and server.";

export async function handleMt5Cloud(deps: CommandRouterDeps, chatId: number, editMessageId?: number): Promise<void> {
  const hasAgent = !!getMt5CloudAgent(deps.userId);
  let text: string;
  let status: Mt5CloudStatus | undefined;
  if (!hasAgent) {
    text = SETUP_TEXT;
  } else {
    try {
      status = await mt5CloudStatus(deps.userId);
      text = `<b>MT5 in Dave's container</b>\n${describeMt5CloudStatus(status)}`;
    } catch (err) {
      text = `<b>MT5 in Dave's container</b>\n${escapeHtml(err instanceof Error ? err.message : String(err))}`;
    }
  }
  const params = { chat_id: chatId, text, parse_mode: "HTML" as const, reply_markup: menu(status, hasAgent) };
  if (editMessageId) await deps.client.editMessageText({ ...params, message_id: editMessageId }).catch(() => deps.client.sendMessage(params));
  else await deps.client.sendMessage(params);
}

export async function handleMt5Callback(deps: CommandRouterDeps, chatId: number, data: string, messageId?: number): Promise<void> {
  const k = key(deps, chatId);
  const ask = (text: string) => deps.client.sendMessage({ chat_id: chatId, text, parse_mode: "HTML" });
  switch (data) {
    case "mt5c:refresh":
      return handleMt5Cloud(deps, chatId, messageId);
    case "mt5c:connect":
      pending.set(k, { step: "login", at: Date.now() });
      await ask("Send your MT5 <b>account number</b> (the login).");
      return;
    case "mt5c:symbol":
      pending.set(k, { step: "symbol", at: Date.now() });
      await ask("Send the symbol for the EA's chart, exactly as your broker names it (e.g. <code>VOL_80</code> or <code>EURUSD</code>). The EA analyses every symbol Dave asks for regardless -- this is just the chart it sits on.");
      return;
    case "mt5c:mw": {
      pending.set(k, { step: "marketwatch", at: Date.now() });
      const group = activeGroupSymbols(deps.userId);
      const current = await mt5CloudStatus(deps.userId).then((st) => st.marketWatch ?? [], () => []);
      await deps.client.sendMessage({
        chat_id: chatId,
        text:
          "<b>Market Watch</b>\n" +
          `Now: ${current.length ? escapeHtml(current.join(", ")) : "only the EA's chart"}\n\n` +
          "Send the pairs MT5 should have, separated by commas (e.g. <code>VOL_80, BOOM_100, EURUSD</code>), exactly as your broker names them. Each one goes into Market Watch and gets its own chart. This replaces the list.",
        parse_mode: "HTML",
        reply_markup: group.length ? keyboard([[coloredButton(`Use my pair group (${group.length})`, "green", "mt5c:mw:group")]]) : undefined,
      });
      return;
    }
    case "mt5c:mw:group": {
      pending.delete(k);
      const group = activeGroupSymbols(deps.userId);
      if (!group.length) {
        await ask("Your active pair group is empty -- send the pairs instead.");
        return;
      }
      await runAndReport(deps, chatId, `Loading ${escapeHtml(group.join(", "))} into MT5's Market Watch...`, () => mt5CloudSettings(deps.userId, { marketWatch: group.slice(0, 30) }));
      return;
    }
    case "mt5c:push":
      pending.set(k, { step: "push", at: Date.now() });
      await ask("How often should the EA report, in seconds? (2 to 120; 8 is the usual.)");
      return;
    case "mt5c:period":
      await deps.client.sendMessage({
        chat_id: chatId,
        text: "Timeframe for the EA's chart:",
        reply_markup: keyboard([["M1", "M5", "M15", "H1"].map((p) => coloredButton(p, "blue", `mt5c:period:${p}`))]),
      });
      return;
    case "mt5c:restart":
      await runAndReport(deps, chatId, "Restarting MT5...", () => mt5CloudRestart(deps.userId));
      return;
  }
  const period = /^mt5c:period:(M1|M5|M15|H1)$/.exec(data)?.[1];
  if (period) await runAndReport(deps, chatId, `Moving the EA to ${period}...`, () => mt5CloudSettings(deps.userId, { period }));
}

/** The reply half of the flow. Returns true when the message belonged to it. */
export async function tryHandleMt5Entry(deps: CommandRouterDeps, chatId: number, text: string, messageId: number): Promise<boolean> {
  const k = key(deps, chatId);
  const p = pending.get(k);
  if (!p) return false;
  if (Date.now() - p.at > PENDING_TTL_MS) {
    pending.delete(k);
    return false;
  }
  const value = text.trim();
  const say = (t: string) => deps.client.sendMessage({ chat_id: chatId, text: t, parse_mode: "HTML" });
  if (value.startsWith("/")) {
    pending.delete(k); // a command cancels the flow
    return false;
  }
  switch (p.step) {
    case "login":
      if (!/^\d{3,20}$/.test(value)) {
        await say("That doesn't look like an account number -- it's digits only. Send it again, or /mt5 to start over.");
        return true;
      }
      pending.set(k, { ...p, step: "password", login: value, at: Date.now() });
      await say("Now the <b>password</b> for that account. I'll delete your message as soon as I've read it; it goes only to your MT5 container, never into our chat history or to the AI.");
      return true;
    case "password":
      await deps.client.deleteMessage({ chat_id: chatId, message_id: messageId }).catch(() => undefined);
      pending.set(k, { ...p, step: "server", password: value, at: Date.now() });
      await say("Got it (message deleted). Last one: the <b>server</b> name exactly as MT5 shows it at login, e.g. <code>Deriv-Demo</code> or <code>DerivSVG-Server</code>.");
      return true;
    case "server": {
      pending.delete(k);
      const group = activeGroupSymbols(deps.userId);
      const symbol = group[0] ?? "EURUSD";
      // Market Watch starts as the pairs Dave trades; /mt5 -> Market Watch pairs changes it.
      await runAndReport(deps, chatId, `Connecting ${p.login} on ${escapeHtml(value)}... compiling the EA and starting MT5. This can take a couple of minutes.`, () =>
        mt5CloudConnect(deps.userId, { login: p.login!, password: p.password!, server: value, symbol, marketWatch: group.slice(0, 30) }),
      );
      return true;
    }
    case "symbol":
      if (!/^[A-Za-z0-9_.#+-]{1,32}$/.test(value)) {
        await say("That doesn't look like a symbol. Send it again, e.g. VOL_80.");
        return true;
      }
      pending.delete(k);
      await runAndReport(deps, chatId, `Moving the EA to ${escapeHtml(value)}...`, () => mt5CloudSettings(deps.userId, { symbol: value }));
      return true;
    case "marketwatch": {
      let pairs: string[];
      try {
        pairs = parseMarketWatch(value);
      } catch (err) {
        await say(`${escapeHtml(err instanceof Error ? err.message : String(err))} Send the pairs again, separated by commas.`);
        return true;
      }
      if (!pairs.length) {
        await say("Send at least one pair, e.g. <code>VOL_80, EURUSD</code>.");
        return true;
      }
      pending.delete(k);
      await runAndReport(deps, chatId, `Loading ${escapeHtml(pairs.join(", "))} into MT5's Market Watch...`, () => mt5CloudSettings(deps.userId, { marketWatch: pairs }));
      return true;
    }
    case "push": {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 2 || n > 120) {
        await say("A whole number of seconds from 2 to 120, please.");
        return true;
      }
      pending.delete(k);
      await runAndReport(deps, chatId, `Setting the report interval to ${n}s...`, () => mt5CloudSettings(deps.userId, { inputs: { PushSeconds: n } }));
      return true;
    }
  }
  return false;
}

/** Runs a container action, then waits for the terminal to settle and reports what it says. */
async function runAndReport(deps: CommandRouterDeps, chatId: number, working: string, action: () => Promise<{ ok: boolean; error?: string; compileLog?: string }>): Promise<void> {
  await deps.client.sendMessage({ chat_id: chatId, text: working, parse_mode: "HTML" });
  let result;
  try {
    result = await action();
  } catch (err) {
    await deps.client.sendMessage({ chat_id: chatId, text: `⚠️ ${escapeHtml(err instanceof Error ? err.message : String(err))}`, parse_mode: "HTML" });
    return;
  }
  if (!result.ok) {
    const log = result.compileLog ? `\n\n<pre>${escapeHtml(result.compileLog.slice(-600))}</pre>` : "";
    await deps.client.sendMessage({ chat_id: chatId, text: `⚠️ ${escapeHtml(result.error ?? "The container refused.")}${log}`, parse_mode: "HTML" });
    return;
  }
  // Logging in takes a few seconds after the terminal starts; answer with what actually happened.
  let status: Mt5CloudStatus | undefined;
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    status = await mt5CloudStatus(deps.userId).catch(() => undefined);
    if (status && (status.login === "logged-in" || status.login === "failed")) break;
  }
  await handleMt5Cloud(deps, chatId);
}

/** The active pair group -- the markets Dave actually trades. */
function activeGroupSymbols(userId: string): string[] {
  try {
    return [...(getActiveGroupInfo(userId).effectiveSymbols ?? [])];
  } catch {
    return [];
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
