/**
 * The user id every device-facing route should act on when the caller does not name one.
 *
 * Real bug this prevents, found by reading main.ts before writing the app's API client: the bot
 * stores everything under `process.env.OWNER_USER_ID ?? "default"`, but the routes the app talks
 * to defaulted to a hardcoded "default". On any deployment where OWNER_USER_ID is set, a phone
 * would pair successfully and then show an empty account -- no balance, no trades, no memory --
 * because it was reading a user nobody writes to. The admin process inherits the bot's
 * environment (main.ts spawns it with `...process.env`), so the same variable is visible here.
 *
 * An explicit `?userId=` still wins, which keeps the web panel's multi-user box working.
 */
export function ownerUserId(): string {
  const fromEnv = process.env.OWNER_USER_ID?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : "default";
}

export function resolveUserId(explicit: string | null | undefined): string {
  const trimmed = explicit?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : ownerUserId();
}
