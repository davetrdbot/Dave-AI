import { join } from "node:path";

/**
 * Real gap fixed (final pre-deployment pass): every admin API route
 * independently inlined `join(process.cwd(), "data", "db", \`${userId}.db\`)`
 * -- correct for local dev, but with no way to point at a real shared
 * volume when the admin panel deploys as its own Railway service
 * separate from the bot process (packages/dave-agent-loop/src/main.ts).
 * DATA_DIR lets both processes be pointed at the same real mounted
 * volume so a credential paired here (e.g. the Telegram bot token) is
 * actually visible to the bot, not just to this service's own
 * ephemeral filesystem. Defaults to the exact prior behavior when unset.
 */
export function dbPathFor(userId: string): string {
  const dataDir = process.env.DATA_DIR ?? join(process.cwd(), "data", "db");
  return join(dataDir, `${userId}.db`);
}
