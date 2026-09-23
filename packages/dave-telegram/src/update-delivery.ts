import type { DaveDatabase } from "@dave/db";
import type { TelegramClient, TelegramUpdate } from "./client.js";
import { enableTelegramWebhook } from "./telegram-webhook.js";
import { hasPendingTelegramPairing } from "./telegram-otp.js";
import { writeTelegramStatus } from "./bot-status.js";

/**
 * How Telegram updates reach the bot, chosen by what the deployment can offer.
 *
 *   - WEBHOOK, when the bot has a public HTTPS address (Railway gives one): Telegram pushes each
 *     update. A watchdog re-registers the webhook if anything removes or replaces it -- the web
 *     panel's own pairing flow deletes it (it has to: getUpdates is refused while a webhook is
 *     set), and so does any other tool that ever touched the same bot token.
 *   - POLLING, when there is no public address (a home machine, a VPS without a domain, Docker on
 *     a laptop): the bot asks Telegram for updates itself. Before this existed the bot simply
 *     never came online in that situation -- it logged an error nobody saw and waited forever.
 *
 * Either way, updates go to the same handler, and the running state is written for the web panel.
 */

export interface UpdateDeliveryOptions {
  client: TelegramClient;
  db: DaveDatabase;
  ownerUserId: string;
  /** Public HTTPS base URL, or undefined to poll. */
  publicBaseUrl?: string;
  onUpdate: (userId: string, update: TelegramUpdate) => Promise<void> | void;
  username?: string;
  /** How often the webhook watchdog checks. */
  watchdogMs?: number;
}

export interface UpdateDelivery {
  mode: "webhook" | "polling";
  /** Where Telegram sends updates (webhook mode). */
  webhookUrl?: string;
  stop(): void;
}

export const WEBHOOK_WATCHDOG_MS = 60_000;
/** Long-poll hold time. Telegram answers as soon as an update arrives, so this costs no latency. */
const POLL_TIMEOUT_S = 25;

export async function startUpdateDelivery(o: UpdateDeliveryOptions): Promise<UpdateDelivery> {
  if (o.publicBaseUrl) {
    const route = await enableTelegramWebhook(o.client, o.ownerUserId, o.publicBaseUrl);
    const expected = `${o.publicBaseUrl}${route.path}`;
    writeTelegramStatus({ state: "online", mode: "webhook", username: o.username });
    const timer = setInterval(() => {
      void (async () => {
        // A pairing in progress needs the webhook OFF (its check uses getUpdates) -- never fight it.
        if (hasPendingTelegramPairing(o.db, o.ownerUserId)) return;
        try {
          const info = await o.client.getWebhookInfo();
          if (info.url !== expected) {
            console.log(`[telegram] webhook was ${info.url ? `changed to ${info.url}` : "removed"} -- registering it again`);
            await enableTelegramWebhook(o.client, o.ownerUserId, o.publicBaseUrl!);
          }
          writeTelegramStatus({ state: "online", mode: "webhook", username: o.username, detail: info.last_error_message ? `Telegram's last delivery error: ${info.last_error_message}` : undefined });
        } catch (err) {
          writeTelegramStatus({ state: "error", mode: "webhook", username: o.username, detail: `Could not reach Telegram: ${err instanceof Error ? err.message : String(err)}` });
        }
      })();
    }, o.watchdogMs ?? WEBHOOK_WATCHDOG_MS);
    timer.unref?.();
    return { mode: "webhook", webhookUrl: expected, stop: () => clearInterval(timer) };
  }

  // Polling. Keep whatever is queued -- messages sent while the bot was offline still get answered.
  await o.client.deleteWebhook().catch(() => undefined);
  writeTelegramStatus({ state: "online", mode: "polling", username: o.username, detail: "No public web address, so the bot fetches messages from Telegram itself." });
  let stopped = false;
  let offset: number | undefined;
  void (async () => {
    while (!stopped) {
      if (hasPendingTelegramPairing(o.db, o.ownerUserId)) {
        // Two getUpdates callers on one token cancel each other; the pairing check wins until done.
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      let updates: TelegramUpdate[];
      try {
        updates = await o.client.getUpdates({ offset, timeout: POLL_TIMEOUT_S, allowed_updates: ["message", "callback_query", "poll_answer"] });
      } catch (err) {
        writeTelegramStatus({ state: "error", mode: "polling", username: o.username, detail: `Could not fetch messages from Telegram: ${err instanceof Error ? err.message : String(err)}` });
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      writeTelegramStatus({ state: "online", mode: "polling", username: o.username, detail: "No public web address, so the bot fetches messages from Telegram itself." });
      for (const u of updates) {
        offset = u.update_id + 1;
        try {
          await o.onUpdate(o.ownerUserId, u);
        } catch (err) {
          console.error("[telegram] update handler failed:", err);
        }
      }
    }
  })();
  return { mode: "polling", stop: () => (stopped = true) };
}
