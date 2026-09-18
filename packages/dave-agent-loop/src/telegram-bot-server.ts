import type { Server } from "node:http";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DaveDatabase } from "@dave/db";
import type { TradeExecutor } from "@dave/trading";
import { type ContentBlock, type CompletionMessage } from "@dave/brain";
import { TelegramClient, createTelegramWebhookServer, enableTelegramWebhook, registerDefaultCommandMenu, updateBotDisplayInfo, isDaveCommand, looksLikeSlashCommand, markdownToTelegramHtml, chunkForTelegram, getActiveIndicator, setActiveIndicator, clearActiveIndicator, withThinkingIndicator, type ActionType, type TelegramUpdate, type TelegramMessage } from "@dave/telegram";
import { invokeWebhookTrigger } from "@dave/db";
import { buildImageContentBlock, transcribeAudioBytesWithKeyFailover, NoGroqKeyError } from "@dave/vision";
import { type ToolRegistry } from "./tool-registry.js";
import { buildFullToolRegistry } from "./full-registry.js";
import { AgentLoop, type AgentRunResult, type AgentStep } from "./agent-loop.js";
import { runAutonomousTick, type TickOutcome } from "./autonomous-tick.js";
import { getPendingQuestion, clearPendingQuestion, ASK_USER_TOOL_NAME } from "./ask-user.js";
import { BootstrapFlow, type Transport } from "@dave/core";
import { stopOrPanic, isTradingHalted, assertNotTripped, CircuitBreakerTrippedError } from "@dave/safety";
import { getEaConnectionStatus, createEaAnalysisSource } from "@dave/ea-bridge";
import { enforceDrawdownLimit } from "./drawdown-guard.js";
import { startAutonomousTradingLoop, stopAutonomousTradingLoop, isAutonomousTradingRunning, setAutonomousTradingIntervalMinutes, getTradingLoopIntervalMinutes } from "./trading-loop.js";
import { modelConfigProvider } from "./provider-selection.js";
import { createWorker, sendMessage as sendCommsMessage, DAVE_PARTICIPANT_ID } from "@dave/workers";
import { setBusy, clearBusy, getBusyState, setAutonomousBusy, clearAutonomousBusy, getAutonomousBusyState, waitForBusyToClear } from "./busy-state.js";
import { eaConnectionAlert, cycleErrorAlert, clearCycleErrorAlert } from "./health-alerts.js";
import { startWatchSweep } from "./watch-sweep.js";
import { beginTurn, endTurn, abortTurn } from "./turn-abort.js";
import { addPendingDelegation, getPendingDelegationQueue, clearPendingDelegation, buildDelegationPrompt, collapseQueuedMessages } from "./delegation.js";
import { loadConversationHistory, saveConversationHistory } from "./conversation-store.js";
import { dispatchCommand, dispatchCallback, tryHandlePendingModelEntry, tryHandlePendingVoiceEntry, tryHandlePendingKeyEntry, tryHandlePendingTtsKeyEntry, tryHandlePendingE2BKeyEntry, tryHandlePendingLimitEntry, tryHandlePendingRiskEntry, tryHandlePendingTrailingEntry, tryHandlePendingApprovalReply, tryHandlePendingMcpUrlEntry, tryHandlePendingActivePairEntry, tryHandlePendingConfidenceEntry, tryHandlePendingFirecrawlKeyEntry, tryHandlePendingLovableMcpEntry, tryHandlePendingMcpServerEntry, tryHandlePendingPushIntervalEntry, type CommandRouterDeps } from "./command-router.js";
import { recordActiveChat, getPrimaryChatId } from "./primary-chat.js";
import { isAutonomousTradingEnabled, setAutonomousTradingEnabled, setAutonomousExecutionEnabled, isAutonomousExecutionEnabled } from "./autonomous-trading-state.js";
import { wireMorningBrief } from "./morning-brief-handler.js";
import { wireFeedbackLoop } from "./feedback-loop-handler.js";
import { friendlyErrorMessage } from "./error-messages.js";
import { recordCycleOutcome } from "./autonomous-cycle-status.js";
import { withLiveContext } from "./live-context.js";
import { isJsonlSkillFile, installSkillsFromJsonl } from "@dave/skills";

/** Real gap fixed (user: "the auto-trading loop is too chatty"): a cycle only ever reports back
 *  when one of these genuinely fired -- tied to real, verifiable tool-call outcomes, not to
 *  whatever prose the model happened to write this cycle. */
export const NOTABLE_TRADING_TOOLS = new Set([
  "trade_execute",
  "trade_modify",
  "modify_sl_tp",
  "remove_sl_tp",
  "partial_close",
  "full_close",
  "delete_pending_order",
  "delete_all_pending_orders",
  "enable_position_trailing",
  "disable_position_trailing",
  "propose_settings_change",
]);

/**
 * The real, persistent replacement for a one-off polling script: a
 * webhook server Telegram pushes every update to directly, real
 * conversation history persisted per user (survives a restart, unlike
 * an in-memory array), and the user's own configured model (primary +
 * fallback, same ModelConfig the admin UI's "AI Models" tab already
 * writes) picked via their own stored provider keys -- not a
 * hardcoded provider.
 */
export interface TelegramBotServerDeps {
  /** The single Dave account this bot serves -- all chats it talks in share this one account's credentials/settings/tools, per-chat state is only the conversation history. */
  ownerUserId: string;
  db: DaveDatabase;
  executor: TradeExecutor;
  botToken: string;
  publicBaseUrl: string;
  systemPrompt: string;
}

export interface TelegramBotServer {
  server: Server;
  webhookUrl: string;
  /** Real gap fixed (user: "a hardcoded message to send when a trade is closed"): exposed so a
   *  caller (main.ts, wiring EaBridge's real onClosedPosition/onManualClose events) can send a
   *  fast, consistent, non-LLM-generated notification straight to the user's chat -- without
   *  waiting on (or paying for) an agent-loop turn just to narrate a trade closing. */
  client: TelegramClient;
}

/**
 * User-requested addition ("after Dave sends a response, show a small follow-up message/edit
 * indicating token usage for that exchange... then automatically edit that same message to
 * remove/clear it after about 4 seconds -- a transient indicator, not a permanent extra
 * message"). Fire-and-forget: never awaited by the real turn, and any failure (rate limit, chat
 * gone) is swallowed -- this is cosmetic, must never affect the real conversation.
 */
function sendTransientTokenUsage(client: TelegramClient, chatId: number, usage: { totalTokens: number; cacheReadInputTokens?: number } | undefined): void {
  if (!usage) return;
  // Real addition (independent audit): CompletionResult.cacheUsage was computed by
  // Claude/Bedrock but never surfaced anywhere a user could see it -- now aggregated onto the run
  // (agent-loop.ts's RunTokenUsage) and, when this run genuinely had a cache hit, appended here as
  // a short suffix. Kept small and in the same style as the existing message, not redesigned.
  const cacheRead = usage.cacheReadInputTokens ?? 0;
  const cacheSuffix = cacheRead > 0 ? ` (${(cacheRead / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })}k cached)` : "";
  void client
    .sendMessage({ chat_id: chatId, text: `🔢 ${usage.totalTokens.toLocaleString()} tokens${cacheSuffix}` })
    .then((sent) => {
      setTimeout(() => {
        void client.deleteMessage({ chat_id: chatId, message_id: sent.message_id }).catch(() => {});
      }, 4000);
    })
    .catch(() => {});
}

/** Third reversal (the trader, live, explicit: "hardcode this so instead of the bot calling it
 *  it's already hardcoded" -- the model-callable tg_thinking/tg_thinking_update/tg_finalize tools
 *  never got called reliably even after being promoted into CORE_TOOL_NAMES, so the trader wants
 *  zero AI decision in whether the live progress indicator shows). Derives a real icon+text pair
 *  straight from the AgentStep the loop already hands back after every real tool call -- no model
 *  cooperation required, matches the exact `AgentStep { toolName, arguments, result, isError }`
 *  shape agent-loop.ts's own `onStep` callback fires with. */
