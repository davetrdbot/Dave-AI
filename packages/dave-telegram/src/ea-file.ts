import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getOrCreateUserWebhook } from "@dave/memory";
import type { TelegramClient } from "./client.js";
import { keyboard } from "./buttons.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(__dirname, "..", "..", "..", "ea", "DaveEA.mq5");

/**
 * Step 8.5/11.1/11.4: /ea shows a button picker, then sends the
 * personalized .mq5 with webhook URL + token pre-filled -- shown again
 * in the caption. Reuses the real hidden per-user webhook built in Step
 * 4 (`getOrCreateUserWebhook`) as the real, working URL+token source
 * today; Step 11 may formalize a dedicated EA-specific webhook, but this
 * is genuinely functional now, not a placeholder.
 */

export function eaPickerKeyboard() {
  return keyboard([
    [{ text: "🖥️ Dave's default MT5 account", callback_data: "ea:default" }],
    [{ text: "🔑 My own MT5 account", callback_data: "ea:own" }],
  ]);
}

export function personalizeEaFile(userId: string, publicBaseUrl: string): { filename: string; content: string; webhookUrl: string; token: string } {
  const hook = getOrCreateUserWebhook(userId);
  const webhookUrl = `${publicBaseUrl}${hook.path}`;
  const template = readFileSync(TEMPLATE_PATH, "utf8");
  const content = template.replace("{{WEBHOOK_URL}}", webhookUrl).replace("{{TOKEN}}", hook.token);
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
    `Drop it in MQL5/Experts/DAVEMA/, compile with F7, attach to a chart.`;
  await client.sendDocument({ chat_id: chatId, document: fileRef, caption, parse_mode: "HTML" });
  return { webhookUrl, token };
}
