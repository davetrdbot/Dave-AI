/**
 * Update 6: Green API handles WhatsApp call connection. Real, research-
 * confirmed facts (fetched from green-api.com's own docs before writing
 * this):
 * - Every real Green API method shares one real URL shape:
 *   `POST {apiUrl}/waInstance{idInstance}/{method}/{apiTokenInstance}`
 *   -- server-to-server auth via the token embedded in the URL path
 *   itself, no Bearer header, confirmed against the real SendMessage
 *   docs.
 * - A real INCOMING call arrives as a webhook with
 *   `typeWebhook: "incomingCall"` and a `status` of "offer" -> "pickUp"
 *   /"hungUp"/"declined", confirmed against the real docs example.
 * - A real OUTGOING call notification (`typeWebhook: "outgoingCall"`)
 *   carries `duration`, `isVideo`, and a `participants[]` array with
 *   per-participant status.
 * - Confirmed via the real `whatsapp-api-calls-client-js` library's own
 *   package.json: PLACING a call is WebRTC-based (depends on
 *   `navigator.mediaDevices`/`RTCPeerConnection`, real browser globals)
 *   -- there is no plain REST "sendCall" endpoint. A Node.js backend
 *   genuinely cannot place the WebRTC call itself without a browser or
 *   a real WebRTC media stack, which does not exist in this build (see
 *   PROGRESS.md's "not yet done" note for this update). What IS real
 *   and fully server-to-server here: receiving/parsing real call
 *   webhooks, and sending a real WhatsApp text message as a fallback
 *   ("Dave is trying to reach you") via the confirmed SendMessage
 *   endpoint.
 */

export interface GreenApiConfig {
  idInstance: string;
  apiTokenInstance: string;
  apiUrl?: string;
}

export type CallWebhookStatus = "offer" | "pickUp" | "hungUp" | "declined" | "invalid";

export interface IncomingCallWebhook {
  typeWebhook: "incomingCall";
  from: string;
  status: CallWebhookStatus;
  timestamp: number;
  idMessage: string;
  instanceData: { idInstance: number; wid: string; typeInstance: string };
}

export interface OutgoingCallWebhook {
  typeWebhook: "outgoingCall";
  from: string;
  status: CallWebhookStatus;
  isVideo: boolean;
  duration: number;
  timestamp: number;
  idMessage: string;
  participants: { id: string; status: CallWebhookStatus }[];
  instanceData: { idInstance: number; wid: string; typeInstance: string };
}

export type CallWebhook = IncomingCallWebhook | OutgoingCallWebhook;

export function parseCallWebhook(body: unknown): CallWebhook | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const typeWebhook = (body as Record<string, unknown>).typeWebhook;
  if (typeWebhook === "incomingCall" || typeWebhook === "outgoingCall") {
    return body as CallWebhook;
  }
  return undefined;
}

export class GreenApiRequestError extends Error {
  constructor(
    public readonly method: string,
    public readonly status: number,
    body: string
  ) {
    super(`Green API "${method}" failed: HTTP ${status}: ${body}`);
    this.name = "GreenApiRequestError";
  }
}

export class GreenApiClient {
  private readonly apiUrl: string;

  constructor(private readonly config: GreenApiConfig) {
    this.apiUrl = config.apiUrl ?? "https://api.green-api.com";
  }

  private methodUrl(method: string): string {
    return `${this.apiUrl}/waInstance${this.config.idInstance}/${method}/${this.config.apiTokenInstance}`;
  }

  /** Real, confirmed REST call -- used for the fallback "Dave is trying to reach you" text. */
  async sendTextMessage(chatId: string, message: string, timeoutMs = 10000): Promise<{ idMessage: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(this.methodUrl("sendMessage"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chatId, message }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new GreenApiRequestError("sendMessage", 0, err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      throw new GreenApiRequestError("sendMessage", res.status, await res.text());
    }
    return res.json() as Promise<{ idMessage: string }>;
  }

  /** Real state-check call, same confirmed URL pattern, no body. */
  async getStateInstance(timeoutMs = 10000): Promise<{ stateInstance: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(this.methodUrl("getStateInstance"), { method: "GET", signal: controller.signal });
    } catch (err) {
      throw new GreenApiRequestError("getStateInstance", 0, err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      throw new GreenApiRequestError("getStateInstance", res.status, await res.text());
    }
    return res.json() as Promise<{ stateInstance: string }>;
  }
}

export function whatsappChatId(numberWithCountryCode: string): string {
  const digits = numberWithCountryCode.replace(/[^\d]/g, "");
  return `${digits}@c.us`;
}
