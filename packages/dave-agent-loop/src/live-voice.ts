import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DaveDatabase } from "@dave/db";
import { getGeminiLiveKey } from "@dave/notifications";
import type { ToolRegistry } from "./tool-registry.js";
import { withLiveContext } from "./live-context.js";

/**
 * Talking to Dave live (Gemini Live -- the trader: "build the gemini live next").
 *
 * The phone talks to Gemini directly (lowest latency for audio), but never holds the trader's
 * Gemini key: the bot mints a one-use, short-lived EPHEMERAL TOKEN from it for each call, and hands
 * the app the whole session setup -- Dave's voice-call instructions, what's happening right now,
 * and a curated set of his tools. When Gemini wants a tool, the app sends the call here
 * (runLiveTool) and passes the answer back.
 *
 * Trade actions are gated HERE, not by trusting the model: a tool that changes a trade refuses to
 * run until it is called with confirmed: true, and the instructions say to ask for a spoken yes
 * first. Anything bigger than a quick tool goes to full Dave through ask_dave (a normal chat turn,
 * all his tools and safeguards).
 */

export const LIVE_MODELS = { fast: "gemini-3.8-live", thinking: "gemini-3.8-live-extended-thinking" } as const;
export const LIVE_VOICES = ["Puck", "Charon", "Kore", "Fenrir", "Aoede", "Orus", "Leda", "Zephyr"];
const GEMINI = "https://generativelanguage.googleapis.com";
export const LIVE_WS_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained";

/** Read-only tools: free to call. */
const READ_TOOLS = [
  "get_live_state",
  "get_account_balance",
  "get_price",
  "get_candles",
  "get_trend",
  "get_volatility",
  "get_market_structure",
  "get_zones",
  "get_session",
  "get_trade_history",
  "get_win_rate",
  "get_todays_journal",
  "recall_memory",
  "growth_status",
  "list_exit_rules",
  "self_aware_stats",
  "list_reminders",
  "get_levels",
  "get_liquidity",
  "get_momentum",
  "get_news",
  "get_trade_thesis",
  "get_summary",
  "get_open_trades",
  "get_symbol_info",
  "get_position_size",
  "get_deal_history",
  "web_search",
];
/** Tools that change a trade or schedule something: need the trader's spoken yes. */
const ACTION_TOOLS = ["set_breakeven", "fit_analysis_to_skill", "modify_sl_tp", "partial_close", "full_close", "delete_pending_order", "set_exit_rule", "cancel_exit_rule", "set_reminder", "trade_execute"];
export const LIVE_TOOL_NAMES = new Set([...READ_TOOLS, ...ACTION_TOOLS, "ask_dave"]);
const isAction = (name: string) => ACTION_TOOLS.includes(name);

/** JSON Schema (as the tools declare it) -> the Gemini Schema subset: upper-case types, no
 *  unions or additionalProperties. Anything it can't express becomes a plain string. */
export function toGeminiSchema(s: unknown): Record<string, unknown> {
  const o = (s ?? {}) as Record<string, unknown>;
  let type = o.type;
  let nullable = false;
  if (Array.isArray(type)) {
    nullable = type.includes("null");
    type = type.find((t) => t !== "null") ?? "string";
  }
  const t = String(type ?? (o.properties ? "object" : "string")).toUpperCase();
  const out: Record<string, unknown> = { type: ["STRING", "NUMBER", "INTEGER", "BOOLEAN", "ARRAY", "OBJECT"].includes(t) ? t : "STRING" };
  if (typeof o.description === "string") out.description = o.description.slice(0, 900);
  if (nullable) out.nullable = true;
  if (Array.isArray(o.enum)) out.enum = o.enum.map(String);
  if (out.type === "ARRAY") out.items = toGeminiSchema(o.items ?? { type: "string" });
  if (out.type === "OBJECT") {
    const props = (o.properties ?? {}) as Record<string, unknown>;
    out.properties = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, toGeminiSchema(v)]));
    if (Array.isArray(o.required) && o.required.length) out.required = o.required.filter((r) => typeof r === "string" && r in props);
  }
  return out;
}

