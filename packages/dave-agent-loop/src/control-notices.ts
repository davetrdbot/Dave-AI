import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Changes made to the bot from OUTSIDE Telegram -- the phone app or the web panel -- that the
 * trader should hear about in the chat.
 *
 * Those surfaces run in the admin process, which cannot send Telegram messages or touch this
 * process's timers. So they append a notice here, and the bot's control watcher (see
 * telegram-bot-server.ts) delivers each one and clears the file. The admin side's writer lives in
 * packages/dave-admin/server/bot-control.ts and must keep this exact path and shape.
 */

export interface ControlNotice {
  /** What happened, e.g. "trading-started". Free-form but stable, for tests and logs. */
  event: string;
  /** Where it came from, e.g. "app" or "web". */
  source: string;
  at: number;
}

export function controlNoticesPath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "agent-loop", userId, "control-notices.json");
}

/** Returns every pending notice, oldest first, and clears them. A corrupt file is dropped. */
export function takeControlNotices(userId: string): ControlNotice[] {
  const path = controlNoticesPath(userId);
  if (!existsSync(path)) return [];
  let notices: ControlNotice[] = [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (Array.isArray(parsed)) notices = parsed.filter((n): n is ControlNotice => typeof n?.event === "string");
  } catch {
    // unreadable -- treat as empty and reset below
  }
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "[]", "utf8");
  return notices;
}

/** The chat line for a notice. */
export function describeControlNotice(n: ControlNotice): string {
  const from = n.source === "app" ? "from the app" : n.source === "web" ? "from the web panel" : `from ${n.source}`;
  switch (n.event) {
    case "trading-started":
      return `▶️ Autonomous trading turned on ${from}. I'm scanning now.`;
    case "trading-stopped":
      return `⏸ Autonomous trading turned off ${from}. Open positions are not closed.`;
    case "execution-on":
      return `Taking trades automatically again (changed ${from}).`;
    case "execution-off":
      return `Watch-only (changed ${from}): I'll keep analysing and managing what's open, and ask before opening anything new.`;
    default:
      return `Settings changed ${from}: ${n.event}.`;
  }
}
