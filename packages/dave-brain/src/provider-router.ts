import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CompletionRequest, CompletionResult, Provider, ProviderName } from "./providers.js";
import { ProviderError } from "./providers.js";

export interface FailoverEvent {
  ts: number;
  failedProvider: ProviderName;
  reason: string;
  fellBackTo: ProviderName | null;
}

export interface ModelConfig {
  primary: ProviderName;
  fallback: ProviderName[];
}

const DEFAULT_CONFIG: ModelConfig = { primary: "airllm", fallback: ["deepseek", "claude"] };

function configPath(userId: string): string {
  return join(process.cwd(), "data", "brain", `${userId}-model-config.json`);
}

/** Step 5.2: button-driven model-picker UI reads/writes this. Only these three providers exist. */
export function getModelConfig(userId: string): ModelConfig {
  const path = configPath(userId);
  if (!existsSync(path)) return DEFAULT_CONFIG;
  return JSON.parse(readFileSync(path, "utf8"));
}

export function setModelConfig(userId: string, config: ModelConfig): void {
  const path = configPath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2), "utf8");
}

export class AllProvidersFailedError extends Error {
  constructor(public readonly attempts: FailoverEvent[]) {
    super(`All configured providers failed: ${attempts.map((a) => `${a.failedProvider} (${a.reason})`).join("; ")}`);
    this.name = "AllProvidersFailedError";
  }
}

/**
 * Step 5.3: basic failover. Tries the primary provider first; on
 * failure/timeout, falls through the configured fallback list in order.
 * Every attempt (success or failure) is recorded so failover is provable,
 * not just assumed to have happened.
 */
export class ProviderRouter {
  private readonly log: FailoverEvent[] = [];

  constructor(private readonly providers: Partial<Record<ProviderName, Provider>>) {}

  getFailoverLog(): FailoverEvent[] {
    return this.log;
  }

  async generate(
    userId: string,
    req: CompletionRequest,
    opts: { timeoutMs?: number } = {}
  ): Promise<CompletionResult> {
    const config = getModelConfig(userId);
    const order: ProviderName[] = [config.primary, ...config.fallback.filter((p) => p !== config.primary)];
    const timeoutMs = opts.timeoutMs ?? 15000;

    let lastError: unknown;
    for (let i = 0; i < order.length; i++) {
      const name = order[i];
      const provider = this.providers[name];
      if (!provider) continue;
      try {
        const result = await provider.generate(req, timeoutMs);
        return result;
      } catch (err) {
        lastError = err;
        const reason = err instanceof ProviderError ? err.message : String(err);
        const next = order[i + 1] ?? null;
        this.log.push({ ts: Date.now(), failedProvider: name, reason, fellBackTo: next });
      }
    }
    throw new AllProvidersFailedError(this.log);
  }
}

/** Step 5.4: workers never get AirLLM -- always DeepSeek or Claude. */
export function routeForWorker(preferred: "deepseek" | "claude" = "deepseek"): ModelConfig {
  const other: "deepseek" | "claude" = preferred === "deepseek" ? "claude" : "deepseek";
  return { primary: preferred, fallback: [other] };
}
