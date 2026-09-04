import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TelegramClient } from "@dave/telegram";
import { getOrCreateRFeedWebhook } from "./rfeed-webhook.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(__dirname, "..", "..", "..", "ea", "RFeedEA.mq5");

/**
 * Real personalization + delivery for R_Feed's own EA file -- mirrors
 * `dave-telegram/ea-file.ts`'s real pattern for the real Dave EA, but
 * against R_Feed's own webhook/token (`getOrCreateRFeedWebhook`), never
 * the real EA's. Sent as its own file, with its own instructions --
 * never bundled with or confused for the real DaveEA.mq5 delivery.
 */
export function personalizeRFeedFile(userId: string, publicBaseUrl: string): { filename: string; content: string; webhookUrl: string; token: string } {
  const hook = getOrCreateRFeedWebhook(userId);
  const webhookUrl = `${publicBaseUrl}${hook.path}`;
  const template = readFileSync(TEMPLATE_PATH, "utf8");
  const content = template.replaceAll("{{WEBHOOK_URL}}", webhookUrl).replaceAll("{{TOKEN}}", hook.token);
  if (content.includes("{{WEBHOOK_URL}}") || content.includes("{{TOKEN}}")) {
    throw new Error("R_Feed EA template still contains an unreplaced {{WEBHOOK_URL}}/{{TOKEN}} placeholder.");
  }
  return { filename: "RFeedEA.mq5", content, webhookUrl, token: hook.token };
}

export async function sendPersonalizedRFeedFile(
  client: TelegramClient,
  chatId: number,
  userId: string,
  publicBaseUrl: string,
  uploadFile: (content: string, filename: string) => Promise<string>
): Promise<{ webhookUrl: string; token: string }> {
  const { filename, content, webhookUrl, token } = personalizeRFeedFile(userId, publicBaseUrl);
  const fileRef = await uploadFile(content, filename);
  const caption =
    `R_Feed -- your demo/practice account EA. Separate from your real DaveEA -- ` +
    `zero real money at risk, ever.\n\nWebhook: ${webhookUrl}\nToken: ${token}\n\n` +
    `Drop it in MQL5/Experts/, compile with F7, attach to a chart on your DEMO account (never a live one).`;
  await client.sendDocument({ chat_id: chatId, document: fileRef, caption, parse_mode: "HTML" });
  return { webhookUrl, token };
}