export function liveFunctionDeclarations(registry: ToolRegistry, allowActions = true): Record<string, unknown>[] {
  const decls: Record<string, unknown>[] = [];
  for (const tool of registry.list() as { name: string; description?: string; parameters?: unknown }[]) {
    if (!LIVE_TOOL_NAMES.has(tool.name) || tool.name === "ask_dave") continue;
    if (!allowActions && isAction(tool.name)) continue;
    const params = toGeminiSchema(tool.parameters ?? { type: "object", properties: {} });
    if (params.type !== "OBJECT") continue;
    if (isAction(tool.name)) {
      (params.properties as Record<string, unknown>).confirmed = { type: "BOOLEAN", description: "true ONLY after the trader clearly said yes to exactly this action, on this call" };
    }
    decls.push({ name: tool.name, description: String(tool.description ?? "").slice(0, 1000) + (isAction(tool.name) ? " CHANGES A TRADE: say what you'll do, wait for a clear yes, then call with confirmed: true." : ""), parameters: params });
  }
  decls.push({
    name: "ask_dave",
    description:
      "Hand a bigger job to Dave's full brain (every tool, his memory, his full trading rules): a full analysis of a pair, a setup search, a what-if, anything the quick tools can't answer. Takes up to a minute -- tell the trader you're checking first. Returns Dave's written answer; say it naturally, shorter.",
    parameters: { type: "OBJECT", properties: { request: { type: "STRING", description: "the job, in the trader's words plus what you already know" } }, required: ["request"] },
  });
  return decls;
}

function readPrompt(file: string): string {
  const p = join(process.cwd(), "prompts", file);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

/** Dave's voice-call instructions: his character, the safety rules, voice manners, right now. */
export function liveSystemInstruction(userId: string, allowActions = true): string {
  const now = withLiveContext(userId, "(voice call started)");
  const context = typeof now === "string" ? now : "";
  return [
    "You are Dave, the trader's own trading agent, on a LIVE VOICE CALL with them.",
    "Voice rules: speak like a sharp trading partner on the phone -- short, natural sentences; one idea at a time; no markdown, lists, emoji or symbols read aloud. Say prices the way a trader says them ('twenty-six fifty', 'one oh eight five'). Round sensibly. If you're checking something, say so in a few words first ('let me look'). Let the trader interrupt; when they do, stop and listen.",
    "Tools: use them for anything factual -- never guess a price, balance or position. For bigger questions (full analysis, finding setups, what-ifs) use ask_dave and summarise his answer in a sentence or two.",
    allowActions
      ? "Trade actions (breakeven, moving SL/TP, closing, new trades, exit rules, reminders): say exactly what you're about to do, wait for a clear yes, then call the tool with confirmed: true. A maybe is a no. Never widen a stop. If the app tells you the trader tapped yes or no, that is their answer."
      : "On this call you can't change trades (the trader switched that off): if they ask, say so and suggest they do it in the app or turn 'Let him act on trades' back on.",
    "",
    readPrompt("SOUL.md"),
    "",
    readPrompt("SECURITY.md"),
    "",
    "RIGHT NOW (from Dave's own state -- the same picture he trades from):",
    context.slice(0, 12_000),
  ].join("\n");
}

export interface LiveSession {
  url: string;
  token: string;
  model: string;
  expiresAt: number;
  setup: Record<string, unknown>;
}

export class NoGeminiKeyError extends Error {
  constructor() {
    super("Add your Gemini API key first (Settings > Dave's voice > Talk to Dave live).");
  }
}

/** Mints the one-use token and builds the session setup the app sends first on the socket. */
export async function startLiveSession(
  deps: { db: DaveDatabase; userId: string; registry: ToolRegistry },
  opts: { thinking?: boolean; voice?: string; allowActions?: boolean; extraInstruction?: string } = {},
  fetchImpl: typeof fetch = fetch,
  now = Date.now()
): Promise<LiveSession> {
  const key = getGeminiLiveKey(deps.db, deps.userId);
  if (!key) throw new NoGeminiKeyError();
  const model = opts.thinking ? LIVE_MODELS.thinking : LIVE_MODELS.fast;
  const expiresAt = now + 30 * 60_000;
  const voice = opts.voice && LIVE_VOICES.includes(opts.voice) ? opts.voice : "Charon";
  const setup = {
    model: `models/${model}`,
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
    systemInstruction: { parts: [{ text: [liveSystemInstruction(deps.userId, opts.allowActions !== false), opts.extraInstruction].filter(Boolean).join("\n\n") }] },
    tools: [{ functionDeclarations: liveFunctionDeclarations(deps.registry, opts.allowActions !== false) }],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    contextWindowCompression: { slidingWindow: {} },
    // Google closes a live socket every ~10 minutes; the app reconnects with the handle it was
    // last given (sessionResumptionUpdate) and a fresh token, and the call carries on.
    sessionResumption: {},
  };
  // One-use call tokens exist only on v1alpha, and the REST body names the locked setup
  // `bidiGenerateContentSetup` (the SDKs call it liveConnectConstraints -- Google refuses that name).
  const res = await fetchImpl(`${GEMINI}/v1alpha/auth_tokens`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({
      uses: 1,
      expireTime: new Date(expiresAt).toISOString(),
      newSessionExpireTime: new Date(now + 2 * 60_000).toISOString(),
      // The WHOLE setup goes in the token. Google locks a constrained session to the token's setup
      // and ignores what the app sends -- with only the model in it, Dave had no instructions and
      // no tools on the call ("it doesn't know anything about trade, it can't open trade").
      bidiGenerateContentSetup: setup,
    }),
  });
  const json = (await res.json().catch(() => ({}))) as { name?: string; token?: { name?: string }; error?: { message?: string } };
  if (!res.ok) throw new Error(`Google refused the call: ${json.error?.message ?? `HTTP ${res.status}`}`);
  const token = json.name ?? json.token?.name;
  if (!token) throw new Error("Google didn't return a call token.");
  return {
    url: `${LIVE_WS_URL}?access_token=${encodeURIComponent(token)}`,
    token,
    model,
    expiresAt,
    setup: { setup },
  };
}

