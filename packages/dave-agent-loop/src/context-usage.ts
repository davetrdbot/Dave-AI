import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CompletionRequest, CompletionResult, ContentBlock, ToolSpec } from "@dave/brain";

/**
 * What fills Dave's context window, and how much he used over the day (the trader, with a
 * screenshot of a "Context windows" panel: "add this to the app ... how it was used for the full
 * day").
 *
 * Two records, both files (the phone reads them through the admin process, which cannot import
 * this package -- packages/dave-admin/server/context-usage.ts mirrors the paths and shapes):
 *
 *   - `last-request.json`: for the latest request of each kind (chat, autonomous), how big it was
 *     and what it was made of -- tool definitions, system prompt, conversation, skills, memory and
 *     knowledge, live context. The TOTAL is the provider's own prompt-token count whenever it
 *     reports one; the split between parts is measured on the actual text sent, then scaled to
 *     that total. Nothing is guessed except when the provider reported no usage at all, and then
 *     the record says so (`estimated: true`).
 *   - `hourly.json`: every AI call, bucketed by hour -- calls, prompt/output/cached tokens, and
 *     which part of Dave made them. Kept for 45 days.
 */

export type UsageSource = "chat" | "autonomous" | "background" | "worker" | "review";

export const CONTEXT_PARTS = ["tools", "systemPrompt", "messages", "skills", "memory", "liveContext"] as const;
export type ContextPart = (typeof CONTEXT_PARTS)[number];

export interface ContextSnapshot {
  at: number;
  source: UsageSource;
  provider: string;
  model?: string;
  /** Tokens in the request that was sent (the provider's own count when reported). */
  promptTokens: number;
  completionTokens?: number;
  cachedTokens?: number;
  /** True when the provider reported no usage and promptTokens is estimated from the text. */
  estimated: boolean;
  contextWindow?: number;
  /** Tokens per part; sums to promptTokens. */
  parts: Record<ContextPart, number>;
  toolCount: number;
  messageCount: number;
}

export interface HourBucket {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  /** Calls whose tokens were estimated because the provider reported none. */
  estimatedCalls: number;
  /** Largest single request this hour -- how close Dave came to the window. */
  peakPromptTokens: number;
  bySource: Partial<Record<UsageSource, { calls: number; tokens: number }>>;
}

export const USAGE_RETENTION_MS = 45 * 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;

export function contextUsageDir(userId: string): string {
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

/** Write-then-rename, so the admin process never reads half a file. */
function writeJson(path: string, value: unknown): void {
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), "utf8");
  renameSync(tmp, path);
}

function textOf(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content.map((b) => ("text" in b && typeof b.text === "string" ? b.text : "")).join("");
}

/** A tag's span inside the live-context block, e.g. <remembered>...</remembered>. */
function tagLength(text: string, tag: string): number {
  const open = text.indexOf(`<${tag}>`);
  if (open === -1) return 0;
  const close = text.indexOf(`</${tag}>`, open);
  return close === -1 ? 0 : close + tag.length + 3 - open;
}

/** Characters per part of a request, measured on what is actually sent. */
export function measureRequest(req: Pick<CompletionRequest, "messages" | "tools">): Record<ContextPart, number> {
  const parts: Record<ContextPart, number> = { tools: 0, systemPrompt: 0, messages: 0, skills: 0, memory: 0, liveContext: 0 };
  parts.tools = req.tools && req.tools.length > 0 ? JSON.stringify(req.tools as ToolSpec[]).length : 0;
  for (const m of req.messages) {
    const text = textOf(m.content);
    const calls = m.toolCalls ? JSON.stringify(m.toolCalls).length : 0;
    if (m.role === "system") {
      parts.systemPrompt += text.length;
      continue;
    }
    const liveStart = text.indexOf("<live_context>");
    const liveEnd = text.indexOf("</live_context>");
    if (m.role === "user" && liveStart !== -1 && liveEnd > liveStart) {
      const live = text.slice(liveStart, liveEnd + "</live_context>".length);
      const skills = tagLength(live, "active_strategy_skill") + tagLength(live, "available_skills");
      const memory = tagLength(live, "remembered") + tagLength(live, "knowledge_index");
      parts.skills += skills;
      parts.memory += memory;
      parts.liveContext += live.length - skills - memory;
      parts.messages += text.length - live.length + calls;
    } else {
      parts.messages += text.length + calls;
    }
  }
  return parts;
}

