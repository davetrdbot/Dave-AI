import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Whether the Telegram side of the bot is actually running, written by the bot process and read by
 * the admin panel -- they are separate processes, so it is a file (the convention everything else
 * crossing that boundary follows).
 *
 * Real bug this exists for (a trader who forked the repo): pairing in the web panel succeeded, the
 * panel sent "What should I call you?", and then nothing -- no command menu, no replies -- with no
 * way to tell from the panel whether the bot had come online, was still waiting, or had failed and
 * why. The only record was a line in the server log. Now the panel shows it.
 */

export type TelegramBotState = "waiting-for-token" | "starting" | "online" | "error";

export interface TelegramBotStatus {
  state: TelegramBotState;
  /** How updates arrive: Telegram pushes to a public URL, or the bot fetches them itself. */
  mode?: "webhook" | "polling";
  /** @username of the running bot. */
  username?: string;
  /** Plain-language reason for "error" (and context for the other states). */
  detail?: string;
  at: number;
}

export function telegramStatusPath(): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "telegram", "status.json");
}

export function writeTelegramStatus(status: Omit<TelegramBotStatus, "at">, now = Date.now()): void {
  try {
    const path = telegramStatusPath();
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...status, at: now }), "utf8");
    renameSync(tmp, path);
  } catch (err) {
    console.error("[telegram] could not write status:", err);
  }
}

export function readTelegramStatus(): TelegramBotStatus | undefined {
  const path = telegramStatusPath();
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as TelegramBotStatus;
  } catch {
    return undefined;
  }
}
