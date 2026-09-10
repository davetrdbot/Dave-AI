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
