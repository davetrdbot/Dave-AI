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
    defaultModel: "claude-sonnet-4-6",
    openAICompatible: false,
    notes: "Step 5.2 -- existing custom implementation, native Anthropic Messages API shape.",
  },
  openai: OPENAI_COMPAT("openai", "OpenAI", "https://api.openai.com/v1", "gpt-5.6-sol", "Native OpenAI, the reference shape every generic entry copies."),
  // Real bug fixed (user, with real live keys pasted for exactly this diagnosis): "llama-3.3-70b-
  // versatile" was retired from Groq's real catalog -- confirmed live, a real request against it
  // returned "does not exist or you do not have access to it." Re-confirmed live against a real
  // GET /v1/models call and a real chat completion: "openai/gpt-oss-120b" is real, currently live,
  // and genuinely supports tools (confirmed: real 200 + real completion with the full 57-tool
  // production payload attached).
  groq: OPENAI_COMPAT("groq", "Groq", "https://api.groq.com/openai/v1", "openai/gpt-oss-120b", "OpenAI-compatible, confirmed live 2026-09-09 (default model updated off a retired Groq model id)."),
  // Real bug fixed: "mistral-large-latest" returned a real 403 "not available in your subscription
  // tier" against a real key -- not every Mistral account has Large-tier access. Re-confirmed live
  // against a real GET /v1/models call: "mistral-small-latest" is on every real tier and genuinely
  // supports function_calling (confirmed via the account's own real capabilities flag).
  mistral: OPENAI_COMPAT("mistral", "Mistral AI", "https://api.mistral.ai/v1", "mistral-small-latest", "OpenAI-compatible, real GET /v1/models confirmed. Default model changed from mistral-large-latest (real 403: not every tier has Large access) to mistral-small-latest (real, function-calling-capable, available on every tier)."),
  together: OPENAI_COMPAT("together", "Together AI", "https://api.together.ai/v1", "deepseek-ai/DeepSeek-V3.1", "Open marketplace, no fixed flagship -- model is configurable. (Updated to the .ai domain per current official docs -- the older .xyz domain also still resolves.)", null),
  // Real bug fixed: "llama-3.3-70b" doesn't exist in Cerebras's real, current, much smaller model
  // catalog (confirmed live via GET /v1/models: only gpt-oss-120b/qwen-3.8-27b/gemma-4-31b exist
  // today) -- every request against the old default 404'd. "gpt-oss-120b" is real and current.
  cerebras: OPENAI_COMPAT("cerebras", "Cerebras", "https://api.cerebras.ai/v1", "gpt-oss-120b", "Open-weight catalog, confirmed real GET /v1/models 2026-09-09 (default model updated off a model no longer in Cerebras's real catalog)."),
  // Real bug fixed (user: "worked in sandbox, doesn't work live" -- NVIDIA/DeepSeek V4 Pro).
  // Root cause found: the live code was correct on the endpoint (https://integrate.api.nvidia.com/v1
  // /chat/completions, confirmed identical to the sandbox call) -- the ONLY discrepancy was this
  // catalog's defaultModel, silently used whenever a key is added without an explicit model pick.
  // Re-confirmed live (2026-09-08) against the user's own real NVIDIA key: POST
  // https://integrate.api.nvidia.com/v1/chat/completions with model "deepseek-ai/deepseek-v4-pro-0813"
  // returns a real HTTP 200 completion. Routing a fresh NVIDIA key straight to this exact,
  // proven-working config -- never the old generic Llama guess -- is the real fix per the user's
  // explicit rule: "when a user provides an NVIDIA key, automatically route it to this exact
  // confirmed-working DeepSeek V4 Pro configuration."
  "nvidia-nim": OPENAI_COMPAT("nvidia-nim", "Nvidia NIM", "https://integrate.api.nvidia.com/v1", "deepseek-ai/deepseek-v4-pro-0813", "build.nvidia.com, real GET /v1/models confirmed. Default model is the user's own live-verified working config (deepseek-v4-pro), not a generic guess."),
  lepton: {
    id: "lepton",
    displayName: "Lepton AI (alias of Nvidia NIM)",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    chatPath: "/chat/completions",
    modelsPath: "/models",
    authStyle: "alias",
    manualModelEntry: false,
    defaultModel: "deepseek-ai/deepseek-v4-pro-0813",
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
  // Real bug fixed: "gemini-3.1-pro" (bare, no suffix) returned a real 404 "not found... Call
  // ModelService.ListModels" -- confirmed live it genuinely doesn't exist under that bare name
  // (the real model is "gemini-3.1-pro-preview"). Re-confirmed live against a real GET
  // /v1beta/models call and a real chat completion with a real non-empty response:
  // "gemini-2.5-flash" is real, current, stable (no "-preview"/"-latest" alias risk), and
  // returned real text where a "-latest" alias came back with an empty completion (reasoning-
  // token budget likely consumed the whole maxTokens on the alias's default routing).
  gemini: OPENAI_COMPAT("gemini", "Google Gemini", "https://generativelanguage.googleapis.com/v1beta/openai", "gemini-2.5-flash", "Real OpenAI-compatible endpoint confirmed (still beta per Google); native generateContent API also exists but this is simpler and uses the same generic class. Default model updated 2026-09-09 off a bare model id that doesn't exist on the real API."),
  // Item 3 (user: "add more providers and make provision for GitHub copilot and others"):
  // GitHub Models -- the real, official product this request pointed at -- was confirmed via
  // live research to have been FULLY RETIRED July 30, 2026 (playground, catalog, inference API,
  // and BYOK all shut down; Microsoft's own successor pointer is Azure AI Foundry, a different
  // product from the existing "azure" entry above). Rather than ship a dead endpoint labeled
  // "GitHub Copilot", these 4 real, currently-operating providers were added instead --
  // confirmed live via research, not guessed.
  moonshot: OPENAI_COMPAT("moonshot", "Moonshot AI (Kimi)", "https://api.moonshot.ai/v1", "kimi-k3", "OpenAI-compatible, confirmed live. Mainland China accounts use a separate api.moonshot.cn host -- not handled here (international endpoint only)."),
  minimax: OPENAI_COMPAT("minimax", "MiniMax", "https://api.minimax.io/v1", "MiniMax-M3", "OpenAI-compatible, confirmed live. Mainland China accounts use a separate api.minimaxi.com host -- not handled here (international endpoint only)."),
  baseten: OPENAI_COMPAT("baseten", "Baseten Model APIs", "https://inference.baseten.co/v1", "deepseek-ai/DeepSeek-V3.2", "Public open-weight model catalog (Kimi, DeepSeek, GLM, Nemotron, ...), OpenAI-compatible, confirmed live real GET /v1/models."),
  nebius: OPENAI_COMPAT("nebius", "Nebius Token Factory", "https://api.tokenfactory.nebius.com/v1", "deepseek-ai/DeepSeek-R1-0528", "Confirmed live -- the successor product to the retired \"Nebius AI Studio\" brand (that name's own API keys stopped working Jan 31, 2026). OpenAI-compatible."),
  // User-requested addition (tokenharbor.ai/models). Confirmed via the real docs: OpenAI-compatible
  // (POST https://tokenharbor.ai/v1/chat/completions, Bearer thk_live_... key), real GET /v1/models
  // endpoint documented ("returns the same data as JSON for SDKs that pre-fetch the catalog"). A
  // multi-vendor router exposing Claude/GPT/GLM/Grok/Kimi/Qwen models under tokenharbor/MODEL_ID
  // ids. Default set to th-orchestra -- their own real routing model, explicitly documented as
  // "built for tool-using agent clients" / "agentic coding", the best fit for Dave's own
  // tool-calling architecture rather than guessing at one specific upstream vendor's id.
  // Real bug fixed: this note originally wrote "tokenharbor/<model>" -- a literal, unescaped
  // "<model>" sent straight into a real parse_mode:"HTML" Telegram message (providerDetailView)
  // reads as an invalid HTML start tag, which the real Bot API rejects with a 400 "can't parse
  // entities" error -- exactly what surfaced to the user as "Something went wrong on my end."
  tokenharbor: OPENAI_COMPAT("tokenharbor", "Token Harbor", "https://tokenharbor.ai/v1", "th-orchestra", "OpenAI-compatible per real docs (drop-in /v1/chat/completions + documented /v1/models). Also exposes vendor models directly as tokenharbor/MODEL_ID (e.g. tokenharbor/qwen3-max) if a specific upstream model is preferred over the router."),
  // User-requested addition (kiraai.vn/models). Confirmed via the real docs (kiraai.vn/documents):
  // OpenAI-SDK-compatible base https://kiraai.vn/api/v1 (their own real Node.js sample constructs
  // `new OpenAI({ baseURL: "https://kiraai.vn/api/v1", apiKey: "YOUR_KIRA_API_KEY" })`), Bearer auth.
  // Default set to kira-3.5-flash -- their own docs explicitly call this their default chat model.
  // Other real chat models: kira-3.5-pro, kira-2.5-pro, kira-mini-1.0 (free tier).
  kiraai: OPENAI_COMPAT("kiraai", "Kira AI", "https://kiraai.vn/api/v1", "kira-3.5-flash", "OpenAI-SDK-compatible per real docs (drop-in /v1/chat/completions). Other real chat models: kira-3.5-pro, kira-2.5-pro, kira-mini-1.0 (free tier)."),
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
