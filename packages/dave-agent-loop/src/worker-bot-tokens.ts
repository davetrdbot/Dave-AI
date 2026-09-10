import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * User-requested addition ("bot can now talk to each other in group... add in settings like a
 * each worker panel have its own bot token so I can see how they are talking to each other").
 * Each Setup Panel specialist (setup-panel.ts) can be given its OWN real Telegram bot identity
 * (its own BotFather token) -- when one is configured, that specialist's real finding is ALSO
 * posted into a real Telegram group chat using that bot's own identity, so the user can literally
 * watch multiple distinct bots converse in a group, not just read a compressed internal log.
 * This never replaces the internal comms log (setup-panel.ts still writes there unconditionally,
 * so Dave's own visibility into the discussion never depends on the user having configured this)
 * -- it's a real, optional, additional visibility layer.
 */
export const WORKER_BOT_SPECIALISTS = [
  "Structure & Liquidity",
  "ICT & Smart Money",
  "Momentum & Trend",
  "Volatility & Volume",
  "Levels & Confluence",
  "Macro & Context",
  "Risk & Sizing",
  "Goal & Risk Appetite",
] as const;
export type WorkerBotSpecialist = (typeof WORKER_BOT_SPECIALISTS)[number];

function tokensPath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "trading", userId, "worker-bot-tokens.json");
}

function groupChatPath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "trading", userId, "panel-group-chat.json");
}

function readTokens(userId: string): Record<string, string> {
  const path = tokensPath(userId);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeTokens(userId: string, tokens: Record<string, string>): void {
  const path = tokensPath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(tokens, null, 2), "utf8");
}

export function setWorkerBotToken(userId: string, specialist: WorkerBotSpecialist, token: string): void {
  const tokens = readTokens(userId);
  tokens[specialist] = token;
  writeTokens(userId, tokens);
}

export function removeWorkerBotToken(userId: string, specialist: WorkerBotSpecialist): void {
  const tokens = readTokens(userId);
  delete tokens[specialist];
  writeTokens(userId, tokens);
}

export function getWorkerBotToken(userId: string, specialist: string): string | undefined {
  return readTokens(userId)[specialist];
}

/** Real status per specialist -- token PRESENCE only, never the token value itself (same secrecy
 *  convention as every other stored credential in this codebase). */
export function listWorkerBotStatus(userId: string): { specialist: WorkerBotSpecialist; configured: boolean }[] {
  const tokens = readTokens(userId);
  return WORKER_BOT_SPECIALISTS.map((specialist) => ({ specialist, configured: Boolean(tokens[specialist]) }));
}

/**
 * The real Telegram group the user has added every worker bot (and Dave's own bot) to --
 * captured via /set_panel_group, sent AS A MESSAGE INSIDE that group (Dave's own already-live
 * webhook receives it, same as any other real command), not a separate webhook per worker bot.
 */
export function setPanelGroupChatId(userId: string, chatId: number): void {
  const path = groupChatPath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(chatId), "utf8");
}

export function getPanelGroupChatId(userId: string): number | undefined {
  const path = groupChatPath(userId);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * User-requested addition ("set the bot to admin then on thread so it can see message from a
 * bot can respond to it"). Real Telegram Bot API behavior (confirmed via the real docs, see
 * worker-bot-webhook.ts): a bot only sees another bot's messages if it's admin (privacy mode
 * disabled) AND has Bot-to-Bot Communication Mode enabled via BotFather. This module tracks
 * each worker bot's own numeric Telegram user id (from a real getMe() call) so the receiving
 * webhook handler can tell "a message from another one of MY OWN configured worker bots" apart
 * from a human's message or its own echo.
 */
function botIdsPath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "trading", userId, "worker-bot-ids.json");
}

function readBotIds(userId: string): Record<string, number> {
  const path = botIdsPath(userId);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

export function setWorkerBotId(userId: string, specialist: string, botId: number): void {
  const ids = readBotIds(userId);
  ids[specialist] = botId;
  const path = botIdsPath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(ids, null, 2), "utf8");
}

export function getWorkerBotId(userId: string, specialist: string): number | undefined {
  return readBotIds(userId)[specialist];
}

/** Real reverse lookup: given a Telegram user id that posted in the panel group, which (if any)
 *  of THIS user's own configured worker bots does it belong to? */
export function findSpecialistByBotId(userId: string, botId: number): WorkerBotSpecialist | undefined {
  const ids = readBotIds(userId);
  const entry = Object.entries(ids).find(([, id]) => id === botId);
  return entry?.[0] as WorkerBotSpecialist | undefined;
}

/**
 * Real, bounded "live discussion window" -- reactive worker-bot replies (worker-bot-webhook.ts)
 * only ever fire while a real panel run genuinely has one open, for the SAME real thread id, and
 * only up to a real reply cap. Without this, admin + Bot-to-Bot Communication Mode would let
 * worker bots react to each other indefinitely outside of any real panel run, and/or loop
 * without bound within one.
 */
export const MAX_REACTIVE_REPLIES_PER_SESSION = 12;
const DISCUSSION_SESSION_DURATION_MS = 3 * 60 * 1000;

interface DiscussionSession {
  threadId: string;
  expiresAt: number;
  replyCount: number;
}

function sessionPath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "trading", userId, "panel-discussion-session.json");
}

function readSession(userId: string): DiscussionSession | undefined {
  const path = sessionPath(userId);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeSession(userId: string, session: DiscussionSession): void {
  const path = sessionPath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(session, null, 2), "utf8");
}

export function startPanelDiscussionSession(userId: string, threadId: string): void {
  writeSession(userId, { threadId, expiresAt: Date.now() + DISCUSSION_SESSION_DURATION_MS, replyCount: 0 });
}

/** True only for the real, currently-open session's own thread id -- a stale/expired session, or
 *  a message about a DIFFERENT panel thread, never counts as active. */
export function isPanelDiscussionSessionActive(userId: string, threadId: string): boolean {
  const session = readSession(userId);
  if (!session) return false;
  return session.threadId === threadId && Date.now() < session.expiresAt && session.replyCount < MAX_REACTIVE_REPLIES_PER_SESSION;
}

/** The real currently-open session's thread id, if any -- a real worker bot webhook update has
 *  no other way to know which panel run (if any) is genuinely still live. */
export function getActiveDiscussionThreadId(userId: string): string | undefined {
  const session = readSession(userId);
  if (!session) return undefined;
  if (Date.now() >= session.expiresAt || session.replyCount >= MAX_REACTIVE_REPLIES_PER_SESSION) return undefined;
  return session.threadId;
}

/** Real, atomic-enough-for-this-use increment (single-process, synchronous file I/O) -- returns
 *  the new count so the caller can log/report it. */
export function incrementReactiveReplyCount(userId: string, threadId: string): number {
  const session = readSession(userId);
  if (!session || session.threadId !== threadId) return MAX_REACTIVE_REPLIES_PER_SESSION; // no active session -- treat as already capped
  session.replyCount += 1;
  writeSession(userId, session);
  return session.replyCount;
}
