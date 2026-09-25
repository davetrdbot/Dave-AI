import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage, type NewMessageEvent } from "telegram/events/index.js";
import { LogLevel } from "telegram/extensions/Logger.js";
import { clearNousLogin, getNousConfig, getNousLogin, saveNousLogin, type NousChat } from "./store.js";

/**
 * Nous reads signal channels through the trader's OWN Telegram account (MTProto, via GramJS).
 * A bot can't: Telegram's Chat Automation / business bots only ever see private chats, and a bot
 * can only read a channel it was added to as admin. Logging in as the trader is the only way to
 * read channels they merely follow -- the same way every signal-copier works.
 *
 * Only channels and groups the trader ticks are read (private chats are never touched, even if
 * ticked by mistake -- the handler drops them). The session is stored encrypted (store.ts).
 */

export interface NousPost {
  chatId: string;
  chatTitle: string;
  messageId: number;
  postedAt: number;
  text: string;
}

function newClient(session: string, apiId: number, apiHash: string): TelegramClient {
  const client = new TelegramClient(new StringSession(session), apiId, apiHash, { connectionRetries: 10, autoReconnect: true });
  client.setLogLevel(LogLevel.ERROR);
  return client;
}

/** Boot-time check that this server can reach Telegram's login servers at all (the handshake
 *  needs no account). Logged, so a deploy shows whether /nous can work before anyone tries. */
