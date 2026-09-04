import { PROVIDER_CATALOG, resolveProviderAlias, type ProviderKeyConfig } from "./provider-catalog.js";
import {
  AirLLMProvider,
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
    case "airllm":
      return new AirLLMProvider(config.baseUrlOverride ?? entry.baseUrl.toString());
    case "deepseek":
      return new DeepSeekProvider(config.apiKey, config.baseUrlOverride ?? (entry.baseUrl as string));
    case "claude":
      return new ClaudeProvider(config.apiKey, config.model ?? entry.defaultModel, config.baseUrlOverride ?? (entry.baseUrl as string));
    case "cohere":
      return new CohereProvider(config.apiKey, config.model ?? entry.defaultModel, config.baseUrlOverride ?? (entry.baseUrl as string));
    case "replicate":
      return new ReplicateProvider(config.apiKey, config.model ?? entry.defaultModel, config.baseUrlOverride ?? (entry.baseUrl as string));
    case "bedrock":
      if (!config.secretAccessKey || !config.region) {
        throw new Error("bedrock requires both region and secretAccessKey in the stored key's config");
      }
      return new BedrockProvider(config.apiKey, config.secretAccessKey, config.region, config.model ?? entry.defaultModel);
    default: {
      const baseUrl = config.baseUrlOverride ?? (typeof entry.baseUrl === "function" ? entry.baseUrl(config) : entry.baseUrl);
      if (entry.requiresExtraConfig?.includes("accountId") && !config.accountId) {
        throw new Error(`${resolved} requires accountId in the stored key's config`);
      }
      return new OpenAICompatibleProvider(name, baseUrl, config.apiKey, config.model ?? entry.defaultModel, entry.chatPath);
    }
  }
}
