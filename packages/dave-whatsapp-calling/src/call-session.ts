import { GreenApiVoipClient, type GreenApiVoipEvent, type IncomingCallPayload } from "./green-api-voip-client.js";
import { getGreenApiCredentials } from "./greenapi-credentials.js";
import type { DaveDatabase } from "@dave/db";

/**
 * Part 3 (B6): one real, live GreenApiVoipClient session per user --
 * same "in-memory only, real live socket" honesty as EaTradeExecutor's
 * pending map and the MCP manager's live connections. A call is a real
 * live signaling+WebRTC session; it cannot be persisted across a
 * process restart.
 */
interface CallSessionState {
  client: GreenApiVoipClient;
  events: GreenApiVoipEvent[];
  pendingIncomingCall: IncomingCallPayload | null;
}

const sessions = new Map<string, CallSessionState>();

export class NoGreenApiCredentialsError extends Error {
  constructor() {
    super("No Green API credentials stored for this user -- call set_greenapi_credentials first.");
    this.name = "NoGreenApiCredentialsError";
  }
}

async function ensureSession(db: DaveDatabase, userId: string): Promise<CallSessionState> {
  const existing = sessions.get(userId);
  if (existing) return existing;

  const creds = getGreenApiCredentials(db, userId);
  if (!creds) throw new NoGreenApiCredentialsError();

  const client = new GreenApiVoipClient();
  const state: CallSessionState = { client, events: [], pendingIncomingCall: null };
  client.on((event) => {
    state.events.push(event);
    if (event.type === "incoming-call") state.pendingIncomingCall = event.payload;
    if (event.type === "end-call") state.pendingIncomingCall = null;
  });
  await client.init({ idInstance: creds.idInstance, apiTokenInstance: creds.apiTokenInstance });
  sessions.set(userId, state);
  return state;
}

export async function placeVoiceCall(db: DaveDatabase, userId: string, phoneNumber: string): Promise<{ callId: string }> {
  const session = await ensureSession(db, userId);
  return session.client.startCall(phoneNumber);
}

export async function acceptInboundCall(db: DaveDatabase, userId: string): Promise<{ accepted: boolean }> {
  const session = await ensureSession(db, userId);
  if (!session.pendingIncomingCall) return { accepted: false };
  await session.client.acceptCall();
  return { accepted: true };
}

export async function rejectInboundCall(db: DaveDatabase, userId: string): Promise<{ rejected: boolean }> {
  const session = await ensureSession(db, userId);
  if (!session.pendingIncomingCall) return { rejected: false };
  await session.client.rejectCall();
  return { rejected: true };
}

export async function endActiveCall(db: DaveDatabase, userId: string): Promise<{ ended: boolean }> {
  const session = sessions.get(userId);
  if (!session) return { ended: false };
  await session.client.endCall();
  return { ended: true };
}

export function getCallStatus(userId: string): { connected: boolean; pendingIncomingCall: IncomingCallPayload | null; recentEvents: GreenApiVoipEvent[] } {
  const session = sessions.get(userId);
  if (!session) return { connected: false, pendingIncomingCall: null, recentEvents: [] };
  return { connected: true, pendingIncomingCall: session.pendingIncomingCall, recentEvents: session.events.slice(-10) };
}
