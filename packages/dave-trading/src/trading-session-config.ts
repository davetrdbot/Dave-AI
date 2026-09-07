import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Real gap fixed (user: "in settings to select the session you want it to trade and also a
 * option to put all so it can trade all sessions"). Real UTC session windows (the standard,
 * widely-used forex session hours) -- "all" (the default) means no restriction at all.
 */
export type TradingSession = "sydney" | "asian" | "london" | "new_york" | "all";

export const TRADING_SESSION_WINDOWS_UTC: Record<Exclude<TradingSession, "all">, { startHour: number; endHour: number }> = {
  sydney: { startHour: 21, endHour: 6 }, // wraps past midnight UTC
  asian: { startHour: 0, endHour: 9 },
  london: { startHour: 7, endHour: 16 },
  new_york: { startHour: 12, endHour: 21 },
};

function configPath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "trading", userId, "session-config.json");
}

interface SessionConfig {
  session: TradingSession;
}

export function getTradingSession(userId: string): TradingSession {
  const path = configPath(userId);
  if (!existsSync(path)) return "all";
  return (JSON.parse(readFileSync(path, "utf8")) as SessionConfig).session;
}

export function setTradingSession(userId: string, session: TradingSession): void {
  const path = configPath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify({ session }, null, 2), "utf8");
}

/** Real check: is `now` (defaults to the real current time) genuinely within the user's selected
 *  session window? Always true for "all". Handles a session that wraps past midnight UTC (Sydney). */
export function isWithinSelectedSession(userId: string, now: Date = new Date()): boolean {
  const session = getTradingSession(userId);
  if (session === "all") return true;
  const { startHour, endHour } = TRADING_SESSION_WINDOWS_UTC[session];
  const hour = now.getUTCHours();
  if (startHour <= endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour; // wraps past midnight
}
