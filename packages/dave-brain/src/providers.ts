import { createHash, createHmac } from "node:crypto";

/**
 * Real bug fixed (user, explicit: "there should be no limitations for token"). A hardcoded
 * default (512, later 4096) was silently capping every real request that didn't explicitly pass
 * `maxTokens` -- which is EVERY real production call, since dave-agent-loop never sets it. Per
 * the user's explicit instruction, no default is imposed here at all anymore: `max_tokens` is
 * only ever included in a request when the caller genuinely passes one. Omitted, every provider's
 * own real API default applies -- which for essentially every current real provider/model is
 * that model's own real maximum output length, not an arbitrary number this codebase invents.
 */

/**
 * Step 20.1: images are handed to the model as a real content block --
 * the raw base64 bytes go straight into the request, never routed
 * through a separate OCR/description step first. Real Anthropic
 * Messages API shape, confirmed against the current docs (media_type/
 * data field names, base64 source type).
 */
export interface ImageContentBlock {
  type: "image";
  source: { type: "base64"; media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string };
}

export interface TextContentBlock {
  type: "text";
  text: string;
}

export type ContentBlock = ImageContentBlock | TextContentBlock;

/**
 * Update 9: real, provider-agnostic tool-calling support -- this is
 * the wire-shape both ClaudeProvider (native `tools`/`tool_use`) and
 * OpenAICompatibleProvider (native `tools`/`tool_calls`) translate
 * to/from their own real API shapes, so an agent loop built on top of
 * `Provider` never has to know which provider it's talking to.
 */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface CompletionMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentBlock[];
  /** Only meaningful on an "assistant" message that requested tool calls. */
  toolCalls?: ToolCall[];
  /** Only meaningful on a "tool" message -- which real tool call this is the result of. */
  toolCallId?: string;
}

export interface CompletionRequest {
  messages: CompletionMessage[];
  maxTokens?: number;
  tools?: ToolSpec[];
  /** Real gap fixed (user, live: doubted the trading-decision tool was "implemented well" --
   *  it wasn't, fully, without this): with `tools` alone, nothing stops a model from just
   *  answering in plain text instead of calling the one tool it was offered. For a caller with
   *  exactly one tool that MUST be called every time (autonomous-tick.ts's single trading
   *  decision), this forces that specific tool rather than leaving it optional. Every provider
   *  that supports real tool calling translates this to its own forced-tool-choice shape;
   *  ignored (silently, same as an unsupported provider seeing `tools` alone) by a provider that
   *  doesn't support it at all. */
  toolChoice?: { name: string };
}

export interface CompletionResult {
  text: string;
  provider: ProviderName;
  latencyMs: number;
  toolCalls?: ToolCall[];
  /** Real prompt-caching usage, when the provider's own API reports it (Claude, DeepSeek, and any OpenAI-compatible provider that mirrors OpenAI's cached_tokens field -- confirmed: Fireworks) -- cacheReadInputTokens>0 is a real, provable cache hit. Undefined, not zero, on a provider that doesn't report it at all. */
  cacheUsage?: { cacheCreationInputTokens: number; cacheReadInputTokens: number };
  /**
   * User-requested addition ("show a small follow-up message/edit indicating token usage for
   * that exchange"): the real per-call token usage every provider's own API already reports
   * (OpenAI-shaped `usage.prompt_tokens/completion_tokens/total_tokens`, Anthropic's own
   * `usage.input_tokens/output_tokens`) -- not an estimate. Undefined on a provider response that
   * genuinely didn't include a usage block, never fabricated.
   */
  tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

/**
 * Update 3: the full provider list, restored. "lepton" is a real alias
 * (see provider-catalog.ts) -- it resolves to the nvidia-nim entry
 * rather than shipping a second, dead implementation.
 */
export type ProviderName =
  | "deepseek"
  | "claude"
  | "openai"
  | "gemini"
  | "groq"
  | "mistral"
  | "cohere"
  | "together"
  | "cerebras"
  | "nvidia-nim"
  | "fireworks"
  | "hyperbolic"
  | "deepinfra"
  | "perplexity"
  | "qwen"
  | "sambanova"
  | "novita"
  | "ai21"
  | "lepton"
  | "cloudflare"
  | "replicate"
  | "xai"
  | "openrouter"
  | "huggingface"
  | "orcarouter"
  | "bedrock"
  | "zai"
  | "azure"
  | "moonshot"
  | "minimax"
  | "baseten"
  | "nebius"
  | "tokenharbor"
  | "kiraai"
  | "xpiki"
  | "friendli"
  | "siliconflow"
  | "upstage"
  | "venice"
  | "scaleway"
  | "lambda"
  | "nscale"
  | "parasail"
  | "poe"
  | "custom";

function containsImage(messages: CompletionMessage[]): boolean {
  return messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "image"));
}

export class ProviderError extends Error {
  constructor(
    public readonly provider: ProviderName,
    message: string,
    public readonly cause?: unknown,
    /**
     * Real gap fixed (cross-referenced against a sibling investigation into "gets rate limited
     * quickly"): a real HTTP 429 response's `Retry-After` header (seconds, or an HTTP-date --
     * both real, documented forms) was being read nowhere in this codebase -- confirmed via a
     * full-repo search for "retry-after"/"retryAfter", zero matches outside this fix. Every 429
     * was treated identically to a generic failure: the key was marked unhealthy and the NEXT
     * key/provider was tried immediately, with nothing recording how long the provider itself
     * said to wait before trying THIS key again. That real signal is captured here (undefined
     * when the provider didn't send one, or on a non-429 error) so provider-keys.ts can honor it
     * instead of re-trying an already-known-rate-limited key on the very next message.
     */
    public readonly retryAfterMs?: number
  ) {
    super(`[${provider}] ${message}`);
    this.name = "ProviderError";
  }
}

