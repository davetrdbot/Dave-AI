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
 * 4 (`getOrCreateUserWebhook`) for the URL+token generation and delivery
 * side of this, which is real and tested.
 *
 * Corrected an overstated claim from the first pass: the webhook SERVER
 * (dave-memory's createHiddenWebhookServer) only understood
 * file/image/journal-entry/settings-change pushes -- it had never
 * actually been proven to accept the EA's own heartbeat/snapshot JSON
 * shape. Fixed by extending WebhookPush's type union and adding a real
 * test (see step8-ea-review.test.ts) that posts the EA's exact payload
 * shape and confirms it's accepted and stored, not just technically
 * passed through by TypeScript's lack of runtime enum checking.
 */

export function eaPickerKeyboard() {
  return keyboard([
    [{ text: "🖥️ Dave's default MT5 account", callback_data: "ea:default" }],
    [{ text: "🔑 My own MT5 account", callback_data: "ea:own" }],
  ]);
}

/**
 * Known gap, flagged rather than silently left: the two picker buttons
 * above aren't wired to different behavior yet -- both currently lead to
 * the same personalizeEaFile() call regardless of which is pressed.
 * "My own MT5 account" needs Step 10.8's separate-credentials storage to
 * actually branch on, so this is correctly Step 10's job to finish, not
 * something to fake here.
 */

export function personalizeEaFile(userId: string, publicBaseUrl: string): { filename: string; content: string; webhookUrl: string; token: string } {
  const hook = getOrCreateUserWebhook(userId);
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
    `Drop it in MQL5/Experts/DAVEMA/, compile with F7, attach to a chart.`;
  await client.sendDocument({ chat_id: chatId, document: fileRef, caption, parse_mode: "HTML" });
  return { webhookUrl, token };
}
