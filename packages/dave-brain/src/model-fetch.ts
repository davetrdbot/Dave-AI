import { PROVIDER_CATALOG, resolveProviderAlias, type ProviderKeyConfig } from "./provider-catalog.js";
import type { ProviderName } from "./providers.js";

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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}${entry.modelsPath}`, {
      headers: { authorization: `Bearer ${config.apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      return { provider: name, manualEntryRequired: false, models: [], error: `HTTP ${res.status}: ${await res.text()}` };
    }
    const json = (await res.json()) as { data?: { id: string }[] };
    const models = (json.data ?? []).map((m) => m.id);
    return { provider: name, manualEntryRequired: false, models };
  } catch (err) {
    return { provider: name, manualEntryRequired: false, models: [], error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
