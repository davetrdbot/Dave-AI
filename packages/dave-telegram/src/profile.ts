import type { TelegramClient } from "./client.js";

/**
 * Step 8.7: "Dave has a tool to update its own Telegram bot profile
 * picture/display info via the Bot API." Checked the real docs before
 * building this (see PROGRESS.md) -- the display-info half is real
 * (setMyName / setMyDescription / setMyShortDescription all exist), but
 * there is genuinely NO Bot API method for a bot to change its own
 * profile PHOTO. That can only be done manually through @BotFather's
 * /setuserpic command. Implementing a fake call here would violate the
 * whole point of this build process (real proof, not assumed success),
 * so this is honest about the boundary instead: it does what's real, and
 * returns clear instructions for the one piece that isn't.
 */

export interface DisplayInfoUpdate {
  name?: string;
  description?: string;
  shortDescription?: string;
}

export async function updateBotDisplayInfo(client: TelegramClient, update: DisplayInfoUpdate): Promise<string[]> {
  const applied: string[] = [];
  if (update.name) {
    await client.setMyName({ name: update.name });
    applied.push("name");
  }
  if (update.description) {
    await client.setMyDescription({ description: update.description });
    applied.push("description");
  }
  if (update.shortDescription) {
    await client.setMyShortDescription({ short_description: update.shortDescription });
    applied.push("short_description");
  }
  return applied;
}

/**
 * No API path exists for this -- returns the real, manual instructions
 * instead of pretending an API call happened. This IS the honest
 * implementation of this half of Step 8.7.
 */
export function botProfilePhotoInstructions(): string {
  return (
    "There's no Bot API method for a bot to change its own profile photo -- I checked the real docs, " +
    "it genuinely doesn't exist. To update it: message @BotFather, send /setuserpic, pick this bot, " +
    "and upload the image there. I can't do this one myself."
  );
}
