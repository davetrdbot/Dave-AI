import type { DaveDatabase } from "@dave/db";
import { getLovableMcpSettings } from "./lovable-settings.js";
import { LovableMcpImageClient } from "./lovable-mcp-client.js";

/**
 * Update 5: real, agent-callable image-creation tool -- same
 * `ToolDefinition` shape as Step 10's TRADING_TOOLS/Step 22's
 * RFEED_TOOLS/Update 4's PROVIDER_TOOLS. Reads the user's OWN
 * configured URL/token (never a hardcoded default) fresh on every
 * call, so a rotated token takes effect immediately without a restart.
 */
export interface LovableToolContext {
  userId: string;
  db: DaveDatabase;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: LovableToolContext) => Promise<unknown>;
}

export class LovableMcpNotConfiguredError extends Error {
  constructor() {
    super("Lovable MCP is not configured -- set 'Lovable MCP URL' and 'Lovable MCP Token' in Settings first.");
    this.name = "LovableMcpNotConfiguredError";
  }
}

export const LOVABLE_TOOLS: ToolDefinition[] = [
  {
    name: "generate_image",
    description: "Generate an image from a text prompt via the user's configured Lovable MCP server. This is the ONLY Lovable MCP capability exposed to you -- text generation and voice synthesis on that same server are deliberately never reachable through this tool.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        size: { type: "string", enum: ["1024x1024", "1024x1536", "1536x1024", "auto"] },
        style: { type: "string" },
        transparentBackground: { type: "boolean" },
      },
      required: ["prompt"],
    },
    execute: async (args, ctx) => {
      const settings = getLovableMcpSettings(ctx.db, ctx.userId);
      if (!settings.url || !settings.token) throw new LovableMcpNotConfiguredError();
      const client = new LovableMcpImageClient(settings.url, settings.token);
      await client.connect();
      return client.generateImage({
        prompt: args.prompt as string,
        size: args.size as any,
        style: args.style as string | undefined,
        transparentBackground: args.transparentBackground as boolean | undefined,
      });
    },
  },
];
