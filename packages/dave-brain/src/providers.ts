import { createHash, createHmac } from "node:crypto";

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
}

export interface CompletionResult {
  text: string;
  provider: ProviderName;
  latencyMs: number;
  toolCalls?: ToolCall[];
  /** Real prompt-caching usage, when the provider's own API reports it (Claude, DeepSeek, and any OpenAI-compatible provider that mirrors OpenAI's cached_tokens field -- confirmed: Fireworks) -- cacheReadInputTokens>0 is a real, provable cache hit. Undefined, not zero, on a provider that doesn't report it at all. */
  cacheUsage?: { cacheCreationInputTokens: number; cacheReadInputTokens: number };
}

/**
 * Update 3: the full provider list, restored. "lepton" is a real alias
 * (see provider-catalog.ts) -- it resolves to the nvidia-nim entry
 * rather than shipping a second, dead implementation.
 */
export type ProviderName =
  | "airllm"
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
  | "custom";

function containsImage(messages: CompletionMessage[]): boolean {
  return messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "image"));
}

export class ProviderError extends Error {
  constructor(
    public readonly provider: ProviderName,
    message: string,
    public readonly cause?: unknown
  ) {
    super(`[${provider}] ${message}`);
    this.name = "ProviderError";
  }
}

/**
 * Step 20.1: only Claude's real configured model here has vision
 * support -- AirLLM's self-hosted Qwen3-235B (via ai-brain-service) and
 * DeepSeek's configured `deepseek-chat` model are both real, current,
 * text-only endpoints (confirmed via research: DeepSeek's only vision
 * chat model is `deepseek-v4-flash-vision-exp`, an experimental model
 * NOT what's wired up here). Rather than silently sending an image
 * content block to a text-only endpoint and getting a confusing
 * provider-side error, this is checked and refused up front, honestly.
 */
export class ImageNotSupportedError extends ProviderError {
  constructor(provider: ProviderName) {
    super(provider, `this provider's configured model has no real vision support -- cannot send image content to it`);
  }
}

export interface Provider {
  readonly name: ProviderName;
  generate(req: CompletionRequest, timeoutMs: number): Promise<CompletionResult>;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
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

/**
 * Step 5.1/5.5: self-hosted AirLLM/Qwen3-235B, called over HTTP from
 * `ai-brain-service` (a separate Python process -- Step 2's rationale:
 * AirLLM is Python-only and disk-heavy, doesn't belong in the Node app).
 * `compression` defaults to '4bit' per Step 5.5.
 */
export class AirLLMProvider implements Provider {
  readonly name = "airllm" as const;

  constructor(
    private readonly baseUrl: string,
    private readonly compression: "4bit" | "8bit" | "none" = "4bit"
  ) {}

