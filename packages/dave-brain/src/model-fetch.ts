import { BEDROCK_DEFAULT_REGION, PROVIDER_CATALOG, resolveProviderAlias, type ProviderKeyConfig } from "./provider-catalog.js";
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

  if (resolved === "bedrock") return fetchBedrockModels(name, config, timeoutMs);
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

/**
 * Bedrock's models, from its control plane with the same Bedrock API key: the text models that can
 * be called on demand (ListFoundationModels), plus the system inference profiles
 * (ListInferenceProfiles) -- in eu-north-1 many models (Claude among them) are only callable
 * through their cross-region "eu." profile, so those come first. Only for API-key logins; IAM
 * access keys would need SigV4 on these calls too, so they type the model id instead.
 */
export async function fetchBedrockModels(name: ProviderName, config: ProviderKeyConfig, timeoutMs = 10000): Promise<ModelListResult> {
  if (config.secretAccessKey) return { provider: name, manualEntryRequired: true, models: [] };
  const region = config.region || BEDROCK_DEFAULT_REGION;
  const base = `https://bedrock.${region}.amazonaws.com`;
  const headers = { authorization: `Bearer ${config.apiKey}`, accept: "application/json" };
  try {
    const [fm, ip] = await Promise.all([
      fetchWithTimeout(`${base}/foundation-models?byOutputModality=TEXT`, { headers }, timeoutMs),
      fetchWithTimeout(`${base}/inference-profiles?typeEquals=SYSTEM_DEFINED&maxResults=1000`, { headers }, timeoutMs),
    ]);
    if (!fm.ok && !ip.ok) return { provider: name, manualEntryRequired: false, models: [], error: `HTTP ${fm.status}: ${(await fm.text()).slice(0, 300)}` };
    const fmJson = fm.ok ? ((await fm.json()) as { modelSummaries?: { modelId: string; inferenceTypesSupported?: string[]; outputModalities?: string[]; modelLifecycle?: { status?: string } }[] }) : {};
    const ipJson = ip.ok ? ((await ip.json()) as { inferenceProfileSummaries?: { inferenceProfileId: string; status?: string }[] }) : {};
    const profiles = (ipJson.inferenceProfileSummaries ?? []).filter((p) => !p.status || p.status === "ACTIVE").map((p) => p.inferenceProfileId);
    const onDemand = (fmJson.modelSummaries ?? [])
      .filter((m) => (m.inferenceTypesSupported ?? []).includes("ON_DEMAND") && (m.outputModalities ?? ["TEXT"]).includes("TEXT") && m.modelLifecycle?.status !== "LEGACY")
      .map((m) => m.modelId);
    return { provider: name, manualEntryRequired: false, models: [...new Set([...profiles, ...onDemand])] };
  } catch (err) {
    return { provider: name, manualEntryRequired: false, models: [], error: err instanceof Error ? err.message : String(err) };
  }
}
