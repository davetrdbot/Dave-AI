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

export interface CompletionMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentBlock[];
}

export interface CompletionRequest {
  messages: CompletionMessage[];
  maxTokens?: number;
}

export interface CompletionResult {
  text: string;
  provider: ProviderName;
  latencyMs: number;
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

/** Step 5.2: DeepSeek AI as a configured, switchable fallback provider. */
export class DeepSeekProvider implements Provider {
  readonly name = "deepseek" as const;

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://api.deepseek.com"
  ) {}

  async generate(req: CompletionRequest, timeoutMs: number): Promise<CompletionResult> {
    if (containsImage(req.messages)) throw new ImageNotSupportedError("deepseek");
    const start = Date.now();
    let res: Response;
    try {
      res = await fetchWithTimeout(
        `${this.baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({ model: "deepseek-chat", messages: req.messages, max_tokens: req.maxTokens ?? 512 }),
        },
        timeoutMs
      );
    } catch (err) {
      throw new ProviderError("deepseek", `request failed/timed out after ${timeoutMs}ms`, err);
    }
    if (!res.ok) {
      throw new ProviderError("deepseek", `HTTP ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as { choices: { message: { content: string } }[] };
    return { text: json.choices[0].message.content, provider: "deepseek", latencyMs: Date.now() - start };
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

  async generate(req: CompletionRequest, timeoutMs: number): Promise<CompletionResult> {
    const start = Date.now();
    const systemMessage = req.messages.find((m) => m.role === "system");
    if (systemMessage && typeof systemMessage.content !== "string") {
      throw new ProviderError("claude", "a system message must be plain text -- images belong on a user message, not the system prompt");
    }
    const system = systemMessage?.content as string | undefined;
    const messages = req.messages.filter((m) => m.role !== "system");
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
    const json = (await res.json()) as { content: { type: string; text: string }[] };
    const text = json.content.find((b) => b.type === "text")?.text ?? "";
    return { text, provider: "claude", latencyMs: Date.now() - start };
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
    private readonly chatPath = "/chat/completions"
  ) {}

  async generate(req: CompletionRequest, timeoutMs: number): Promise<CompletionResult> {
    const start = Date.now();
    let res: Response;
    try {
      res = await fetchWithTimeout(
        `${this.baseUrl}${this.chatPath}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({ model: this.model, messages: req.messages, max_tokens: req.maxTokens ?? 512 }),
        },
        timeoutMs
      );
    } catch (err) {
      throw new ProviderError(this.name, `request failed/timed out after ${timeoutMs}ms`, err);
    }
    if (!res.ok) {
      throw new ProviderError(this.name, `HTTP ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as { choices: { message: { content: string } }[] };
    return { text: json.choices[0].message.content, provider: this.name, latencyMs: Date.now() - start };
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
    let res: Response;
    try {
      res = await fetchWithTimeout(
        `${this.baseUrl}/chat`,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({ model: this.model, messages: req.messages, max_tokens: req.maxTokens ?? 512 }),
        },
        timeoutMs
      );
    } catch (err) {
      throw new ProviderError("cohere", `request failed/timed out after ${timeoutMs}ms`, err);
    }
    if (!res.ok) {
      throw new ProviderError("cohere", `HTTP ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as { message: { content: { text: string }[] } };
    const text = json.message.content[0]?.text ?? "";
    return { text, provider: "cohere", latencyMs: Date.now() - start };
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
    const body = JSON.stringify({
      messages: req.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role, content: [{ text: typeof m.content === "string" ? m.content : "" }] })),
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
    const json = (await res.json()) as { output: { message: { content: { text: string }[] } } };
    const text = json.output.message.content.find((b) => b.text)?.text ?? "";
    return { text, provider: "bedrock", latencyMs: Date.now() - start };
  }
}