  async generate(req: CompletionRequest, timeoutMs: number): Promise<CompletionResult> {
    if (containsImage(req.messages)) throw new ImageNotSupportedError("airllm");
    const start = Date.now();
    let res: Response;
    try {
      res = await fetchWithTimeout(
        `${this.baseUrl}/generate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages: req.messages, max_tokens: req.maxTokens ?? 512, compression: this.compression }),
        },
        timeoutMs
      );
    } catch (err) {
      throw new ProviderError("airllm", `request failed/timed out after ${timeoutMs}ms`, err);
    }
    if (!res.ok) {
      throw new ProviderError("airllm", `HTTP ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as { text: string };
    return { text: json.text, provider: "airllm", latencyMs: Date.now() - start };
  }
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

  async generate(req: CompletionRequest, timeoutMs: number): Promise<CompletionResult> {
    if (containsImage(req.messages)) throw new ImageNotSupportedError("deepseek");
    const start = Date.now();
    const tools = toOpenAIToolSpecs(req.tools);
    let res: Response;
    try {
      res = await fetchWithTimeout(
        `${this.baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({ model: this.model, messages: toOpenAIToolCallMessages(req.messages), max_tokens: req.maxTokens ?? 512, tools }),
        },
        timeoutMs
      );
    } catch (err) {
      throw new ProviderError("deepseek", `request failed/timed out after ${timeoutMs}ms`, err);
    }
    if (!res.ok) {
      throw new ProviderError("deepseek", `HTTP ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as {
      choices: { message: { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
      usage?: { prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number };
    };
    const message = json.choices[0].message;
    const toolCalls = message.tool_calls?.map((tc) => ({ id: tc.id, name: tc.function.name, arguments: JSON.parse(tc.function.arguments || "{}") }));
    // Real DeepSeek "context caching" -- automatic, no cache_control needed on
    // this API; a real cache hit shows up as a nonzero prompt_cache_hit_tokens
    // in the response usage. DeepSeek doesn't separately report a "creation"
    // count the way Anthropic does (caching there is automatic/implicit), so
    // that field is honestly 0 rather than guessed.
    const cacheUsage = json.usage ? { cacheCreationInputTokens: 0, cacheReadInputTokens: json.usage.prompt_cache_hit_tokens ?? 0 } : undefined;
    return { text: message.content ?? "", provider: "deepseek", latencyMs: Date.now() - start, toolCalls, cacheUsage };
  }
}

/** Step 5.2: Claude AI as a configured, switchable fallback provider. */
export class ClaudeProvider implements Provider {
  readonly name = "claude" as const;

  constructor(
    private readonly apiKey: string,
    private readonly model = "claude-sonnet-5",
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

  async generate(req: CompletionRequest, timeoutMs: number): Promise<CompletionResult> {
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
            max_tokens: req.maxTokens ?? 512,
            system,
            messages,
            tools,
          }),
        },
        timeoutMs
      );
    } catch (err) {
      throw new ProviderError("claude", `request failed/timed out after ${timeoutMs}ms`, err);
    }
    if (!res.ok) {
      throw new ProviderError("claude", `HTTP ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as {
      content: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[];
      usage?: { cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
    };
    const text = json.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    const toolCalls = json.content
      .filter((b) => b.type === "tool_use")
      .map((b) => ({ id: b.id!, name: b.name!, arguments: b.input ?? {} }));
    const cacheUsage = json.usage
      ? { cacheCreationInputTokens: json.usage.cache_creation_input_tokens ?? 0, cacheReadInputTokens: json.usage.cache_read_input_tokens ?? 0 }
      : undefined;
    return { text, provider: "claude", latencyMs: Date.now() - start, toolCalls: toolCalls.length > 0 ? toolCalls : undefined, cacheUsage };
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
    private readonly authHeaderStyle: "bearer" | "api-key-header" = "bearer"
  ) {}

  async generate(req: CompletionRequest, timeoutMs: number): Promise<CompletionResult> {
    const start = Date.now();
    const tools = toOpenAIToolSpecs(req.tools);
    let res: Response;
    try {
      res = await fetchWithTimeout(
        `${this.baseUrl}${this.chatPath}`,
        {
          method: "POST",
          headers:
            this.authHeaderStyle === "api-key-header"
              ? { "content-type": "application/json", "api-key": this.apiKey }
              : { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({ model: this.model, messages: toOpenAIToolCallMessages(req.messages), max_tokens: req.maxTokens ?? 512, tools }),
        },
        timeoutMs
      );
    } catch (err) {
      throw new ProviderError(this.name, `request failed/timed out after ${timeoutMs}ms`, err);
    }
    if (!res.ok) {
      throw new ProviderError(this.name, `HTTP ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as {
      choices: { message: { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
      usage?: { prompt_tokens_details?: { cached_tokens?: number } };
    };
    const message = json.choices[0].message;
    const toolCalls = message.tool_calls?.map((tc) => ({ id: tc.id, name: tc.function.name, arguments: JSON.parse(tc.function.arguments || "{}") }));
    // Real, provider-agnostic prompt-caching read: OpenAI's own automatic
    // caching (no cache_control needed -- kicks in for long enough shared
    // prefixes) reports a real cached-token count at
    // usage.prompt_tokens_details.cached_tokens; several of this class's
    // real OpenAI-compatible providers (confirmed: Fireworks) mirror that
    // same field. Left undefined -- not zero-filled -- for any provider
    // that simply doesn't send it, so this never fabricates a cache signal.
    const cachedTokens = json.usage?.prompt_tokens_details?.cached_tokens;
    const cacheUsage = cachedTokens !== undefined ? { cacheCreationInputTokens: 0, cacheReadInputTokens: cachedTokens } : undefined;
    return { text: message.content ?? "", provider: this.name, latencyMs: Date.now() - start, toolCalls, cacheUsage };
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

  async generate(req: CompletionRequest, timeoutMs: number): Promise<CompletionResult> {
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
    let res: Response;
    try {
      res = await fetchWithTimeout(
        `${this.baseUrl}/chat`,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({ model: this.model, messages: toOpenAIToolCallMessages(req.messages), max_tokens: req.maxTokens ?? 512, tools }),
        },
        timeoutMs
      );
    } catch (err) {
      throw new ProviderError("cohere", `request failed/timed out after ${timeoutMs}ms`, err);
    }
    if (!res.ok) {
      throw new ProviderError("cohere", `HTTP ${res.status}: ${await res.text()}`);
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

  async generate(req: CompletionRequest, timeoutMs: number): Promise<CompletionResult> {
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
          body: JSON.stringify({ version: this.model, input: { prompt, max_tokens: req.maxTokens ?? 512 } }),
        },
        timeoutMs
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
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
      const pollRes = await fetch(created.urls.get, { headers: { authorization: `Bearer ${this.apiKey}` } });
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
 * Update 3: AWS Bedrock's Converse API. Confirmed via research: SigV4
 * request signing is mandatory here -- there is no Bearer/API-key path
 * for the native API. This computes a real SigV4 signature (canonical
 * request -> string to sign -> derived signing key -> HMAC), not a
 * placeholder header.
 */
export class BedrockProvider implements Provider {
  readonly name = "bedrock" as const;

  constructor(
    private readonly accessKeyId: string,
    private readonly secretAccessKey: string,
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

    const authorization = `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    return { authorization, "x-amz-date": amzDate, "x-amz-content-sha256": payloadHash };
  }

  async generate(req: CompletionRequest, timeoutMs: number): Promise<CompletionResult> {
    const start = Date.now();
    const path = `/model/${encodeURIComponent(this.model)}/converse`;
    // Real bug fixed (provider audit -- user: "check the providers... check if prompt caching is
    // implemented for all providers"): system messages were silently DROPPED entirely (`.filter
    // ((m) => m.role !== "system")` with nowhere else sending them) -- Bedrock never actually saw
    // Dave's system prompt at all. Real Converse API shape: system is its own top-level array of
    // content blocks, not a "system"-roled message. Also real prompt caching added here for the
    // first time: `cachePoint` blocks (AWS's real, documented Converse API mechanism, confirmed
    // working for Claude/Nova on Bedrock) on the system block and the last conversational message,
    // same "cache the stable prefix" pattern ClaudeProvider already uses directly against Anthropic.
    const systemMessages = req.messages.filter((m) => m.role === "system");
    const conversational = req.messages.filter((m) => m.role !== "system");
    const system = systemMessages.length > 0 ? [{ text: systemMessages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n\n") }, { cachePoint: { type: "default" } }] : undefined;
    // Real bug fixed (provider audit, same class of bug as the DeepSeek one -- user: "I can use
    // any provider, nothing works"): Bedrock never sent `toolConfig` at all, and every message was
    // sent with its RAW `m.role` -- for a real "tool" role message, `"tool"` is not a valid
    // Converse API role (only `user`/`assistant` are) and would genuinely be rejected by the real
    // API, and an assistant's real `toolCalls` were silently dropped entirely (only `.text` was
    // ever read). Real, confirmed Converse API shapes (AWS's own docs/samples): a tool result goes
    // on a `user` turn as a `toolResult` content block (`toolUseId`/`content`/`status`); an
    // assistant's tool call is a `toolUse` content block (`toolUseId`/`name`/`input`) on an
    // `assistant` turn; tools are declared via `toolConfig: {tools: [{toolSpec: {name,
    // description, inputSchema: {json}}}]}`.
    const messages = conversational.map((m, i) => {
      const isLast = i === conversational.length - 1;
      const cachePoint = isLast ? [{ cachePoint: { type: "default" } }] : [];
      if (m.role === "tool") {
        return { role: "user", content: [{ toolResult: { toolUseId: m.toolCallId, content: [{ text: typeof m.content === "string" ? m.content : "" }], status: "success" } }, ...cachePoint] };
      }
      if (m.role === "assistant" && m.toolCalls?.length) {
        const textBlock = typeof m.content === "string" && m.content.length > 0 ? [{ text: m.content }] : [];
        const toolUseBlocks = m.toolCalls.map((c) => ({ toolUse: { toolUseId: c.id, name: c.name, input: c.arguments } }));
        return { role: "assistant", content: [...textBlock, ...toolUseBlocks, ...cachePoint] };
      }
      return { role: m.role, content: [{ text: typeof m.content === "string" ? m.content : "" }, ...cachePoint] };
    });
    const toolConfig = req.tools && req.tools.length > 0 ? { tools: req.tools.map((t) => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.parameters } } })) } : undefined;
    const body = JSON.stringify({
      ...(system ? { system } : {}),
      messages,
      ...(toolConfig ? { toolConfig } : {}),
      inferenceConfig: { maxTokens: req.maxTokens ?? 512 },
    });
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const signedHeaders = this.sign("POST", path, body, amzDate, dateStamp);

    let res: Response;
    try {
      res = await fetchWithTimeout(
        `${this.baseUrl}${path}`,
        { method: "POST", headers: { "content-type": "application/json", ...signedHeaders }, body },
        timeoutMs
      );
    } catch (err) {
      throw new ProviderError("bedrock", `request failed/timed out after ${timeoutMs}ms`, err);
    }
    if (!res.ok) {
      throw new ProviderError("bedrock", `HTTP ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as {
      output: { message: { content: { text?: string; toolUse?: { toolUseId: string; name: string; input: Record<string, unknown> } }[] } };
      usage?: { cacheReadInputTokens?: number; cacheWriteInputTokens?: number };
    };
    const blocks = json.output.message.content;
    const text = blocks.filter((b) => b.text).map((b) => b.text).join("");
    const toolCalls = blocks
      .filter((b) => b.toolUse)
      .map((b) => ({ id: b.toolUse!.toolUseId, name: b.toolUse!.name, arguments: b.toolUse!.input ?? {} }));
    const cacheUsage = json.usage && (json.usage.cacheReadInputTokens !== undefined || json.usage.cacheWriteInputTokens !== undefined)
      ? { cacheCreationInputTokens: json.usage.cacheWriteInputTokens ?? 0, cacheReadInputTokens: json.usage.cacheReadInputTokens ?? 0 }
      : undefined;
    return { text, provider: "bedrock", latencyMs: Date.now() - start, toolCalls: toolCalls.length > 0 ? toolCalls : undefined, cacheUsage };
  }
}