/** Real, standard parse of a real HTTP `Retry-After` header -- either form providers actually
 *  send: a plain integer number of seconds, or an HTTP-date. Returns undefined for a missing or
 *  unparseable header rather than guessing. */
function parseRetryAfterMs(res: Response): number | undefined {
  const header = res.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

/** Shared by every provider class below: builds a real `ProviderError` from a non-ok response,
 *  carrying the real `Retry-After` value (undefined when absent) so callers can honor it. */
async function providerErrorFromResponse(provider: ProviderName, res: Response): Promise<ProviderError> {
  const retryAfterMs = res.status === 429 ? parseRetryAfterMs(res) : undefined;
  return new ProviderError(provider, `HTTP ${res.status}: ${await res.text()}`, undefined, retryAfterMs);
}

/**
 * Step 20.1: only Claude's real configured model here has vision
 * support -- DeepSeek's configured `deepseek-chat` model is a real,
 * current, text-only endpoint (confirmed via research: DeepSeek's only
 * vision chat model is `deepseek-v4-flash-vision-exp`, an experimental
 * model NOT what's wired up here). Rather than silently sending an
 * image content block to a text-only endpoint and getting a confusing
 * provider-side error, this is checked and refused up front, honestly.
 */
export class ImageNotSupportedError extends ProviderError {
  constructor(provider: ProviderName) {
    super(provider, `this provider's configured model has no real vision support -- cannot send image content to it`);
  }
}

export interface Provider {
  readonly name: ProviderName;
  generate(req: CompletionRequest, timeoutMs: number, signal?: AbortSignal): Promise<CompletionResult>;
}

/**
 * Real bug fixed (user, live: a stuck turn kept "thinking"/burning credit forever -- changing the
 * timeout setting, `/stop`, and `/reset` all did nothing). The per-call timeout here was always
 * real, but there was no way for anything OUTSIDE this one call to cancel it early. `signal` is
 * the real, external cancel path (wired from AgentLoop.run() -> turn-abort.ts, triggered by
 * `/stop`/`/panic`/`/reset`): the request is genuinely aborted -- and stops billing/generating --
 * the instant either the caller's own signal fires OR the per-call timeout elapses, whichever
 * comes first.
 */
export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onExternalAbort);
  }
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * Update 9: real OpenAI-shape tool-calling translation, shared by every real OpenAI-shaped
 * provider (OpenAICompatibleProvider AND DeepSeekProvider -- real bug fixed: DeepSeekProvider was
 * a "Step 5.2 existing custom implementation" that predates Update 9's tool-calling work and was
 * never retrofitted, so it silently never sent `tools` at all and never translated tool_calls/
 * tool-role messages, making DeepSeek unable to call any real tool no matter what the model
 * requested). A "tool" message maps to OpenAI's real `{role:"tool", tool_call_id, content}` shape;
 * an assistant message with `toolCalls` becomes a real `tool_calls: [{id, type:"function",
 * function:{name, arguments}}]` array (arguments is a JSON STRING on the wire, per OpenAI's real,
 * confirmed shape -- not an object).
 */