const MAX_RESULT_CHARS = 6000;

/**
 * Runs one tool Gemini asked for. Only the call's own tools; trade actions only with confirmed:
 * true; results trimmed (spoken answers don't need 40 KB of JSON). Never throws -- errors go back
 * to Gemini as {error}, so it can say what went wrong.
 */
export async function runLiveTool(
  deps: { registry: ToolRegistry; askDave: (request: string) => Promise<string> },
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (!LIVE_TOOL_NAMES.has(name)) return { error: `${name} isn't available on a voice call -- use ask_dave.` };
  try {
    if (name === "ask_dave") {
      const request = String(args.request ?? "").trim();
      if (!request) return { error: "What should Dave do?" };
      return { answer: (await deps.askDave(request)).slice(0, MAX_RESULT_CHARS) };
    }
    if (isAction(name) && args.confirmed !== true) {
      return {
        needsConfirmation: true,
        instruction: "Not done. Tell the trader exactly what you're about to do and ask. Only if they clearly say yes, call again with confirmed: true.",
      };
    }
    const { confirmed: _c, ...clean } = args;
    const tool = (deps.registry.list() as { name: string; execute: (a: Record<string, unknown>) => Promise<unknown> }[]).find((t) => t.name === name);
    if (!tool) return { error: `${name} isn't set up on this bot.` };
    const out = await tool.execute(clean);
    const text = typeof out === "string" ? out : JSON.stringify(out);
    return text.length > MAX_RESULT_CHARS ? { result: text.slice(0, MAX_RESULT_CHARS), truncated: true } : { result: out as unknown };
  } catch (err) {
    return { error: (err instanceof Error ? err.message : String(err)).slice(0, 500) };
  }
}
