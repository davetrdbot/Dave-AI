import type { DaveDatabase } from "@dave/db";
import type { DavemaClient } from "@dave/davema";
import type { TradeExecutor } from "@dave/trading";
import { TRADING_TOOLS } from "@dave/trading";
import { RFEED_TOOLS, type RFeedTradeExecutor, type HistoryRequestManager } from "@dave/rfeed";
import { EA_STATE_TOOLS } from "@dave/ea-bridge";
import { CORE_TOOLS } from "@dave/core";
import { KNOWLEDGE_TOOLS } from "@dave/knowledge";
import { MCP_MANAGER_TOOLS } from "@dave/mcp-manager";
import { FIRECRAWL_TOOLS } from "@dave/firecrawl";
import { PROVIDER_TOOLS } from "@dave/brain";
import { LOVABLE_TOOLS, LOVABLE_SETTINGS_TOOLS } from "@dave/lovable-mcp";
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
import { AUTOMATION_TOOLS, wireScheduledAutomations, wireWebhookAutomations, wireEntityAutomations } from "@dave/db";
import { FEEDBACK_TOOLS, logTrade } from "@dave/feedback";
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
  registry.register(adaptTools(CORE_TOOLS, { userId: deps.userId, davema: deps.davema, workspaceRoot: process.cwd() }));
  registry.register(adaptTools(KNOWLEDGE_TOOLS, { userId: deps.userId }));
  registry.register(adaptTools(MCP_MANAGER_TOOLS, { userId: deps.userId }));
  registry.register(adaptTools(FIRECRAWL_TOOLS, dbOnlyCtx));
  registry.register(adaptTools(PROVIDER_TOOLS, dbOnlyCtx));
  registry.register(adaptTools(LOVABLE_TOOLS, dbOnlyCtx));
  registry.register(adaptTools(LOVABLE_SETTINGS_TOOLS, dbOnlyCtx));
  registry.register(adaptTools(VOICE_SETTINGS_TOOLS, dbOnlyCtx));
  registry.register(adaptTools(PAIR_GROUP_TOOLS, { userId: deps.userId }));
  registry.register(adaptTools(SETTINGS_TOOLS, tradingCtx)); // ctx unused by these tools -- args carry userId directly
  registry.register(adaptTools(DAVE_TOOL_REQUEST_TOOLS, ownerCtx));
  registry.register(adaptTools(SKILL_TOOLS, skillCtx));
  registry.register(adaptTools(E2B_TOOLS, dbOnlyCtx));
  registry.register(adaptTools(SUBAGENT_TOOLS, ownerCtx));
  registry.register(adaptTools(MEMORY_TOOLS, { actorId: deps.userId }));
  registry.register(adaptTools(MEMORY_EXTRA_TOOLS, { actorId: deps.userId }));
  // Real fix (Step 18 re-verification): a single journal_trade call now
  // feeds BOTH the file-backed narrative store (Step 12) AND Step 18's
  // DB-backed trade log -- the latter is what actually drives
  // trade-count reflection (18.2) and the weekly export (18.6); without
  // this callback logTrade() was never once called outside its own test.
  registry.register(adaptTools(JOURNAL_TOOLS, { userId: deps.userId, onTradeLogged: (input) => logTrade(deps.db, deps.userId, input) }));
  registry.register(adaptTools(FEEDBACK_TOOLS, dbOnlyCtx));
  registry.register(adaptTools(SAFETY_TOOLS, dbOnlyCtx));
  registry.register(adaptTools(SELF_IMPROVE_TOOLS, dbOnlyCtx));
  registry.register(adaptTools(VISION_TOOLS, dbOnlyCtx));
  registry.register(adaptTools(SANDBOX_TOOLS, dbOnlyCtx));
  registry.register(adaptTools(DB_TOOLS, dbOnlyCtx));
  registry.register(adaptTools(AUTOMATION_TOOLS, dbOnlyCtx));
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

  // Part 3 (B4): real, live wiring -- every enabled "scheduled" automation
  // this user has gets a REAL node-cron trigger whose handler calls back
  // into THIS registry (registry.execute), so a persisted automation row
  // genuinely fires a real tool call, not just data sitting unused.
  const automationDispatch = (userId: string, toolName: string, toolArgs: Record<string, unknown>) => registry.execute(toolName, toolArgs);
  wireScheduledAutomations(deps.db, deps.userId, automationDispatch);
  // Real fix: "webhook"/"entity" automations previously persisted as DB rows
  // with zero live connection -- these now genuinely wire to the real
  // webhook-trigger primitive (stable URL across rebuilds) and the real
  // db.onEntityEvent() primitive respectively, same as scheduled automations
  // above. The webhook route still needs createAutomationWebhookServer() (or
  // an equivalent already-running listener) actually accepting connections --
  // that's a deployment-level HTTP server start, same as every other webhook
  // server in this codebase (EA/Telegram/user webhooks), not something a
  // registry build spins up on its own.
  wireWebhookAutomations(deps.db, deps.userId, automationDispatch);
  wireEntityAutomations(deps.db, deps.userId, automationDispatch);

  return registry;
}
