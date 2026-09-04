import { coloredButton, keyboard, type InlineKeyboardButton, type InlineKeyboardMarkup } from "@dave/telegram";
import type { TtsProviderName, VoiceSettings } from "./voice-settings.js";

/**
 * Step 21.3: "fully button-driven" -- every real voice-setting change
 * (on/off, active provider, which voice) happens through a real
 * Telegram inline keyboard, callback_data driven, reusing Step 8's
 * real button primitives (`coloredButton`, `keyboard`) rather than a
 * second differently-shaped button system.
 */

const NAMESPACE = "voice";

export const VoiceCallback = {
  toggle: `${NAMESPACE}:toggle`,
  provider: (p: TtsProviderName) => `${NAMESPACE}:provider:${p}`,
  pickVoice: (provider: TtsProviderName, voiceId: string) => `${NAMESPACE}:pick:${provider}:${voiceId}`,
};

export type VoiceCallbackAction =
  | { action: "toggle" }
  | { action: "provider"; provider: TtsProviderName }
  | { action: "pick"; provider: TtsProviderName; voiceId: string };

export function parseVoiceCallback(data: string): VoiceCallbackAction | undefined {
  const parts = data.split(":");
  if (parts[0] !== NAMESPACE) return undefined;
  if (parts[1] === "toggle") return { action: "toggle" };
  if (parts[1] === "provider" && (parts[2] === "fish-audio" || parts[2] === "elevenlabs")) return { action: "provider", provider: parts[2] };
  if (parts[1] === "pick" && (parts[2] === "fish-audio" || parts[2] === "elevenlabs") && parts[3]) return { action: "pick", provider: parts[2], voiceId: parts.slice(3).join(":") };
  return undefined;
}

/** The real top-level voice settings screen -- on/off, provider choice, and a real state-reflecting label per button. */
export function buildVoiceSettingsKeyboard(settings: VoiceSettings): InlineKeyboardMarkup {
  const rows: InlineKeyboardButton[][] = [
    [coloredButton(settings.enabled ? "Voice: ON" : "Voice: OFF", settings.enabled ? "green" : "red", VoiceCallback.toggle)],
  ];
  if (settings.enabled) {
    rows.push([
      { text: settings.activeProvider === "fish-audio" ? "✓ Fish Audio" : "Fish Audio", callback_data: VoiceCallback.provider("fish-audio") },
      { text: settings.activeProvider === "elevenlabs" ? "✓ ElevenLabs" : "ElevenLabs", callback_data: VoiceCallback.provider("elevenlabs") },
    ]);
  }
  return keyboard(rows);
}

/** A real voice-picker keyboard for one provider -- built from whatever real voice list that provider's API returned. */
export function buildVoicePickerKeyboard(provider: TtsProviderName, voices: { voiceId: string; name: string }[], currentVoiceId: string | null): InlineKeyboardMarkup {
  const rows: InlineKeyboardButton[][] = voices.map((v) => [
    { text: v.voiceId === currentVoiceId ? `✓ ${v.name}` : v.name, callback_data: VoiceCallback.pickVoice(provider, v.voiceId) },
  ]);
  return keyboard(rows);
}
