import type { DaveDatabase } from "@dave/db";
import {
  generateWithKeyFailover,
  getModelConfig,
  listProviderKeys,
  PROVIDER_CATALOG,
  resolveProviderAlias,
  knownContextWindow,
  type Provider,
  type CompletionRequest,
  type CompletionResult,
  type ProviderName,
} from "@dave/brain";
import { recordModelCall, type UsageSource } from "./context-usage.js";
import { getProviderTimeoutMs, MAX_TIMEOUT_SECONDS } from "./provider-timeout-config.js";
import { AllConfiguredProvidersFailedError, classifyProviderError, describeProviderFailure } from "./error-messages.js";

/** A real, conservative emergency trim -- well under any known provider's real tool-count cap,
 *  used only as a last-resort defensive retry (see the "too many tools" catch below). Dynamic
 *  tool selection (agent-loop.ts) is the real, primary fix -- this is a safety net, not the fix. */
const EMERGENCY_TOOL_TRIM = 16;

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
 * Real bug fixed (user, with real pasted proof: raw JSON error blobs sent directly as bot
 * messages, sometimes duplicated). An earlier, since-superseded instruction made every
 * notification here ONLY the raw JSON body with no provider name at all -- besides being
 * unreadable, it made a real NVIDIA error unattributable and get reported back as "Mistral 404"
 * (item 5 of the same bug report). Per the user's current, explicit instruction, every
 * notification below is now ONE short, clean, human-readable line naming the real provider and a
 * real classification of what happened -- never the raw JSON.
 *
 * Real dedup fix: onProviderExhausted only notifies live when there's actually a NEXT provider to
 * switch to -- the LAST provider's failure is reported exactly once, by the final
 * AllConfiguredProvidersFailedError message (error-messages.ts) when the whole chain gives up.
 * Previously it fired for every provider unconditionally, so the same failure could reach the
 * user twice: once here, live, and again in the final thrown error's own rendering.
 */
/**
 * How long a transient notice stays in the chat before deleting itself. The trader's own number
 * ("this message should get deleted ... after 10 s").
 */
export const TRANSIENT_NOTICE_MS = 10_000;

/**
 * Options a notice carries to its sink. `transientMs` means "this is worth glancing at, not worth
 * keeping" -- the sink should delete the message after that long.
 *
 * Real complaint this exists for (the trader): "when the bot is calling its tool already it
 * shouldn't show any timeout -- it's already working, so what's the point". A key rotation that
 * RECOVERS is, by definition, a turn that carried on working, so its notice is noise a few seconds
 * later. It still shows briefly (a sick key is worth knowing about) and then removes itself.
 */
export interface NoticeOptions {
  transientMs?: number;
}

export type NotifyFn = (text: string, options?: NoticeOptions) => void | Promise<void>;

/** The model a provider's calls go to, and its context window from the published table. Kept
 *  free of network calls: this runs on every AI request. (A window the table doesn't know is
 *  looked up from the provider's own model listing by the admin side, when the app asks.) */
function modelAndWindow(db: DaveDatabase, userId: string, provider: ProviderName): { model?: string; contextWindow?: number } {
  try {
    const keys = listProviderKeys(db, userId, provider);
    const key = keys.find((k) => k.isPrimary) ?? keys[0];
    const model = key?.config.model ?? PROVIDER_CATALOG[resolveProviderAlias(provider)]?.defaultModel;
    return model ? { model, contextWindow: knownContextWindow(model) } : {};
  } catch {
    return {};
  }
}

/**
 * `source` labels every call for the app's usage panel (chat, the autonomous cycle, background
 * checks, workers, reviews) -- see context-usage.ts.
 */
