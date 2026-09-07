import type { DaveDatabase } from "@dave/db";
import { generateWithKeyFailover, getModelConfig, type Provider, type CompletionRequest, type CompletionResult, type ProviderName } from "@dave/brain";
import { getProviderTimeoutMs } from "./provider-timeout-config.js";
import { AllConfiguredProvidersFailedError } from "./error-messages.js";

/**
 * Pulled out of telegram-bot-server.ts so this real, shared provider-selection logic (owner's
 * configured primary/fallback chain, per-provider timeouts, failover notifications) can also be
 * used by worker-loop.ts's real subagent execution -- a worker uses the SAME provider config the
 * owner already set up, not a separate hardcoded path. Kept in its own file (not re-exported from
 * telegram-bot-server.ts) specifically so worker-loop.ts never has to import telegram-bot-server.ts,
 * which would create a circular import (telegram-bot-server -> full-registry -> worker-loop).
 */

/** Largest delay `setTimeout` can legally take (2^31-1 ms, ~24.8 days) -- used as an effectively
 *  unlimited timeout for providers exempted from the real request timeout entirely. */
export const NO_TIMEOUT_MS = 2147483647;

/**
 * Real gap fixed (user: "should show the errors from the endpoint so I will confirm it, not you
 * saying it"): every failover/exhaustion notification below now includes the actual raw reason
 * string generateWithKeyFailover captured from the real API response (an HTTP status + body, or
 * the underlying fetch error) -- not just Dave's own paraphrase ("ran out of credit"). The
 * paraphrase stays as a quick-read label; the real endpoint text rides alongside it so the user
 * can verify it themselves instead of taking Dave's word for it.
 */
export function modelConfigProvider(db: DaveDatabase, userId: string, notify: (text: string) => void | Promise<void>): Provider {
  return {
    name: "model-config" as ProviderName,
    async generate(req: CompletionRequest, defaultTimeoutMs: number): Promise<CompletionResult> {
      const config = getModelConfig(userId);
      const order = [config.primary, ...config.fallback.filter((p) => p !== config.primary)];
      const attempts: { provider: ProviderName; reason: string }[] = [];
      for (let p = 0; p < order.length; p++) {
        const provider = order[p];
        // Real gap fixed (user: "increase the timeout if possible put 2 and 3 to 5 sec settable
        // in settings"): the primary provider gets its own (usually longer) real, persisted,
        // user-configurable timeout; every fallback attempt after it gets a separate (usually
        // shorter) one -- a slow/dead primary no longer burns the SAME long timeout on every
        // provider down the chain. Falls back to the caller's own default if nothing's configured.
        // Real exception (user: "specially for Nvidia they shouldn't be any timeout"): nvidia-nim
        // genuinely runs much slower/less predictably than the other providers (real large-model
        // cold starts on build.nvidia.com), so it's exempted from the configured/default timeout
        // entirely.
        const timeoutMs = provider === "nvidia-nim" ? NO_TIMEOUT_MS : getProviderTimeoutMs(userId, p === 0) || defaultTimeoutMs;
        try {
          return await generateWithKeyFailover(db, userId, provider, req, timeoutMs, {
            onKeySwitch: async ({ fromIndex, toIndex, nextLabel, reason, quotaExhausted }) => {
              await notify(`🔄 Switched from key #${fromIndex} to key #${toIndex} (${nextLabel}) on ${provider} — key #${fromIndex} ${quotaExhausted ? "ran out of credit" : "failed"}. Real error: ${reason}`);
            },
            onProviderExhausted: async ({ reason, quotaExhausted }) => {
              attempts.push({ provider, reason });
              const nextProvider = order[p + 1];
              if (quotaExhausted) {
                await notify(`⚠️ ${provider} ran out of credit${nextProvider ? ` — switching to the next available key/provider (${nextProvider})` : " — no fallback provider is configured"}. Real error: ${reason}`);
              } else if (!nextProvider) {
                await notify(`⚠️ ${provider} failed and no fallback provider is configured. Real error: ${reason}`);
              }
            },
          });
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          if (!attempts.some((a) => a.provider === provider)) attempts.push({ provider, reason });
        }
      }
      throw new AllConfiguredProvidersFailedError(attempts);
    },
  };
}
