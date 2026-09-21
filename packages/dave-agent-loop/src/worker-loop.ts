import type { DaveDatabase } from "@dave/db";
import type { TradeExecutor, AnalysisSource } from "@dave/trading";
import { markdownToTelegramHtml, sendSelfDeletingMessage, type TelegramClient } from "@dave/telegram";
import { type Worker, toolsForWorker, JOURNAL_TOOLS, WORKER_TOOL_REQUEST_TOOLS, reportToUser, sendMessage as sendCommsMessage, DAVE_PARTICIPANT_ID, getGrantedToolNames, retireWorker } from "@dave/workers";
import { logTrade } from "@dave/feedback";
import { E2B_TOOLS } from "@dave/e2b";
import { ToolRegistry, adaptTools, type AgentTool } from "./tool-registry.js";
import { AgentLoop } from "./agent-loop.js";
import { modelConfigProvider } from "./provider-selection.js";
import { beginTurn, endTurn } from "./turn-abort.js";

/**
 * The real worker execution engine (user: "build a real worker execution loop"). Before this, a
 * worker was a bookkeeping record only -- `create_subagent` wrote a row and nothing ever ran it.
 * `runWorkerTask` gives a worker its own real, restricted `ToolRegistry` (Update 7's tested
 * trade-placing-exclusion semantics, reused as-is via `toolsForWorker`) and a real `AgentLoop` over
 * the owner's own configured provider chain -- a genuine multi-step agent run, not a simulation.
 *
 * Deliberately narrow tool grant, matching the already-tested `toolsForWorkerWithGrants` model: a
 * worker starts with its base tools (all TRADING_TOOLS except trade-placing, unless it's a
 * "trading" role worker) plus `request_tool`/`check_my_tool_requests` -- anything else (E2B,
 * image generation, etc.) must be explicitly requested and granted by Dave through the existing
 * real request/grant exchange (tool-requests.ts), which is synced live into this run's own
 * registry every step -- no restart needed for a mid-task grant to take effect (same mechanism
 * Update 7's step28 test already proved for AgentLoop.run()'s per-iteration `toSpecs()` re-read).
 *
 * Real gap closed alongside this: `reportToUser`/`readWorkerReports` (report-to-user.ts) were real
 * and tested for their own webhook/inbox round trip, but NOTHING ever forwarded that inbox to the
 * live Telegram chat -- a worker's real report never reached the user. Since this loop runs
 * in-process with a live Telegram client, its own `report_to_user` tool now does BOTH: the real
 * webhook round trip (kept, for anything that reads the inbox later) AND a direct
 * `client.sendMessage` so the user genuinely sees it immediately.
 */
export interface RunWorkerTaskParams {
  db: DaveDatabase;
  ownerUserId: string;
  analysis: AnalysisSource;
  executor: TradeExecutor;
  publicBaseUrl: string;
  client: TelegramClient;
  chatId: number;
  worker: Worker;
  task: string;
  /** The owner's own full tool registry -- the source of truth a granted tool name is resolved
   *  against, already bound with the owner's real ctx (db/analysis/executor/telegram). */
  fullRegistry: ToolRegistry;
}

// Guards against a worker being kicked off twice concurrently (e.g. a duplicate/retried
// create_subagent call) -- same pattern as trading-loop.ts's activeIntervals guard.
const activeRuns = new Set<string>();

