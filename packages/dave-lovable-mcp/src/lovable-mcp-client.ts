import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * Update 5: "Lovable MCP -- IMAGE CREATION ONLY. Scoped to ONLY image
 * creation, no other capability exposed." Real-world confirmed (manual
 * probe against the user-supplied test server,
 * https://dexdjyqyuanuoycmeyzw.supabase.co/functions/v1/utility-mcp):
 * the server's real `tools/list` returns THREE tools --
 * `lovable_ai_agent` (text), `generate_image`, and `generate_voice`.
 * This client is a real, standard MCP client (same
 * @modelcontextprotocol/sdk + StreamableHTTPClientTransport pattern as
 * Step 11.3's McpTradeExecutor), but its public surface only ever calls
 * `generate_image` -- there is no method here that can reach
 * `lovable_ai_agent` or `generate_voice`, scoping enforced by what this
 * class can even do, not by a runtime allowlist check that could be
 * bypassed.
 */

export interface LovableImageRequest {
  prompt: string;
  size?: "1024x1024" | "1024x1536" | "1536x1024" | "auto";
  style?: string;
  transparentBackground?: boolean;
}

export interface LovableImageResult {
  url: string;
  raw: string;
}

export class LovableMcpConnectionError extends Error {
  constructor(serverUrl: string, cause: unknown) {
    super(`Could not connect to the Lovable MCP server at ${serverUrl}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "LovableMcpConnectionError";
  }
}

export class LovableMcpToolError extends Error {
  constructor(message: string) {
    super(`Lovable MCP generate_image failed: ${message}`);
    this.name = "LovableMcpToolError";
  }
}

const IMAGE_TOOL_NAME = "generate_image";

export class LovableMcpImageClient {
  private client: Client | undefined;

  constructor(
    private readonly url: string,
    private readonly token: string
  ) {}

  async connect(): Promise<void> {
    const client = new Client({ name: "dave-ai", version: "0.1.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(this.url), {
      requestInit: { headers: { authorization: `Bearer ${this.token}` } },
    });
    try {
      await client.connect(transport);
    } catch (err) {
      throw new LovableMcpConnectionError(this.url, err);
    }
    this.client = client;
  }

  private requireClient(): Client {
    if (!this.client) throw new Error("LovableMcpImageClient.connect() must succeed before generating an image.");
    return this.client;
  }

  /** The ONLY tool call this client will ever make -- image creation, nothing else. */
  async generateImage(req: LovableImageRequest): Promise<LovableImageResult> {
    const client = this.requireClient();
    const result = await client.callTool({
      name: IMAGE_TOOL_NAME,
      arguments: {
        prompt: req.prompt,
        size: req.size,
        style: req.style,
        transparent_background: req.transparentBackground,
      },
    });

    const content = Array.isArray(result.content) ? result.content : [];
    const text = content.find((c: any) => c.type === "text")?.text as string | undefined;
    if (result.isError) {
      throw new LovableMcpToolError(text ?? "unknown error");
    }
    const urlMatch = text?.match(/https?:\/\/\S+/);
    if (!urlMatch) {
      throw new LovableMcpToolError(`no image URL found in response: ${text ?? JSON.stringify(result)}`);
    }
    return { url: urlMatch[0], raw: text ?? "" };
  }
}
