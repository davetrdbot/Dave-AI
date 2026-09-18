import type { InlineKeyboardButton, InlineKeyboardMarkup } from "./client.js";

/**
 * Step 8.3: "colored inline buttons used meaningfully."
 *
 * CORRECTED: an earlier pass here concluded InlineKeyboardButton has no
 * color field and built an emoji-prefix workaround instead -- that was
 * wrong. Checked again by pulling the raw docs HTML directly (the same
 * WebFetch-summary tool that produced the wrong answer the first time
 * silently missed this field on a page too large for its summarizer to
 * fully cover -- exactly the failure mode that also caused the
 * sendRichMessageDraft bug). The real field: `style`, one of "danger"
 * (red), "success" (green), or "primary" (blue). This is a genuine,
 * native Telegram feature, not a workaround.
 */
export type ButtonColor = "green" | "red" | "blue" | "neutral";

const COLOR_STYLE: Record<ButtonColor, InlineKeyboardButton["style"]> = {
  green: "success",
  red: "danger",
  blue: "primary",
  neutral: undefined,
};

// Telegram's real limit for callback_data, confirmed in the docs: 1-64 bytes.
const CALLBACK_DATA_MAX_BYTES = 64;

export function coloredButton(text: string, color: ButtonColor, callbackData: string): InlineKeyboardButton {
  const byteLength = new TextEncoder().encode(callbackData).length;
  if (byteLength === 0 || byteLength > CALLBACK_DATA_MAX_BYTES) {
    throw new Error(`callback_data must be 1-64 bytes, got ${byteLength} for "${callbackData}"`);
  }
  const style = COLOR_STYLE[color];
  return style ? { text, callback_data: callbackData, style } : { text, callback_data: callbackData };
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

/**
 * Update 8: "whenever [Dave] wants to [change a setting] it should ask
 * the user approve or decline, coloured buttons." Domain-agnostic --
 * `pendingId` is whatever id the proposing domain (dave-trading's
 * `proposeSettingsChange`, or any other) generated; the callback data
 * carries it back so the handler knows exactly which pending change to
 * approve/decline.
 */
export function approvalKeyboard(pendingId: string, domain: string): InlineKeyboardMarkup {
  return keyboard([[coloredButton("✅ Approve", "green", `approve:${domain}:${pendingId}`), coloredButton("❌ Decline", "red", `decline:${domain}:${pendingId}`)]]);
}

/**
 * Real bug fixed (the owner, from a live Telegram screenshot: a below-threshold trade arrived as
 * "⚠️ CRASH_200 SELL 0.01 lots -- confidence 66% is below your 70% threshold... Approve to place
 * it, or decline to skip." with NO buttons attached at all, so there was literally nothing to
 * press). The interactive half only ever existed inline in full-registry.ts's trade_execute
 * wrapper -- the autonomous tick, which is what actually produced that message, returned a bare
 * string and its send path attached no reply_markup. Lifted here, next to approvalKeyboard above,
 * so both real producers of a trade-approval ask build the SAME keyboard instead of one of them
 * silently shipping a dead prompt. Callback data matches command-router.ts's existing
 * tradeapprove:/tradedecline:/tradefindanother: dispatcher exactly.
 */
export function tradeApprovalKeyboard(pendingId: string): InlineKeyboardMarkup {
  return keyboard([
    [
      coloredButton("✅ Approve", "green", `tradeapprove:${pendingId}`),
      coloredButton("❌ Decline", "red", `tradedecline:${pendingId}`),
      coloredButton("🔍 Find Another", "neutral", `tradefindanother:${pendingId}`),
    ],
  ]);
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
