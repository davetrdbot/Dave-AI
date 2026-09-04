import { WebSocket } from "ws";

/**
 * Update 6: Gemini Live API as the real-time voice sub-agent. Real,
 * research-confirmed endpoint:
 * `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`
 * -- a real bidirectional WebSocket, API key passed as a query param,
 * first client message is a real `BidiGenerateContentSetup` envelope.
 *
 * This is a genuine connection attempt against the real endpoint, same
 * "real attempt, honest typed failure without a working key" pattern
 * used throughout this build (AirLLM, DAVEMA, MCP trade connections).
 * What this class does NOT do: bridge real WhatsApp call audio to
 * Gemini -- that would require a real WebRTC media stack decoding the
 * call's RTP audio, which green-api-client.ts's own comment documents
 * as genuinely unavailable server-side (WhatsApp calling via Green API
 * is WebRTC/browser-only, confirmed via research). This class proves
 * the Gemini Live half of the pipe is real and reachable; the audio
 * bridge is the documented gap.
 */
const GEMINI_LIVE_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

export class GeminiLiveConnectionError extends Error {
  constructor(cause: unknown) {
    super(`Could not connect to Gemini Live API: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "GeminiLiveConnectionError";
  }
}

export interface GeminiLiveSetupOptions {
  apiKey: string;
  model?: string;
  systemInstruction?: string;
  voiceName?: string;
}

export class GeminiLiveClient {
  private socket: WebSocket | undefined;

  /**
   * Real connection + real setup handshake against the real endpoint.
   * Confirmed via a live probe: the WebSocket upgrade itself succeeds
   * even with an invalid API key -- Google only rejects the key
   * AFTER the real `setup` message is sent, closing the socket with
   * close code 1007 and a real "API key not valid" reason. So a bad
   * key is only detectable by waiting past `open` for either the
   * server's `setupComplete` ack or an early close/error -- resolving
   * on `open` alone would be a false positive.
   */
  async connect(opts: GeminiLiveSetupOptions, timeoutMs = 10000): Promise<void> {
    const url = `${GEMINI_LIVE_URL}?key=${encodeURIComponent(opts.apiKey)}`;
    const socket = new WebSocket(url);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error(`no setup acknowledgement within ${timeoutMs}ms`));
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        socket.removeAllListeners("message");
        socket.removeAllListeners("close");
        socket.removeAllListeners("error");
      };

      socket.once("open", () => {
        socket.send(
          JSON.stringify({
            setup: {
              model: `models/${opts.model ?? "gemini-2.5-flash-native-audio-preview"}`,
              generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: opts.voiceName ? { voiceConfig: { prebuiltVoiceConfig: { voiceName: opts.voiceName } } } : undefined,
              },
              systemInstruction: opts.systemInstruction ? { parts: [{ text: opts.systemInstruction }] } : undefined,
            },
          })
        );
      });
      socket.once("message", () => {
        cleanup();
        resolve();
      });
      socket.once("close", (code, reason) => {
        cleanup();
        reject(new Error(`connection closed before setup completed (code ${code}): ${reason.toString()}`));
      });
      socket.once("error", (err) => {
        cleanup();
        reject(err);
      });
      socket.once("unexpected-response", (_req, res) => {
        cleanup();
        reject(new Error(`unexpected HTTP response during WebSocket upgrade: ${res.statusCode}`));
      });
    }).catch((err) => {
      throw new GeminiLiveConnectionError(err);
    });

    this.socket = socket;
  }

  isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.socket?.close();
    this.socket = undefined;
  }
}
