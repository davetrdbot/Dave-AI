import type { TelegramClient } from "./client.js";
import { DAVE_COMMANDS } from "./commands.js";

/**
 * Step 8.6: Dave's own bot menu (setMyCommands), plus confirming
 * per-user customization. Real finding: BotCommandScope supports
 * `BotCommandScopeChatMember` -- genuinely per-user-per-chat, confirmed
 * in Step 1.6 research against the real docs. Default scope applies to
 * everyone; a per-user override is only set if that user has customized
 * their view (e.g. hidden a command they don't use).
 */

export async function registerDefaultCommandMenu(client: TelegramClient): Promise<void> {
  await client.setMyCommands({ commands: DAVE_COMMANDS as unknown as { command: string; description: string }[] });
}

export async function setPerUserCommandMenu(
  client: TelegramClient,
  chatId: number,
  userId: number,
  commands: { command: string; description: string }[]
): Promise<void> {
  await client.setMyCommands({
    commands,
    scope: { type: "chat_member", chat_id: chatId, user_id: userId },
  });
}