function describeStep(step: AgentStep): { action: ActionType; text: string } {
  const name = step.toolName;
  if (step.isError) return { action: "code", text: `${name} failed` };
  if (name.startsWith("get_") || name === "find_setup" || name === "hunt_for_setup") return { action: "api", text: `Checking ${name.replace(/^get_/, "")}` };
  if (name.startsWith("trade_") || name === "modify_sl_tp" || name === "remove_sl_tp" || name === "partial_close" || name === "full_close") return { action: "trade", text: `${name.replace(/_/g, " ")}` };
  if (name.startsWith("recall_") || name.startsWith("remember_") || name.startsWith("session_") || name === "tencent_memory") return { action: "memory", text: `${name.replace(/_/g, " ")}` };
  if (name.startsWith("db_")) return { action: "database", text: `${name.replace(/_/g, " ")}` };
  if (name.startsWith("create_subagent") || name.startsWith("list_subagents") || name === "retire_subagent") return { action: "worker", text: `${name.replace(/_/g, " ")}` };
  if (name.startsWith("tg_") || name === "send_telegram") return { action: "output", text: `${name.replace(/_/g, " ")}` };
  return { action: "input", text: `${name.replace(/_/g, " ")}` };
}

/** The real, shared agent-turn path -- both a normal incoming message AND the "Pause and do it
 * myself" delegation button run through this exact function, so there is no second, divergent
 * way a message actually gets processed. Brackets the real run with setBusy()/clearBusy() so a
 * genuinely concurrent second message can detect it and ask (see the delegation flow above). */
async function runAgentTurn(
  deps: TelegramBotServerDeps,
  client: TelegramClient,
  chatId: number,
  historyKey: string,
  userContent: string | ContentBlock[],
  messageText: string | undefined
): Promise<void> {
  const registry = getOrBuildRegistry(deps, client, chatId);
  const provider = modelConfigProvider(deps.db, deps.ownerUserId, async (text) => { await client.sendMessage({ chat_id: chatId, text }); });
  const loop = new AgentLoop(provider, registry);

  let history = loadConversationHistory(deps.db, historyKey);
  if (history.length === 0) history = [{ role: "system", content: deps.systemPrompt }];

  // Real bug fixed: ask_user (ask-user.ts) genuinely pauses the loop and its question
  // WAS being sent to the user, but nothing ever resumed the paused run -- the next
  // message just started a fresh loop.run() over history that still had a dangling
  // assistant tool_call with no matching tool_result, which every real provider's API
  // rejects as malformed. Confirmed via this exact code path having no getPendingQuestion/
  // resume() reference anywhere. Now: if a question is genuinely pending for this owner,
  // this message IS the real answer -- resume the exact paused call, not a fresh turn.
  const pendingQuestion = messageText ? getPendingQuestion(deps.ownerUserId) : undefined;
  const pendingToolCallId = pendingQuestion ? findPendingAskUserToolCallId(history) : undefined;

  const taskDescription = typeof userContent === "string" ? userContent.slice(0, 80) : "processing your message";
  setBusy(deps.ownerUserId, taskDescription);
  // Real bug fixed (user, live: a turn got stuck "thinking" forever, immune to a changed timeout
  // setting, `/stop`, and `/reset`). This tracks the turn so those commands can genuinely cancel
  // it (see turn-abort.ts) instead of only flipping flags nothing in this call ever checked.
  const abortController = beginTurn(deps.ownerUserId);
  try {
    // Third reversal (see describeStep's comment above): the live progress indicator is now
    // ALWAYS shown for the duration of the real turn -- zero AI decision in whether it appears,
    // matching thinking-indicator.ts's own "9.1" design the automatic wrapper originally shipped
    // with. `setActiveIndicator` registers this exact instance so autonomous-tick.ts's
    // sequential-thinking progress hook (which reads via `getActiveIndicator`) keeps working
    // unchanged, and `onStep` (agent-loop.ts's real per-tool-call callback) drives live updates
    // from genuine tool-call events instead of a model tool-call that may never come.
    const finalResult = await withThinkingIndicator<AgentRunResult>(client, chatId, async (indicator) => {
      setActiveIndicator(chatId, indicator);
      const onStep = (step: AgentStep): void => {
        const { action, text } = describeStep(step);
        void indicator.update(action, text);
      };
      let result: AgentRunResult;
      if (pendingQuestion && pendingToolCallId) {
        clearPendingQuestion(deps.ownerUserId);
        result = await loop.resume(
          { status: "awaiting_user", question: pendingQuestion, toolCallId: pendingToolCallId, history, steps: [] },
          messageText as string,
          { signal: abortController.signal, onStep }
        );
      } else {
        history.push({ role: "user", content: withLiveContext(deps.ownerUserId, userContent) });
        result = await loop.run(history, { signal: abortController.signal, onStep });
      }
      saveConversationHistory(deps.db, historyKey, result.history);

      let finalText: string;
      if (result.status === "aborted") {
        // Real, plain visibility into the exact bug this closes (user, live: "/stop didn't work,
        // still showing typing") -- confirms in the logs that an abort genuinely reached and
        // stopped the loop, not just "processing forever" with nothing to check.
        console.log(`[turn-abort] ${deps.ownerUserId}: turn genuinely stopped (reason=${result.reason})`);
        // Real gap fixed (traced via a dedicated investigation subagent, the trader's "low
        // response" report): a genuine deadline hit (the turn was still honestly working, just
        // took longer than the overall budget) used to show the EXACT same text as a real
        // user-initiated /stop -- reading like Dave stopped for no reason, when it actually timed
        // out on real work. Distinct, honest text for each real cause.
        finalText = result.reason === "deadline" ? "⏹️ That took longer than I could keep going on this turn -- try again, or ask for something narrower." : "⏹️ Stopped -- that turn was cancelled.";
      } else {
        // Real bug fixed (user: "sometimes it shows (no text) like this everytime"): a turn that
        // ends with tool calls but no closing remark from the model (common after a purely
        // action-driven turn, e.g. placing a trade with nothing left to say) used to literally send
        // the placeholder string "(no text)" as if it were Dave's real reply -- looked exactly like
        // a bug because it was one. A real, minimal, honest completion signal instead.
        const rawFinalText = result.status === "done" ? result.text || "✅ Done." : result.question.question;
        finalText = markdownToTelegramHtml(rawFinalText);
      }
      return { result, finalText };
    });
    clearActiveIndicator(chatId);

    // Real gap fixed (item 7: "inline-button-based questions Dave asks aren't being
    // received/processed correctly") -- ask_user previously had no way to offer clickable
    // choices at all. When the paused question carries real options, send them as real inline
    // buttons (askuser:<toolCallId>:<index>) in a follow-up message; tapping one is handled
    // below in the real callback_query path, resuming the SAME paused loop exactly like a typed
    // answer would.
    if (finalResult.status === "awaiting_user" && finalResult.question.options && finalResult.question.options.length > 0) {
      const options = finalResult.question.options;
      const toolCallId = finalResult.toolCallId;
      const rows = options.map((opt, i) => [{ text: opt, callback_data: `askuser:${toolCallId}:${i}` }]);
      await client.sendMessage({ chat_id: chatId, text: "Tap an option:", reply_markup: { inline_keyboard: rows } });
    }
    if (finalResult.status !== "aborted") sendTransientTokenUsage(client, chatId, finalResult.tokenUsage);
  } catch (err) {
    // withThinkingIndicator already ran indicator.cleanupOnFailure() (deletes the real progress
    // message without sending final text) before rethrowing -- an orphaned "thinking..." message
    // must never survive an error path, and now it can't, whether or not this specific run ever
    // called a tool at all.
    clearActiveIndicator(chatId);
    await client.sendMessage({ chat_id: chatId, text: friendlyErrorMessage(err) }).catch(() => {});
  } finally {
    endTurn(deps.ownerUserId, abortController);
    clearBusy(deps.ownerUserId);
    // Final safety net: whatever happened above, never let a turn end with a live indicator still
    // tracked for this chat -- a bug in one of the paths above must not leave "thinking..." stuck
    // in the chat forever with nothing left to clean it up.
    await ensureNoOrphanedIndicator(client, chatId);
  }
}

/** Exported for tests, and used above as runAgentTurn's own last-resort safety net: finalizes and
 *  clears any `ThinkingIndicator` still tracked for this chat (tools.ts's `activeIndicators`).
 *  Real-world case this closes: tg_thinking opened an indicator, then the turn threw before ever
 *  reaching tg_finalize (a provider error, an unrelated tool exception, an abort) -- without this,
 *  that "thinking..." message would sit in the chat forever with nothing left to edit or delete
 *  it. Returns whether an orphaned indicator was actually found and cleaned up. */
