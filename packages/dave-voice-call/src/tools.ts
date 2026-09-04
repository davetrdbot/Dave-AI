import type { DaveDatabase } from "@dave/db";
import { getVoiceCallSettings } from "./call-settings.js";
import { GreenApiClient, whatsappChatId } from "./green-api-client.js";
import { evaluateCallTrigger, type CallTriggerState } from "./trigger.js";

/**
 * Update 6: real, agent-callable voice-call tools -- same
 * `ToolDefinition` shape as every other tool manifest in this repo.
 */
export interface VoiceCallToolContext {
  userId: string;
  db: DaveDatabase;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: VoiceCallToolContext) => Promise<unknown>;
}

export class VoiceCallNotConfiguredError extends Error {
  constructor() {
    super("WhatsApp calling is not configured -- set Green API Token, Instance ID, and your WhatsApp number in Settings first.");
    this.name = "VoiceCallNotConfiguredError";
  }
}

export const VOICE_CALL_TOOLS: ToolDefinition[] = [
  {
    name: "evaluate_call_trigger",
    description: "Decide whether the current situation warrants a real WhatsApp call attempt: the user has been unresponsive on Telegram for the configured duration AND you have something to tell them, or you have an urgent unanswered question.",
    parameters: {
      type: "object",
      properties: {
        lastUserTelegramActivityAt: { type: "number", description: "Unix ms of the user's last Telegram activity." },
        daveHasSomethingToTell: { type: "boolean" },
        daveHasUrgentUnansweredQuestion: { type: "boolean" },
      },
      required: ["lastUserTelegramActivityAt"],
    },
    execute: async (args, ctx) => {
      const settings = getVoiceCallSettings(ctx.db, ctx.userId);
      const state: CallTriggerState = {
        lastUserTelegramActivityAt: args.lastUserTelegramActivityAt as number,
        now: Date.now(),
        unresponsiveMinutes: settings.unresponsiveMinutes,
        daveHasSomethingToTell: Boolean(args.daveHasSomethingToTell),
        daveHasUrgentUnansweredQuestion: Boolean(args.daveHasUrgentUnansweredQuestion),
      };
      return evaluateCallTrigger(state);
    },
  },
  {
    name: "notify_trying_to_reach_you",
    description: "Send a real WhatsApp text (via Green API) telling the user Dave is trying to reach them -- the honest fallback for the parts of WhatsApp calling that require a browser-based WebRTC client this backend doesn't have.",
    parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
    execute: async (args, ctx) => {
      const settings = getVoiceCallSettings(ctx.db, ctx.userId);
      if (!settings.greenApiToken || !settings.greenApiInstanceId || !settings.whatsappNumber) {
        throw new VoiceCallNotConfiguredError();
      }
      const client = new GreenApiClient({ idInstance: settings.greenApiInstanceId, apiTokenInstance: settings.greenApiToken });
      return client.sendTextMessage(whatsappChatId(settings.whatsappNumber), args.message as string);
    },
  },
];
