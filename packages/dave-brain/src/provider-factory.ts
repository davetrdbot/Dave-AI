import { BEDROCK_DEFAULT_REGION, PROVIDER_CATALOG, resolveProviderAlias, type ProviderKeyConfig } from "./provider-catalog.js";
import {
  BedrockProvider,
  ClaudeProvider,
  CohereProvider,
  DeepSeekProvider,
  OpenAICompatibleProvider,
  ReplicateProvider,
  type Provider,
  type ProviderName,
} from "./providers.js";

/**
 * Update 3: builds a real Provider instance for any catalog entry given
 * a stored key's config -- the single place that decides which of the
 * providers.ts classes a given provider name maps to.
 */
export function buildProvider(name: ProviderName, config: ProviderKeyConfig): Provider {
  const resolved = resolveProviderAlias(name);
  const entry = PROVIDER_CATALOG[resolved];

  switch (resolved) {
    case "deepseek":
      // Real bug fixed: DeepSeekProvider used to hardcode "deepseek-chat", silently ignoring
      // whatever model the user's stored key config actually specified.
      return new DeepSeekProvider(config.apiKey, config.baseUrlOverride ?? (entry.baseUrl as string), config.model ?? entry.defaultModel);
    case "claude":
      return new ClaudeProvider(config.apiKey, config.model ?? entry.defaultModel, config.baseUrlOverride ?? (entry.baseUrl as string));
    case "cohere":
      return new CohereProvider(config.apiKey, config.model ?? entry.defaultModel, config.baseUrlOverride ?? (entry.baseUrl as string));
    case "replicate":
      return new ReplicateProvider(config.apiKey, config.model ?? entry.defaultModel, config.baseUrlOverride ?? (entry.baseUrl as string));
    case "bedrock":
      // A Bedrock API key on its own (Bearer), or IAM access keys when a secret is stored (SigV4).
      return new BedrockProvider(config.apiKey, config.secretAccessKey || undefined, config.region || BEDROCK_DEFAULT_REGION, config.model ?? entry.defaultModel);
    case "azure": {
      // Real fix: Azure OpenAI genuinely needs a different auth mechanism (a real `api-key`
      // header, not Authorization: Bearer -- confirmed against Microsoft's own docs) and its
      // "model" is really a user-named deployment, not a catalog id -- both required explicitly
      // rather than silently defaulting to a placeholder that would 404 against the real API.
      if (!config.accountId) throw new Error("azure requires accountId (the Azure resource name) in the stored key's config");
      if (!config.model) throw new Error("azure requires model (the deployment name) in the stored key's config");
      const baseUrl = config.baseUrlOverride ?? (typeof entry.baseUrl === "function" ? entry.baseUrl(config) : entry.baseUrl);
      return new OpenAICompatibleProvider(name, baseUrl, config.apiKey, config.model, entry.chatPath, "api-key-header");
    }
    default: {
      const baseUrl = config.baseUrlOverride ?? (typeof entry.baseUrl === "function" ? entry.baseUrl(config) : entry.baseUrl);
      if (entry.requiresExtraConfig?.includes("accountId") && !config.accountId) {
        throw new Error(`${resolved} requires accountId in the stored key's config`);
      }
      return new OpenAICompatibleProvider(name, baseUrl, config.apiKey, config.model ?? entry.defaultModel, entry.chatPath, "bearer", entry.toolChoiceStyle);
    }
  }
}
