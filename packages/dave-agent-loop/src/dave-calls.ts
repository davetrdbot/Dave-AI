import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { appendCallEvent } from "@dave/ea-bridge";
import { publishActivity } from "./activity-bus.js";
import type { AgentTool } from "./tool-registry.js";

/**
 * Dave calls the trader (the trader: "add a feature that it will call me -- Gemini Live -- design the
 * UI so I can receive it outside the app or inside, like WhatsApp").
 *
 * Dave decides to call (the call_trader tool). The call goes to the phone through the trade-event
 * stream the app's background service already holds open, so it rings with the app closed: a
 * full-screen incoming-call screen with Answer / Decline. Answering opens a Gemini Live call whose
 * instructions carry why Dave called, and Dave speaks first. A declined or unanswered call is told
 * back to Dave, so he can follow up in writing.
 */

export interface DaveCall {
  id: string;
  reason: string;
  symbol: string;
  urgent: boolean;
  at: number;
  status: "ringing" | "answered" | "declined" | "missed";
  updatedAt: number;
}

/** No more than one call in this window unless it's urgent -- a phone that keeps ringing gets muted. */
export const CALL_COOLDOWN_MS = 10 * 60_000;
/** A call nobody answered in this long is missed. */
export const RING_TIMEOUT_MS = 60_000;

function path(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "trading", userId, "calls.json");
}
function readCalls(userId: string): DaveCall[] {
  try {
    if (existsSync(path(userId))) return JSON.parse(readFileSync(path(userId), "utf8")) as DaveCall[];
  } catch {
    /* a broken file means no history */
  }
  return [];
}
function writeCalls(userId: string, calls: DaveCall[]): void {
  mkdirSync(dirname(path(userId)), { recursive: true });
  writeFileSync(path(userId), JSON.stringify(calls.slice(-50), null, 2), "utf8");
}

export class CallCooldownError extends Error {}

/** Rings the trader's phone. */
export function placeCall(userId: string, input: { reason: string; symbol?: string; urgent?: boolean }, now = Date.now()): DaveCall {
  const reason = input.reason.replace(/\s+/g, " ").trim().slice(0, 400);
  if (reason.length < 4) throw new Error("Say why you're calling (one sentence).");
  const calls = expireRinging(userId, now);
  const last = calls.at(-1);
  if (last && !input.urgent && now - last.at < CALL_COOLDOWN_MS) {
    throw new CallCooldownError(`You called ${Math.round((now - last.at) / 60_000)} min ago -- wait ${Math.ceil((CALL_COOLDOWN_MS - (now - last.at)) / 60_000)} min, mark it urgent if it truly can't wait, or send a message instead.`);
  }
  const call: DaveCall = { id: `call-${randomBytes(5).toString("hex")}`, reason, symbol: (input.symbol ?? "").toUpperCase(), urgent: !!input.urgent, at: now, status: "ringing", updatedAt: now };
  calls.push(call);
  writeCalls(userId, calls);
  appendCallEvent(userId, { id: call.id, text: reason, urgent: call.urgent, symbol: call.symbol }, now);
  publishActivity(userId, "background", "call", { text: `📞 Calling you${call.urgent ? " (urgent)" : ""}: ${reason}`, callId: call.id });
  return call;
}

/** Ringing calls past the timeout become missed (told to the chat once). */
function expireRinging(userId: string, now: number): DaveCall[] {
  const calls = readCalls(userId);
  let changed = false;
  for (const c of calls) {
    if (c.status === "ringing" && now - c.at > RING_TIMEOUT_MS) {
      c.status = "missed";
      c.updatedAt = now;
      changed = true;
      publishActivity(userId, "chat", "notice", { text: `📞 Missed call from Dave: ${c.reason}` });
    }
  }
  if (changed) writeCalls(userId, calls);
  return calls;
}

export function getCall(userId: string, id: string, now = Date.now()): DaveCall | undefined {
  return expireRinging(userId, now).find((c) => c.id === id);
}

export function listCalls(userId: string, now = Date.now()): DaveCall[] {
  return expireRinging(userId, now);
}

/** The phone reports what the trader did with the call. */
export function setCallStatus(userId: string, id: string, status: "answered" | "declined" | "missed", now = Date.now()): DaveCall | undefined {
  const calls = readCalls(userId);
  const c = calls.find((x) => x.id === id);
  if (!c) return undefined;
  if (c.status === status) return c;
  c.status = status;
  c.updatedAt = now;
  writeCalls(userId, calls);
  if (status === "declined") publishActivity(userId, "chat", "notice", { text: `📞 You declined Dave's call. What he wanted: ${c.reason}` });
  if (status === "missed") publishActivity(userId, "chat", "notice", { text: `📞 Missed call from Dave: ${c.reason}` });
  return c;
}

/** The line added to the Gemini Live instructions when the call is one Dave placed. */
export function callOpeningInstruction(call: DaveCall): string {
  return [
    `THIS CALL: YOU called the trader${call.urgent ? " (urgent)" : ""}${call.symbol ? ` about ${call.symbol}` : ""}. Why: ${call.reason}`,
    `Open the call yourself, straight away: a short hello, then in one or two sentences why you called, then what you need from them (a decision, a yes/no, or just to know). Check live numbers with your tools before quoting any.`,
  ].join("\n");
}

export function createCallTraderTool(userId: string): AgentTool {
  return {
    name: "call_trader",
    description:
      "Phone the trader: their phone rings like a WhatsApp call (even with the app closed) and answering starts a live voice call where you speak first. " +
      "Use it when something needs their voice NOW: they asked you to call them (\"call me when gold hits 2650\"), a decision only they can make, a trade in real danger, a big win to bank. " +
      "Not for routine updates -- write those. One call per 10 minutes unless urgent. If they decline or miss it you'll be told; then follow up in writing.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Why you're calling, one or two sentences -- shown on the ringing screen and said when they answer." },
        symbol: { type: "string", description: "The pair it's about, if any." },
        urgent: { type: "boolean", description: "True only when it can't wait (skips the 10-minute gap)." },
      },
      required: ["reason"],
    },
    execute: async (args: Record<string, unknown>) => {
      try {
        const c = placeCall(userId, { reason: String(args.reason ?? ""), symbol: typeof args.symbol === "string" ? args.symbol : undefined, urgent: args.urgent === true });
        return { ok: true, callId: c.id, status: "ringing", note: "Their phone is ringing. If they answer, the live call opens with your reason. If not, you'll see a missed/declined note -- then write to them." };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
