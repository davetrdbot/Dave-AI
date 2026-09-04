import type { TelegramClient, FileInput, LocalFile } from "@dave/telegram";

/**
 * Step 15.3: Dave pushes files out -- the FULL range (document, photo,
 * video, voice note, video note/screen recording, PDF-as-document), not
 * just plain documents.
 *
 * Expiry warning: the only real expiring-link concept in the Bot API is
 * getFile's file_path download URL, guaranteed valid for "at least 1
 * hour" (confirmed against the real docs). So: uploading real bytes
 * (a LocalFile) never needs a warning -- Telegram re-hosts it as a
 * permanent file_id. Sending a URL string DOES need one if that URL is
 * itself a Telegram-issued file link, since it can go stale.
 */
export type OutboundFileKind = "document" | "photo" | "video" | "voice" | "video_note" | "animation";

export interface SendFileOutParams {
  chatId: number | string;
  kind: OutboundFileKind;
  file: FileInput;
  caption?: string;
}

const TELEGRAM_FILE_LINK_PATTERN = /^https:\/\/api\.telegram\.org\/file\//;

export function isLinkThatMayExpire(file: FileInput): boolean {
  return typeof file === "string" && TELEGRAM_FILE_LINK_PATTERN.test(file);
}

export const EXPIRY_WARNING =
  "(heads up -- this is a Telegram file link and is only guaranteed valid for about an hour; save it if you need it longer)";

export interface SendFileOutResult {
  message_id: number;
  expiryWarned: boolean;
}

export async function sendFileOut(client: TelegramClient, params: SendFileOutParams): Promise<SendFileOutResult> {
  const expiryWarned = isLinkThatMayExpire(params.file);
  const caption = expiryWarned ? [params.caption, EXPIRY_WARNING].filter(Boolean).join("\n\n") : params.caption;

  let result: { message_id: number };
  switch (params.kind) {
    case "document":
      result = await client.sendDocument({ chat_id: params.chatId, document: params.file, caption, parse_mode: caption ? "HTML" : undefined });
      break;
    case "photo":
      result = await client.sendPhoto({ chat_id: params.chatId, photo: params.file, caption, parse_mode: caption ? "HTML" : undefined });
      break;
    case "video":
      result = await client.sendVideo({ chat_id: params.chatId, video: params.file, caption, parse_mode: caption ? "HTML" : undefined });
      break;
    case "voice":
      result = await client.sendVoice({ chat_id: params.chatId, voice: params.file, caption, parse_mode: caption ? "HTML" : undefined });
      break;
    case "video_note":
      // sendVideoNote has no caption parameter in the real API -- confirmed, it's the only one of these that doesn't.
      if (typeof params.file === "string") {
        result = await client.sendVideoNote({ chat_id: params.chatId, video_note: params.file });
      } else {
        result = await client.sendVideoNote({ chat_id: params.chatId, video_note: params.file as LocalFile });
      }
      break;
    case "animation":
      result = await client.sendAnimation({ chat_id: params.chatId, animation: params.file, caption, parse_mode: caption ? "HTML" : undefined });
      break;
  }
  return { message_id: result.message_id, expiryWarned };
}
