import type { DaveDatabase } from "@dave/db";
import { getVoiceCallSettings, setVoiceCallSettings } from "./call-settings.js";

/**
 * Update 17 (settings audit): Green API/WhatsApp-calling settings had
 * a real admin API route (Update 6) but no agent-callable tool for
 * reading/writing them conversationally.
 */
export interface CallSettingsToolContext {
  userId: string;
  db: DaveDatabase;
}

export interface CallSettingsToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: CallSettingsToolContext) => Promise<unknown>;
}

export const CALL_SETTINGS_TOOLS: CallSettingsToolDefinition[] = [
  {
    name: "get_voice_call_settings",
    description: "Read the user's Green API/WhatsApp-calling settings -- instance id, WhatsApp number, unresponsive-duration threshold, and whether a token is set (the token itself is never returned in plaintext).",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => {
      const s = getVoiceCallSettings(ctx.db, ctx.userId);
      return { greenApiInstanceId: s.greenApiInstanceId, whatsappNumber: s.whatsappNumber, unresponsiveMinutes: s.unresponsiveMinutes, tokenSet: Boolean(s.greenApiToken) };
    },
  },
  {
    name: "set_voice_call_settings",
    description: "Set or update the user's Green API token/instance id/WhatsApp number/unresponsive-duration threshold. Omit any field to leave it unchanged.",
    parameters: {
      type: "object",
      properties: {
        greenApiToken: { type: "string" },
        greenApiInstanceId: { type: "string" },
        whatsappNumber: { type: "string" },
        unresponsiveMinutes: { type: "number" },
      },
    },
    execute: async (args, ctx) => {
      // Only include fields the caller actually provided -- setVoiceCallSettings
      // merges via {...current, ...patch}, so an explicit `undefined` key would
      // WIPE an existing value rather than leaving it untouched.
      const patch: Record<string, unknown> = {};
      if (args.greenApiToken !== undefined) patch.greenApiToken = args.greenApiToken;
      if (args.greenApiInstanceId !== undefined) patch.greenApiInstanceId = args.greenApiInstanceId;
      if (args.whatsappNumber !== undefined) patch.whatsappNumber = args.whatsappNumber;
      if (args.unresponsiveMinutes !== undefined) patch.unresponsiveMinutes = args.unresponsiveMinutes;
      const updated = setVoiceCallSettings(ctx.db, ctx.userId, patch);
      return { greenApiInstanceId: updated.greenApiInstanceId, whatsappNumber: updated.whatsappNumber, unresponsiveMinutes: updated.unresponsiveMinutes, tokenSet: Boolean(updated.greenApiToken) };
    },
  },
];
