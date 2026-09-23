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
 * Real bug fixed (user, with real pasted proof: raw JSON error blobs sent directly as bot
 * messages, sometimes duplicated). An earlier fix (per an explicit, since-superseded user
 * instruction) made every provider-failure notice ONLY the raw JSON body, no provider name, no
 * classification -- which (a) made a genuinely-Mistral-labeled bug report actually be a
 * misattributed NVIDIA error (nothing named which provider a raw blob came from) and (b) still
 * let the SAME failure be reported twice: once live via onProviderExhausted's notify(), and again
 * via this module's own AllConfiguredProvidersFailedError message when the whole chain finally
 * gave up. Per the user's current, explicit instruction, this returns to naming the real
 * provider -- but as ONE short, clean, human-readable line, never the raw JSON, and provider-
 * selection.ts (the live notifier) now only fires a live notice when there's actually a NEXT
 * provider to switch to, so the final summary here is the only place the LAST failure is ever
 * reported -- never both.
 */
export function classifyProviderError(reason: string): string {
  if (/maximum number of items is 128|too many tools|tools.{0,20}(maximum|limit)/i.test(reason)) return "too many tools in request";
  if (/insufficient_quota|quota exceeded|exceeded your current quota|out of credit|billing|payment required|\b402\b/i.test(reason)) return "out of credit/quota";
  if (/\b429\b|rate.?limit(ed)?\b|too many requests/i.test(reason)) return "rate limited";
  if (/\b401\b|invalid.{0,20}api.?key|unauthorized|incorrect api key/i.test(reason)) return "invalid API key";
  if (/\b403\b|forbidden/i.test(reason)) return "forbidden (check key permissions)";
  if (/\b404\b|model.{0,20}not found|function.{0,20}not found/i.test(reason)) return "model/endpoint not found";
  // Real gap fixed (the trader, live, real pasted proof: "upstage (request failed)" -- a real
  // HTTP 400/422 fell all the way through every classified case above into the generic fallback,
  // which told the trader nothing they could act on). A 400/422 almost always means the request
  // itself was malformed for that provider (wrong model id, an unsupported field/parameter) --
  // worth its own real label rather than looking identical to an unclassifiable network blip.
  if (/\b400\b|\b422\b|bad request|invalid.{0,20}request|unprocessable/i.test(reason)) return "bad request -- check the configured model id/parameters";
  if (/timed out|timeout|ETIMEDOUT|abort/i.test(reason)) return "timed out";
  if (/ECONNRESET|ECONNREFUSED|fetch failed|network|ENOTFOUND/i.test(reason)) return "connection issue";
  if (/\b5\d\d\b|internal server error|service unavailable|bad gateway/i.test(reason)) return "server error";
  return "request failed";
}

/** Shared by every place that reports a provider failure to the user (this module's own
 *  AllConfiguredProvidersFailedError rendering below, and provider-selection.ts's live
 *  onKeySwitch/onProviderExhausted notices): a recognized classification stays a clean short
 *  label, but the unclassified "request failed" fallback -- which told the trader nothing
 *  actionable in the real "upstage (request failed)" report -- is replaced with a genuine
 *  (truncated) snippet of the actual endpoint reason instead. */
export function describeProviderFailure(reason: string): string {
  const classification = classifyProviderError(reason);
  if (classification !== "request failed") return classification;
  return reason.replace(/^\[[^\]]+\]\s*/, "").slice(0, 140);
}
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

export function friendlyErrorMessage(err: unknown): string {
  const name = err instanceof Error ? err.name : undefined;
  const message = err instanceof Error ? err.message : String(err);

  if (err instanceof AllConfiguredProvidersFailedError) {
    if (err.attempts.length === 0) return "⚠️ No provider is configured at all — add one via /providers.";
    // Real bug fixed (user, with real pasted proof of raw/duplicated JSON error blobs): ONE
    // clean, human-readable line naming every provider actually tried and a short classification
    // of what went wrong with each -- never the raw JSON body, and never a repeat of what a live
    // key-switch/provider-switch notice (provider-selection.ts) already told the user moments ago.
    // A fresh install has no keys at all -- that is setup, not a failure, and "All configured
    // providers failed: openai (no working keys)" told a new user nothing about what to do.
    if (err.attempts.every((a) => /no stored keys for provider/.test(a.reason))) {
      const names = [...new Set(err.attempts.map((a) => a.provider))].join(" or ");
      return `⚠️ I don't have a key for ${names} yet, so I can't think or answer. Add one in the web panel's AI providers card, or in the Dave app under Settings → AI providers -- then message me again.`;
    }
    const parts = err.attempts.map((a) => {
      const noStoredKeys = /no stored keys for provider "([^"]+)"/.exec(a.reason);
      return `${a.provider} (${noStoredKeys ? "no working keys" : describeProviderFailure(a.reason)})`;
    });
    return `⚠️ All configured providers failed: ${parts.join(", ")}. Check /providers.`;
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
