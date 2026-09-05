import type { DaveDatabase } from "@dave/db";
import { setGreenApiCredentials, getGreenApiCredentials } from "./greenapi-credentials.js";
import { placeVoiceCall, acceptInboundCall, rejectInboundCall, endActiveCall, getCallStatus } from "./call-session.js";

export interface WhatsAppCallToolContext {
  userId: string;
  db: DaveDatabase;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: WhatsAppCallToolContext) => Promise<unknown>;
}

export const WHATSAPP_CALL_TOOLS: ToolDefinition[] = [
  {
    name: "set_greenapi_credentials",
    description: "Store this user's real Green API instance credentials (idInstance + apiTokenInstance) for WhatsApp voice calling.",
    parameters: { type: "object", required: ["idInstance", "apiTokenInstance"], properties: { idInstance: { type: "string" }, apiTokenInstance: { type: "string" } } },
    execute: async (args, ctx) => {
      setGreenApiCredentials(ctx.db, ctx.userId, { idInstance: args.idInstance as string, apiTokenInstance: args.apiTokenInstance as string });
      return { stored: true };
    },
  },
  {
    name: "get_greenapi_credentials_status",
    description: "Check whether Green API credentials are stored for this user (never returns the real token).",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => {
      const creds = getGreenApiCredentials(ctx.db, ctx.userId);
      return { configured: !!creds, idInstance: creds?.idInstance };
    },
  },
  {
    name: "place_voice_call",
    description: "Place a real outbound WhatsApp voice call to a phone number, using the real Green API signaling + WebRTC protocol.",
    parameters: { type: "object", required: ["phoneNumber"], properties: { phoneNumber: { type: "string" } } },
    execute: async (args, ctx) => placeVoiceCall(ctx.db, ctx.userId, args.phoneNumber as string),
  },
  {
    name: "handle_inbound_call",
    description: "Accept or reject a real pending inbound WhatsApp voice call.",
    parameters: { type: "object", required: ["action"], properties: { action: { type: "string", enum: ["accept", "reject"] } } },
    execute: async (args, ctx) => (args.action === "accept" ? acceptInboundCall(ctx.db, ctx.userId) : rejectInboundCall(ctx.db, ctx.userId)),
  },
  {
    name: "end_voice_call",
    description: "End the current real active WhatsApp voice call, if any.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => endActiveCall(ctx.db, ctx.userId),
  },
  {
    name: "get_call_status",
    description: "Get the real current call session status -- connected, any pending inbound call, and recent real signaling events.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => getCallStatus(ctx.userId),
  },
];
