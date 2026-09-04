import type { InlineKeyboardButton, InlineKeyboardMarkup } from "./client.js";

/**
 * Step 8.3: "colored inline buttons used meaningfully." Verified against
 * the real Bot API docs before building this (Step 8 kickoff): there is
 * NO color field on InlineKeyboardButton -- Telegram doesn't support
 * button colors at the API level at all. Every real bot that appears to
 * have "colored buttons" is doing exactly what this does: a leading
 * emoji circle carrying the semantic meaning. Documented here rather
 * than silently faked as a real color property.
 */
export type ButtonColor = "green" | "red" | "blue" | "neutral";

const COLOR_PREFIX: Record<ButtonColor, string> = {
  green: "\u{1F7E2}", // confirm / safe / go
  red: "\u{1F534}", // danger / stop / cancel
  blue: "\u{1F535}", // informational / neutral action
  neutral: "",
};

export function coloredButton(text: string, color: ButtonColor, callbackData: string): InlineKeyboardButton {
  const prefix = COLOR_PREFIX[color];
  return { text: prefix ? `${prefix} ${text}` : text, callback_data: callbackData };
}

export function keyboard(rows: InlineKeyboardButton[][]): InlineKeyboardMarkup {
  return { inline_keyboard: rows };
}

/**
 * Step 8.4: the consistent settings-screen pattern -- two buttons per
 * row, live state shown on the button label, a checkmark on whichever
 * option is currently active, and a trailing Back row.
 */
export interface SettingsOption {
  label: string;
  callbackData: string;
  active: boolean;
}

export function settingsScreen(optionPairs: SettingsOption[][], backCallbackData: string): InlineKeyboardMarkup {
  const rows: InlineKeyboardButton[][] = optionPairs.map((pair) =>
    pair.map((opt) => ({
      text: opt.active ? `✅ ${opt.label}` : opt.label,
      callback_data: opt.callbackData,
    }))
  );
  rows.push([{ text: "⬅️ Back", callback_data: backCallbackData }]);
  return keyboard(rows);
}
