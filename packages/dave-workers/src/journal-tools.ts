import { journalTrade, journalClose, journalDaily, journalSearch } from "./journal-store.js";
import type { TradeJournalInput } from "./journal-worker.js";

export interface JournalToolContext {
  userId: string;
}

export interface JournalToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: JournalToolContext) => Promise<unknown>;
}

export const JOURNAL_TOOLS: JournalToolDefinition[] = [
  {
    name: "journal_trade",
    description: "Write a real trade journal entry -- structured facts plus your own real reasoning, turned into readable prose.",
    parameters: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        direction: { type: "string", enum: ["buy", "sell"] },
        entryPrice: { type: "number" },
        sl: { type: "number" },
        tp: { type: "number" },
        reasoning: { type: "array", items: { type: "string" } },
        confluenceScore: { type: "number" },
      },
      required: ["symbol", "direction", "entryPrice", "reasoning"],
    },
    execute: async (args, ctx) => journalTrade(ctx.userId, args as unknown as TradeJournalInput),
  },
  {
    name: "journal_close",
    description: "Append a real close note (and the real P&L) to an existing journal entry.",
    parameters: { type: "object", properties: { entryId: { type: "string" }, closeNote: { type: "string" }, pnl: { type: "number" } }, required: ["entryId", "closeNote"] },
    execute: async (args, ctx) => journalClose(ctx.userId, args.entryId as string, args.closeNote as string, args.pnl as number | undefined),
  },
  {
    name: "journal_daily",
    description: "Get every real journal entry created within a given day range.",
    parameters: { type: "object", properties: { dayStart: { type: "number" }, dayEnd: { type: "number" } }, required: ["dayStart", "dayEnd"] },
    execute: async (args, ctx) => journalDaily(ctx.userId, args.dayStart as number, args.dayEnd as number),
  },
  {
    name: "journal_search",
    description: "Search real journal entries by keyword (symbol or narrative text).",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    execute: async (args, ctx) => journalSearch(ctx.userId, args.query as string),
  },
];
