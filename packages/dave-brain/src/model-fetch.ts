import { PROVIDER_CATALOG, resolveProviderAlias, type ProviderKeyConfig } from "./provider-catalog.js";
import { fetchWithTimeout, type ProviderName } from "./providers.js";
import { contextWindowFromModelListing } from "./context-windows.js";

export interface ModelListResult {
  provider: ProviderName;
  manualEntryRequired: boolean;
  models: string[];
  error?: string;
}

/**
 * Update 3: "auto-fetch models where supported using real confirmed
 * endpoints (don't re-guess); manual model entry specifically for
 * OpenRouter, OrcaRouter, HuggingFace." The catalog's `manualModelEntry`
 * flag is the single source of truth for that split, honored here even
 * where research found a real /models endpoint might technically exist
 * (OpenRouter/OrcaRouter) -- the instruction was explicit, not a
 * fallback for missing data.
 */
export async function fetchAvailableModels(name: ProviderName, config: ProviderKeyConfig, timeoutMs = 10000): Promise<ModelListResult> {
  const resolved = resolveProviderAlias(name);
  const entry = PROVIDER_CATALOG[resolved];

  if (entry.manualModelEntry || !entry.modelsPath) {
    return { provider: name, manualEntryRequired: true, models: [] };
  }

  const baseUrl = config.baseUrlOverride ?? (typeof entry.baseUrl === "function" ? entry.baseUrl(config) : entry.baseUrl);
  try {
    const res = await fetchWithTimeout(
      `${baseUrl}${entry.modelsPath}`,
      { headers: { authorization: `Bearer ${config.apiKey}` } },
      timeoutMs,
    );
    if (!res.ok) {
      return { provider: name, manualEntryRequired: false, models: [], error: `HTTP ${res.status}: ${await res.text()}` };
    }
    const json = (await res.json()) as { data?: { id: string }[] };
    const models = (json.data ?? []).map((m) => m.id);
    return { provider: name, manualEntryRequired: false, models };
  } catch (err) {
    return { provider: name, manualEntryRequired: false, models: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The context window the provider itself reports for `model`, read from its /models listing
 * (Baseten's documents context windows there). Undefined when the provider has no listing, the
 * call fails, or the entry carries no such field -- callers fall back to knownContextWindow().
 */
export async function fetchModelContextWindow(name: ProviderName, config: ProviderKeyConfig, model: string, timeoutMs = 10000): Promise<number | undefined> {
  const entry = PROVIDER_CATALOG[resolveProviderAlias(name)];
  if (!entry.modelsPath) return undefined;
  const baseUrl = config.baseUrlOverride ?? (typeof entry.baseUrl === "function" ? entry.baseUrl(config) : entry.baseUrl);
  try {
    const res = await fetchWithTimeout(`${baseUrl}${entry.modelsPath}`, { headers: { authorization: `Bearer ${config.apiKey}` } }, timeoutMs);
    if (!res.ok) return undefined;
    const json = (await res.json()) as { data?: { id: string }[] };
    const match = (json.data ?? []).find((m) => m.id?.toLowerCase() === model.toLowerCase());
    return contextWindowFromModelListing(match);
  } catch {
    return undefined;
  }
}
