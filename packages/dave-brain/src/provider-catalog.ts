/**
 * Update 3 (post-Step-22): the full provider list, restored. Real,
 * research-confirmed values only (see the four research passes this was
 * built from -- OpenAI/Mistral/Together/Cerebras/Fireworks/Perplexity/
 * xAI; Nvidia NIM/Lepton/Hyperbolic/DeepInfra/SambaNova/Novita/AI21/
 * Qwen; Gemini/Cloudflare/Replicate/HuggingFace/Bedrock/OpenRouter/
 * Cohere; AI21 Jamba + OrcaRouter + OpenRouter/HuggingFace models-list
 * confirmation).
 *
 * "Lepton AI" is a real, deliberate alias -- Nvidia acquired Lepton AI
 * (~April 2025) and folded it into NVIDIA DGX Cloud Lepton, a GPU
 * marketplace layer, not a separate inference API anymore. Rather than
 * re-implement a dead API surface, Lepton resolves straight to the
 * Nvidia NIM entry (same base URL, same auth) -- confirmed via research,
 * not guessed.
 */
import type { ProviderName } from "./providers.js";

export type AuthStyle = "bearer" | "api-key-header" | "sigv4" | "alias";

export interface ProviderCatalogEntry {
  readonly id: ProviderName;
  readonly displayName: string;
  /** Real base URL. A function when the URL genuinely depends on per-user config (Cloudflare's account_id). */
  readonly baseUrl: string | ((config: ProviderKeyConfig) => string);
  readonly chatPath: string;
  readonly modelsPath: string | null;
  readonly authStyle: AuthStyle;
  /** Forced per the master plan's explicit instruction, independent of whether a real /models endpoint exists. */
  readonly manualModelEntry: boolean;
  readonly defaultModel: string;
  readonly openAICompatible: boolean;
  readonly requiresExtraConfig?: ("accountId" | "region" | "secretAccessKey")[];
  readonly aliasOf?: ProviderName;
  readonly notes: string;
}

export interface ProviderKeyConfig {
  apiKey: string;
  model?: string;
  accountId?: string; // Cloudflare
  region?: string; // Bedrock
  secretAccessKey?: string; // Bedrock (apiKey field carries the access key id)
  baseUrlOverride?: string; // custom providers (Update 4)
}

const OPENAI_COMPAT = (id: ProviderName, displayName: string, baseUrl: string, defaultModel: string, notes: string, modelsPath: string | null = "/models"): ProviderCatalogEntry => ({
  id,
  displayName,
  baseUrl,
  chatPath: "/chat/completions",
  modelsPath,
  authStyle: "bearer",
  manualModelEntry: false,
  defaultModel,
  openAICompatible: true,
  notes,
});

