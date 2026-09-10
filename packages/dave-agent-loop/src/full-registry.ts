import type { DaveDatabase } from "@dave/db";
import type { TradeExecutor } from "@dave/trading";
import { TRADING_TOOLS, HUNT_MODE_MIN_SCORE } from "@dave/trading";
import { EA_STATE_TOOLS, EA_ANALYSIS_TOOLS, createEaAnalysisSource } from "@dave/ea-bridge";
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
import { MEMORY_TOOLS, MEMORY_EXTRA_TOOLS, MEMORY_WRITE_TOOLS } from "@dave/memory";
import { PUSH_TOOLS, TELEGRAM_TOOLS, type TelegramClient } from "@dave/telegram";
import { NOTIFICATION_TOOLS } from "@dave/notifications";
import { SAFETY_TOOLS } from "@dave/safety";
import { SELF_IMPROVE_TOOLS } from "@dave/self-improve";
import { VISION_TOOLS } from "@dave/vision";
import { SANDBOX_TOOLS } from "@dave/sandbox";
import { DB_TOOLS } from "@dave/db";
import { TRAILING_TOOLS, MT5_ACCOUNT_TOOLS, DAVEMA_TOOLS } from "@dave/trading";
import { AUTOMATION_TOOLS, wireScheduledAutomations, wireWebhookAutomations, wireEntityAutomations, WORKFLOW_TOOLS } from "@dave/db";
import { FEEDBACK_TOOLS, logTrade } from "@dave/feedback";
import { ToolRegistry, adaptTools, type AgentTool } from "./tool-registry.js";
import { createAskUserTool } from "./ask-user.js";
import { runWorkerTask } from "./worker-loop.js";
import type { Worker } from "@dave/workers";
import type { OrderRequest } from "@dave/trading";
import { buildTradePlacedMessage, buildTradeApprovalRequestMessage } from "./trade-notifications.js";
import { runSetupPanel } from "./setup-panel.js";

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
  executor: TradeExecutor;
  /** Optional -- push_message_to_user is only registered when a real Telegram client + chat are supplied. */
  telegram?: { client: TelegramClient; chatId: number };
  /** Optional -- required (alongside `telegram`) for create_subagent to actually kick off a real
   *  worker execution run; without it, create_subagent still creates the bookkeeping record but
   *  nothing ever runs it (the pre-worker-engine behavior). */
  publicBaseUrl?: string;
}