export async function ensureNoOrphanedIndicator(client: TelegramClient, chatId: number, fallbackText = "⚠️ Lost track of that task -- please try again."): Promise<boolean> {
  const leftover = getActiveIndicator(chatId);
  if (!leftover) return false;
  await leftover.finalize(fallbackText).catch(() => {});
  clearActiveIndicator(chatId);
  return true;
}

/**
 * The single real handler for /stop, /panic, /start_trading, /stop_trading -- shared between the
 * typed-text path (checked first thing, before anything else) and the /menu button-tap path
 * (menucmd:start_trading etc in the callback_query handler below), so a tap does exactly the
 * same real thing as typing the command, not a second divergent path. Returns true if `text`
 * was one of these and was handled (caller should not do anything else with it).
 */
async function handleTradingControlCommand(deps: TelegramBotServerDeps, client: TelegramClient, chatId: number, text: string): Promise<boolean> {
  if (/^\/(stop|panic)\b/i.test(text)) {
    stopOrPanic(deps.ownerUserId, text.toLowerCase().startsWith("/panic") ? "panic" : "stop");
    stopAutonomousTradingLoop(deps.ownerUserId);
    // Real gap fixed: an emergency stop must never silently come back on its own after the next
    // deploy/restart -- the user explicitly killed it, so the persisted intent goes off too,
    // same as /stop_trading below.
    setAutonomousTradingEnabled(deps.ownerUserId, false);
    // Real gap fixed: /stop_trading (below) can leave execution in "watch-only, sniper-tier-only"
    // mode -- a real /stop or /panic is a genuine full stop, so reset that too, otherwise a later
    // /start_trading would wake back up already stuck in watch-only mode instead of normal.
    setAutonomousExecutionEnabled(deps.ownerUserId, true);
    // Real bug fixed (user, live: a stuck turn kept "thinking"/burning credit, and neither /stop
    // nor changing the timeout setting did anything about it). /stop and /panic now also
    // genuinely cancel an in-flight chat turn, not just flip trading flags.
    const cancelled = abortTurn(deps.ownerUserId);
    // Real bug fixed (independent audit): /stop and /panic used to abort the in-flight turn but
    // never touch the pending-delegation queue -- a message that arrived while busy (and got the
    // 3-button "pause/worker/skip" prompt) was left silently sitting in pending-delegation.json
    // forever, with a now-stale prompt, unless the user still had that old message to tap. An
    // emergency stop means stop everything, including anything queued -- so it's discarded here,
    // but never silently: the user is told exactly how many messages were dropped.
    let discardedCount = 0;
    if (cancelled) {
      const queue = getPendingDelegationQueue(deps.ownerUserId);
      if (queue.length > 0) {
        clearPendingDelegation(deps.ownerUserId);
        discardedCount = queue.length;
      }
    }
    let stopReplyText = cancelled ? "🛑 Stopped -- all trading and workers halted immediately. Also cancelled the message you were waiting on." : "🛑 Stopped -- all trading and workers halted immediately.";
    if (discardedCount > 0) {
      stopReplyText += discardedCount === 1 ? " Also discarded 1 message that was waiting." : ` Also discarded ${discardedCount} messages that were waiting.`;
    }
    await client.sendMessage({
      chat_id: chatId,
      text: stopReplyText,
    });
    return true;
  }

  // Real gap fixed (user: "every 5 min -- make this settable and configurable"): an optional
  // trailing number of minutes, e.g. "/start_trading 10", sets the real persisted cadence
  // (trading-loop-config.ts). Works whether the loop is currently off (starts it at that
  // cadence) or already running (re-arms it live at the new cadence, no stop/start needed).
  const startTradingMatch = text.match(/^\/start_trading(?:\s+(\d+))?\s*$/i);
  if (startTradingMatch) {
    const requestedMinutes = startTradingMatch[1] ? Number(startTradingMatch[1]) : undefined;
    if (requestedMinutes !== undefined) {
      try {
        setAutonomousTradingIntervalMinutes(deps.ownerUserId, requestedMinutes);
      } catch (err) {
        await client.sendMessage({ chat_id: chatId, text: err instanceof Error ? err.message : String(err) });
        return true;
      }
    }
    const wasAlreadyRunning = isAutonomousTradingRunning(deps.ownerUserId);
    // Real, live bug fixed (user: "if I turn on trading it will tell me it's already on"). Root
    // cause: /stop_trading (below) deliberately leaves the scheduler's setInterval ARMED -- it
    // only flips execution off -- so isAutonomousTradingRunning stays true the whole time the
    // user thinks trading is off. /start_trading after a /stop_trading then hit the "already
    // running" branch below even though real execution had genuinely been off and the user was
    // now turning it back on. Capture whether execution was actually enabled BEFORE flipping it,
    // so the reply can tell a genuine "already fully on" apart from "was paused, now resumed."
    const wasExecutionEnabled = isAutonomousExecutionEnabled(deps.ownerUserId);
    // Real bug fixed: pass 0 as intervalMs on a fresh start so the FIRST real cycle fires within
    // the next poll tick (~5s) instead of waiting the full configured interval -- a user who just
    // sent /start_trading expects activity to start, not a blank minute of silence.
    const started = startAutonomousTradingLoop(deps.ownerUserId, () => runAutonomousTradingCycle(deps, client, chatId), wasAlreadyRunning ? undefined : 0);
    // Real bug fixed (user, live: autonomous trading silently stops on every deploy/restart --
    // startAutonomousTradingLoop's setInterval is purely in-memory, no persistence, no resume).
    // Persists the user's real standing intent so a boot-time resume (see the bottom of
    // startTelegramBotServer below) can genuinely re-arm this after a restart, not leave the
    // user to notice the silence and manually retype /start_trading every time.
    setAutonomousTradingEnabled(deps.ownerUserId, true);
    // Only re-enable execution when genuinely starting or resuming -- not on a bare interval
    // update while the loop was already running with execution explicitly paused, which would
    // silently undo the user's /stop_trading without saying so.
    if (!wasAlreadyRunning || !wasExecutionEnabled) {
      setAutonomousExecutionEnabled(deps.ownerUserId, true);
    }
    const interval = getTradingLoopIntervalMinutes(deps.ownerUserId);
    let replyText: string;
    if (started) {
      replyText = `▶️ Autonomous trading is on (scan loop: every ${interval} min). I'll scan every pair in my active pair group and act on real setups on my own initiative -- I'll only message you when something actually happens (a trade, a TP/SL hit, or a real question). /stop_trading turns this off, /stop or /panic is still the instant hard kill.`;
    } else if (requestedMinutes !== undefined && wasAlreadyRunning) {
      replyText = `🔄 Autonomous trading loop interval updated to every ${interval} min, applied immediately.`;
    } else if (wasAlreadyRunning && !wasExecutionEnabled) {
      replyText = `▶️ Resumed -- I was paused (/stop_trading), now back to acting on real setups on my own initiative (scan loop: every ${interval} min).`;
    } else {
      replyText = `Autonomous trading is already running and actively trading (scan loop: every ${interval} min).`;
    }
    await client.sendMessage({ chat_id: chatId, text: replyText });
    return true;
  }
  if (/^\/stop_trading\b/i.test(text)) {
    // Real bug fixed (user, live: "/stop_trading it shouldn't give it offer to place new trade
    // because I just did it now and it's still placing trade so it doesn't work" -- root cause:
    // the scheduler kept running but nothing re-checked mid-cycle before an already-in-flight
    // decision fired). The scheduler now deliberately stays ARMED (no stopAutonomousTradingLoop
    // here) -- this only turns off normal auto-execution; autonomous-tick.ts's own final gate
    // check discards anything already in flight, and per the user's own follow-up ask, the loop
    // keeps watching: a genuinely sniper-tier setup still gets surfaced as a real approve/decline
    // ask instead of the account going fully dark.
    const wasRunning = isAutonomousTradingRunning(deps.ownerUserId);
    setAutonomousExecutionEnabled(deps.ownerUserId, false);
    await client.sendMessage({
      chat_id: chatId,
      text: wasRunning
        ? "⏸️ Autonomous trading is off. I'll keep watching in the background, but I won't open a normal new trade -- only a genuinely sniper-tier setup will come to you as an approve/decline ask. I'll still help directly whenever you message me."
        : "Autonomous trading wasn't running.",
    });
    return true;
  }
  return false;
}

