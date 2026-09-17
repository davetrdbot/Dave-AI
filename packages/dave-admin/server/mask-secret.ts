/**
 * Real bug fixed (bug-hunting pass): provider-keys, e2b-keys and
 * firecrawl-keys admin API routes were returning the FULL, real, stored
 * API key (and secretAccessKey for Bedrock) in plaintext in every GET/POST
 * response body -- visible to anyone with devtools/network access to the
 * admin panel, logged by any HTTP logging proxy, cached by intermediaries.
 * Every other secret in this codebase is masked before it ever leaves the
 * server (see dave-davema/src/endpoints.ts's maskDavemaKey, dave-trading's
 * "masked login/server, never the real password" for MT5 credentials,
 * this package's own lovable-mcp-settings route which sends only
 * `tokenSet: boolean`). These three routes were the one place that didn't
 * follow that pattern. The UI never even reads the raw value back (see
 * app/page.tsx's ProviderKeysCard/SimpleKeysCard, which only render
 * label/provider/health), so nothing observable changes except that the
 * real secret stops being sent to the browser.
 */
export function maskSecret(value: string | undefined | null): string | undefined {
  if (!value) return value ?? undefined;
  if (value.length <= 8) return "*".repeat(value.length);
  return `${value.slice(0, 4)}${"*".repeat(Math.max(0, value.length - 8))}${value.slice(-4)}`;
}
