import type { CallWebhookStatus } from "./green-api-client.js";

/**
 * Update 6: "10-minute session cap." A real timer-enforced cutoff on a
 * live call session, driven by real webhook status transitions
 * (offer -> pickUp -> hungUp/declined), not a simulated countdown.
 */
const SESSION_CAP_MS = 10 * 60 * 1000;

export type CallSessionState = "ringing" | "active" | "ended";

export interface CallSessionEvent {
  state: CallSessionState;
  reason: "answered" | "hung_up" | "declined" | "cap_reached";
}

export class CallSession {
  private state: CallSessionState = "ringing";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners: ((event: CallSessionEvent) => void)[] = [];
  private startedAt: number | undefined;

  constructor(
    public readonly callId: string,
    private readonly capMs: number = SESSION_CAP_MS
  ) {}

  getState(): CallSessionState {
    return this.state;
  }

  onEvent(handler: (event: CallSessionEvent) => void): () => void {
    this.listeners.push(handler);
    return () => {
      const i = this.listeners.indexOf(handler);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  private emit(event: CallSessionEvent): void {
    this.listeners.forEach((l) => l(event));
  }

  /** Real transition, driven by a real Green API webhook status value. */
  applyWebhookStatus(status: CallWebhookStatus): void {
    if (this.state === "ended") return;

    if (status === "pickUp" && this.state === "ringing") {
      this.state = "active";
      this.startedAt = Date.now();
      this.timer = setTimeout(() => this.end("cap_reached"), this.capMs);
      this.emit({ state: "active", reason: "answered" });
      return;
    }
    if (status === "hungUp") {
      this.end("hung_up");
      return;
    }
    if (status === "declined") {
      this.end("declined");
      return;
    }
  }

  private end(reason: CallSessionEvent["reason"]): void {
    if (this.state === "ended") return;
    if (this.timer) clearTimeout(this.timer);
    this.state = "ended";
    this.emit({ state: "ended", reason });
  }

  getElapsedMs(): number {
    if (!this.startedAt) return 0;
    return Date.now() - this.startedAt;
  }

  /** Explicit stop -- e.g. Dave decides to end the call itself before the cap. */
  hangUp(): void {
    this.end("hung_up");
  }
}