/** The real per-tick body of /start_trading's autonomous loop (see trading-loop.ts for the
 * scheduling itself). Deliberately runs against its OWN, separate conversation history
 * (`<owner>:autonomous:<chatId>`) rather than the user's real chat thread -- an autonomous
 * scan's internal back-and-forth isn't something the user should see mixed into their own
 * conversation later, even though it shares the exact same tools/registry/system prompt (goal.yaml
 * included). Per IDENTITY.md's "trade quietly" rule, this sends NOTHING to the user unless the
 * model's own final text is real content -- a bare "NOTHING_TO_REPORT" sentinel (or empty text)
 * means a normal, quiet cycle where nothing needed saying, and is swallowed here, never sent. */
/** Real gap fixed (a dedicated investigation subagent, the trader's "why isn't it trading"
 *  report): this used to ONLY reach a server-side console.log -- the comment above used to admit
 *  outright that "the user has no other way to see why" than Railway's own log tail. Every gate
 *  that returns through this function (EA disconnected, circuit breaker, drawdown, a pending
 *  question, busy-state, and every real decision from autonomous-tick.ts) now ALSO persists via
 *  autonomous-cycle-status.ts, so the admin panel's Autonomous Trading card can show the real,
 *  current answer -- not just the log. The console.log line stays too, for anyone who does have
 *  log access. */
function logCycle(userId: string, reason: string): void {
  console.log(`[autonomous-tick] ${userId}: ${reason}`);
  recordCycleOutcome(userId, reason);
}

/** See the real bug this fixes at its one call site below (getPendingQuestion gate). */
const MAX_PENDING_QUESTION_AGE_MS = 15 * 60_000;

/**
 * Real bug fixed (the trader: "find bugs this bot"). The cycle's only error handling was
 * trading-loop.ts's `.catch(err => console.error(...))` -- so an expired/out-of-credit provider
 * key, a rate limit, or any other throw meant EVERY cycle died into a Railway log while the loop
 * still looked perfectly alive. The owner had no way to learn their bot had stopped trading
 * entirely. This wrapper is the alerting half; the inner function below is unchanged. Dedup and
 * the once-an-hour repeat for an ONGOING identical failure live in health-alerts.ts, so a
 * permanently broken key reminds rather than spams, and a genuinely new failure still gets
 * through immediately.
 */
/**
 * The one real send path for a tick's own message to the owner -- chunked for Telegram's real
 * 4096-char limit, with the outcome's real inline keyboard (when it has one) attached to the LAST
 * chunk so an approve/decline ask actually arrives pressable. Exported so this exact behavior is
 * testable end to end rather than only reachable through a full live cycle.
 */
export async function sendTickOutcome(client: TelegramClient, chatId: number, outcome: TickOutcome): Promise<void> {
  if (!outcome.message) return;
  const chunks = chunkForTelegram(outcome.message);
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    await client.sendMessage({
      chat_id: chatId,
      text: chunks[i],
      ...(isLast && outcome.replyMarkup ? { reply_markup: outcome.replyMarkup } : {}),
    });
  }
}

export async function runAutonomousTradingCycle(deps: TelegramBotServerDeps, client: TelegramClient, chatId: number): Promise<void> {
  try {
    await runAutonomousTradingCycleInner(deps, client, chatId);
    clearCycleErrorAlert(deps.ownerUserId);
  } catch (err) {
    console.error(`[autonomous-tick] ${deps.ownerUserId}: cycle threw:`, err);
    const alert = cycleErrorAlert(deps.ownerUserId, err);
    if (alert) void client.sendMessage({ chat_id: chatId, text: alert }).catch(() => undefined);
  }
}

async function runAutonomousTradingCycleInner(deps: TelegramBotServerDeps, client: TelegramClient, chatId: number): Promise<void> {
  if (isTradingHalted(deps.ownerUserId)) return logCycle(deps.ownerUserId, "skipped -- trading halted (/stop, /panic, or a tripped safety gate)");
  if (getBusyState(deps.ownerUserId)) return logCycle(deps.ownerUserId, "skipped -- a real user turn is already in flight");
  if (getAutonomousBusyState(deps.ownerUserId)) return logCycle(deps.ownerUserId, "skipped -- the previous autonomous cycle is still running");

  // Items 2/6 real gating gap fixed (user's reference pattern: "real gating checks before any
  // analysis: kill switch, auto_trading flag, pending user question, EA heartbeat freshness,
  // drawdown cap"). isTradingHalted/getBusyState above already covered the kill-switch/busy
  // case; these are the real gates that were genuinely missing:
  //
  // Real bug fixed (user, live: confirmed via the new logging this session added -- "skipped --
  // an unanswered question is still pending" fired on EVERY cycle for 10+ minutes straight,
  // permanently blocking all trading). getPendingQuestion (ask-user.ts) has no expiry -- a
  // question the main chat asked once, that the user never got to (or already effectively moved
  // past without it ever being cleared), gates autonomous trading forever with nothing to ever
  // clear it. Same class of bug busy-state.ts already self-heals (a stale record with no live
  // process left to clear it) -- past this age, autonomous trading proceeds anyway; the pending
  // question record itself is left untouched, so the main chat can still resume it normally the
  // moment the user does reply.
  const pendingQuestion = getPendingQuestion(deps.ownerUserId);
  if (pendingQuestion) {
    const ageMs = Date.now() - pendingQuestion.askedAt;
    if (ageMs < MAX_PENDING_QUESTION_AGE_MS) return logCycle(deps.ownerUserId, `skipped -- an unanswered question is still pending (asked ${Math.round(ageMs / 60_000)}m ago)`);
    logCycle(deps.ownerUserId, `pending question is stale (asked ${Math.round(ageMs / 60_000)}m ago, never answered) -- proceeding with autonomous trading anyway`);
  }
  const eaStatus = getEaConnectionStatus(deps.ownerUserId);
  // Real bug fixed (the trader: "find bugs this bot"). This gate silently returned -- so when MT5
  // went offline (PC asleep, internet dropped, terminal closed, EA detached), Dave stopped hunting
  // completely and the owner was never told. On a bot trading real money that's the worst failure
  // shape there is: it looks alive, it has been dead for hours, and the only way to find out was
  // to run /status by hand. Edge-triggered via health-alerts.ts, so an EA that stays offline is
  // reported ONCE, not once per cycle.
  if (!eaStatus.connected) {
    const alert = eaConnectionAlert(deps.ownerUserId, false, eaStatus.secondsSinceLastSeen);
    if (alert) void client.sendMessage({ chat_id: chatId, text: alert }).catch(() => undefined);
    return logCycle(deps.ownerUserId, "skipped -- EA is not connected, no live data to analyze");
  }
  // The recovery edge. onConnect in main.ts covers a genuine 6-minute-gap reconnect; this covers
  // the ordinary case where the EA was briefly marked offline and is simply reporting again.
  const recovered = eaConnectionAlert(deps.ownerUserId, true, eaStatus.secondsSinceLastSeen);
  if (recovered) void client.sendMessage({ chat_id: chatId, text: recovered }).catch(() => undefined);
  try {
    assertNotTripped(deps.db, deps.ownerUserId);
  } catch (err) {
    if (err instanceof CircuitBreakerTrippedError) return logCycle(deps.ownerUserId, "skipped -- circuit breaker tripped");
    throw err;
  }
  const drawdownPaused = await enforceDrawdownLimit(deps.db, deps.ownerUserId, async (text) => {
    await client.sendMessage({ chat_id: chatId, text });
  });
  if (drawdownPaused) return logCycle(deps.ownerUserId, "skipped -- drawdown limit paused trading");

  // Real gap fixed: this used to build a full AgentLoop with the entire tool registry and a
  // long-persisted conversation thread -- an open-ended agentic loop with no boundary between
  // the model "reasoning out loud" and "making a real control-flow decision," which is exactly
  // what let Dave invent its own authority to halt trading, forget trades it had just placed,
  // and hedge on real setups (three connected live complaints, confirmed by reading the user's
  // own former bot's proven decision mechanism alongside this one). Replaced with a single
  // structured decision per cycle (autonomous-tick.ts, modeled directly on that reference bot's
  // tickOne()) -- one request, no tools, one of BUY/SELL/SKIP/ASK back, nothing more for the
  // model to narrate its way out of. The main chat (runAgentTurn above) keeps the full agentic
  // tool loop unchanged -- only this unattended background loop, running with real money with
  // nobody watching each cycle, gets the tighter mechanism.
  if (deps.executor === undefined) return logCycle(deps.ownerUserId, "skipped -- no trade executor configured");
  const provider = modelConfigProvider(deps.db, deps.ownerUserId, async (text) => {
    await client.sendMessage({ chat_id: chatId, text });
  });

  setAutonomousBusy(deps.ownerUserId, "autonomous trading cycle");
  // Real interrupt wiring (user, live, this session): a real incoming chat message must be able
  // to cut an in-flight tick off immediately, not run alongside it unaware. Mirrors runAgentTurn's
  // exact real pattern above -- beginTurn() before the real tick work, endTurn() in a finally --
  // so turn-abort.ts's Set-based tracking sees the tick as just another real in-flight turn for
  // this owner, right alongside their own chat turn/any delegated worker task, never clobbering
  // either. abortTurn(ownerUserId) (called at the top of onUpdate for every real incoming message,
  // see below) then genuinely cancels this controller's signal, which autonomous-tick.ts threads
  // into its own provider.generate() call.
  const tickAbortController = beginTurn(deps.ownerUserId);
  try {
    const outcome = await runAutonomousTick({
      userId: deps.ownerUserId,
      db: deps.db,
      executor: deps.executor,
      provider,
      signal: tickAbortController.signal,
      // Part 3: sequential-thinking progress (when the user has it on) goes through the SAME
      // tg_thinking_update mechanism from Part 1, never a separate indicator. Autonomous cycles
      // stay silent by default (IDENTITY.md's "trade quietly"), so this is a real no-op unless a
      // live indicator already happens to be open for this chat.
      onSequentialThinkingProgress: (text) => void getActiveIndicator(chatId)?.update("trade", text),
    });
    logCycle(deps.ownerUserId, `decision: ${outcome.action}${outcome.symbol ? ` ${outcome.symbol}` : ""}${outcome.notable ? " (notable)" : ""}${outcome.message ? ` -- ${outcome.message.replace(/\n/g, " | ")}` : ""}`);
    // Real, live fix (user: the trade-placed message's reason is now the model's full, real,
    // untruncated reasoning, not a summary -- a rare pathologically long one could exceed
    // Telegram's real 4096-char sendMessage limit and fail outright). Chunked via the same shared
    // chunkForTelegram utility every other long-message send path in this codebase already uses
    // (command-router.ts, thinking-indicator.ts) -- sent as real sequential messages, never
    // summarized or shortened.
    // Real bug fixed (the owner, from a live Telegram screenshot: an autonomous below-threshold
    // trade arrived saying "Approve to place it, or decline to skip." with NO inline keyboard on
    // it at all -- nothing to press, so a gated trade could never be approved or declined). This
    // send path only ever passed `text`, so a tick outcome that genuinely needs a decision from
    // the owner (confidence-gated trade, sniper-tier-while-stopped) shipped as dead prose. The
    // outcome now carries the real keyboard (autonomous-tick.ts's TickOutcome.replyMarkup) and it
    // is attached to the LAST chunk -- the same placement full-registry.ts's trade_execute
    // wrapper already uses, so the buttons sit under the end of the reasoning, not mid-message.
    if (outcome.message) await sendTickOutcome(client, chatId, outcome);
  } catch (err) {
    console.error(`[trading-loop] autonomous cycle failed for ${deps.ownerUserId}:`, err);
    recordCycleOutcome(deps.ownerUserId, `cycle threw: ${err instanceof Error ? err.message : String(err)}`);
    // Real bug fixed, caught LIVE within minutes of shipping the outer alert wrapper: this inner
    // catch already existed and swallowed the error here, so it never reached that wrapper and no
    // alert was ever sent. Proved by a real failed trade -- Dave found a genuine BOOM_100 setup at
    // 62% confidence, the broker rejected it with "not enough money", and the owner was told
    // nothing at all. This is the catch that actually sees a failing cycle, so this is where the
    // alert has to live. Same edge-triggered dedup, so a repeating failure still can't spam.
    const alert = cycleErrorAlert(deps.ownerUserId, err);
    if (alert) await client.sendMessage({ chat_id: chatId, text: alert }).catch(() => undefined);
  } finally {
    endTurn(deps.ownerUserId, tickAbortController);
    clearAutonomousBusy(deps.ownerUserId);
  }
}