function toOpenAIToolCallMessages(messages: CompletionMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: typeof m.content === "string" && m.content.length > 0 ? m.content : null,
        tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

function toOpenAIToolSpecs(tools: CompletionRequest["tools"]): unknown[] | undefined {
  return tools?.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

/** Real, standard OpenAI-shaped forced tool choice -- shared by every OpenAI-compatible wire
 *  format in this file (OpenAICompatibleProvider, DeepSeek, Cohere all use this exact shape).
 *
 *  Real bug fixed (the trader, live: nscale returned HTTP 400 INVALID_TOOL_CHOICE -- "Supported
 *  tool_choice values are \"auto\" and \"none\" currently" -- which crashed every autonomous trading
 *  cycle, since the tick forces tool_choice to the named decision tool). Not every OpenAI-compatible
 *  server implements the named-function form; `style: "auto-only"` degrades a forced choice to the
 *  plain string "auto" for those, which they DO accept. Safe for the two real forced call sites:
 *  both send exactly ONE tool, and both already fall back to parsing the model's text when no
 *  structured tool call comes back (autonomous-tick's parseDecisionFromText, sequential-thinking's
 *  own guard) -- so "auto" degrades reasoning quality slightly at worst, instead of failing hard. */
function toOpenAIToolChoice(toolChoice: CompletionRequest["toolChoice"], style: ToolChoiceStyle = "named"): unknown | undefined {
  if (!toolChoice) return undefined;
  return style === "auto-only" ? "auto" : { type: "function", function: { name: toolChoice.name } };
}

export type ToolChoiceStyle = "named" | "auto-only";

/** Does this 400 body look like the server rejecting the NAMED tool_choice shape specifically?
 *  Used for a real one-shot retry so a provider we haven't catalogued yet self-heals instead of
 *  failing the whole run (nscale's own body is the reference case: an INVALID_TOOL_CHOICE code with
 *  a "tool_choice" param). Deliberately narrow -- it must not swallow unrelated 400s. */
function looksLikeToolChoiceRejection(body: string): boolean {
  return /tool_choice/i.test(body) && /invalid|unsupported|not supported|supported .*values/i.test(body);
}

/**
 * Real bug fixed (user, with real pasted proof: raw
 * `<|toolcallssectionbegin|><|toolcallbegin|>call06f079ade1a8495e8511f748<|toolcallargumentbegin|>{}<|toolcallend|><|toolcallssectionend|>`
 * leaked straight into a live Telegram message). Some open-weight models served through a generic
 * OpenAI-compatible `/chat/completions` endpoint (this class's own 9-provider expansion, commit
 * 98cd706, added several -- Moonshot/Kimi, Baseten and Fireworks all serve Kimi-K2-family models,
 * which use this exact templated tool-call marker family) emit tool calls as inline TEXT tokens in
 * `message.content` instead of populating the structured `message.tool_calls` field, for a real
 * chat-template mismatch or a real model misfire. Before this fix, `message.content` was returned
 * to the user completely verbatim -- there was no code anywhere in this repo that looked for this
 * pattern, structured field or not.
 *
 * The real, documented Kimi-K2 tool-call template (and the minor `toolcalls...` variant confirmed
 * live in the trader's paste, which drops the underscores the documented template uses) is:
 *   <|tool_calls_section_begin|>
 *     <|tool_call_begin|> functions.NAME:INDEX <|tool_call_argument_begin|> {...json...} <|tool_call_end|>
 *     ... (repeatable)
 *   <|tool_calls_section_end|>
 * Matched with underscores optional so both the documented shape and the trader's real underscore-
 * less variant (and any other close cousin from another provider using the same family of chat
 * template) are caught by the same regex, not just this one exact string.
 *
 * Real, honest limits of what gets parsed into an actual ToolCall (option (a) from the fix): a
 * segment is only turned into a real, executable ToolCall when BOTH a real function name (the
 * `functions.NAME:INDEX` shape) and real, valid JSON arguments are present -- exactly the trader's
 * own real paste has NEITHER (the header is a bare opaque id, `call06f079...`, with no `functions.`
 * name at all, so which real tool was meant is genuinely unrecoverable here). For that case (and
 * any other segment the model emitted with a name/arguments shape too malformed to trust), this
 * falls back to (b): the raw tokens are stripped from the user-visible text and, if nothing else
 * from the model survives, replaced with one honest, non-technical sentence -- never raw tokens,
 * and never a silently dropped tool call pretending nothing happened.
 */
const TOOL_CALL_MARKER_RE = /<\|tool_?calls?_?section_?begin\|>([\s\S]*?)<\|tool_?calls?_?section_?end\|>/gi;
const TOOL_CALL_SEGMENT_RE = /<\|tool_?call_?begin\|>([\s\S]*?)<\|tool_?call_?argument_?begin\|>([\s\S]*?)<\|tool_?call_?end\|>/gi;
const TOOL_CALL_NAME_RE = /functions\.([a-zA-Z0-9_-]+)(?::\d+)?/;

export function stripInlineToolCallMarkers(content: string): { text: string; toolCalls?: ToolCall[] } {
  if (!content.includes("tool_call") && !content.includes("toolcall")) return { text: content };
  const parsedCalls: ToolCall[] = [];
  let sawMalformedSegment = false;
  const text = content
    .replace(TOOL_CALL_MARKER_RE, (_full, sectionBody: string) => {
      let matchedAny = false;
      // Reset lastIndex -- TOOL_CALL_SEGMENT_RE is a shared module-level /g regex.
      TOOL_CALL_SEGMENT_RE.lastIndex = 0;
      let segMatch: RegExpExecArray | null;
      while ((segMatch = TOOL_CALL_SEGMENT_RE.exec(sectionBody)) !== null) {
        matchedAny = true;
        const [, header, rawArgs] = segMatch;
        const nameMatch = TOOL_CALL_NAME_RE.exec(header.trim());
        let parsedArgs: Record<string, unknown> | undefined;
        try {
          const val = JSON.parse(rawArgs.trim() || "{}");
          if (val && typeof val === "object" && !Array.isArray(val)) parsedArgs = val as Record<string, unknown>;
        } catch {
          // malformed JSON -- fall through to the malformed-segment path below
        }
        if (nameMatch && parsedArgs !== undefined) {
          parsedCalls.push({ id: header.trim() || `inline-${parsedCalls.length}`, name: nameMatch[1], arguments: parsedArgs });
        } else {
          // No recoverable function name (e.g. the trader's real paste -- a bare opaque id with no
          // `functions.NAME` at all) and/or unparseable arguments: genuinely can't be turned into a
          // real, executable tool call, so it's dropped rather than guessed at.
          sawMalformedSegment = true;
        }
      }
      // Even a section with no segments matching the inner shape (or empty) must still never
      // leak its own raw markers -- if it wasn't parsed, it's at minimum removed.
      if (!matchedAny) sawMalformedSegment = true;
      return "";
    })
    .trim();
  if (parsedCalls.length === 0 && !sawMalformedSegment) return { text: content };
  const finalText = text.length > 0 ? text : sawMalformedSegment && parsedCalls.length === 0 ? "The model attempted a malformed tool call." : text;
  return { text: finalText, toolCalls: parsedCalls.length > 0 ? parsedCalls : undefined };
}

/**
 * Step 5.2: DeepSeek AI as a configured, switchable fallback provider.
 *
 * Real bug fixed (user, live-diagnosed with real pasted keys against the real production tool
 * payload): this class predated Update 9's tool-calling work and was never retrofitted -- it sent
 * `req.messages` raw (never translating a real assistant `toolCalls` array or a real "tool" role
 * message into DeepSeek's actual OpenAI-shaped wire format) and never sent `tools` AT ALL, no
 * matter what the caller passed. Confirmed live: the real outgoing request body had
 * `hasTools: false` unconditionally. DeepSeek is genuinely OpenAI-compatible in shape (real
 * `/chat/completions`, real bearer auth, real `tool_calls` in its responses) -- it was simply
 * never wired up to use that shape for tools, making it structurally unable to call ANY real tool
 * regardless of what the model wanted to do. Also hardcoded `model: "deepseek-chat"`, silently
 * ignoring whatever model the user's stored key config actually specified.
 */
export class DeepSeekProvider implements Provider {
  readonly name = "deepseek" as const;

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://api.deepseek.com",
    private readonly model = "deepseek-chat"
  ) {}

  async generate(req: CompletionRequest, timeoutMs: number, signal?: AbortSignal): Promise<CompletionResult> {
    if (containsImage(req.messages)) throw new ImageNotSupportedError("deepseek");
    const start = Date.now();
    const tools = toOpenAIToolSpecs(req.tools);
    const tool_choice = toOpenAIToolChoice(req.toolChoice);
    let res: Response;
    try {
      res = await fetchWithTimeout(
        `${this.baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({ model: this.model, messages: toOpenAIToolCallMessages(req.messages), max_tokens: req.maxTokens, tools, tool_choice }),
        },
        timeoutMs,
        signal
      );
    } catch (err) {
      throw new ProviderError("deepseek", `request failed/timed out after ${timeoutMs}ms`, err);
    }
    if (!res.ok) {
      throw await providerErrorFromResponse("deepseek", res);
    }
    const json = (await res.json()) as {
      choices: { message: { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
      usage?: { prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number };
    };
    const message = json.choices[0].message;
    let toolCalls = message.tool_calls?.map((tc) => ({ id: tc.id, name: tc.function.name, arguments: JSON.parse(tc.function.arguments || "{}") }));
    // Same real gap as OpenAICompatibleProvider (see stripInlineToolCallMarkers) -- DeepSeek's
    // wire shape is the same generic OpenAI `/chat/completions` shape, so a model behind it can
    // emit the same raw inline tool-call tokens instead of populating `tool_calls`.
    let text = message.content ?? "";
    if ((!toolCalls || toolCalls.length === 0) && text) {
      const stripped = stripInlineToolCallMarkers(text);
      text = stripped.text;
      if (stripped.toolCalls) toolCalls = stripped.toolCalls;
    }
    // Real DeepSeek "context caching" -- automatic, no cache_control needed on
    // this API; a real cache hit shows up as a nonzero prompt_cache_hit_tokens
    // in the response usage. DeepSeek doesn't separately report a "creation"
    // count the way Anthropic does (caching there is automatic/implicit), so
    // that field is honestly 0 rather than guessed.
    const cacheUsage = json.usage ? { cacheCreationInputTokens: 0, cacheReadInputTokens: json.usage.prompt_cache_hit_tokens ?? 0 } : undefined;
    return { text, provider: "deepseek", latencyMs: Date.now() - start, toolCalls, cacheUsage };
  }
}

/** Step 5.2: Claude AI as a configured, switchable fallback provider. */
export class ClaudeProvider implements Provider {
  readonly name = "claude" as const;

  constructor(
    private readonly apiKey: string,
    private readonly model = "claude-sonnet-4-6",
    private readonly baseUrl = "https://api.anthropic.com"
  ) {}

  /**
   * Update 9: real Anthropic Messages API tool-calling translation.
   * An "assistant" message carrying `toolCalls` becomes a real
   * `tool_use` content block (with the SAME id Claude originally gave
   * it -- required for Claude to match it to the tool_result that
   * follows); a "tool" message becomes a `tool_result` content block
   * on a "user" turn (Claude's real, confirmed shape -- there is no
   * separate "tool" role in the Messages API).
   */
  private toClaudeMessages(messages: CompletionMessage[]): unknown[] {
    return messages
      .filter((m) => m.role !== "system")
      .map((m) => {
        if (m.role === "tool") {
          return { role: "user", content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }] };
        }
        if (m.role === "assistant" && m.toolCalls?.length) {
          const blocks: unknown[] = [];
          if (typeof m.content === "string" && m.content.length > 0) blocks.push({ type: "text", text: m.content });
          for (const call of m.toolCalls) blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments });
          return { role: "assistant", content: blocks };
        }
        return { role: m.role, content: m.content };
      });
  }

  async generate(req: CompletionRequest, timeoutMs: number, signal?: AbortSignal): Promise<CompletionResult> {
    const start = Date.now();
    const systemMessage = req.messages.find((m) => m.role === "system");
    if (systemMessage && typeof systemMessage.content !== "string") {
      throw new ProviderError("claude", "a system message must be plain text -- images belong on a user message, not the system prompt");
    }
    // Real Anthropic prompt caching: a `cache_control: {type:"ephemeral"}` block
    // marks everything UP TO that point as cacheable -- the system prompt (per
    // Step 1.7's "static-first" ordering, MEMORY.md/USER.md/IDENTITY.md rarely
    // change turn to turn) and the tool list (which also stays fixed across a
    // whole conversation) are exactly the real, confirmed candidates for this.
    // Genuinely cuts cost/latency on a cache hit -- not decorative.
    const system = systemMessage?.content
      ? [{ type: "text", text: systemMessage.content as string, cache_control: { type: "ephemeral" } }]
      : undefined;
    const messages = this.toClaudeMessages(req.messages);
    const tools = req.tools?.map((t, i, arr) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
      ...(i === arr.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
    }));
    const tool_choice = req.toolChoice ? { type: "tool", name: req.toolChoice.name } : undefined;
    let res: Response;
    try {
      res = await fetchWithTimeout(
        `${this.baseUrl}/v1/messages`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": this.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: this.model,
            max_tokens: req.maxTokens,
            system,
            messages,
            tools,
            tool_choice,
          }),
        },
        timeoutMs,
        signal
      );
    } catch (err) {
      throw new ProviderError("claude", `request failed/timed out after ${timeoutMs}ms`, err);
    }
    if (!res.ok) {
      throw await providerErrorFromResponse("claude", res);
    }
    const json = (await res.json()) as {
      content: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[];
      usage?: { cache_creation_input_tokens?: number; cache_read_input_tokens?: number; input_tokens?: number; output_tokens?: number };
    };
    const text = json.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    const toolCalls = json.content
      .filter((b) => b.type === "tool_use")
      .map((b) => ({ id: b.id!, name: b.name!, arguments: b.input ?? {} }));
    const cacheUsage = json.usage
      ? { cacheCreationInputTokens: json.usage.cache_creation_input_tokens ?? 0, cacheReadInputTokens: json.usage.cache_read_input_tokens ?? 0 }
      : undefined;
    const tokenUsage =
      json.usage?.input_tokens !== undefined && json.usage?.output_tokens !== undefined
        ? { promptTokens: json.usage.input_tokens, completionTokens: json.usage.output_tokens, totalTokens: json.usage.input_tokens + json.usage.output_tokens }
        : undefined;
    return { text, provider: "claude", latencyMs: Date.now() - start, toolCalls: toolCalls.length > 0 ? toolCalls : undefined, cacheUsage, tokenUsage };
  }
}

/**
 * Update 3: one generic class for every provider confirmed (by research)
 * to share OpenAI's `/chat/completions` request/response shape with a
 * plain `Authorization: Bearer <key>` header -- OpenAI, Groq, Mistral,
 * Together, Cerebras, Nvidia NIM (+ Lepton alias), Fireworks, Hyperbolic,
 * DeepInfra, Perplexity, Qwen, SambaNova, Novita, AI21 (chat endpoint
 * only), xAI, OpenRouter, HuggingFace (router), OrcaRouter, Gemini
 * (its real OpenAI-compat endpoint), Cloudflare (its real OpenAI-compat
 * shim, base URL parametrized with account_id). Real, not guessed --
 * every base URL/auth combination here traces to a specific research
 * confirmation in provider-catalog.ts.
 */
export class OpenAICompatibleProvider implements Provider {
  constructor(
    readonly name: ProviderName,
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
    private readonly chatPath = "/chat/completions",
    /** Real fix: authStyle was purely decorative catalog metadata -- every provider through this
     * class always sent `Authorization: Bearer`, regardless of what the catalog declared. Azure
     * OpenAI genuinely needs a different mechanism (a real `api-key` header, confirmed against
     * Microsoft's own docs -- Bearer is not accepted there), so this is now a real, honored switch,
     * not just documentation. Every existing provider keeps its current (correct) Bearer behavior
     * by default. */
    private readonly authHeaderStyle: "bearer" | "api-key-header" = "bearer",
    /** See toOpenAIToolChoice: some OpenAI-compatible servers only accept the string forms of
     *  tool_choice. Catalog-driven, defaulting to the full OpenAI shape. */
    private readonly toolChoiceStyle: ToolChoiceStyle = "named"
  ) {}

  async generate(req: CompletionRequest, timeoutMs: number, signal?: AbortSignal): Promise<CompletionResult> {
    const start = Date.now();
    const tools = toOpenAIToolSpecs(req.tools);
    const headers: Record<string, string> =
      this.authHeaderStyle === "api-key-header"
        ? { "content-type": "application/json", "api-key": this.apiKey }
        : { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` };
    const post = async (tool_choice: unknown | undefined): Promise<Response> => {
      try {
        return await fetchWithTimeout(
          `${this.baseUrl}${this.chatPath}`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({ model: this.model, messages: toOpenAIToolCallMessages(req.messages), max_tokens: req.maxTokens, tools, tool_choice }),
          },
          timeoutMs,
          signal
        );
      } catch (err) {
        throw new ProviderError(this.name, `request failed/timed out after ${timeoutMs}ms`, err);
      }
    };

    let sentToolChoice = toOpenAIToolChoice(req.toolChoice, this.toolChoiceStyle);
    let res = await post(sentToolChoice);
    if (!res.ok) {
      // The body can only be read once, so read it here and decide from it -- either a real
      // one-shot retry with the degraded tool_choice, or the same error we always raised.
      const body = await res.text();
      const sentNamedChoice = sentToolChoice !== undefined && typeof sentToolChoice !== "string";
      if (res.status === 400 && sentNamedChoice && looksLikeToolChoiceRejection(body)) {
        // This provider genuinely doesn't implement the named form. Retry once with "auto" so the
        // run survives (and is worth cataloguing as auto-only, as nscale now is).
        sentToolChoice = "auto";
        res = await post(sentToolChoice);
        if (!res.ok) throw new ProviderError(this.name, `HTTP ${res.status}: ${await res.text()}`, undefined, res.status === 429 ? parseRetryAfterMs(res) : undefined);
      } else {
        throw new ProviderError(this.name, `HTTP ${res.status}: ${body}`, undefined, res.status === 429 ? parseRetryAfterMs(res) : undefined);
      }
    }
    const json = (await res.json()) as {
      choices: {
        message: {
          content: string | null;
          /** Reasoning models served through this same OpenAI-compatible shape put their chain of
           *  thought here (DeepSeek-R1 and its distills: `reasoning_content`; GPT-OSS and several
           *  routers: `reasoning`) -- see the fallback below. */
          reasoning_content?: string | null;
          reasoning?: string | null;
          tool_calls?: { id: string; function: { name: string; arguments: string } }[];
        };
      }[];
      usage?: { prompt_tokens_details?: { cached_tokens?: number }; prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const message = json.choices[0].message;
    let toolCalls = message.tool_calls?.map((tc) => ({ id: tc.id, name: tc.function.name, arguments: JSON.parse(tc.function.arguments || "{}") }));
    // Real bug fixed: some models served through this generic OpenAI-compatible shape (Kimi-K2
    // family among them -- see stripInlineToolCallMarkers's own comment) never populate the
    // structured `tool_calls` field above at all -- they emit the tool call as raw text tokens
    // inline in `content` instead. Only consulted when the structured field came back genuinely
    // empty, so a provider that's doing this correctly is never touched.
    let text = message.content ?? "";
    // Real bug fixed (the trader, live: "nscale provider it just says ✅ Done."). "✅ Done." is
    // telegram-bot-server's fallback for an EMPTY final text -- and this class only ever read
    // `content`. A reasoning model (nscale's own default is DeepSeek-R1-Distill-Qwen-32B) routinely
    // returns its answer in `reasoning_content`/`reasoning` with `content` empty or null, so every
    // such reply was silently thrown away and replaced by "✅ Done.". Strictly a fallback: a
    // provider that fills `content` properly is never touched. Deliberately ahead of the marker
    // strip below, so a reasoning-only reply carrying inline tool-call tokens is cleaned up exactly
    // the way a `content` reply would be.
    if (!text.trim()) {
      const reasoning = (message.reasoning_content ?? message.reasoning ?? "").trim();
      if (reasoning) text = reasoning;
    }
    if ((!toolCalls || toolCalls.length === 0) && text) {
      const stripped = stripInlineToolCallMarkers(text);
      text = stripped.text;
      if (stripped.toolCalls) toolCalls = stripped.toolCalls;
    }
    // Real, provider-agnostic prompt-caching read: OpenAI's own automatic
    // caching (no cache_control needed -- kicks in for long enough shared
    // prefixes) reports a real cached-token count at
    // usage.prompt_tokens_details.cached_tokens; several of this class's
    // real OpenAI-compatible providers (confirmed: Fireworks) mirror that
    // same field. Left undefined -- not zero-filled -- for any provider
    // that simply doesn't send it, so this never fabricates a cache signal.
    const cachedTokens = json.usage?.prompt_tokens_details?.cached_tokens;
    const cacheUsage = cachedTokens !== undefined ? { cacheCreationInputTokens: 0, cacheReadInputTokens: cachedTokens } : undefined;
    // Real, standard OpenAI-shaped usage block -- every provider through this shared class
    // reports it (it's the same field name across virtually every OpenAI-compatible API).
    // Undefined, not zero-filled, when a provider genuinely omits it.
    const tokenUsage =
      json.usage?.prompt_tokens !== undefined && json.usage?.completion_tokens !== undefined
        ? { promptTokens: json.usage.prompt_tokens, completionTokens: json.usage.completion_tokens, totalTokens: json.usage.total_tokens ?? json.usage.prompt_tokens + json.usage.completion_tokens }
        : undefined;
    return { text, provider: this.name, latencyMs: Date.now() - start, toolCalls, cacheUsage, tokenUsage };
  }
}

/** Update 3: Cohere's real v2 `/chat` shape -- confirmed NOT OpenAI-compatible. */
export class CohereProvider implements Provider {
  readonly name = "cohere" as const;

  constructor(
    private readonly apiKey: string,
    private readonly model = "command-a",
    private readonly baseUrl = "https://api.cohere.com/v2"
  ) {}

  async generate(req: CompletionRequest, timeoutMs: number, signal?: AbortSignal): Promise<CompletionResult> {
    if (containsImage(req.messages)) throw new ImageNotSupportedError("cohere");
    const start = Date.now();
    // Real bug fixed (provider audit, same class of bug as the DeepSeek one -- user: "I can use
    // any provider, nothing works"): `tools` was never sent, and `req.messages` was passed
    // through raw -- a real assistant `toolCalls` array and real "tool" role messages were never
    // translated into anything Cohere's real API could understand. Confirmed via research
    // (Cohere's own v2 /chat docs): the real tool-calling wire shape is IDENTICAL to OpenAI's
    // (`type:"function"`, a `tool_calls` array with `{id, type, function:{name, arguments}}`, and
    // a real `role:"tool"` message with `tool_call_id`) -- the same shared helpers
    // OpenAICompatibleProvider/DeepSeekProvider use apply here too, not a bespoke translation.
    const tools = toOpenAIToolSpecs(req.tools);
    const tool_choice = toOpenAIToolChoice(req.toolChoice);
    let res: Response;
    try {
      res = await fetchWithTimeout(
        `${this.baseUrl}/chat`,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({ model: this.model, messages: toOpenAIToolCallMessages(req.messages), max_tokens: req.maxTokens, tools, tool_choice }),
        },
        timeoutMs,
        signal
      );
    } catch (err) {
      throw new ProviderError("cohere", `request failed/timed out after ${timeoutMs}ms`, err);
    }
    if (!res.ok) {
      throw await providerErrorFromResponse("cohere", res);
    }
    const json = (await res.json()) as {
      message: { content: { text: string }[]; tool_calls?: { id: string; function: { name: string; arguments: string } }[] };
    };
    const text = json.message.content?.[0]?.text ?? "";
    const toolCalls = json.message.tool_calls?.map((tc) => ({ id: tc.id, name: tc.function.name, arguments: JSON.parse(tc.function.arguments || "{}") }));
    return { text, provider: "cohere", latencyMs: Date.now() - start, toolCalls };
  }
}

/**
 * Update 3: Replicate is genuinely async -- confirmed via research.
 * POST /predictions returns immediately with status "starting"; this
 * really polls GET /predictions/{id} until a terminal status, rather
 * than pretending it's a synchronous call.
 */
export class ReplicateProvider implements Provider {
  readonly name = "replicate" as const;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl = "https://api.replicate.com/v1",
    private readonly pollIntervalMs = 1000
  ) {}

  async generate(req: CompletionRequest, timeoutMs: number, signal?: AbortSignal): Promise<CompletionResult> {
    if (containsImage(req.messages)) throw new ImageNotSupportedError("replicate");
    const start = Date.now();
    const prompt = req.messages.map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : ""}`).join("\n");

    let createRes: Response;
    try {
      createRes = await fetchWithTimeout(
        `${this.baseUrl}/predictions`,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({ version: this.model, input: { prompt, max_tokens: req.maxTokens } }),
        },
        timeoutMs,
        signal
      );
    } catch (err) {
      throw new ProviderError("replicate", `create-prediction request failed/timed out after ${timeoutMs}ms`, err);
    }
    if (!createRes.ok) {
      throw new ProviderError("replicate", `HTTP ${createRes.status} creating prediction: ${await createRes.text()}`);
    }
    const created = (await createRes.json()) as { id: string; urls: { get: string }; status: string };

    const deadline = start + timeoutMs;
    let status = created.status;
    let output: string[] | string | undefined;
    while (status !== "succeeded" && status !== "failed" && status !== "canceled") {
      if (Date.now() >= deadline) {
        throw new ProviderError("replicate", `prediction ${created.id} did not reach a terminal status within ${timeoutMs}ms (last status: ${status})`);
      }
      // Real cancel path: a genuinely aborted turn (`/stop`/`/panic`/`/reset`) must stop polling
      // a still-running prediction instead of waiting out the rest of `timeoutMs` regardless.
      if (signal?.aborted) {
        throw new ProviderError("replicate", `prediction ${created.id} cancelled -- the turn was aborted while polling`);
      }
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
      const pollRes = await fetchWithTimeout(created.urls.get, { headers: { authorization: `Bearer ${this.apiKey}` } }, Math.max(1, deadline - Date.now()), signal);
      if (!pollRes.ok) {
        throw new ProviderError("replicate", `HTTP ${pollRes.status} polling prediction ${created.id}`);
      }
      const polled = (await pollRes.json()) as { status: string; output?: string[] | string };
      status = polled.status;
      output = polled.output;
    }
    if (status !== "succeeded") {
      throw new ProviderError("replicate", `prediction ${created.id} ended with status "${status}"`);
    }
    const text = Array.isArray(output) ? output.join("") : (output ?? "");
    return { text, provider: "replicate", latencyMs: Date.now() - start };
  }
}

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/**
 * AWS Bedrock's Converse API -- one request shape for every Bedrock model, tool calls included.
 *
 * Two ways in:
 *   - an Amazon Bedrock API key (the "long-term API key" from the Bedrock console): sent as
 *     `Authorization: Bearer <key>` -- AWS's documented path for Bedrock and Bedrock Runtime;
 *   - classic IAM access keys (access key id + secret): a real SigV4 signature.
 * `secretAccessKey` present -> SigV4; absent -> the key is a Bedrock API key.
 */
export class BedrockProvider implements Provider {
  readonly name = "bedrock" as const;

  constructor(
    private readonly apiKeyOrAccessKeyId: string,
    private readonly secretAccessKey: string | undefined,
    private readonly region: string,
    private readonly model: string,
    private readonly baseUrl = `https://bedrock-runtime.${region}.amazonaws.com`
  ) {}

  private sign(method: string, path: string, body: string, amzDate: string, dateStamp: string): Record<string, string> {
    const host = new URL(this.baseUrl).host;
    const service = "bedrock";
    const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = "content-type;host;x-amz-date";
    const payloadHash = sha256Hex(body);
    const canonicalRequest = [method, path, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");

    const credentialScope = `${dateStamp}/${this.region}/${service}/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");

    const kDate = hmac(`AWS4${this.secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, this.region);
    const kService = hmac(kRegion, service);
    const kSigning = hmac(kService, "aws4_request");
    const signature = hmac(kSigning, stringToSign).toString("hex");

    const authorization = `AWS4-HMAC-SHA256 Credential=${this.apiKeyOrAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    return { authorization, "x-amz-date": amzDate, "x-amz-content-sha256": payloadHash };
  }

  async generate(req: CompletionRequest, timeoutMs: number, signal?: AbortSignal): Promise<CompletionResult> {
    const start = Date.now();
    // SigV4 signs the path exactly as sent; the model id (which may contain ':' in a version
    // suffix) is percent-encoded once, which is what Bedrock expects for both auth styles.
    const path = `/model/${encodeURIComponent(this.model)}/converse`;
    const body = JSON.stringify(buildConverseBody(req, this.model));
    let authHeaders: Record<string, string>;
    if (this.secretAccessKey) {
      const now = new Date();
      const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
      authHeaders = this.sign("POST", path, body, amzDate, amzDate.slice(0, 8));
    } else {
      authHeaders = { authorization: `Bearer ${this.apiKeyOrAccessKeyId}` };
    }
    const signedHeaders = authHeaders;

    let res: Response;
    try {
      res = await fetchWithTimeout(
        `${this.baseUrl}${path}`,
        { method: "POST", headers: { "content-type": "application/json", ...signedHeaders }, body },
        timeoutMs,
        signal
      );
    } catch (err) {
      throw new ProviderError("bedrock", `request failed/timed out after ${timeoutMs}ms`, err);
    }
    if (!res.ok) {
      throw await providerErrorFromResponse("bedrock", res);
    }
    const json = (await res.json()) as {
      output: { message: { content: { text?: string; toolUse?: { toolUseId: string; name: string; input: Record<string, unknown> } }[] } };
      usage?: { cacheReadInputTokens?: number; cacheWriteInputTokens?: number; inputTokens?: number; outputTokens?: number; totalTokens?: number };
    };
    const blocks = json.output?.message?.content ?? [];
    const text = blocks.filter((b) => b.text).map((b) => b.text).join("");
    const toolCalls = blocks
      .filter((b) => b.toolUse)
      .map((b) => ({ id: b.toolUse!.toolUseId, name: b.toolUse!.name, arguments: b.toolUse!.input ?? {} }));
    const cacheUsage = json.usage && (json.usage.cacheReadInputTokens !== undefined || json.usage.cacheWriteInputTokens !== undefined)
      ? { cacheCreationInputTokens: json.usage.cacheWriteInputTokens ?? 0, cacheReadInputTokens: json.usage.cacheReadInputTokens ?? 0 }
      : undefined;
    const tokenUsage =
      json.usage?.inputTokens !== undefined && json.usage?.outputTokens !== undefined
        ? { promptTokens: json.usage.inputTokens, completionTokens: json.usage.outputTokens, totalTokens: json.usage.totalTokens ?? json.usage.inputTokens + json.usage.outputTokens }
        : undefined;
    return { text, provider: "bedrock", latencyMs: Date.now() - start, toolCalls: toolCalls.length > 0 ? toolCalls : undefined, cacheUsage, tokenUsage };
  }
}

/** Only these Bedrock model families accept Converse `cachePoint` blocks; others reject them. */
export function bedrockSupportsCaching(model: string): boolean {
  return /anthropic\.claude|amazon\.nova/i.test(model);
}

type ConverseBlock = Record<string, unknown>;

function converseContent(content: CompletionMessage["content"]): ConverseBlock[] {
  if (typeof content === "string") return content.trim() ? [{ text: content }] : [];
  const out: ConverseBlock[] = [];
  for (const b of content) {
    if (b.type === "text") {
      if (b.text.trim()) out.push({ text: b.text });
    } else if (b.type === "image") {
      // Converse takes raw bytes (base64 over JSON) and the bare format name.
      out.push({ image: { format: b.source.media_type.split("/")[1] === "jpg" ? "jpeg" : b.source.media_type.split("/")[1], source: { bytes: b.source.data } } });
    }
  }
  return out;
}

/**
 * The Converse request for a CompletionRequest. Converse is stricter than the chat APIs: turns
 * must alternate user/assistant and start with the user, a tool result is a `toolResult` block on
 * a USER turn (several results in a row share one turn), and blank text blocks are rejected.
 */
export function buildConverseBody(req: CompletionRequest, model: string): Record<string, unknown> {
  const caching = bedrockSupportsCaching(model);
  const systemText = req.messages
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : m.content.map((b) => (b.type === "text" ? b.text : "")).join("")))
    .filter((t) => t.trim())
    .join("\n\n");
  const system = systemText ? [{ text: systemText }, ...(caching ? [{ cachePoint: { type: "default" } }] : [])] : undefined;

  const turns: { role: "user" | "assistant"; content: ConverseBlock[] }[] = [];
  const push = (role: "user" | "assistant", content: ConverseBlock[]) => {
    if (!content.length) return;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content.push(...content);
    else turns.push({ role, content: [...content] });
  };
  for (const m of req.messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      const text = typeof m.content === "string" ? m.content : m.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      push("user", [{ toolResult: { toolUseId: m.toolCallId, content: [{ text: text.trim() ? text : "(empty)" }], status: "success" } }]);
    } else if (m.role === "assistant") {
      const toolUse = (m.toolCalls ?? []).map((c) => ({ toolUse: { toolUseId: c.id, name: c.name, input: c.arguments ?? {} } }));
      push("assistant", [...converseContent(m.content), ...toolUse]);
    } else {
      push("user", converseContent(m.content));
    }
  }
  if (turns[0]?.role !== "user") turns.unshift({ role: "user", content: [{ text: "(continue)" }] });
  if (caching && turns.length) turns[turns.length - 1].content.push({ cachePoint: { type: "default" } });

  const toolConfig =
    req.tools && req.tools.length > 0
      ? {
          tools: req.tools.map((t) => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.parameters } } })),
          ...(req.toolChoice ? { toolChoice: { tool: { name: req.toolChoice.name } } } : {}),
        }
      : undefined;
  return {
    ...(system ? { system } : {}),
    messages: turns,
    ...(toolConfig ? { toolConfig } : {}),
    ...(req.maxTokens ? { inferenceConfig: { maxTokens: req.maxTokens } } : {}),
  };
}
