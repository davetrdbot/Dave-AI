import type { DaveDatabase } from "@dave/db";
import type { TelegramClient } from "@dave/telegram";
import { getLastKnownAccountSnapshot, getLastKnownState } from "@dave/ea-bridge";
import { getActiveGroupInfo } from "@dave/trading";
import { syncMorningBriefCron } from "@dave/notifications";
import { getPrimaryChatId } from "./primary-chat.js";

/**
 * Real gap fixed (F5): syncMorningBriefCron() genuinely fires a real
 * node-cron trigger on schedule -- that part was already proven real --
 * but nothing in production code ever called it with an `onBrief`
 * handler that actually composes and sends content. The cron fired into
 * nothing. This is that handler: real balance (EA account snapshot),
 * real open trades (EA last-known state), and the day's watchlist (the
 * user's real active pair group), composed into one message and sent
 * via the same real client.sendMessage() every other push in this
 * codebase uses.
 */
export function composeBriefContent(userId: string): string {
  const snapshot = getLastKnownAccountSnapshot(userId);
  const state = getLastKnownState(userId);
  const group = getActiveGroupInfo(userId);

  const balanceLine = snapshot ? `Balance: $${snapshot.balance.toFixed(2)} | Equity: $${(snapshot.equity ?? snapshot.balance).toFixed(2)}` : "Balance: no EA report yet";
  const positionsLine = `Open trades: ${state.positions.length}${state.positions.length > 0 ? ` (${state.positions.map((p) => p.symbol).join(", ")})` : ""}`;
  const watchlistLine = group.activeGroup ? `Watchlist (${group.activeGroup.name}): ${group.activeGroup.symbols.join(", ") || "no symbols configured"}` : "Watchlist: no active pair group configured";
  const pausedLine = group.pausedForExtremeConditions ? "\n⚠️ Paused for extreme market conditions." : "";

  return `<b>☀️ Morning Brief</b>\n${balanceLine}\n${positionsLine}\n${watchlistLine}${pausedLine}`;
}

export interface MorningBriefDeps {
  db: DaveDatabase;
  client: TelegramClient;
  ownerUserId: string;
}

/** The real onBrief handler -- composes real content and sends it to the real chat the owner last messaged from. Honestly no-ops (logs, doesn't throw) if no chat is known yet -- there is genuinely nowhere to send it. */
export function createMorningBriefHandler(deps: MorningBriefDeps): () => Promise<void> {
  return async () => {
    const chatId = getPrimaryChatId(deps.db, deps.ownerUserId);
    if (chatId === undefined) {
      console.warn(`[morning-brief] no known chat for ${deps.ownerUserId} yet -- skipping (owner has never messaged the bot)`);
      return;
    }
    const text = composeBriefContent(deps.ownerUserId);
    await deps.client.sendMessage({ chat_id: chatId, text, parse_mode: "HTML" });
  };
}

/** Called once at startup (and after any settings change) to make the real cron match the user's current brief settings. */
export function wireMorningBrief(deps: MorningBriefDeps) {
  return syncMorningBriefCron(deps.db, deps.ownerUserId, createMorningBriefHandler(deps));
}