/** Real fix companion: a paused run's saved history ends with an assistant message whose
 * ask_user tool call has no matching tool_result yet -- this finds that call's real id so
 * resume() can supply the answer against the exact right toolCallId, not a fresh turn. */
function findPendingAskUserToolCallId(history: CompletionMessage[]): string | undefined {
  const lastAssistant = [...history].reverse().find((m) => m.role === "assistant" && m.toolCalls?.length);
  return lastAssistant?.toolCalls?.find((c) => c.name === ASK_USER_TOOL_NAME)?.id;
}

function inboxDir(ownerUserId: string): string {
  const dir = join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "telegram-inbox", ownerUserId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Real gap closed (final pre-deployment pass, Step 15 -- file I/O both
 * directions): the live webhook handler used to fall straight to
 * `if (!message?.text) return;`, silently dropping every incoming
 * voice note, photo, and document -- real transcription (Groq) and
 * real vision (Claude image blocks) both existed as library code, but
 * nothing in the live message path ever called them. This builds the
 * real user-turn content for whichever of the three arrived, downloading
 * the actual bytes via the real Telegram `getFile` + download round
 * trip (Step 15.3) first.
 *
 * Returns undefined (and has already told the user why) when the
 * attachment genuinely couldn't be turned into something the model can
 * use -- a missing Groq key, an unsupported image format, etc. -- so the
 * caller can bail out for this update without also invoking the agent
 * loop on nothing.
 */
export async function buildInboundContent(
  client: TelegramClient,
  message: TelegramMessage,
  ownerUserId: string,
  db: DaveDatabase
): Promise<string | ContentBlock[] | undefined> {
  if (message.voice) {
    const bytes = await client.downloadFile(message.voice.file_id);
    const filename = `${message.voice.file_unique_id}.ogg`;
    writeFileSync(join(inboxDir(ownerUserId), filename), bytes);
    const transcript = await transcribeAudioBytesWithKeyFailover(db, ownerUserId, bytes, filename);
    return `[Voice note transcript]: ${transcript.text}`;
  }
  if (message.photo && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1]; // Bot API orders resolutions smallest -> largest
    const bytes = await client.downloadFile(largest.file_id);
    const filename = `${largest.file_unique_id}.jpg`;
    writeFileSync(join(inboxDir(ownerUserId), filename), bytes);
    const block = buildImageContentBlock(bytes, filename);
    const caption = message.caption?.trim();
    return [{ type: "text", text: caption ? caption : "[Photo attached, no caption]" }, block];
  }
  if (message.document) {
    const bytes = await client.downloadFile(message.document.file_id);
    const filename = message.document.file_name ?? `${message.document.file_unique_id}`;
    const savedPath = join(inboxDir(ownerUserId), filename);
    writeFileSync(savedPath, bytes);
    // Real gap fixed (jsonl-install.ts's own doc: "I can send it .jsonl it will automatically
    // detect it as skill" -- confirmed there was no actual call site anywhere; installing a
    // skill from an uploaded .jsonl required the MODEL to decide to call
    // install_skills_from_jsonl, which it wasn't reliably doing). A .jsonl upload is detected and
    // installed right here, in the real inbound-file path, before the model ever sees the turn --
    // same real behavior as voice/photo, which are already handled without the model's help.
    if (isJsonlSkillFile(filename)) {
      const result = installSkillsFromJsonl(ownerUserId, bytes.toString("utf8"), filename);
      const installedNames = result.installed.map((s) => `"${s.name}"`).join(", ");
      const errorLines = result.errors.map((e) => `line ${e.line}: ${e.message}`).join("; ");
      return (
        `[.jsonl skill file "${filename}" received and auto-installed]` +
        (result.installed.length > 0 ? ` Installed ${result.installed.length} skill(s): ${installedNames}.` : " No skills installed.") +
        (result.errors.length > 0 ? ` Errors: ${errorLines}.` : "") +
        ` Tell the user what was installed (and any errors) -- do not call install_skills_from_jsonl yourself, this file is already installed.`
      );
    }
    const isImage = /\.(png|jpe?g|gif|webp)$/i.test(filename);
    if (isImage) {
      const block = buildImageContentBlock(bytes, filename);
      const caption = message.caption?.trim();
      return [{ type: "text", text: caption ? caption : `[Image document "${filename}" attached]` }, block];
    }
    return `[Document received and saved to ${savedPath}]${message.caption ? ` Caption: ${message.caption}` : ""} -- use your sandbox file tools to read/process it.`;
  }
  return undefined;
}

