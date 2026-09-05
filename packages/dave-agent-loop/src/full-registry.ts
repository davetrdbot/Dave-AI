import type { DaveDatabase } from "@dave/db";
import type { DavemaClient } from "@dave/davema";
import type { TradeExecutor } from "@dave/trading";
import { TRADING_TOOLS } from "@dave/trading";
import { RFEED_TOOLS, type RFeedTradeExecutor, type HistoryRequestManager } from "@dave/rfeed";
import { EA_STATE_TOOLS } from "@dave/ea-bridge";
import { PROVIDER_TOOLS } from "@dave/brain";
import { LOVABLE_TOOLS, LOVABLE_SETTINGS_TOOLS } from "@dave/lovable-mcp";
import { VOICE_CALL_TOOLS, CALL_SETTINGS_TOOLS } from "@dave/voice-call";
import { VOICE_SETTINGS_TOOLS } from "@dave/notifications";
import { PAIR_GROUP_TOOLS } from "@dave/trading";
import { SETTINGS_TOOLS, DAVE_TOOL_REQUEST_TOOLS, SUBAGENT_TOOLS, JOURNAL_TOOLS } from "@dave/workers";
import { SKILL_TOOLS, seedInternalToolDocSkills, seedToolUsageSkill } from "@dave/skills";
import { E2B_TOOLS } from "@dave/e2b";
import { MEMORY_TOOLS, MEMORY_EXTRA_TOOLS } from "@dave/memory";
import { PUSH_TOOLS, TELEGRAM_TOOLS, type TelegramClient } from "@dave/telegram";
import { NOTIFICATION_TOOLS } from "@dave/notifications";
import { SAFETY_TOOLS } from "@dave/safety";
import { SELF_IMPROVE_TOOLS } from "@dave/self-improve";
import { VISION_TOOLS } from "@dave/vision";
import { SANDBOX_TOOLS } from "@dave/sandbox";
import { DB_TOOLS } from "@dave/db";
import { TRAILING_TOOLS, MT5_ACCOUNT_TOOLS, DAVEMA_TOOLS } from "@dave/trading";
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
  /** Optional -- push_message_to_user is only registered when a real Telegram client + chat are supplied. */
  telegram?: { client: TelegramClient; chatId: number };
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
  registry.register(adaptTools(EA_STATE_TOOLS, { userId: deps.userId }));
  registry.register(adaptTools(PROVIDER_TOOLS, dbOnlyCtx));
  registry.register(adaptTools(LOVABLE_TOOLS, dbOnlyCtx));
  registry.register(adaptTools(LOVABLE_SETTINGS_TOOLS, dbOnlyCtx));
  registry.register(adaptTools(VOICE_CALL_TOOLS, dbOnlyCtx));
  registry.register(adaptTools(CALL_SETTINGS_TOOLS, dbOnlyCtx));
  registry.register(adaptTools(VOICE_SETTINGS_TOOLS, dbOnlyCtx));
  registry.register(adaptTools(PAIR_GROUP_TOOLS, { userId: deps.userId }));
  registry.register(adaptTools(SETTINGS_TOOLS, tradingCtx)); // ctx unused by these tools -- args carry userId directly
  registry.register(adaptTools(DAVE_TOOL_REQUEST_TOOLS, ownerCtx));
  registry.register(adaptTools(SKILL_TOOLS, skillCtx));
  registry.register(adaptTools(E2B_TOOLS, dbOnlyCtx));
  registry.register(adaptTools(SUBAGENT_TOOLS, ownerCtx));
  registry.register(adaptTools(MEMORY_TOOLS, { actorId: deps.userId }));
  registry.register(adaptTools(MEMORY_EXTRA_TOOLS, { actorId: deps.userId }));
  registry.register(adaptTools(JOURNAL_TOOLS, { userId: deps.userId }));
  registry.register(adaptTools(SAFETY_TOOLS, dbOnlyCtx));
  registry.register(adaptTools(SELF_IMPROVE_TOOLS, dbOnlyCtx));
  registry.register(adaptTools(VISION_TOOLS, dbOnlyCtx));
  registry.register(adaptTools(SANDBOX_TOOLS, dbOnlyCtx));
  registry.register(adaptTools(DB_TOOLS, dbOnlyCtx));
  registry.register(adaptTools(TRAILING_TOOLS, tradingCtx));
  registry.register(adaptTools(MT5_ACCOUNT_TOOLS, tradingCtx));
  registry.register(adaptTools(DAVEMA_TOOLS, tradingCtx));
  if (deps.telegram) {
    registry.register(adaptTools(PUSH_TOOLS, deps.telegram));
    registry.register(adaptTools(TELEGRAM_TOOLS, deps.telegram));
    registry.register(adaptTools(NOTIFICATION_TOOLS, { userId: deps.userId, db: deps.db, client: deps.telegram.client, chatId: deps.telegram.chatId }));
  }
  registry.register([createAskUserTool(deps.userId)] as AgentTool[]);

  // Update 11 follow-up: "give the bot ability to search from his tools
  // in case" -- registered LAST (of the real tools) so it can search
  // everything already registered above (it can't find itself, which
  // is fine: you don't need to search for the search tool).
  registry.register([
    {
      name: "search_tools",
      description: "Search your own registered tools by keyword (matches tool name or description) -- use this if you're not sure a tool exists or forgot its exact name.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      execute: async (args: Record<string, unknown>) => ({ matches: registry.search(args.query as string) }),
    },
  ]);

  // Update 13/10: seed (or re-seed in place) the permanent "how do I use
  // myself" skills -- the internal tool docs (E2B/EA-webhook/R_Feed) and
  // the auto-generated tool-usage skill, from THIS registry's own real,
  // final, current tool specs (everything registered above, included).
  seedInternalToolDocSkills(deps.userId);
  seedToolUsageSkill(deps.userId, registry.toSpecs());

  return registry;
}
