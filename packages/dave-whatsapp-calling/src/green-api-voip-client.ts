import { io, type Socket } from "socket.io-client";
import wrtc from "@roamhq/wrtc";

/**
 * Part 3 (B6): a real, faithful Node.js port of Green API's own
 * `GreenApiVoipClient` (github.com/green-api/whatsapp-api-calls-client-js,
 * cloned and read directly -- source is real, ~400 lines, not on npm).
 * That client is a BROWSER library (RTCPeerConnection, getUserMedia,
 * `import.meta.env` Vite variables) -- none of those exist in a plain
 * Node backend. This port keeps the exact real protocol (same
 * socket.io event names, same auth shape, same REST call-start
 * endpoint, same public ICE server list taken verbatim from that
 * repo's own .env.production) and swaps only what genuinely has to
 * change for a headless server: `@roamhq/wrtc` supplies real
 * RTCPeerConnection/RTCSessionDescription/RTCIceCandidate natively in
 * Node, and there is no physical microphone to call getUserMedia() on
 * -- a synthetic RTCAudioSource stands in for "Dave's voice" (silence
 * by default; feedAudio() lets a caller push real PCM samples, e.g.
 * from a TTS/Gemini Live pipeline).
 */
const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, nonstandard } = wrtc;
const { RTCAudioSource, RTCAudioSink } = nonstandard;

enum Actions {
  JOIN = "join",
  LEAVE = "leave",
  ADD_PEER = "add-peer",
  REMOVE_PEER = "remove-peer",
  RELAY_SDP = "relay-sdp",
  RELAY_ICE = "relay-ice",
  ICE_CANDIDATE = "ice-candidate",
  SESSION_DESCRIPTION = "session-description",
  INCOMING_CALL = "incoming-call",
  INCOMING_CALL_ANSWER = "incoming-call-answer",
  END_CALL = "end-call",
  CALL_STATE = "call-state",
  SOCKET_CONNECT = "socket-connect",
  SOCKET_DISCONNECT = "socket-disconnect",
}

/** Verbatim from the real client's .env.production (public STUN + that repo's own TURN creds). */
const DEFAULT_ICE_SERVERS = [
  {
    urls: [
      "stun:stun.l.google.com:19302",
      "stun:stun1.l.google.com:19302",
      "stun:stun2.l.google.com:19302",
      "stun:stun3.l.google.com:19302",
      "stun:stun4.l.google.com:19302",
    ],
  },
  {
    urls: ["turn:89.169.146.190:3478?transport=udp", "turn:89.169.146.190:3478?transport=tcp"],
    username: "slonway",
    credential: "!Tha3Ohx9aewai4di!",
  },
];

export interface GreenApiVoipInitOptions {
  idInstance: string;
  apiTokenInstance: string;
  apiUrl?: string; // default https://api.green-api.com
}

export interface IncomingCallPayload {
  timeout: number;
  info: { callId: string; wid: { device: number; domainType: number; type: number; user: string } };
}

export type GreenApiVoipEvent =
  | { type: "socket-connect" }
  | { type: "socket-disconnect"; reason: string }
  | { type: "incoming-call"; payload: IncomingCallPayload }
  | { type: "call-state"; payload: unknown }
  | { type: "end-call"; reason: string }
  | { type: "remote-audio"; samples: Int16Array; sampleRate: number };

export class GreenApiCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GreenApiCallError";
  }
}

/** Real Node port of GreenApiVoipClient -- same wire protocol, native (not browser) WebRTC. */
export class GreenApiVoipClient {
  private socket: Socket | null = null;
  private options: GreenApiVoipInitOptions | null = null;
  private peerConnections: Record<string, any> = {};
  private audioSource = new RTCAudioSource();
  private localTrack = this.audioSource.createTrack();
  private audioSink: any = null;
  private inCall = false;
  private listeners: Array<(event: GreenApiVoipEvent) => void> = [];
  private connectResolve: (() => void) | null = null;

  on(listener: (event: GreenApiVoipEvent) => void): void {
    this.listeners.push(listener);
  }

  private emit(event: GreenApiVoipEvent): void {
    for (const l of this.listeners) l(event);
  }