/**
 * Real bug fixed (user: "Dave doesn't ask for a Groq API key" when a voice note comes in). This
 * used to always send the same generic "couldn't process that attachment" line for every
 * `buildInboundContent` failure -- which swallowed `NoGroqKeyError`'s own specific, actionable
 * message ("add one on the Credentials tab (or via add_provider_key)") -- exactly the same
 * "no stored keys" honest-message pattern already used for LLM providers
 * (error-messages.ts's `friendlyErrorMessage`), just never wired up here. A missing Groq key now
 * surfaces that real, specific prompt instead of a dead end; any other genuine failure (an
 * unsupported image format, Telegram's own file download failing) still gets the honest generic
 * fallback rather than a raw, confusing internal error string.
 */
export function attachmentErrorMessage(err: unknown): string {
  if (err instanceof NoGroqKeyError) return `⚠️ ${err.message}`;
  return "⚠️ Couldn't process that attachment. Try again in a moment.";
}

/** Real, persistent per-chat registry + loop cache -- rebuilding a full 130+-tool registry on every single message would be wasteful. */
const registryCache = new Map<string, ToolRegistry>();

export function getOrBuildRegistry(deps: TelegramBotServerDeps, client: TelegramClient, chatId: number): ToolRegistry {
  // Keyed by chat too -- push_message_to_user/send_telegram etc. bind to a
  // specific chatId, so a registry built for one chat can't be reused for
  // another, even though both share the same owner account/tools/db.
  const key = `${deps.ownerUserId}:${chatId}`;
  if (!registryCache.has(key)) {
    registryCache.set(
      key,
      buildFullToolRegistry({
        userId: deps.ownerUserId,
        db: deps.db,
        executor: deps.executor,
        telegram: { client, chatId },
        publicBaseUrl: deps.publicBaseUrl,
      })
    );
  }
  return registryCache.get(key)!;
}

/**
 * Starts the real webhook server AND registers it with Telegram
 * (setWebhook) -- from this point on, Telegram itself pushes every
 * update straight to this process; the bot is online for as long as
 * this process stays up, with no poll loop required.
 */
