import { InvalidDavemaKeyError, storeDavemaKey, getMaskedDavemaKey } from "./credentials.js";
import { extractDavemaKey } from "./endpoints.js";

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

  /**
   * Returns true if the message was consumed as a key submission. Looks
   * for a key ANYWHERE in the message, not just when the whole trimmed
   * message is exactly the key -- a real user is just as likely to paste
   * "here's my key: sk_live_..." as the bare key, and the original
   * strict-prefix check would have silently ignored that (routed to
   * normal chat handling with no key ever saved, no error shown either).
   */
  async handleMessage(userId: string, message: string): Promise<boolean> {
    if (!message.includes("sk_live_")) return false; // not a key attempt at all, let the caller route it elsewhere

    const extracted = extractDavemaKey(message);
    if (!extracted) {
      // Contains "sk_live_" but not in the right shape -- still an
      // attempted key, so give real feedback instead of silently
      // dropping it into normal chat handling.
      await this.transport.send(
        userId,
        'That doesn\'t look like a DAVEMA key -- expected "sk_live_" followed by 48 hex characters. Mind pasting it again?'
      );
      return true;
    }

    try {
      storeDavemaKey(userId, extracted);
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
