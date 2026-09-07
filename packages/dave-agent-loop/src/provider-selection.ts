import type { DaveDatabase } from "@dave/db";
import { generateWithKeyFailover, getModelConfig, type Provider, type CompletionRequest, type CompletionResult, type ProviderName } from "@dave/brain";
import { getProviderTimeoutMs, MAX_TIMEOUT_SECONDS } from "./provider-timeout-config.js";
import { AllConfiguredProvidersFailedError } from "./error-messages.js";

/**
 * Pulled out of telegram-bot-server.ts so this real, shared provider-selection logic (owner's
 * configured primary/fallback chain, per-provider timeouts, failover notifications) can also be
 * used by worker-loop.ts's real subagent execution -- a worker uses the SAME provider config the
 * owner already set up, not a separate hardcoded path. Kept in its own file (not re-exported from
 * telegram-bot-server.ts) specifically so worker-loop.ts never has to import telegram-bot-server.ts,
 * which would create a circular import (telegram-bot-server -> full-registry -> worker-loop).
 */

/**
 * Real, verified finding (tested live against the user's own real nvidia-nim key and
 * deepseek-v4-pro-0813): nvidia-nim's real backend gets dramatically slower as the number of
 * tools in the request grows -- 1 tool: ~6s, 2: ~12s, 5: ~18s, 10+: still running after 30s, and
 * Dave's real full tool registry is ~194 tools. A literally-unlimited timeout (what was shipped
 * previously) makes this worse, not better: it lets a request hang silently for as long as it
 * takes rather than ever surfacing a real error, which is indistinguishable from "doesn't work"
 * to the user. This is instead the largest BOUNDED real timeout the rest of the app already
 * supports (provider-timeout-config.ts's own MAX_TIMEOUT_SECONDS) -- generous, but a real request
 * still either succeeds or fails within it, rather than hanging forever.
 */
export const NVIDIA_TIMEOUT_MS = MAX_TIMEOUT_SECONDS * 1000;

/**
 * Real gap fixed AGAIN (user, explicitly, repeatedly, and angrily: "I told you that the error
 * should be fetch from the endpoint I want to see it on my own not you tell me my bot is not
 * working"): the previous version still put Dave's OWN guessed label ("ran out of credit") in
 * front of the real error, decided by a regex (`isQuotaExhaustedError`) that was WRONG here --
 * it matched bare `429`/"rate limit exceeded"/"too many requests" as "quota exhausted" even
 * though a plain rate limit (too many requests right now, real code "rate_limited") is NOT the
 * same real condition as a genuinely exhausted quota/billing plan ("insufficient_quota"). The
 * user saw "ran out of credit" directly contradicted by the real error text sitting right below
 * it ("Rate limit exceeded"), which is exactly the confusing, untrustworthy result they called
 * out. Fix: stop guessing/labeling the failure type in the user-facing message entirely -- state
 * only the plain fact of what's happening (a key/provider failed, what's tried next) and show
 * ONLY the real endpoint text, verbatim, so the user reads the actual cause themselves instead of
 * taking Dave's interpretation of it.
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
        // nvidia-nim gets real extra patience (verified: it's genuinely much slower than other
        // providers under Dave's real tool count) -- but bounded, see NVIDIA_TIMEOUT_MS above.
        const timeoutMs = provider === "nvidia-nim" ? NVIDIA_TIMEOUT_MS : getProviderTimeoutMs(userId, p === 0) || defaultTimeoutMs;
        try {
          return await generateWithKeyFailover(db, userId, provider, req, timeoutMs, {
            onKeySwitch: async ({ fromIndex, toIndex, nextLabel, reason }) => {
              await notify(`🔄 ${provider} key #${fromIndex} failed, switching to key #${toIndex} (${nextLabel}).\n${reason}`);
            },
            onProviderExhausted: async ({ reason }) => {
              attempts.push({ provider, reason });
              const nextProvider = order[p + 1];
              // Real gap also fixed: this used to only notify when quotaExhausted was true, or
              // when there was no fallback -- a non-quota failure WITH a real fallback configured
              // silently notified no one at all. Every real exhaustion is worth telling the user
              // about, regardless of how it's classified.
              await notify(`⚠️ ${provider} failed${nextProvider ? ` — switching to ${nextProvider}` : " — no fallback provider is configured"}.\n${reason}`);
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