export async function startTelegramBotServer(deps: TelegramBotServerDeps): Promise<TelegramBotServer> {
  const client = new TelegramClient(deps.botToken);
  const registration = await enableTelegramWebhook(client, deps.ownerUserId, deps.publicBaseUrl);
  // Real gap fixed: registerDefaultCommandMenu (setMyCommands) only
  // ever existed as a tool Dave itself could choose to call -- nothing
  // called it automatically at startup, so the real 9 commands never
  // showed up in Telegram's native "/" menu on a fresh pairing. Best-
  // effort: a failure here must not block the bot from coming online.
  await registerDefaultCommandMenu(client).catch((err) => console.error(`[telegram] failed to register command menu: ${err instanceof Error ? err.message : String(err)}`));

  // Real gap fixed (STEP 7 re-verification): getMyDescription/getMyShortDescription
  // came back genuinely empty in production -- updateBotDisplayInfo() existed only
  // as a callable tool, nothing ever invoked it with real content. Best-effort,
  // same as the command menu above: never blocks the bot from coming online.
  await updateBotDisplayInfo(client, {
    description:
      "Dave is your autonomous MT5 trading assistant. Connect your account, and Dave watches your trades, " +
      "proposes and (with your approval) executes setups, and keeps you posted here in Telegram. " +
      "Send /menu to see everything Dave can do.",
    shortDescription: "Your autonomous MT5 trading assistant.",
  }).catch((err) => console.error(`[telegram] failed to set bot display info: ${err instanceof Error ? err.message : String(err)}`));

  // Real fix (F5): syncMorningBriefCron() fires a real cron on schedule,
  // but nothing ever called it with a real content-composing handler in
  // production -- it fired into nothing. Wired here, once, at startup,
  // bound to this process's real client so a scheduled brief actually
  // sends real balance/open-trades/watchlist content.
  wireMorningBrief({ db: deps.db, client, ownerUserId: deps.ownerUserId });

  // Real fix (Step 18 re-verification): all 6 feedback-loop jobs
  // (dreaming cron, trade-count reflection, weekly export, the weekly
  // feedback poll send) were genuinely real, tested code that nothing
  // in production ever called -- same class of gap as F5 above.
  wireFeedbackLoop({ db: deps.db, client, ownerUserId: deps.ownerUserId });

  const server = createTelegramWebhookServer({
    onUpdate: async (_userId: string, update: TelegramUpdate) => {
      // Real fix (Step 18.5 re-verification): a real `poll_answer` update
      // is how Telegram genuinely delivers a feedback poll's answer --
      // there is no separate inbound channel for it. `poll_id` (NOT
      // message_id) is what `sendFeedbackPoll` registered its webhook
      // token as, so this relays it straight to that same real handler
      // in-process (no fake HTTP round trip needed, same process).
      if (update.poll_answer) {
        const handled = await invokeWebhookTrigger(update.poll_answer.poll_id, { selectedOptionIndex: update.poll_answer.option_ids[0] });
        if (!handled) console.warn(`[telegram-bot-server] poll_answer for unknown/expired poll_id ${update.poll_answer.poll_id}`);
        return;
      }

      // Real fix (A3): every inline button press arrives as a
      // callback_query, not a message -- this used to be silently
      // dropped by the `if (!message?.text) return;` guard below,
      // leaving every settings toggle / approve-decline / EA picker
      // button completely dead. Routed to its real handler first.
      if (update.callback_query) {
        const cbChatId = update.callback_query.message?.chat.id;
        if (cbChatId !== undefined) recordActiveChat(deps.db, deps.ownerUserId, cbChatId);

        // Real gap fixed (mid-task delegation): the 3 real buttons a delegation prompt sends
        // need runAgentTurn/createWorker, which only this module (not command-router.ts) has
        // in scope -- intercepted here, before the generic dispatchCallback.
        const delegateData = update.callback_query.data ?? "";
        if (delegateData.startsWith("delegate:") && cbChatId !== undefined) {
          // Real bug fixed (user, live: two messages minutes apart got answered "bundled"
          // together -- root-caused in part to this queue silently holding only the LAST
          // message while an earlier one waited on this exact button prompt). Every message
          // that queued up while busy is processed now, in order, not just the newest one.
          const queue = getPendingDelegationQueue(deps.ownerUserId);
          clearPendingDelegation(deps.ownerUserId);
          const action = delegateData.slice("delegate:".length);
          if (queue.length === 0) {
            await client.answerCallbackQuery({ callback_query_id: update.callback_query.id, text: "That request is no longer waiting" }).catch(() => undefined);
            return;
          }
          const pending = queue[0];
          if (action === "skip") {
            await client.answerCallbackQuery({ callback_query_id: update.callback_query.id, text: "Skipped" }).catch(() => undefined);
            await client.sendMessage({ chat_id: pending.chatId, text: queue.length > 1 ? `Skipped all ${queue.length} -- let me know if you still need any of that.` : "Skipped -- let me know if you still need that." });
          } else if (action === "worker") {
            await client.answerCallbackQuery({ callback_query_id: update.callback_query.id, text: "Assigning a worker" }).catch(() => undefined);
            for (const item of queue) {
              const worker = createWorker(deps.ownerUserId, { assignment: "temporary", role: "generic", task: item.text });
              sendCommsMessage(deps.ownerUserId, DAVE_PARTICIPANT_ID, worker.id, item.text);
              await client.sendMessage({ chat_id: item.chatId, text: `Handed to ${worker.name} (#${worker.name.toLowerCase()}) -- I'll keep going on what I was doing.` });
            }
          } else if (action === "pause") {
            await client.answerCallbackQuery({ callback_query_id: update.callback_query.id, text: "Pausing to handle it now" }).catch(() => undefined);
            await client.sendMessage({ chat_id: pending.chatId, text: queue.length > 1 ? `Pausing what I was doing -- on all ${queue.length}, in order.` : "Pausing what I was doing -- on it now." });
            // Real bug fixed (independent audit, confirmed): this used to start runAgentTurn for
            // the queued message(s) immediately on the button tap, assuming the ORIGINAL turn
            // (still possibly mid-loop.run()) had already finished. It hadn't necessarily -- both
            // calls then load/save conversation-store.ts history around the same window and
            // whichever save lands last silently overwrites the other's real exchange. Genuinely
            // wait for the original turn's busy flag to actually clear first, so the two
            // load/save cycles are sequential, not concurrent -- see waitForBusyToClear's own
            // reasoning in busy-state.ts.
            const wait = await waitForBusyToClear(deps.ownerUserId);
            if (!wait.cleared) {
              console.warn(`[delegate:pause] ${deps.ownerUserId}: proceeding without confirmed clear after ${wait.waitedMs}ms -- see waitForBusyToClear warning above`);
            }
            // See collapseQueuedMessages in delegation.ts for the real bug this fixes: a
            // separate full agent turn per queued message, which is how three messages sent
            // minutes apart became three back-to-back turns that each re-answered from scratch.
            for (const collapsed of collapseQueuedMessages(queue)) {
              const historyKeyForPending = `${deps.ownerUserId}:${collapsed.chatId}`;
              await runAgentTurn(deps, client, collapsed.chatId, historyKeyForPending, collapsed.text, collapsed.text);
            }
          }
          return;
        }

        // Real gap fixed (item 7: inline-button ask_user answers were never received/processed
        // -- this callback_data prefix had NO handler anywhere, so a tap silently did nothing).
        // Intercepted here (not in command-router's generic dispatchCallback) because resuming
        // the paused loop needs runAgentTurn, which only this module has in scope.
        const askUserData = update.callback_query.data ?? "";
        if (askUserData.startsWith("askuser:") && cbChatId !== undefined) {
          const [, toolCallId, indexStr] = askUserData.split(":");
          const pendingQuestion = getPendingQuestion(deps.ownerUserId);
          const historyKeyForAskUser = `${deps.ownerUserId}:${cbChatId}`;
          const history = loadConversationHistory(deps.db, historyKeyForAskUser);
          const actualToolCallId = findPendingAskUserToolCallId(history);
          if (!pendingQuestion || actualToolCallId !== toolCallId) {
            await client.answerCallbackQuery({ callback_query_id: update.callback_query.id, text: "That question is no longer waiting" }).catch(() => undefined);
            return;
          }
          const chosen = pendingQuestion.options?.[Number(indexStr)];
          if (chosen === undefined) {
            await client.answerCallbackQuery({ callback_query_id: update.callback_query.id, text: "That option expired -- please answer in a message" }).catch(() => undefined);
            return;
          }
          await client.answerCallbackQuery({ callback_query_id: update.callback_query.id, text: `Picked: ${chosen}` }).catch(() => undefined);
          await client.sendMessage({ chat_id: cbChatId, text: `You picked: ${chosen}` });
          await runAgentTurn(deps, client, cbChatId, historyKeyForAskUser, chosen, chosen);
          return;
        }

        // Real gap fixed (user: "/start_trading, /stop_trading, /panic should be... added to the
        // menu UI"): the /menu screen's buttons for these tap through as menucmd:<command> --
        // routed to the exact same real handler the typed command uses (handleTradingControlCommand),
        // not the generic command-router switch (which has no case for these three; the real
        // logic lives only here, where the live autonomous-cycle closure/runAgentTurn are in scope).
        const menuCmdData = update.callback_query.data ?? "";
        if (/^menucmd:(start_trading|stop_trading|stop|panic)$/.test(menuCmdData) && cbChatId !== undefined) {
          const command = menuCmdData.slice("menucmd:".length);
          await client.answerCallbackQuery({ callback_query_id: update.callback_query.id }).catch(() => undefined);
          await handleTradingControlCommand(deps, client, cbChatId, `/${command}`);
          return;
        }

        const routerDeps: CommandRouterDeps = { db: deps.db, client, userId: deps.ownerUserId, publicBaseUrl: deps.publicBaseUrl, executor: deps.executor };
        await dispatchCallback(routerDeps, update.callback_query);
        return;
      }

      const message = update.message;
      // Real fix (Step 15 re-verification): this used to be
      // `if (!message?.text) return;`, silently dropping every voice
      // note, photo, and document Telegram ever delivered -- real
      // transcription/vision code existed but nothing here called it.
      if (!message || (!message.text && !message.voice && !message.photo && !message.document)) return;
      // Real interrupt wiring (user, live, this session): a real incoming user message must
      // immediately interrupt an in-flight autonomous trading tick, not queue up alongside it
      // unaware. Called unconditionally, at the very top of the real genuine-message path --
      // before any busy check, command dispatch, or runAgentTurn -- so nothing about this
      // message's own handling can ever delay it. abortTurn() aborts EVERY controller currently
      // tracked for this owner (turn-abort.ts's real Set-based design), so this is a harmless,
      // safe no-op when nothing is running (confirmed: abortTurn returns false in that case) and
      // never touches a controller belonging to a genuinely different turn class -- it just
      // cancels whatever was in flight, tick included. The user's OWN new turn then gets its own
      // fresh controller a few lines below via runAgentTurn's existing beginTurn() call -- calling
      // abortTurn() here first, then beginTurn() for the new turn right after, is safe: they touch
      // the same per-user Set but at different times, with nothing concurrent between them, so
      // there is no race between "cancel what was running" and "start what's new."
      abortTurn(deps.ownerUserId);
      const chatId = message.chat.id;
      // Real fix (F5): the morning brief (and any other schedule-driven
      // push) has no incoming update to read a chatId off of -- this is
      // what gives it somewhere real to send to.
      recordActiveChat(deps.db, deps.ownerUserId, chatId);
      // Conversation history is scoped per-chat (a group chat or a second
      // person messaging the same bot shouldn't see each other's history),
      // even though tools/credentials are shared across the one owner account.
      const historyKey = `${deps.ownerUserId}:${chatId}`;

      // Real gap fixed: SECURITY.md documents "/stop or /panic from the user is an instant,
      // unconditional halt" as if these were real commands. Also covers /start_trading and
      // /stop_trading (the real autonomous-cycle on/off switch). Checked FIRST, before command
      // dispatch and everything else, so none of these can ever be delayed behind any other
      // handling -- and shared with the /menu button-tap path below (handleTradingControlCommand),
      // so tapping ▶️ Start trading does exactly the same real thing as typing it.
      if (message.text && (await handleTradingControlCommand(deps, client, chatId, message.text.trim()))) {
        return;
      }

      // Real fix (A2): the 9 slash commands used to fall straight
      // through to the LLM like any other message -- no live router
      // ever intercepted them. dispatchCommand() handles all 9 for
      // real (including /reset -> clearConversationHistory()) and
      // returns true when it did, so a recognized command never
      // reaches the agent loop below.
      if (message.text && isDaveCommand(message.text)) {
        const routerDeps: CommandRouterDeps = { db: deps.db, client, userId: deps.ownerUserId, publicBaseUrl: deps.publicBaseUrl, executor: deps.executor };
        const handled = await dispatchCommand(routerDeps, chatId, historyKey, message.text);
        if (handled) return;
      }

      // Real fix ("fetch the models like v1 model so I can select as well"): /models on a
      // manual-entry provider (OpenRouter/OrcaRouter/HuggingFace) asks the user to reply with
      // the model ID as their next message -- this is that capture, checked before anything
      // free-text falls through to the LLM.
      if (message.text) {
        const routerDeps: CommandRouterDeps = { db: deps.db, client, userId: deps.ownerUserId, publicBaseUrl: deps.publicBaseUrl, executor: deps.executor };
        if (await tryHandlePendingModelEntry(routerDeps, chatId, message.text)) return;
        if (await tryHandlePendingVoiceEntry(routerDeps, chatId, message.text)) return;
        if (await tryHandlePendingKeyEntry(routerDeps, chatId, message.text)) return;
        if (await tryHandlePendingTtsKeyEntry(routerDeps, chatId, message.text)) return;
        if (await tryHandlePendingE2BKeyEntry(routerDeps, chatId, message.text)) return;
        if (await tryHandlePendingLimitEntry(routerDeps, chatId, message.text)) return;
        if (await tryHandlePendingRiskEntry(routerDeps, chatId, message.text)) return;
        if (await tryHandlePendingTrailingEntry(routerDeps, chatId, message.text)) return;
        if (await tryHandlePendingMcpUrlEntry(routerDeps, chatId, message.text)) return;
        if (await tryHandlePendingActivePairEntry(routerDeps, chatId, message.text)) return;
        if (await tryHandlePendingConfidenceEntry(routerDeps, chatId, message.text)) return;
        if (await tryHandlePendingFirecrawlKeyEntry(routerDeps, chatId, message.text)) return;
        if (await tryHandlePendingLovableMcpEntry(routerDeps, chatId, message.text)) return;
        if (await tryHandlePendingMcpServerEntry(routerDeps, chatId, message.text)) return;
        if (await tryHandlePendingPushIntervalEntry(routerDeps, chatId, message.text)) return;
        // Item 11: a typed "yes"/"no" answering a real pending settings-change approval is
        // handled here, BEFORE the agent loop ever sees it -- otherwise the model has no way
        // to know an approval is already pending and could re-propose the same change, sending
        // a SECOND UI prompt on top of the first real one.
        if (await tryHandlePendingApprovalReply(routerDeps, chatId, message.text)) return;
      }

      // Real gap fixed: a genuine slash command that ISN'T one of the 9 (mistyped, or an old
      // removed one) used to silently fall through to the LLM as ordinary conversation instead
      // of telling the user it wasn't recognized. Checked after the pending-entry captures above
      // so an in-progress manual model/voice entry is never misread as an unknown command.
      if (message.text && looksLikeSlashCommand(message.text) && !isDaveCommand(message.text)) {
        await client.sendMessage({ chat_id: chatId, text: "Unknown command -- send /help for the full list." });
        return;
      }

      // Real gap fixed: BootstrapFlow (dave-core, exactly matches prompts/BOOTSTRAP.md) was
      // fully built and tested but never triggered against a real Telegram message -- pairing
      // confirmation now starts it (telegram-otp.ts), and this is the other half: every
      // free-text message is fed through it first. handleMessage() itself is a real no-op
      // (returns false immediately) once onboarding is "not-started" or "complete", so this is
      // safe to call unconditionally on every message, not just during a real onboarding window.
      if (message.text) {
        const bootstrapTransport: Transport = { send: async (_userId, text) => { await client.sendMessage({ chat_id: chatId, text }); } };
        if (await new BootstrapFlow(bootstrapTransport).handleMessage(deps.ownerUserId, message.text)) return;
      }

      let userContent: string | ContentBlock[];
      if (message.text) {
        userContent = message.text;
      } else {
        try {
          const built = await buildInboundContent(client, message, deps.ownerUserId, deps.db);
          if (built === undefined) return; // genuinely nothing usable came through (shouldn't happen given the guard above)
          userContent = built;
        } catch (err) {
          // A real, honest failure -- e.g. no stored Groq key yet, an
          // unsupported image format, or Telegram's file download
          // itself failing -- must tell the user why, not silently drop
          // the message or crash the process.
          console.error("[telegram-bot-server] failed to process attachment:", err);
          await client.sendMessage({ chat_id: chatId, text: attachmentErrorMessage(err) });
          return;
        }
      }

      // Real gap fixed (user: "Dave doesn't just silently switch or silently ignore" a new
      // request that arrives while busy with something else). Checked only for genuinely
      // concurrent overlap -- setBusy()/clearBusy() bracket the real agent-loop run below, so
      // this is only ever true if a second webhook delivery lands while the first is still
      // in flight, not on every message.
      const busy = message.text ? getBusyState(deps.ownerUserId) : null;
      if (busy && message.text) {
        // Real bug fixed (user, live: two messages minutes apart got answered "bundled"
        // together, root-caused in part to an earlier queued message being silently discarded
        // by a THIRD arriving before either got answered). Every message queues now, but only
        // the FIRST one still waiting gets the button prompt -- a second/third arrival while
        // one is already pending just confirms it's been added, not another full prompt.
        const alreadyQueued = getPendingDelegationQueue(deps.ownerUserId).length > 0;
        addPendingDelegation(deps.ownerUserId, { text: message.text, chatId });
        if (alreadyQueued) {
          await client.sendMessage({ chat_id: chatId, text: "Got it -- queued behind what's already waiting on your answer above." });
        } else {
          const prompt = buildDelegationPrompt(busy);
          await client.sendMessage({ chat_id: chatId, text: prompt.text, reply_markup: prompt.reply_markup });
        }
        return;
      }

      await runAgentTurn(deps, client, chatId, historyKey, userContent, message.text);
    },
  });

  // Real bug fixed (user, live: "it's not analyzing any [expletive] thing" -- reported right
  // after a routine deploy). Root cause confirmed: startAutonomousTradingLoop's setInterval is
  // purely in-memory -- every deploy/restart is a fresh process, so a real, live autonomous
  // trading run silently dies with every single deploy, with no resume and no notification. If
  // the user's real, persisted intent (autonomous-trading-state.ts) says trading should be on,
  // genuinely re-arm it here, at boot, against the last chat we know they actually messaged from
  // (primary-chat.ts) -- and tell them it happened, so a restart is never silently invisible.
  if (isAutonomousTradingEnabled(deps.ownerUserId)) {
    // Real bug fixed (user, live: three straight "previous autonomous cycle is still running"
    // skips after this exact resume block ran, one full minute apart, with zero real cycles
    // executing -- confirmed via Railway logs on the deploy that shipped this same file). Root
    // cause: busy-autonomous.json is written to the persistent volume, so a process that gets
    // killed mid-cycle by a deploy leaves it behind. The NEXT process reads that stale record
    // here, at boot, and treats it as a real in-flight cycle -- even though the process that set
    // it no longer exists and nothing else in this fresh process could possibly have started one
    // yet. It used to only self-heal after MAX_AUTONOMOUS_BUSY_AGE_MS (6 minutes), so every
    // redeploy cost up to 6 minutes of a fully alive loop producing zero decisions. A fresh boot
    // can never have a real autonomous cycle already in flight from before it existed, so clear it
    // unconditionally right here, before the loop is re-armed.
    clearAutonomousBusy(deps.ownerUserId);
    const resumeChatId = getPrimaryChatId(deps.db, deps.ownerUserId);
    if (resumeChatId !== undefined) {
      // Real gap fixed (a dedicated investigation subagent, live: boot-resume never passed the
      // `intervalMs=0` fire-immediately override that /start_trading already uses for a fresh
      // start -- see that call below). Without it, `lastRunAt` starts at `Date.now()` and the
      // first cycle after every single redeploy silently waits out a full configured interval
      // before firing at all, right when the user most wants live confirmation the loop survived
      // the restart. Fires the first cycle immediately instead, same as /start_trading does.
      const started = startAutonomousTradingLoop(deps.ownerUserId, () => runAutonomousTradingCycle(deps, client, resumeChatId), 0);
      if (started) {
        void client.sendMessage({ chat_id: resumeChatId, text: "🔄 Resumed autonomous trading after a restart -- I'm back to actively scanning." }).catch(() => undefined);
      }
    } else {
      console.error(`[trading-loop] autonomous trading was enabled for ${deps.ownerUserId} but no primary chat is known yet -- cannot resume until the user messages Dave at least once`);
    }
  }

  // Dave's own background checks (mark_level / check_marked_levels / cancel_marked_level). Started
  // unconditionally rather than only alongside autonomous trading: a marked level is Dave watching
  // something for the trader, and it should keep watching whether or not the hunting loop happens
  // to be on. Survives restarts because the watches themselves are persisted -- this only re-arms
  // the timer that evaluates them.
  startWatchSweep({
    userId: deps.ownerUserId,
    analysis: createEaAnalysisSource(deps.ownerUserId),
    notify: async (text) => {
      const chatId = getPrimaryChatId(deps.db, deps.ownerUserId);
      if (chatId === undefined) return;
      await client.sendMessage({ chat_id: chatId, text }).catch(() => undefined);
    },
  });

  return { server, webhookUrl: `${deps.publicBaseUrl}${registration.path}`, client };
}