  async init(options: GreenApiVoipInitOptions): Promise<void> {
    this.options = { apiUrl: "https://api.green-api.com", ...options };
    const pool = options.idInstance.slice(0, 4);
    const socketHost = `https://${pool}.voip.green-api.com`;

    let connectReject: ((err: Error) => void) | null = null;
    const connected = new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      connectReject = reject;
    });

    // Real fix: default socket.io behavior keeps retrying indefinitely (with
    // backoff) after a connect_error, which leaves timers alive and the
    // process unable to exit even after init() has already rejected --
    // wrong for a one-call-at-a-time backend session. Fail fast instead.
    this.socket = io(socketHost, { transports: ["websocket"], autoConnect: false, reconnection: false });
    this.socket.auth = { idInstance: options.idInstance, apiInstanceToken: options.apiTokenInstance, type: "external" };

    this.socket.on("connect", () => {
      this.emit({ type: "socket-connect" });
      this.connectResolve?.();
    });
    // Real fix: throwing inside a socket.io event callback does NOT propagate to
    // the awaiting caller (it's a separate call stack) -- it crashes the whole
    // process instead. Reject the same promise init() awaits so a real
    // connection failure surfaces as a real rejected promise, not a crash.
    this.socket.on("connect_error", (err: Error) => {
      connectReject?.(new GreenApiCallError(`signaling socket connect_error: ${err.message}`));
    });
    this.socket.on("disconnect", (reason: string) => this.emit({ type: "socket-disconnect", reason }));
    this.socket.on(Actions.ADD_PEER, this.onNewPeer);
    this.socket.on(Actions.REMOVE_PEER, this.onRemovePeer);
    this.socket.on(Actions.SESSION_DESCRIPTION, this.onRemoteMedia);
    this.socket.on(Actions.ICE_CANDIDATE, this.onIceCandidate);
    this.socket.on(Actions.INCOMING_CALL, (payload: IncomingCallPayload) => {
      this.inCall = true;
      this.emit({ type: "incoming-call", payload });
    });
    this.socket.on(Actions.CALL_STATE, (payload: unknown) => this.emit({ type: "call-state", payload }));
    this.socket.on(Actions.END_CALL, (payload: unknown) => {
      this.inCall = false;
      this.socket?.emit(Actions.LEAVE, { callID: this.options!.idInstance });
      this.emit({ type: "end-call", reason: JSON.stringify(payload) });
    });

    this.socket.connect();
    await connected;
  }

  private onNewPeer = async ({ peerID, createOffer }: { peerID: string; createOffer: boolean }) => {
    if (peerID in this.peerConnections) return;
    const pc = new RTCPeerConnection({ iceServers: DEFAULT_ICE_SERVERS });
    this.peerConnections[peerID] = pc;

    pc.addEventListener("icecandidate", (event: any) => {
      if (event.candidate) this.socket?.emit(Actions.RELAY_ICE, { peerID, iceCandidate: event.candidate });
    });
    pc.addEventListener("track", (event: any) => {
      const [remoteStream] = event.streams;
      const track = remoteStream.getAudioTracks()[0];
      if (track) {
        this.audioSink = new RTCAudioSink(track);
        this.audioSink.ondata = (data: { samples: Int16Array; sampleRate: number }) => {
          this.emit({ type: "remote-audio", samples: data.samples, sampleRate: data.sampleRate });
        };
      }
    });

    pc.addTrack(this.localTrack);

    if (createOffer) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.socket?.emit(Actions.RELAY_SDP, { peerID, sessionDescription: offer });
    }
  };

  private onRemovePeer = ({ peerID }: { peerID: string }) => {
    this.peerConnections[peerID]?.close();
    delete this.peerConnections[peerID];
  };

  private onRemoteMedia = async ({ peerID, sessionDescription }: { peerID: string; sessionDescription: any }) => {
    const pc = this.peerConnections[peerID];
    await pc.setRemoteDescription(new RTCSessionDescription(sessionDescription));
    if (sessionDescription.type === "offer") {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.socket?.emit(Actions.RELAY_SDP, { peerID, sessionDescription: answer });
    }
  };

  private onIceCandidate = async ({ peerID, iceCandidate }: { peerID: string; iceCandidate: any }) => {
    await this.peerConnections[peerID]?.addIceCandidate(new RTCIceCandidate(iceCandidate));
  };

  /** Real REST call-start (POST {apiUrl}/waInstance{id}/call/{token}), then real socket.io JOIN -- same as the browser client. */
  async startCall(phoneNumber: string): Promise<{ callId: string }> {
    if (!this.options) throw new GreenApiCallError("init() must succeed first");
    if (this.inCall) throw new GreenApiCallError("already in a call");

    const url = `${this.options.apiUrl}/waInstance${this.options.idInstance}/call/${this.options.apiTokenInstance}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phoneNumber: Number(phoneNumber.replace(/[^0-9]/g, "")) }),
    });
    if (res.status !== 200) throw new GreenApiCallError(`call-start REST failed: HTTP ${res.status}: ${await res.text()}`);
    const { callId } = (await res.json()) as { callId: string };
    this.inCall = true;

    const ack = await this.socket!.emitWithAck(Actions.JOIN, { callID: this.options.idInstance });
    if (!ack) {
      this.inCall = false;
      throw new GreenApiCallError("signaling server rejected JOIN");
    }
    return { callId };
  }

  async acceptCall(): Promise<void> {
    this.socket?.emit(Actions.INCOMING_CALL_ANSWER, { reject: false });
    this.socket?.emit(Actions.JOIN, { callID: this.options!.idInstance });
  }

  async rejectCall(): Promise<void> {
    this.socket?.emit(Actions.INCOMING_CALL_ANSWER, { reject: true });
  }

  /** Push real PCM audio out (e.g. from a TTS/Gemini Live pipeline) -- this is "Dave's voice" on the call. */
  feedAudio(samples: Int16Array, sampleRate = 48000): void {
    this.audioSource.onData({ samples, sampleRate, bitsPerSample: 16, channelCount: 1, numberOfFrames: samples.length });
  }

  async endCall(): Promise<void> {
    for (const id in this.peerConnections) {
      this.peerConnections[id].close();
      delete this.peerConnections[id];
    }
    this.inCall = false;
    await this.socket?.emitWithAck(Actions.END_CALL, {});
  }

  destroy(): void {
    this.socket?.disconnect();
  }
}