export function buildFullToolRegistry(deps: FullRegistryDeps): ToolRegistry {
  const registry = new ToolRegistry();

  // Defined early (not just before wireScheduledAutomations below) so
  // WORKFLOW_TOOLS' per-user engine can share the exact same real
  // dispatch every trigger type uses -- a workflow's "call" step
  // genuinely invokes a real tool through this registry, not a second
  // parallel execution path.
  const automationDispatch = (userId: string, toolName: string, toolArgs: Record<string, unknown>) => registry.execute(toolName, toolArgs);

  // Item 5 real gap fixed (DAVEMA retirement): the real market-data source injected into every
  // trading tool that used to depend on `DavemaClient` directly -- backed by the connected MT5
  // EA's own on-demand analysis, not the retired external DAVEMA HTTP API.
  const analysisSource = createEaAnalysisSource(deps.userId);
  const tradingCtx = { userId: deps.userId, analysis: analysisSource, executor: deps.executor };
  const dbOnlyCtx = { userId: deps.userId, db: deps.db };
  const ownerCtx = { ownerUserId: deps.userId };
  const skillCtx = { userId: deps.userId };
  const workflowCtx = { userId: deps.userId, db: deps.db, dispatch: automationDispatch };

  // Real gap fixed (user, with a real screenshot: "implement confidence rate so when it's
  // placing a trade it should send like the screenshot" -- and separately, after this shipped:
  // "confirm if the bot took for trade even to set tp and set sl too"). trade_execute's own
  // result already carries confidence/needsApproval/ticket -- wrapped here (same reason as
  // create_subagent below: needs a live Telegram client, which dave-trading correctly has no
  // dependency on) so a fixed-template message ALWAYS reaches the user for every trade that
  // actually opens -- not gated on a confidence score being attached -- instead of the user
  // having no way to tell whether a trade genuinely fired. trade_modify/modify_sl_tp get the
  // same real confirmation for SL/TP changes on an already-open position.
  const wrappedTradingTools = adaptTools(TRADING_TOOLS, tradingCtx).map((tool): AgentTool => {
    if (tool.name === "trade_execute") {
      return {
        ...tool,
        execute: async (args: Record<string, unknown>) => {
          const result = (await tool.execute(args)) as Record<string, unknown>;
          if (deps.telegram) {
            const order = args as unknown as OrderRequest;
            const confidence = args.confidence as number | undefined;
            if (result.needsApproval) {
              void deps.telegram.client
                .sendMessage({
                  chat_id: deps.telegram.chatId,
                  text: buildTradeApprovalRequestMessage(order, confidence as number, result.threshold as number, args.reason as string | undefined),
                  reply_markup: {
                    inline_keyboard: [[
                      { text: "✅ Approve", callback_data: `tradeapprove:${result.pendingId as string}`, style: "success" },
                      { text: "❌ Decline", callback_data: `tradedecline:${result.pendingId as string}`, style: "danger" },
                      // Item 2/6 real gap fixed (user's reference pattern: "an Approve / Decline /
                      // Find Another inline button prompt"): a real 3rd option, wired to re-hunt
                      // excluding this declined symbol, not just a plain decline.
                      { text: "🔍 Find Another", callback_data: `tradefindanother:${result.pendingId as string}` },
                    ]],
                  },
                })
                .catch(() => undefined);
            } else if (result.ticket) {
              void deps.telegram.client.sendMessage({ chat_id: deps.telegram.chatId, text: buildTradePlacedMessage(order, result.ticket as string, confidence) }).catch(() => undefined);
            }
          }
          return result;
        },
      };
    }
    if (tool.name === "hunt_for_setup") {
      return {
        ...tool,
        execute: async (args: Record<string, unknown>) => {
          const result = (await tool.execute(args)) as { huntModeActivated?: boolean; groupName?: string | null; rows?: unknown[]; bestSetup?: { symbol: string; score: number; direction: string } | null };
          // Item 2/6 real gap fixed (user's reference pattern: "Sends a real message: '🔍 Hunt
          // Mode Active — No setup on [pair]. Scanning [N] pairs…'"): fires the real notification
          // the moment hunt_for_setup genuinely had to broaden beyond a single-pair focus --
          // never a fabricated status update, tied to the real huntModeActivated flag.
          if (deps.telegram && result.huntModeActivated) {
            const n = result.rows?.length ?? 0;
            void deps.telegram.client
              .sendMessage({ chat_id: deps.telegram.chatId, text: `🔍 Hunt Mode Active — no clean setup on the focused pair. Scanning ${n} pair(s) in ${result.groupName ?? "the active group"}…` })
              .catch(() => undefined);
          }
          // Item 7 real gap fixed (user, re-pasting the original spec: "running automatically as
          // part of the continuous hunt loop, not on-demand" -- the panel was only reachable via
          // an OPTIONAL run_setup_panel tool call the model might never make, not genuinely
          // automatic). Every real hunt_for_setup call that surfaces a candidate clearing the same
          // real HUNT_MODE_MIN_SCORE bar hunt mode itself uses now deterministically convenes the
          // real Setup Panel on it, in code -- never left to the model's discretion. Its verdict
          // (converged/proposal/declineReason + the real discussion transcript) rides back on
          // hunt_for_setup's own result, so Dave sees it on every hunt call, automatically.
          if (result.bestSetup && result.bestSetup.score >= HUNT_MODE_MIN_SCORE) {
            try {
              const panel = await runSetupPanel({ db: deps.db, ownerUserId: deps.userId, symbol: result.bestSetup.symbol });
              if (deps.telegram && !panel.converged) {
                void deps.telegram.client
                  .sendMessage({ chat_id: deps.telegram.chatId, text: `🧑‍🤝‍🧑 Panel reviewed ${panel.symbol}, no agreement — skipping.` })
                  .catch(() => undefined);
              }
              return {
                ...result,
                setupPanel: {
                  symbol: panel.symbol,
                  converged: panel.converged,
                  proposal: panel.proposal,
                  declineReason: panel.declineReason,
                  discussion: panel.transcript.map((m) => `${m.from}: ${m.content}`),
                },
              };
            } catch (err) {
              console.error(`[setup-panel] real panel run failed for ${result.bestSetup.symbol}:`, err);
              return result; // a real panel failure must never block hunt_for_setup's own real result from reaching Dave
            }
          }
          return result;
        },
      };
    }
    if (tool.name === "trade_modify" || tool.name === "modify_sl_tp") {
      return {
        ...tool,
        execute: async (args: Record<string, unknown>) => {
          const result = await tool.execute(args);
          if (deps.telegram) {
            const sl = args.sl as number | null | undefined;
            const tp = args.tp as number | null | undefined;
            const parts = [sl !== undefined ? (sl === null ? "SL removed" : `SL -> ${sl}`) : null, tp !== undefined ? (tp === null ? "TP removed" : `TP -> ${tp}`) : null].filter(Boolean);
            if (parts.length > 0) {
              void deps.telegram.client.sendMessage({ chat_id: deps.telegram.chatId, text: `🔧 Ticket #${args.ticket as string}: ${parts.join(", ")}` }).catch(() => undefined);
            }
          }
          return result;
        },
      };
    }
    return tool;
  });
  registry.register(wrappedTradingTools);

  // Item 7: the Setup Panel -- 7 specialist workers (46 real EA analysis endpoints, split
  // sensibly across them, see setup-panel.ts) genuinely discuss a candidate symbol via real
  // worker-to-worker messaging before Dave considers it, instead of Dave alone using a shallow
  // tool subset. Returns the panel's real verdict + the full real discussion transcript so Dave
  // can review it with its own judgment (trading.md) -- this tool NEVER places a trade itself,
  // it only informs Dave's own subsequent decision, same as any other analysis tool.
  const runSetupPanelTool: AgentTool = {
    name: "run_setup_panel",
    description:
      "Convene the Setup Panel -- 7 specialist analyst workers that jointly review a candidate symbol across all real EA analysis endpoints (structure, ICT/SMC, momentum, volatility, levels, macro, risk sizing) and genuinely discuss it before reporting back. Use this for a deeper, multi-angle second opinion on a candidate BEFORE deciding to trade it -- especially during hunt mode. Returns whether the panel converged on a direction, its proposal if so (never auto-executed -- you still decide), and the real discussion transcript.",
    parameters: { type: "object", properties: { symbol: { type: "string" }, timeframe: { type: "string" } }, required: ["symbol"] },
    execute: async (args) => {
      const result = await runSetupPanel({ db: deps.db, ownerUserId: deps.userId, symbol: args.symbol as string, timeframe: args.timeframe as string | undefined });
      if (deps.telegram && !result.converged) {
        void deps.telegram.client
          .sendMessage({ chat_id: deps.telegram.chatId, text: `🧑‍🤝‍🧑 Panel reviewed ${result.symbol}, no agreement — skipping.` })
          .catch(() => undefined);
      }
      return {
        symbol: result.symbol,
        converged: result.converged,
        proposal: result.proposal,
        declineReason: result.declineReason,
        discussion: result.transcript.map((m) => `${m.from}: ${m.content}`),
      };
    },
  };
  registry.register([runSetupPanelTool]);

  registry.register(adaptTools(EA_STATE_TOOLS, { userId: deps.userId }));
  registry.register(adaptTools(EA_ANALYSIS_TOOLS, { userId: deps.userId }));
  registry.register(adaptTools(CORE_TOOLS, { userId: deps.userId, workspaceRoot: process.cwd() }));
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
  // Real worker execution engine (user: "yes go ahead build the worker execution engine"):
  // create_subagent used to only ever write a bookkeeping row -- nothing actually ran the worker.
  // Wrapped here (rather than inside dave-workers' own subagent-tools.ts) specifically because
  // triggering a real agent run needs AgentLoop/ToolRegistry (dave-agent-loop) plus a live
  // Telegram client -- dave-workers must never import dave-agent-loop (that's the reverse of the
  // real, one-way package dependency: dave-agent-loop depends on dave-workers, not the other way).
  // `registry` is captured by reference in this closure and is fully built by the time
  // create_subagent is actually CALLED at runtime (all registration below happens synchronously
  // before this function returns), so it doubles as the real "granted tool" source of truth
  // worker-loop.ts's live-grant sync resolves names against.
  const subagentTools = adaptTools(SUBAGENT_TOOLS, ownerCtx).map((tool): AgentTool => {
    if (tool.name !== "create_subagent") return tool;
    return {
      ...tool,
      execute: async (args: Record<string, unknown>) => {
        const worker = (await tool.execute(args)) as Worker;
        if (deps.telegram && deps.publicBaseUrl) {
          void runWorkerTask({
            db: deps.db,
            ownerUserId: deps.userId,
            analysis: analysisSource,
            executor: deps.executor,
            publicBaseUrl: deps.publicBaseUrl,
            client: deps.telegram.client,
            chatId: deps.telegram.chatId,
            worker,
            task: args.task as string,
            fullRegistry: registry,
          }).catch((err) => {
            console.error(`[dave-agent-loop] worker "${worker.name}" (${worker.id}) run failed to even start:`, err);
          });
        }
        return worker;
      },
    };
  });
  registry.register(subagentTools);
  registry.register(adaptTools(MEMORY_TOOLS, { actorId: deps.userId }));
  registry.register(adaptTools(MEMORY_EXTRA_TOOLS, { actorId: deps.userId }));
  registry.register(adaptTools(MEMORY_WRITE_TOOLS, { actorId: deps.userId }));
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
  // Real gap fixed (user: "every 3 minutes send me hi never fired"): create/pause/resume/delete
  // used to only ever write a DB row -- the real node-cron/webhook wiring only happened once, at
  // THIS registry-build call below (wireScheduledAutomations/wireWebhookAutomations), which is
  // itself only built once per chat and cached for the process's lifetime. `resync` re-runs both
  // immediately after any automation-tool call changes a row, so a new/resumed automation is
  // armed right away and a paused/deleted one is torn down right away.
  const automationCtx = {
    userId: deps.userId,
    db: deps.db,
    resync: () => {
      wireScheduledAutomations(deps.db, deps.userId, automationDispatch);
      wireWebhookAutomations(deps.db, deps.userId, automationDispatch);
    },
    // `registry` is captured by reference and fully built by the time this is actually called
    // (create_automation only runs at real request time, never during this synchronous build).
    isKnownTool: (name: string) => registry.has(name),
  };
  registry.register(adaptTools(AUTOMATION_TOOLS, automationCtx));
  registry.register(adaptTools(WORKFLOW_TOOLS, workflowCtx));
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
  // (automationDispatch itself is defined above, before WORKFLOW_TOOLS'
  // registration, so both share the exact same real dispatch closure.)
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
