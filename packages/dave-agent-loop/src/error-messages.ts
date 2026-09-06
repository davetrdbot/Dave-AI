/**
 * Item 3 real bug fixed: raw internal error text (e.g. `no stored keys for provider "claude"`,
 * or a raw AllProviderKeysFailedError/ProviderError message) was reaching the user verbatim in
 * more than one place -- both the main agent-turn catch-all AND dispatchCallback's catch-all
 * shared this same class of bug. Shared here so both use the exact same real, honest mapping
 * instead of two copies drifting apart. Recognized errors get a clean, actionable message;
 * anything unrecognized gets a generic message instead of its raw internals -- the real error
 * still goes to the server log (console.error), just never straight to the user's chat.
 */
export function friendlyErrorMessage(err: unknown): string {
  const name = err instanceof Error ? err.name : undefined;
  const message = err instanceof Error ? err.message : String(err);

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
