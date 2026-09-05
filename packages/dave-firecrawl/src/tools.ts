import type { DaveDatabase } from "@dave/db";
import { addFirecrawlKey, listFirecrawlKeys, removeFirecrawlKey, searchWithKeyFailover, scrapeWithKeyFailover } from "./firecrawl-keys.js";

/**
 * Part 3 (B1): real Firecrawl web search/scrape as agent tools, keys
 * stored the same secure way as other provider keys (settable via the
 * settings UI too, same table shape).
 */
export interface FirecrawlToolContext {
  userId: string;
  db: DaveDatabase;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: FirecrawlToolContext) => Promise<unknown>;
}

export const FIRECRAWL_TOOLS: ToolDefinition[] = [
  {
    name: "add_firecrawl_key",
    description: "Store a real Firecrawl API key (up to 10).",
    parameters: { type: "object", properties: { label: { type: "string" }, apiKey: { type: "string" } }, required: ["label", "apiKey"] },
    execute: async (args, ctx) => addFirecrawlKey(ctx.db, ctx.userId, args.label as string, args.apiKey as string),
  },
  {
    name: "list_firecrawl_keys",
    description: "List stored Firecrawl keys and their real health status.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => listFirecrawlKeys(ctx.db, ctx.userId),
  },
  {
    name: "remove_firecrawl_key",
    description: "Delete a stored Firecrawl key.",
    parameters: { type: "object", properties: { keyId: { type: "string" } }, required: ["keyId"] },
    execute: async (args, ctx) => ({ removed: removeFirecrawlKey(ctx.db, ctx.userId, args.keyId as string) }),
  },
  {
    name: "web_search",
    description: "Real web search via Firecrawl -- returns real results (url/title/description), auto-fails over across stored keys.",
    parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
    execute: async (args, ctx) => searchWithKeyFailover(ctx.db, ctx.userId, args.query as string, args.limit as number | undefined),
  },
  {
    name: "scrape_url",
    description: "Real scrape of one URL via Firecrawl -- returns real markdown content + metadata, auto-fails over across stored keys.",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    execute: async (args, ctx) => scrapeWithKeyFailover(ctx.db, ctx.userId, args.url as string),
  },
];