export async function runWorkerTask(params: RunWorkerTaskParams): Promise<void> {
  const { db, ownerUserId, analysis, executor, publicBaseUrl, client, chatId, worker, task, fullRegistry } = params;
  if (activeRuns.has(worker.id)) return;
  activeRuns.add(worker.id);
  const tag = `#${worker.name.toLowerCase()}`;

  try {
    const tradingCtx = { userId: ownerUserId, analysis, executor };
    const liveRegistry = new ToolRegistry();
    liveRegistry.register(adaptTools(toolsForWorker(worker), tradingCtx));
    if (worker.role === "journal") {
      liveRegistry.register(adaptTools(JOURNAL_TOOLS, { userId: ownerUserId, onTradeLogged: (input) => logTrade(db, ownerUserId, input) }));
    }
    liveRegistry.register(adaptTools(WORKER_TOOL_REQUEST_TOOLS, { ownerUserId, workerId: worker.id }));
    // Real script capability, granted to every subagent by default (the trader: "expand the
    // background tool and the subtask so it can run any script to check for anything in the
    // market"). This is deliberately NOT routed through the request/grant exchange the way other
    // extra tools are: a subagent whose whole job is "go measure this" is useless if it has to
    // stop and ask permission to compute. Only run_script is granted -- E2B key management stays
    // Dave's, so a worker can run code but can never add, read, or delete a stored key.
    const workerRunScript = E2B_TOOLS.find((t) => t.name === "run_script");
    if (workerRunScript) liveRegistry.register(adaptTools([workerRunScript], { userId: ownerUserId, db }));

    const reportTool: AgentTool = {
      name: "report_to_user",
      description: `Send a real update straight to the user, tagged "${tag}" -- use this for genuinely meaningful progress or results, not every micro-step.`,
      parameters: { type: "object", properties: { content: { type: "string" } }, required: ["content"] },
      execute: async (args) => {
        const content = args.content as string;
        await reportToUser(worker, content, publicBaseUrl);
        // Real gap fixed (item 2, same class as the "<b>" bug): worker reports never routed
        // through the real markdown/HTML converter at all -- a worker's own markdown or literal
        // HTML tags would have leaked to the user completely raw, unconverted.
        await client.sendMessage({ chat_id: chatId, text: markdownToTelegramHtml(`${tag}: ${content}`), parse_mode: "HTML" });
        return { ok: true };
      },
    };
    const messageDaveTool: AgentTool = {
      name: "message_dave",
      description: "Send a message directly to Dave (not the user) -- e.g. handing off a finding or a question only Dave should weigh in on.",
      parameters: { type: "object", properties: { content: { type: "string" } }, required: ["content"] },
      execute: async (args) => sendCommsMessage(ownerUserId, worker.id, DAVE_PARTICIPANT_ID, args.content as string),
    };
    liveRegistry.register([reportTool, messageDaveTool]);

    // Real live-grant sync: re-checked every step of the loop (agent-loop.ts's run() re-reads
    // `this.registry.toSpecs()` fresh each iteration), so a tool Dave grants mid-task becomes
    // callable on the worker's very next step -- no restart.
    const onStep = () => {
      for (const name of getGrantedToolNames(ownerUserId, worker.id)) {
        if (liveRegistry.has(name)) continue;
        const tool = fullRegistry.list().find((t) => t.name === name);
        if (tool) liveRegistry.register([tool]);
      }
    };

    const provider = modelConfigProvider(db, ownerUserId, async (text, options) => {
      const params = { chat_id: chatId, text: markdownToTelegramHtml(`${tag} (provider): ${text}`), parse_mode: "HTML" as const };
      if (options?.transientMs) {
        await sendSelfDeletingMessage(client, params, options.transientMs).catch(() => undefined);
        return;
      }
      await client.sendMessage(params);
    });
    const loop = new AgentLoop(provider, liveRegistry);

    const systemPrompt = `You are ${worker.name}, a real subagent Dave created to help its user. Your standing assignment: ${worker.task}\n\nYour current task right now: ${task}\n\nYou have run_script: you can write and run real code (bash/python/node, with network access) in a disposable sandbox, pass files into it and get files back out. Use it whenever the task is measurable by code -- pull a live feed, compute an indicator, backtest a rule, parse data the user sent, check a number before you quote it -- rather than estimating.

Use report_to_user whenever you have something genuinely worth telling the user. If you need a tool you weren't given, call request_tool and explain why -- don't guess or make something up. When you're finished, answer in plain text summarizing what you actually did.`;

    // Real gap fixed (independent audit, same class as telegram-bot-server.ts's runAgentTurn
    // fix): a worker's own AgentLoop.run() never registered itself with turn-abort.ts at all, so
    // /stop or /panic could never reach a genuinely stuck worker -- only AgentLoop's own baked-in
    // default overall deadline (~4 minutes) would eventually end it. Mirrors runAgentTurn exactly:
    // beginTurn before the run, the resulting signal passed into run(), endTurn in a finally.
    const abortController = beginTurn(ownerUserId);
    let resultText: string;
    try {
      const result = await loop.run(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: task },
        ],
        // Real cap removed (the trader: "give it uncountable max steps so it knows, like the way
        // you are"). A subagent was capped at 12 steps while Dave's own turns have been uncounted
        // (`maxSteps ?? Infinity`) since the earlier "no max step, unlimited max step" fix -- so a
        // worker given real work (run a script, read its output, fix it, re-run, then report) ran
        // out of steps mid-task and died with MaxStepsExceededError rather than finishing. The
        // real ceiling is the overall wall-clock deadline plus /stop, both still in force below --
        // step count was never the thing protecting anything.
        { onStep, signal: abortController.signal }
      );
      if (result.status === "aborted") {
        console.log(`[turn-abort] ${ownerUserId}: worker "${worker.name}" (${worker.id}) genuinely stopped (reason=${result.reason})`);
        resultText = `⏹️ ${tag} stopped -- that task was cancelled.`;
      } else {
        resultText = result.status === "done" ? result.text : `${tag} paused waiting on a question it isn't allowed to ask on its own -- stopping.`;
      }
    } catch (err) {
      resultText = `⚠️ ${tag} hit a real error and stopped: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      endTurn(ownerUserId, abortController);
    }

    if (resultText.trim().length > 0) {
      await client.sendMessage({ chat_id: chatId, text: markdownToTelegramHtml(`${tag}: ${resultText}`), parse_mode: "HTML" });
    }

    if (worker.assignment === "temporary") retireWorker(ownerUserId, worker.id);
  } finally {
    activeRuns.delete(worker.id);
  }
}
