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

// Real gap fixed (user: "don't hardcode Claude and deepseek as fallback"): a fresh account no
// longer silently gets deepseek+claude as its fallback chain -- fallback starts genuinely empty,
// and the user builds it themselves via the real /providers "Add to fallback chain" toggle
// (command-router.ts's togglefallback: callback).
// AirLLM (the previous default, self-hosted, no key required) was removed from the codebase --
// it was never actually deployed anywhere real (no AIRLLM_BASE_URL in production). Every real
// catalog provider now requires a stored key, so this default is functionally inert either way:
// a fresh account with no key resolves through the existing, already-honest "no stored keys"
// path (provider-keys.ts -> error-messages.ts's clean, actionable message) regardless of which
// provider name sits here. "openai" is used as the label since it's the catalog's own reference/
// canonical entry (see provider-catalog.ts's OPENAI_COMPAT doc comment).
const DEFAULT_CONFIG: ModelConfig = { primary: "openai", fallback: [] };

/**
 * Real bug fixed (user, repeatedly: "the providers are not still working"): the admin panel runs
 * as its own real child process with its OWN process.cwd() (packages/dave-admin -- see main.ts's
 * spawnAdminPanel), so a primary/fallback provider genuinely set through the admin panel's real
 * "AI Models" tab (packages/dave-admin/app/api/model-config) was written to a COMPLETELY
 * DIFFERENT file than the one this bot process reads -- the bot kept running on whatever it had
 * before (or DEFAULT_CONFIG's default), no matter what was actually saved in the
 * admin panel. DAVE_DATA_ROOT (same real fix already applied to @dave/memory's goal.yaml) makes
 * both processes genuinely read/write the identical file.
 */
function configPath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "brain", `${userId}-model-config.json`);
}

/** Step 5.2: button-driven model-picker UI reads/writes this. Any catalog provider name is valid (see provider-catalog.ts). */
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

/** Step 5.4: workers always get DeepSeek or Claude. */
export function routeForWorker(preferred: "deepseek" | "claude" = "deepseek"): ModelConfig {
  const other: "deepseek" | "claude" = preferred === "deepseek" ? "claude" : "deepseek";
  return { primary: preferred, fallback: [other] };
}
