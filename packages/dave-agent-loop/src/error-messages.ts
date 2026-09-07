/**
 * Item 3 real bug fixed: raw internal error text (e.g. `no stored keys for provider "claude"`,
 * or a raw AllProviderKeysFailedError/ProviderError message) was reaching the user verbatim in
 * more than one place -- both the main agent-turn catch-all AND dispatchCallback's catch-all
 * shared this same class of bug. Shared here so both use the exact same real, honest mapping
 * instead of two copies drifting apart. Recognized errors get a clean, actionable message;
 * anything unrecognized gets a generic message instead of its raw internals -- the real error
 * still goes to the server log (console.error), just never straight to the user's chat.
 */
/**
 * Real gap fixed: the previous failover behavior threw only the LAST provider's error (e.g. "no
 * stored keys for provider claude"), which read like Claude was the one actively in use and
 * failing -- confusing when it was really just the last, unconfigured entry at the end of a
 * fallback list, arriving as a second, seemingly disconnected message after an earlier
 * quota-exhaustion notice for a completely different provider. This carries every provider that
 * was actually tried, in order, with each one's own REAL reason (the actual endpoint error, not
 * a paraphrase -- user: "should show the errors from the endpoint so I will confirm it, not you
 * saying it"), so the final message tells the whole story in one place.
 */
export class AllConfiguredProvidersFailedError extends Error {
  constructor(public readonly attempts: { provider: string; reason: string }[]) {
    super(
      attempts.length === 0
        ? "No provider is configured at all."
        : `All configured providers failed:\n${attempts.map((a) => `${a.provider}: ${a.reason}`).join("\n")}`
    );
    this.name = "AllConfiguredProvidersFailedError";
  }
}

/**
 * Real gap fixed AGAIN (user, explicitly, in all caps, repeatedly: "I want to see the raw json
 * error from the provider... don't add anything to that... just only the json error"): every
 * previous version still wrapped the real error in Dave's own text -- a "[provider] HTTP xxx:"
 * prefix (from ProviderError's own message format), a "⚠️ ... failed" sentence, a "None of your
 * configured providers worked" header, a "Fix a key..." footer. None of that is the real endpoint
 * error; per this explicit, repeated instruction, this returns ONLY the raw JSON body a provider
 * actually sent back -- nothing else, no matter how many providers were tried. Falls back to the
 * reason verbatim (still nothing added) when there's genuinely no JSON in it (e.g. a raw fetch/
 * network error with no HTTP response body at all).
 */
export function extractRawProviderError(reason: string): string {
  const firstBrace = reason.indexOf("{");
  return firstBrace === -1 ? reason : reason.slice(firstBrace);
}

export function friendlyErrorMessage(err: unknown): string {
  const name = err instanceof Error ? err.name : undefined;
  const message = err instanceof Error ? err.message : String(err);

  if (err instanceof AllConfiguredProvidersFailedError) {
    if (err.attempts.length === 0) return "No provider is configured at all.";
    // Real distinction kept: "no stored keys" is Dave's own internal state (there's no real
    // endpoint JSON to show for a provider that was never given a key), so it still honestly
    // names the provider so the user knows what to fix -- a REAL endpoint error (an actual raw
    // JSON body a provider sent back) gets shown as ONLY that JSON, nothing else, per the user's
    // explicit, repeated, all-caps instruction.
    return err.attempts
      .map((a) => {
        const noStoredKeys = /no stored keys for provider "([^"]+)"/.exec(a.reason);
        return noStoredKeys ? `${a.provider} has no working keys` : extractRawProviderError(a.reason);
      })
      .join("\n");
  }

  const noStoredKeys = /no stored keys for provider "([^"]+)"/.exec(message);
  if (noStoredKeys) return `⚠️ ${noStoredKeys[1]} has no working keys — add one via /providers or switch providers.`;

  if (name === "AllProviderKeysFailedError") {
    const provider = (err as { provider?: string }).provider ?? "This provider";
    return `⚠️ ${provider} has no working keys left — add more via /providers or switch providers.`;
  }
  if (name === "AllProvidersFailedError") {
    return `⚠️ None of your configured providers have a working key right now — add one via /providers.`;
  }
  if (name === "ProviderError") {
    const provider = (err as { provider?: string }).provider ?? "The AI provider";
    return `⚠️ ${provider} couldn't complete that request right now — try again in a moment, or switch providers via /providers.`;
  }

  console.error("[dave-agent-loop] unhandled error surfaced to user:", err);
  return "⚠️ Something went wrong on my end handling that. Try again in a moment.";
}
