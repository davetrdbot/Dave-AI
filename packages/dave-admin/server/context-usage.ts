import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import { getModelConfig, listProviderKeys, PROVIDER_CATALOG, resolveProviderAlias, knownContextWindow, type ProviderName } from "@dave/brain";
import { dbPathFor } from "./db-path";

/**
 * Read side of the bot's context-usage records (packages/dave-agent-loop/src/context-usage.ts).
 * The admin process cannot import @dave/agent-loop, so the path and shapes are mirrored here --
 * keep them in step with that file.
 */

export const CONTEXT_PARTS = ["tools", "systemPrompt", "messages", "skills", "memory", "liveContext"] as const;

export interface ContextSnapshotView {
  at: number;
  source: string;
  provider: string;
  model?: string;
  promptTokens: number;
  completionTokens?: number;
  cachedTokens?: number;
  estimated: boolean;
  contextWindow?: number;
  parts: Record<(typeof CONTEXT_PARTS)[number], number>;
  toolCount: number;
  messageCount: number;
}

export interface HourBucketView {
  /** Start of the hour, epoch ms (UTC-aligned; the phone groups by its own local day). */
  start: number;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  estimatedCalls: number;
  peakPromptTokens: number;
  bySource: Record<string, { calls: number; tokens: number }>;
}

function dir(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "context-usage", userId);
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** The model Dave is set to use right now -- shown before any request has been recorded, and used
 *  to fill a window the bot could not resolve. */
export function currentModel(userId: string): { provider: string; providerName: string; model?: string; contextWindow?: number } {
  const provider = getModelConfig(userId).primary as ProviderName;
  const entry = PROVIDER_CATALOG[resolveProviderAlias(provider)];
  let model = entry?.defaultModel;
  const db = new DaveDatabase(dbPathFor(userId));
  try {
    const keys = listProviderKeys(db, userId, provider);
    model = (keys.find((k) => k.isPrimary) ?? keys[0])?.config.model ?? model;
  } catch {
    // no keys table yet -- the catalog default stands
  } finally {
    db.close();
  }
  return { provider, providerName: entry?.displayName ?? provider, model, contextWindow: knownContextWindow(model) };
}

export function readContextUsage(userId: string, sinceMs: number) {
  const last = readJson<Record<string, ContextSnapshotView>>(join(dir(userId), "last-request.json"), {});
  const hourly = readJson<Record<string, Omit<HourBucketView, "start">>>(join(dir(userId), "hourly.json"), {});
  const hours: HourBucketView[] = Object.entries(hourly)
    .map(([k, b]) => ({ start: Number(k), ...b, bySource: b.bySource ?? {} }))
    .filter((b) => Number.isFinite(b.start) && b.start >= sinceMs)
    .sort((a, b) => a.start - b.start);
  const now = currentModel(userId);
  for (const snap of Object.values(last)) {
    if (!snap.contextWindow) snap.contextWindow = knownContextWindow(snap.model) ?? (snap.model === now.model ? now.contextWindow : undefined);
  }
  return { current: now, chat: last.chat ?? null, autonomous: last.autonomous ?? null, hours };
}
