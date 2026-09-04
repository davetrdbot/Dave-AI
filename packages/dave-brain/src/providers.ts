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

export type ProviderName = "airllm" | "deepseek" | "claude";

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