export const PROVIDER_CATALOG: Record<ProviderName, ProviderCatalogEntry> = {
  airllm: {
    id: "airllm",
    displayName: "AirLLM (self-hosted Qwen3-235B)",
    baseUrl: "http://127.0.0.1:8090",
    chatPath: "/generate",
    modelsPath: null,
    authStyle: "bearer",
    manualModelEntry: false,
    defaultModel: "qwen3-235b",
    openAICompatible: false,
    notes: "Step 5.1/5.5 -- existing custom implementation, self-hosted, not OpenAI-shaped.",
  },
  deepseek: OPENAI_COMPAT("deepseek", "DeepSeek AI", "https://api.deepseek.com", "deepseek-chat", "Step 5.2 -- existing custom implementation."),
  claude: {
    id: "claude",
    displayName: "Anthropic / Claude AI",
    baseUrl: "https://api.anthropic.com",
    chatPath: "/v1/messages",
    modelsPath: null,
    authStyle: "bearer",
    manualModelEntry: false,
    defaultModel: "claude-sonnet-5",
    openAICompatible: false,
    notes: "Step 5.2 -- existing custom implementation, native Anthropic Messages API shape.",
  },
  openai: OPENAI_COMPAT("openai", "OpenAI", "https://api.openai.com/v1", "gpt-5.6-sol", "Native OpenAI, the reference shape every generic entry copies."),
  groq: OPENAI_COMPAT("groq", "Groq", "https://api.groq.com/openai/v1", "llama-3.3-70b-versatile", "OpenAI-compatible, confirmed."),
  mistral: OPENAI_COMPAT("mistral", "Mistral AI", "https://api.mistral.ai/v1", "mistral-large-latest", "OpenAI-compatible, real GET /v1/models confirmed."),
  together: OPENAI_COMPAT("together", "Together AI", "https://api.together.ai/v1", "deepseek-ai/DeepSeek-V3.1", "Open marketplace, no fixed flagship -- model is configurable. (Updated to the .ai domain per current official docs -- the older .xyz domain also still resolves.)", null),
  cerebras: OPENAI_COMPAT("cerebras", "Cerebras", "https://api.cerebras.ai/v1", "llama-3.3-70b", "Open-weight catalog, confirmed real GET /v1/models."),
  "nvidia-nim": OPENAI_COMPAT("nvidia-nim", "Nvidia NIM", "https://integrate.api.nvidia.com/v1", "meta/llama-3.1-405b-instruct", "build.nvidia.com, real GET /v1/models confirmed."),
  lepton: {
    id: "lepton",
    displayName: "Lepton AI (alias of Nvidia NIM)",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    chatPath: "/chat/completions",
    modelsPath: "/models",
    authStyle: "alias",
    manualModelEntry: false,
    defaultModel: "meta/llama-3.1-405b-instruct",
    openAICompatible: true,
    aliasOf: "nvidia-nim",
    notes: "Real: Nvidia acquired Lepton AI and folded it into NVIDIA DGX Cloud Lepton -- not a separate API anymore.",
  },
  fireworks: OPENAI_COMPAT("fireworks", "Fireworks AI", "https://api.fireworks.ai/inference/v1", "accounts/fireworks/models/gpt-oss-120b", "Models-list lives on a DIFFERENT host path (/v1/accounts/{id}/models) than chat completions -- flagged, not unified here. Default model verified live (real 200 + real chat.completion) Sept 2026 -- the previous default (kimi-k2-instruct-0905) no longer resolves against the account's live model list.", null),
  hyperbolic: OPENAI_COMPAT("hyperbolic", "Hyperbolic", "https://api.hyperbolic.xyz/v1", "meta-llama/Llama-3.1-405B-Instruct", "OpenAI-compatible, real GET /v1/models confirmed."),
  deepinfra: OPENAI_COMPAT("deepinfra", "DeepInfra", "https://api.deepinfra.com/v1/openai", "meta-llama/Llama-3.3-70B-Instruct", "OpenAI-compatible under /v1/openai/*, real models list confirmed."),
  perplexity: OPENAI_COMPAT("perplexity", "Perplexity", "https://api.perplexity.ai", "sonar-pro", "No /models endpoint exists -- flagged. chat/completions has a stated sunset path toward an Agent API (checked Sept 2026: still live).", null),
  qwen: OPENAI_COMPAT("qwen", "Alibaba Qwen (DashScope)", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", "qwen-max", "International endpoint by default -- mainland China uses a different host, key is region-bound."),
  sambanova: OPENAI_COMPAT("sambanova", "SambaNova Cloud", "https://api.sambanova.ai/v1", "Meta-Llama-3.3-70B-Instruct", "OpenAI-compatible, models-list path not independently re-verified -- low confidence, flagged."),
  novita: OPENAI_COMPAT("novita", "Novita AI", "https://api.novita.ai/v3/openai", "deepseek-ai/DeepSeek-V3.1-Terminus", "Base path verified as /v3/openai; catalog rotates, no fixed flagship -- default updated off the stale V3 id, which the marketplace has moved past."),
  ai21: OPENAI_COMPAT("ai21", "AI21 Labs", "https://api.ai21.com/studio/v1", "jamba-large-1.7", "Confirmed: chat/completions uses an OpenAI-style message array but AI21 is NOT fully OpenAI-compatible beyond that -- flagged partial. Default updated to the real current versioned model id (bare \"jamba-large\" no longer resolves).", null),
  zai: {
    ...OPENAI_COMPAT(
      "zai",
      "Z.AI (GLM)",
      "https://api.z.ai/api/paas/v4",
      "glm-5.3",
      "Real, currently-operating hosted API for Zhipu AI's GLM models -- confirmed OpenAI-compatible chat/completions shape at /api/paas/v4 (an alternate /api/openai/v1 base also exists; this is the one Z.AI's own docs lead with). Bearer auth confirmed. No independently-confirmed live /v1/models list endpoint -- manual model entry, same posture as OpenRouter/OrcaRouter/HuggingFace rather than guessing one.",
      null
    ),
    manualModelEntry: true,
  },
  azure: {
    id: "azure",
    displayName: "Azure OpenAI",
    baseUrl: (config) => `https://${config.accountId ?? ""}.openai.azure.com/openai/deployments/${config.model ?? "deployment"}`,
    chatPath: "/chat/completions?api-version=2024-06-01",
    modelsPath: null,
    authStyle: "api-key-header",
    manualModelEntry: true,
    defaultModel: "",
    openAICompatible: true,
    requiresExtraConfig: ["accountId"],
    notes: "Confirmed real REST shape: https://{resource}.openai.azure.com/openai/deployments/{deployment}/chat/completions?api-version=2024-06-01, auth via a real `api-key` header (NOT Authorization: Bearer -- a genuinely different auth mechanism from every other OpenAI-compatible entry here). `accountId` carries the Azure resource name; `model` carries the deployment name (Azure deployment names are user-chosen and don't map 1:1 to a listable model catalog) -- manual entry, since a deployment name isn't something to guess or auto-fetch.",
  },
  cloudflare: {
    id: "cloudflare",
    displayName: "Cloudflare Workers AI",
    baseUrl: (config) => `https://api.cloudflare.com/client/v4/accounts/${config.accountId ?? ""}/ai/v1`,
    chatPath: "/chat/completions",
    modelsPath: null,
    authStyle: "bearer",
    manualModelEntry: false,
    defaultModel: "@cf/meta/llama-3.1-8b-instruct",
    openAICompatible: true,
    requiresExtraConfig: ["accountId"],
    notes: "Real OpenAI-compat shim at /ai/v1/chat/completions confirmed (raw /ai/run/{model} is the native, non-OpenAI shape). Requires the account's accountId.",
  },
  replicate: {
    id: "replicate",
    displayName: "Replicate",
    baseUrl: "https://api.replicate.com/v1",
    chatPath: "/predictions",
    modelsPath: null,
    authStyle: "bearer",
    manualModelEntry: false,
    defaultModel: "meta/meta-llama-3.1-405b-instruct",
    openAICompatible: false,
    notes: "Genuinely async: POST /predictions returns immediately, must poll GET /predictions/{id} until succeeded/failed. Confirmed real, not a simplification to skip.",
  },
  xai: OPENAI_COMPAT("xai", "xAI (Grok)", "https://api.x.ai/v1", "grok-4.6", "OpenAI-compatible, real GET /v1/models confirmed."),
  openrouter: { ...OPENAI_COMPAT("openrouter", "OpenRouter", "https://openrouter.ai/api/v1", "openrouter/auto", "Real GET /api/v1/models exists, but manual entry is FORCED per explicit instruction, not a technical limitation."), manualModelEntry: true },
  huggingface: { ...OPENAI_COMPAT("huggingface", "HuggingFace", "https://router.huggingface.co/v1", "meta-llama/Llama-3.3-70B-Instruct", "Router-based OpenAI-compat endpoint (api-inference.huggingface.co is legacy). No clean runnable-models list -- manual entry required both by instruction and by lack of a real endpoint.", null), manualModelEntry: true },
  orcarouter: { ...OPENAI_COMPAT("orcarouter", "OrcaRouter", "https://api.orcarouter.ai/v1", "orcarouter/auto", "Real, currently-operating (launched May 2026). A models list appears to exist per third-party docs, but manual entry is FORCED per explicit instruction."), manualModelEntry: true },
  bedrock: {
    id: "bedrock",
    displayName: "AWS Bedrock",
    baseUrl: (config) => `https://bedrock-runtime.${config.region ?? "us-east-1"}.amazonaws.com`,
    chatPath: "/converse",
    modelsPath: null,
    authStyle: "sigv4",
    manualModelEntry: false,
    defaultModel: "anthropic.claude-sonnet-5",
    openAICompatible: false,
    requiresExtraConfig: ["region", "secretAccessKey"],
    notes: "Confirmed: SigV4 signing is mandatory, no Bearer/API-key path exists for the native Converse API. apiKey field carries the AWS access key id.",
  },
  gemini: OPENAI_COMPAT("gemini", "Google Gemini", "https://generativelanguage.googleapis.com/v1beta/openai", "gemini-3.1-pro", "Real OpenAI-compatible endpoint confirmed (still beta per Google); native generateContent API also exists but this is simpler and uses the same generic class."),
  custom: {
    id: "custom",
    displayName: "Custom provider",
    baseUrl: "",
    chatPath: "/chat/completions",
    modelsPath: null,
    authStyle: "bearer",
    manualModelEntry: true,
    defaultModel: "",
    openAICompatible: true,
    notes: "Update 4 -- a user-defined provider (see custom-providers.ts), not a static catalog entry with a fixed base URL.",
  },
  cohere: {
    id: "cohere",
    displayName: "Cohere",
    baseUrl: "https://api.cohere.com/v2",
    chatPath: "/chat",
    modelsPath: null,
    authStyle: "bearer",
    manualModelEntry: false,
    defaultModel: "command-a",
    openAICompatible: false,
    notes: "Confirmed NOT OpenAI-shaped -- v2 has its own request/response shape (response.message.content[0].text).",
  },
};

export function resolveProviderAlias(name: ProviderName): ProviderName {
  const entry = PROVIDER_CATALOG[name];
  return entry.aliasOf ?? name;
}

export function listProviderCatalog(): ProviderCatalogEntry[] {
  return Object.values(PROVIDER_CATALOG);
}
