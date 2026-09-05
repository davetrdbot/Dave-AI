import type { DaveDatabase } from "@dave/db";
import type { TelegramClient } from "@dave/telegram";
import { getBriefSettings, setBriefMode, type BriefMode } from "./morning-brief.js";
import { synthesizeSpeechWithStoredKeys, getVoiceSettings, type TtsProviderName } from "./voice-settings.js";
import { setTtsProviderKey } from "./tts-credentials.js";
import { sendConnectionAlert, sendTradeOpenedAlert, routeClosedPositionAlert, type TradeSystem } from "./trade-alerts.js";

/**
 * Update 18 (bulk tool-coverage expansion): morning brief config, real
 * TTS synthesis, and the connect/opened/closed notification senders
 * (Update 15) had no direct agent-tool surface of their own.
 */
export interface NotificationToolContext {
  userId: string;
  db: DaveDatabase;
  client: TelegramClient;
  chatId: number;
}

export interface NotificationToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: NotificationToolContext) => Promise<unknown>;
}

export const NOTIFICATION_TOOLS: NotificationToolDefinition[] = [
  {
    name: "notification_settings",
    description: "Get or set the user's morning-brief notification mode (off/on/custom cron).",
    parameters: { type: "object", properties: { mode: { type: "string", enum: ["off", "on", "custom"] }, customCronExpression: { type: "string" } } },
    execute: async (args, ctx) => {
      if (args.mode) {
        setBriefMode(ctx.db, ctx.userId, args.mode as BriefMode, args.customCronExpression as string | undefined);
      }
      return getBriefSettings(ctx.db, ctx.userId);
    },
  },
  {
    name: "set_tts_provider_key",
    description: "Store a real Fish Audio or ElevenLabs API key for this user, once -- exactly like add_provider_key does for LLM providers. Needed once before voice replies can genuinely be sent; never has to be supplied again after this.",
    parameters: { type: "object", properties: { provider: { type: "string", enum: ["fish-audio", "elevenlabs"] }, apiKey: { type: "string" } }, required: ["provider", "apiKey"] },
    execute: async (args, ctx) => {
      setTtsProviderKey(ctx.db, ctx.userId, args.provider as TtsProviderName, args.apiKey as string);
      return { stored: true, provider: args.provider };
    },
  },
  {
    name: "send_voice_message",
    description: "Real, complete voice reply: synthesizes real speech from text via the user's stored TTS key/active provider (no key-passing needed) AND actually sends it as a real Telegram voice note (sendVoice) -- not just synthesized audio sitting unreturned.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    execute: async (args, ctx) => {
      const settings = getVoiceSettings(ctx.db, ctx.userId);
      if (!settings.enabled) throw new Error("voice replies are OFF for this user -- turn them on with set_voice_enabled first.");
      const result = await synthesizeSpeechWithStoredKeys(ctx.db, ctx.userId, args.text as string);
      const sent = await ctx.client.sendVoice({ chat_id: ctx.chatId, voice: { buffer: result.audio, filename: "voice.mp3" } });
      return { sent: true, messageId: sent.message_id, provider: result.provider, usedFallback: result.usedFallback, bytes: result.audio.length };
    },
  },
  {
    name: "send_ea_connected_notification",
    description: "Send the real connection-confirmed notification for Dave's or R_Feed's EA.",
    parameters: { type: "object", properties: { system: { type: "string", enum: ["dave", "rfeed"] } }, required: ["system"] },
    execute: async (args, ctx) => sendConnectionAlert(ctx.client, ctx.chatId, args.system as TradeSystem),
  },
  {
    name: "send_trade_opened_notification",
    description: "Send the real trade-opened notification -- system + symbol + lots + reason, all together.",
    parameters: { type: "object", properties: { system: { type: "string", enum: ["dave", "rfeed"] }, symbol: { type: "string" }, lots: { type: "number" }, reason: { type: "string" } }, required: ["system", "symbol", "lots", "reason"] },
    execute: async (args, ctx) => sendTradeOpenedAlert(ctx.client, ctx.chatId, { system: args.system as TradeSystem, symbol: args.symbol as string, lots: args.lots as number, reason: args.reason as string }),
  },
  {
    name: "send_trade_closed_notification",
    description: "Send the real trade-closed notification, routed to the right specific alert (TP-hit/SL-hit/general close) by the real reported reason.",
    parameters: {
      type: "object",
      properties: { system: { type: "string", enum: ["dave", "rfeed"] }, symbol: { type: "string" }, pnl: { type: "number" }, reason: { type: "string", enum: ["tp", "sl", "dave", "manual"] }, daveCloseReason: { type: "string" } },
      required: ["system", "symbol", "pnl", "reason"],
    },
    execute: async (args, ctx) =>
      routeClosedPositionAlert(ctx.client, ctx.chatId, { system: args.system as TradeSystem, symbol: args.symbol as string, pnl: args.pnl as number, reason: args.reason as "tp" | "sl" | "dave" | "manual", daveCloseReason: args.daveCloseReason as string | undefined }),
  },
];