export function modelConfigProvider(db: DaveDatabase, userId: string, notify: NotifyFn, source: UsageSource = "chat"): Provider {
  return {
    name: "model-config" as ProviderName,
    async generate(req: CompletionRequest, defaultTimeoutMs: number, signal?: AbortSignal): Promise<CompletionResult> {
      const config = getModelConfig(userId);
      const order = [config.primary, ...config.fallback.filter((p) => p !== config.primary)];
      const attempts: { provider: ProviderName; reason: string }[] = [];
      for (let p = 0; p < order.length; p++) {
        const provider = order[p];
        const hasNextProvider = p < order.length - 1;
        // Real gap fixed (user: "increase the timeout if possible put 2 and 3 to 5 sec settable
        // in settings"): the primary provider gets its own (usually longer) real, persisted,
        // user-configurable timeout; every fallback attempt after it gets a separate (usually
        // shorter) one -- a slow/dead primary no longer burns the SAME long timeout on every
        // provider down the chain. Falls back to the caller's own default if nothing's configured.
        // nvidia-nim gets real extra patience (verified: it's genuinely much slower than other
        // providers under Dave's real tool count) -- but bounded, see NVIDIA_TIMEOUT_MS above.
        const timeoutMs = provider === "nvidia-nim" ? NVIDIA_TIMEOUT_MS : getProviderTimeoutMs(userId, p === 0) || defaultTimeoutMs;
        // Real defensive fix (item 4 example: "Grok call failed -- too many tools in request,
        // retrying with a trimmed set"): dynamic tool selection (agent-loop.ts) already keeps
        // every request under the real per-provider cap in normal operation, but if a
        // "too many tools" error somehow still reaches here (e.g. a provider with a lower real
        // cap than MAX_TOOLS_PER_REQUEST), retry the SAME request once against the SAME
        // provider/key with a hard-trimmed tool list rather than immediately burning a whole
        // provider switch over something a smaller request would have avoided.
        let reqForThisProvider = req;
        const record = (result: CompletionResult, sent: CompletionRequest): CompletionResult => {
          recordModelCall({ userId, source, provider, ...modelAndWindow(db, userId, provider), req: sent, result });
          return result;
        };
        try {
          return record(await generateWithKeyFailover(
            db,
            userId,
            provider,
            reqForThisProvider,
            timeoutMs,
            {
              onKeySwitch: async ({ reason }) => {
                // Transient: a key rotation only matters until the next key answers. If the turn
                // then completes normally the trader has nothing to act on, so the message removes
                // itself rather than sitting in the chat implying something is still wrong.
                await notify(`⚠️ ${provider} key issue (${describeProviderFailure(reason)}) — trying next key`, {
                  transientMs: TRANSIENT_NOTICE_MS,
                });
              },
              onProviderExhausted: async ({ reason }) => {
                attempts.push({ provider, reason });
                // Deliberately NOT transient: a whole provider dropping out is worth keeping in
                // the chat, unlike a single key rotation that recovered.
                if (hasNextProvider) await notify(`⚠️ ${provider} unavailable (${describeProviderFailure(reason)}) — switching provider`);
              },
            },
            signal
          ), reqForThisProvider);
        } catch (err) {
          // Real bug fixed (user, live: /stop cancelled one in-flight call, but "still thinking"
          // never stopped). An abort was being caught here and treated as just "this provider
          // failed," so the loop kept going -- trying the NEXT provider in the whole configured
          // chain with a brand-new network call, over and over, instead of genuinely stopping.
          // A signal that's already aborted means stop now, full stop -- never retry past it.
          if (signal?.aborted) throw err;
          const reason = err instanceof Error ? err.message : String(err);
          if (req.tools && req.tools.length > EMERGENCY_TOOL_TRIM && classifyProviderError(reason) === "too many tools in request") {
            try {
              reqForThisProvider = { ...req, tools: req.tools.slice(0, EMERGENCY_TOOL_TRIM) };
              await notify(`⚠️ ${provider} call failed — too many tools in request, retrying with a trimmed set`);
              return record(await generateWithKeyFailover(db, userId, provider, reqForThisProvider, timeoutMs, {}, signal), reqForThisProvider);
            } catch (retryErr) {
              if (signal?.aborted) throw retryErr;
              const retryReason = retryErr instanceof Error ? retryErr.message : String(retryErr);
              if (!attempts.some((a) => a.provider === provider)) attempts.push({ provider, reason: retryReason });
              continue;
            }
          }
          if (!attempts.some((a) => a.provider === provider)) attempts.push({ provider, reason });
        }
      }
      throw new AllConfiguredProvidersFailedError(attempts);
    },
  };
}