/** Scales measured characters to a token total, so the parts add up exactly. */
export function scaleParts(chars: Record<ContextPart, number>, totalTokens: number): Record<ContextPart, number> {
  const sum = CONTEXT_PARTS.reduce((s, p) => s + chars[p], 0);
  const out = { tools: 0, systemPrompt: 0, messages: 0, skills: 0, memory: 0, liveContext: 0 } as Record<ContextPart, number>;
  if (sum === 0 || totalTokens <= 0) return out;
  let assigned = 0;
  let biggest: ContextPart = "messages";
  for (const p of CONTEXT_PARTS) {
    out[p] = Math.floor((chars[p] / sum) * totalTokens);
    assigned += out[p];
    if (chars[p] > chars[biggest]) biggest = p;
  }
  out[biggest] += totalTokens - assigned; // rounding remainder, so the parts sum to the total
  return out;
}

/** Rough tokens for text when the provider reports none: ~4 characters per token. */
export const CHARS_PER_TOKEN = 4;

export interface RecordCallInput {
  userId: string;
  source: UsageSource;
  provider: string;
  model?: string;
  contextWindow?: number;
  req: Pick<CompletionRequest, "messages" | "tools">;
  result: Pick<CompletionResult, "tokenUsage" | "cacheUsage">;
  now?: number;
}

/** Records one AI call. Never throws: usage bookkeeping must never cost Dave a reply or a trade. */
export function recordModelCall(input: RecordCallInput): ContextSnapshot | undefined {
  try {
    const now = input.now ?? Date.now();
    const chars = measureRequest(input.req);
    const measuredChars = CONTEXT_PARTS.reduce((s, p) => s + chars[p], 0);
    const reported = input.result.tokenUsage;
    const estimated = !reported || !(reported.promptTokens > 0);
    const promptTokens = estimated ? Math.ceil(measuredChars / CHARS_PER_TOKEN) : reported!.promptTokens;
    const completionTokens = reported?.completionTokens ?? 0;
    const cachedTokens = input.result.cacheUsage?.cacheReadInputTokens ?? 0;

    const snapshot: ContextSnapshot = {
      at: now,
      source: input.source,
      provider: input.provider,
      model: input.model,
      promptTokens,
      completionTokens: reported ? completionTokens : undefined,
      cachedTokens: input.result.cacheUsage ? cachedTokens : undefined,
      estimated,
      contextWindow: input.contextWindow,
      parts: scaleParts(chars, promptTokens),
      toolCount: input.req.tools?.length ?? 0,
      messageCount: input.req.messages.length,
    };

    const dir = contextUsageDir(input.userId);
    // Only the conversation and the autonomous cycle are "Dave's context" in the panel's sense;
    // background checks and workers are separate short runs and would overwrite it with noise.
    if (input.source === "chat" || input.source === "autonomous") {
      const lastPath = join(dir, "last-request.json");
      const last = readJson<Partial<Record<UsageSource, ContextSnapshot>>>(lastPath, {});
      last[input.source] = snapshot;
      writeJson(lastPath, last);
    }

    const hourlyPath = join(dir, "hourly.json");
    const hourly = readJson<Record<string, HourBucket>>(hourlyPath, {});
    const key = String(Math.floor(now / HOUR_MS) * HOUR_MS);
    const b: HourBucket = hourly[key] ?? { calls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, estimatedCalls: 0, peakPromptTokens: 0, bySource: {} };
    b.calls += 1;
    b.promptTokens += promptTokens;
    b.completionTokens += completionTokens;
    b.cachedTokens += cachedTokens;
    if (estimated) b.estimatedCalls += 1;
    b.peakPromptTokens = Math.max(b.peakPromptTokens, promptTokens);
    const s = b.bySource[input.source] ?? { calls: 0, tokens: 0 };
    s.calls += 1;
    s.tokens += promptTokens + completionTokens;
    b.bySource[input.source] = s;
    hourly[key] = b;
    const cutoff = now - USAGE_RETENTION_MS;
    for (const k of Object.keys(hourly)) if (Number(k) < cutoff) delete hourly[k];
    writeJson(hourlyPath, hourly);
    return snapshot;
  } catch (err) {
    console.error(`[context-usage] ${input.userId}: could not record a call:`, err);
    return undefined;
  }
}
