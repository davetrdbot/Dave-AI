import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getOrCreateEaWebhook } from "@dave/ea-bridge";
import type { TelegramClient } from "./client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(__dirname, "..", "..", "..", "ea", "DaveEA.mq5");

/**
 * Step 8.5/11.1/11.4: /ea shows a button picker, then sends the
 * personalized .mq5 with webhook URL + token pre-filled -- shown again
 * in the caption.
 *
 * Real bug fixed (user: "connected a real EA but /account showed
 * nothing"): this used to call `getOrCreateUserWebhook` from
 * `@dave/memory` -- dave-memory's GENERIC hidden webhook
 * (`/hooks/user/<token>`), which only ever appends heartbeat/snapshot
 * payloads to an inert per-user inbox. It never touches the real EA
 * bridge state (`saveAccountSnapshot`/`saveLastKnownState` in
 * `@dave/ea-bridge`'s ea-webhook.ts) that `/account`, `/connection`,
 * and the trade-command queue actually read from/write to. So a real
 * EA, personalized with this file, was heartbeating into a dead end --
 * connected from the EA's own point of view (HTTP 200 back), but
 * genuinely invisible to Dave. The fix is `getOrCreateEaWebhook` from
 * `@dave/ea-bridge` -- the EA-specific token system already mounted at
 * `/hooks/ea/<token>` in main.ts, the one `getLastKnownAccountSnapshot`/
 * `getEaConnectionStatus`/the command queue all actually read.
 */

export function personalizeEaFile(userId: string, publicBaseUrl: string): { filename: string; content: string; webhookUrl: string; token: string } {
  const hook = getOrCreateEaWebhook(userId);
  const webhookUrl = `${publicBaseUrl}${hook.path}`;
  const template = readFileSync(TEMPLATE_PATH, "utf8");
  // replaceAll, not replace -- a single .replace() only substitutes the
  // first occurrence, which happened to be safe while each placeholder
  // appeared exactly once but would silently under-substitute the moment
  // the template referenced either one a second time (e.g. in a log line).
  const content = template.replaceAll("{{WEBHOOK_URL}}", webhookUrl).replaceAll("{{TOKEN}}", hook.token);
  // Check for the two known placeholder tokens specifically, not any
  // "{{" substring -- the template's own OnInit() guard legitimately
  // contains the literal string "{{" as part of its placeholder-detection
  // logic, which a blanket includes("{{") check would misfire on.
  if (content.includes("{{WEBHOOK_URL}}") || content.includes("{{TOKEN}}")) {
    throw new Error("EA template still contains an unreplaced {{WEBHOOK_URL}}/{{TOKEN}} placeholder.");
  }
  return { filename: "DaveEA.mq5", content, webhookUrl, token: hook.token };
}

export async function sendPersonalizedEaFile(
  client: TelegramClient,
  chatId: number,
  userId: string,
  publicBaseUrl: string,
  uploadFile: (content: string, filename: string) => Promise<string> // returns a file_id or a URL sendDocument can use
): Promise<{ webhookUrl: string; token: string }> {
  const { filename, content, webhookUrl, token } = personalizeEaFile(userId, publicBaseUrl);
  const fileRef = await uploadFile(content, filename);
  const caption =
    `Your personalized EA -- webhook URL and token are already filled in.\n\n` +
    `Webhook: ${webhookUrl}\nToken: ${token}\n\n` +
    `Drop it in MQL5/Experts/Dave/, compile with F7, attach to a chart.`;
  await client.sendDocument({ chat_id: chatId, document: fileRef, caption, parse_mode: "HTML" });
  return { webhookUrl, token };
}
