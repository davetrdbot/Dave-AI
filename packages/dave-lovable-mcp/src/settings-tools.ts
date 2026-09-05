import type { DaveDatabase } from "@dave/db";
import { getLovableMcpSettings, setLovableMcpSettings } from "./lovable-settings.js";

/**
 * Update 17 (settings audit): the Lovable MCP URL/token had a real
 * admin API route (Update 5) but no agent-callable tool -- a user
 * could set it via the admin panel but Dave itself couldn't read or
 * rotate it conversationally.
 */
export interface LovableSettingsToolContext {
  userId: string;
  db: DaveDatabase;
}

export interface LovableSettingsToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: LovableSettingsToolContext) => Promise<unknown>;
}

export const LOVABLE_SETTINGS_TOOLS: LovableSettingsToolDefinition[] = [
  {
    name: "get_lovable_mcp_settings",
    description: "Read the user's Lovable MCP URL and whether a token is set (the token itself is never returned in plaintext).",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => {
      const settings = getLovableMcpSettings(ctx.db, ctx.userId);
      return { url: settings.url, tokenSet: Boolean(settings.token) };
    },
  },
  {
    name: "set_lovable_mcp_settings",
    description: "Set or rotate the user's Lovable MCP URL/token.",
    parameters: { type: "object", properties: { url: { type: "string" }, token: { type: "string" } } },
    execute: async (args, ctx) => {
      const current = getLovableMcpSettings(ctx.db, ctx.userId);
      setLovableMcpSettings(ctx.db, ctx.userId, { url: (args.url as string | undefined) ?? current.url, token: (args.token as string | undefined) ?? current.token });
      const updated = getLovableMcpSettings(ctx.db, ctx.userId);
      return { url: updated.url, tokenSet: Boolean(updated.token) };
    },
  },
];
