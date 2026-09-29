import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Telegram silent mode (the trader: "turn off the telegram bot from the app ... no message will
 * be sent again to the telegram bot"). While it's on, the bot's own client drops everything that
 * would put something in a Telegram chat -- messages, files, edits, reactions, pins, "typing..." --
 * and Dave carries on in the app only. Reading (updates, getMe, files) keeps working, so turning it
 * back off is instant and nothing is lost: the conversation is shared with the app.
 *
 * One flag per deployment (one bot, one owner), in a file the admin panel and the bot both see.
 */

export interface TelegramSilence {
  silent: boolean;
  since: number | null;
}

function path(): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "telegram", "silent.json");
}

let cache: { at: number; value: TelegramSilence } | null = null;
const CACHE_MS = 2_000;

export function getTelegramSilence(now = Date.now()): TelegramSilence {
  if (cache && now - cache.at < CACHE_MS) return cache.value;
  let value: TelegramSilence = { silent: false, since: null };
  try {
    if (existsSync(path())) {
      const raw = JSON.parse(readFileSync(path(), "utf8")) as Partial<TelegramSilence>;
      value = { silent: raw.silent === true, since: typeof raw.since === "number" ? raw.since : null };
    }
  } catch {
    /* a broken file is "not silent" -- never lose messages to a bad write */
  }
  cache = { at: now, value };
  return value;
}

export const isTelegramSilenced = () => getTelegramSilence().silent;

export function setTelegramSilenced(silent: boolean, now = Date.now()): TelegramSilence {
  const value: TelegramSilence = { silent, since: silent ? (getTelegramSilence(now).silent ? getTelegramSilence(now).since : now) : null };
  mkdirSync(dirname(path()), { recursive: true });
  writeFileSync(path(), JSON.stringify(value), "utf8");
  cache = { at: now, value };
  return value;
}

/** Bot API methods that put something in a chat. */
const OUTBOUND = /^(send|edit|forward|copy|pin|unpin|setMessageReaction|deleteMessageReaction|stopPoll)/;

export const isOutboundMethod = (method: string) => OUTBOUND.test(method);

/** What a muted call returns instead of reaching Telegram: shaped like a sent message, so callers
 *  that read `message_id` carry on (and their later edits are muted too). */
export function mutedResult(method: string, body?: Record<string, unknown>): unknown {
  if (/^(send|forward|copy)/.test(method) && method !== "sendChatAction") {
    return { message_id: 0, date: Math.floor(Date.now() / 1000), chat: { id: body?.chat_id ?? 0 }, muted: true };
  }
  return true;
}