export async function checkTelegramReachable(timeoutMs = 30_000): Promise<string> {
  const client = newClient("", 1, "00000000000000000000000000000000");
  try {
    await Promise.race([client.connect(), new Promise((_, rej) => setTimeout(() => rej(new Error(`no answer in ${timeoutMs / 1000}s`)), timeoutMs).unref())]);
    return "reachable";
  } catch (err) {
    return `NOT reachable: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    await client.destroy().catch(() => undefined);
  }
}

// ---- Login (one pending attempt per user, process memory only) ----

interface LoginAttempt {
  client: TelegramClient;
  apiId: number;
  apiHash: string;
  phone: string;
  phoneCodeHash: string;
  at: number;
}
const attempts = new Map<string, LoginAttempt>();

export async function nousLoginBegin(userId: string, apiId: number, apiHash: string, phone: string): Promise<void> {
  await attempts.get(userId)?.client.destroy().catch(() => undefined);
  attempts.delete(userId);
  const client = newClient("", apiId, apiHash);
  await client.connect();
  const { phoneCodeHash } = await client.sendCode({ apiId, apiHash }, phone);
  attempts.set(userId, { client, apiId, apiHash, phone, phoneCodeHash, at: Date.now() });
}

export type LoginStep = { done: true; account: string } | { done: false; needPassword: true };

/** The code arrives in Telegram itself; typed with spaces ("1 2 3 4 5") so Telegram doesn't
 *  expire it for being shared -- all non-digits are stripped here. */
export async function nousLoginCode(userId: string, typed: string): Promise<LoginStep> {
  const a = attempts.get(userId);
  if (!a) throw new Error("No login in progress -- start again from /nous.");
  const phoneCode = typed.replace(/\D/g, "");
  try {
    await a.client.invoke(new Api.auth.SignIn({ phoneNumber: a.phone, phoneCodeHash: a.phoneCodeHash, phoneCode }));
  } catch (err) {
    if (errorCode(err) === "SESSION_PASSWORD_NEEDED") return { done: false, needPassword: true };
    throw new Error(friendlyError(err));
  }
  return finishLogin(userId, a);
}

export async function nousLoginPassword(userId: string, password: string): Promise<LoginStep> {
  const a = attempts.get(userId);
  if (!a) throw new Error("No login in progress -- start again from /nous.");
  await a.client.signInWithPassword(
    { apiId: a.apiId, apiHash: a.apiHash },
    {
      password: async () => password,
      onError: async (err) => {
        throw new Error(friendlyError(err));
      },
    },
  );
  return finishLogin(userId, a);
}

async function finishLogin(userId: string, a: LoginAttempt): Promise<LoginStep> {
  const me = (await a.client.getMe()) as Api.User;
  const account = [me.firstName, me.lastName].filter(Boolean).join(" ") + (me.username ? ` (@${me.username})` : "");
  saveNousLogin(userId, { apiId: a.apiId, apiHash: a.apiHash, session: String(a.client.session.save()), account });
  attempts.delete(userId);
  await a.client.destroy().catch(() => undefined);
  return { done: true, account };
}

export function cancelNousLogin(userId: string): void {
  void attempts.get(userId)?.client.destroy().catch(() => undefined);
  attempts.delete(userId);
}

// ---- The live connection ----

interface Live {
  client: TelegramClient;
  onPost: (post: NousPost) => void;
}
const live = new Map<string, Live>();

async function connected(userId: string): Promise<TelegramClient> {
  const existing = live.get(userId);
  if (existing) return existing.client;
  const login = getNousLogin(userId);
  if (!login) throw new Error("Telegram isn't connected -- /nous -> Connect Telegram.");
  const client = newClient(login.session, login.apiId, login.apiHash);
  await client.connect();
  if (!(await client.checkAuthorization())) {
    await client.destroy().catch(() => undefined);
    throw new Error("The Telegram login was signed out (from Settings -> Devices?) -- connect it again from /nous.");
  }
  return client;
}

/** Starts listening. Safe to call again (e.g. after the chat list changes) -- it's a no-op then. */
export async function startNousListener(userId: string, onPost: (post: NousPost) => void): Promise<void> {
  if (live.has(userId)) {
    live.get(userId)!.onPost = onPost;
    return;
  }
  const client = await connected(userId);
  const entry: Live = { client, onPost };
  live.set(userId, entry);
  client.addEventHandler(async (event: NewMessageEvent) => {
    try {
      const m = event.message;
      if (m.isPrivate || m.out) return;
      const chatId = String(m.chatId ?? "");
      const chat = getNousConfig(userId).chats.find((c) => c.id === chatId);
      if (!chat) return;
      const text = (m.message ?? "").trim();
      if (!text) return;
      entry.onPost({ chatId, chatTitle: chat.title, messageId: m.id, postedAt: m.date * 1000, text });
    } catch (err) {
      console.error(`[nous] ${userId}: handling a post failed:`, err);
    }
  }, new NewMessage({}));
}

export async function stopNousListener(userId: string): Promise<void> {
  const l = live.get(userId);
  live.delete(userId);
  await l?.client.destroy().catch(() => undefined);
}

export function isNousListening(userId: string): boolean {
  return live.has(userId);
}

/** The trader's channels and groups (never private chats), newest activity first. */
export async function listNousDialogs(userId: string, limit = 60): Promise<NousChat[]> {
  const client = await connected(userId);
  try {
    const dialogs = await client.getDialogs({ limit: 200 });
    return dialogs
      .filter((d) => d.isChannel || d.isGroup)
      .slice(0, limit)
      .map((d) => ({ id: String(d.id), title: (d.title ?? d.name ?? "untitled").slice(0, 60), kind: d.isGroup ? ("group" as const) : ("channel" as const) }));
  } finally {
    if (!live.has(userId)) await client.destroy().catch(() => undefined);
  }
}

/** Signs the session out on Telegram's side too (it disappears from Settings -> Devices). */
export async function nousLogout(userId: string): Promise<void> {
  try {
    const client = await connected(userId);
    await client.invoke(new Api.auth.LogOut()).catch(() => undefined);
    await client.destroy().catch(() => undefined);
  } catch {
    // Already signed out elsewhere -- clearing our copy is all that's left.
  }
  live.delete(userId);
  clearNousLogin(userId);
}

function errorCode(err: unknown): string {
  return (err as { errorMessage?: string })?.errorMessage ?? (err instanceof Error ? err.message : String(err));
}

function friendlyError(err: unknown): string {
  const code = errorCode(err);
  if (/PHONE_CODE_INVALID/.test(code)) return "That code is wrong -- check it and send it again (with spaces).";
  if (/PHONE_CODE_EXPIRED/.test(code)) return "That code expired (Telegram expires a code that was sent as a plain number in a chat). Start again and type it with spaces: 1 2 3 4 5.";
  if (/PASSWORD_HASH_INVALID/.test(code)) return "That two-step verification password is wrong.";
  if (/FLOOD_WAIT/.test(code)) return "Telegram says too many attempts -- wait a few minutes and try again.";
  return code;
}
