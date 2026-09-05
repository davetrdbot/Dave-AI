import type { DaveDatabase } from "@dave/db";
import type { DavemaClient } from "@dave/davema";
import type { TradeExecutor } from "@dave/trading";
import { TRADING_TOOLS } from "@dave/trading";
import { RFEED_TOOLS, type RFeedTradeExecutor, type HistoryRequestManager } from "@dave/rfeed";
import { PROVIDER_TOOLS } from "@dave/brain";
import { LOVABLE_TOOLS } from "@dave/lovable-mcp";
import { VOICE_CALL_TOOLS } from "@dave/voice-call";
import { SETTINGS_TOOLS, DAVE_TOOL_REQUEST_TOOLS } from "@dave/workers";
import { SKILL_TOOLS } from "@dave/skills";
import { ToolRegistry, adaptTools, type AgentTool } from "./tool-registry.js";
import { createAskUserTool } from "./ask-user.js";

/**
 * Update 11 (post-Update-9 follow-up): "you actually forgot to give
 * the agent tools -- it can call any tools." Update 9 built the real
 * tool-CALLING mechanism (native tool support in Provider, AgentLoop,
 * ToolRegistry) but never actually composed every package's own real
 * tools into one live registry. This is that composition: every
 * `*_TOOLS` array this build has produced, bound to real per-user
 * runtime handles, registered into a single `ToolRegistry` -- the
 * thing an `AgentLoop` actually hands to the model.
 */
export interface FullRegistryDeps {
  userId: string;
  db: DaveDatabase;
  davema: DavemaClient;
  executor: TradeExecutor;
  rfeedExecutor: RFeedTradeExecutor;
  rfeedHistoryManager: HistoryRequestManager;
}

export function buildFullToolRegistry(deps: FullRegistryDeps): ToolRegistry {
  const registry = new ToolRegistry();

  const tradingCtx = { userId: deps.userId, davema: deps.davema, executor: deps.executor };
  const rfeedCtx = { userId: deps.userId, db: deps.db, executor: deps.rfeedExecutor, historyManager: deps.rfeedHistoryManager };
  const dbOnlyCtx = { userId: deps.userId, db: deps.db };
  const ownerCtx = { ownerUserId: deps.userId };
  const skillCtx = { userId: deps.userId };

  registry.register(adaptTools(TRADING_TOOLS, tradingCtx));
  registry.register(adaptTools(RFEED_TOOLS, rfeedCtx));
  registry.register(adaptTools(PROVIDER_TOOLS, dbOnlyCtx));
  registry.register(adaptTools(LOVABLE_TOOLS, dbOnlyCtx));
  registry.register(adaptTools(VOICE_CALL_TOOLS, dbOnlyCtx));
  registry.register(adaptTools(SETTINGS_TOOLS, tradingCtx)); // ctx unused by these tools -- args carry userId directly
  registry.register(adaptTools(DAVE_TOOL_REQUEST_TOOLS, ownerCtx));
  registry.register(adaptTools(SKILL_TOOLS, skillCtx));
  registry.register([createAskUserTool(deps.userId)] as AgentTool[]);

  // Update 11 follow-up: "give the bot ability to search from his tools
  // in case" -- registered LAST so it can search everything already
  // registered above (it can't find itself, which is fine: you don't
  // need to search for the search tool).
  registry.register([
    {
      name: "search_tools",
      description: "Search your own registered tools by keyword (matches tool name or description) -- use this if you're not sure a tool exists or forgot its exact name.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      execute: async (args: Record<string, unknown>) => ({ matches: registry.search(args.query as string) }),
    },
  ]);

  return registry;
}
