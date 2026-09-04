import { InvalidDavemaKeyError, storeDavemaKey, getMaskedDavemaKey } from "./credentials.js";

/**
 * The "telegram UI to ask for the DAVEMA api key, only that" flow
 * requested alongside Step 7. Transport-agnostic, same pattern as
 * BootstrapFlow (Step 3) -- takes a real Telegram transport once Step 8
 * wires one, tested here against an in-memory transport.
 */

export interface Transport {
  send(userId: string, text: string): void | Promise<void>;
}

const ASK_MESSAGE =
  "One thing I need before I can pull real market data: your DAVEMA API key.\n\n" +
  "It looks like sk_live_ followed by a long hex string -- grab it from your DAVEMA dashboard's Keys tab and paste it here. " +
  "I'll store it securely and never show it back to you in full.";

export class DavemaApiKeyFlow {
  constructor(private readonly transport: Transport) {}

  async ask(userId: string): Promise<void> {
    await this.transport.send(userId, ASK_MESSAGE);
  }

  /** Returns true if the message was consumed as a key submission. */
  async handleMessage(userId: string, message: string): Promise<boolean> {
    const candidate = message.trim();
    if (!candidate.startsWith("sk_live_")) return false; // not a key attempt, let the caller route it elsewhere

    try {
      storeDavemaKey(userId, candidate);
      const masked = getMaskedDavemaKey(userId);
      await this.transport.send(userId, `Got it -- key saved (${masked}). I can pull live market data now.`);
      return true;
    } catch (err) {
      if (err instanceof InvalidDavemaKeyError) {
        await this.transport.send(userId, `${err.message} Mind pasting it again?`);
        return true;
      }
      throw err;
    }
  }
}
