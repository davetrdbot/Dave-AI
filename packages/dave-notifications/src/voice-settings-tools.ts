import type { DaveDatabase } from "@dave/db";
import { getVoiceSettings, setVoiceEnabled, setActiveProvider, setVoiceId, type TtsProviderName } from "./voice-settings.js";

/**
 * Update 17 (settings audit): voice (TTS) settings had real get/set
 * functions (Step 21.3) but NO agent-callable tool wrapper -- a user
 * could change this via the admin UI but Dave itself had no tool to
 * read or write it conversationally. Full parity now.
 */
export interface VoiceSettingsToolContext {
  userId: string;
  db: DaveDatabase;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: VoiceSettingsToolContext) => Promise<unknown>;
}

export const VOICE_SETTINGS_TOOLS: ToolDefinition[] = [
  {
    name: "get_voice_settings",
    description: "Read the user's real voice (text-to-speech) settings -- enabled, active provider, voice ids.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => getVoiceSettings(ctx.db, ctx.userId),
  },
  {
    name: "set_voice_enabled",
    description: "Turn voice (TTS) replies on/off for the user.",
    parameters: { type: "object", properties: { enabled: { type: "boolean" } }, required: ["enabled"] },
    execute: async (args, ctx) => {
      setVoiceEnabled(ctx.db, ctx.userId, Boolean(args.enabled));
      return getVoiceSettings(ctx.db, ctx.userId);
    },
  },
  {
    name: "set_active_voice_provider",
    description: "Switch which TTS provider (fish-audio/elevenlabs) is currently active.",
    parameters: { type: "object", properties: { provider: { type: "string", enum: ["fish-audio", "elevenlabs"] } }, required: ["provider"] },
    execute: async (args, ctx) => {
      setActiveProvider(ctx.db, ctx.userId, args.provider as TtsProviderName);
      return getVoiceSettings(ctx.db, ctx.userId);
    },
  },
  {
    name: "set_voice_id",
    description: "Set the real voice id to use for a given TTS provider.",
    parameters: { type: "object", properties: { provider: { type: "string", enum: ["fish-audio", "elevenlabs"] }, voiceId: { type: "string" } }, required: ["provider", "voiceId"] },
    execute: async (args, ctx) => {
      setVoiceId(ctx.db, ctx.userId, args.provider as TtsProviderName, args.voiceId as string);
      return getVoiceSettings(ctx.db, ctx.userId);
    },
  },
];
