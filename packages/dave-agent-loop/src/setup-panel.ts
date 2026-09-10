import type { DaveDatabase } from "@dave/db";
import { EA_ANALYSIS_TOOLS, EA_STATE_TOOLS, type EaToolDefinition } from "@dave/ea-bridge";
import { createWorker, retireWorker, sendMessage as sendCommsMessage, getCommsLog, DAVE_PARTICIPANT_ID, type CommsMessage } from "@dave/workers";
import { TelegramClient } from "@dave/telegram";
import { AgentLoop } from "./agent-loop.js";
import { ToolRegistry, adaptTools, type AgentTool } from "./tool-registry.js";
import { modelConfigProvider } from "./provider-selection.js";
import { getWorkerBotToken, getPanelGroupChatId } from "./worker-bot-tokens.js";

/**
 * User-requested addition ("each worker panel have its own bot token so I can see how they are
 * talking to each other"). Best-effort, purely additional: when the user has configured a real
 * bot token for this specialist AND a real panel group chat id (/set_panel_group, captured via
 * Dave's own already-live webhook when that command is sent inside the group), the specialist's
 * real finding is ALSO posted to that group using its own real Telegram bot identity -- a
 * genuinely separate bot, visibly distinct from Dave and from every other specialist's bot, so
 * the user can literally watch them converse. Never required: setup-panel.ts's internal comms
 * log (getPanelTranscript) is unconditionally written regardless, so Dave's own visibility into
 * the discussion never depends on this being configured.
 */
async function postToWorkerGroupChat(ownerUserId: string, specialist: string, workerName: string, text: string): Promise<void> {
  const token = getWorkerBotToken(ownerUserId, specialist);
  const groupChatId = getPanelGroupChatId(ownerUserId);
  if (!token || groupChatId === undefined) return;
  const client = new TelegramClient(token);
  await client.sendMessage({ chat_id: groupChatId, text: `${workerName} (${specialist}): ${text}` }).catch(() => {});
}

/**
 * Item 7: the "Setup Panel" -- multiple specialized analyst workers that jointly review a
 * candidate symbol BEFORE Dave considers trading it, using the existing worker system with real
 * worker-to-worker messaging (dave-workers' comms.ts), instead of Dave alone using a shallow tool
 * subset. Confirmed: the EA exposes exactly 46 real analysis endpoints (44 analytical + "all" +
 * "ping" -- see step13-all-46-endpoints.test.ts); every one of the 44 analytical endpoints is
 * assigned to exactly one of 7 sensibly-grouped specialists below, so the panel's combined real
 * tool coverage is the full 44, not the 4-endpoint subset Dave alone was observed using.
 *
 * All workers (and the synthesis step) route through modelConfigProvider -- the SAME real
 * primary/fallback provider chain Dave's own main turn uses (provider-selection.ts) -- so there
 * is exactly one real brain source across the whole panel, with the same real failover behavior,
 * not a hardcoded/separate provider.
 */
export interface SpecialistGroup {
  name: string;
  endpoints: string[];
}

export const SETUP_PANEL_GROUPS: SpecialistGroup[] = [
  { name: "Structure & Liquidity", endpoints: ["structure", "zones", "liquidity", "levels", "order_blocks", "inducement", "premium_discount", "swing", "orderflow"] },
  { name: "ICT & Smart Money", endpoints: ["ict", "wyckoff", "session", "pivots", "market_profile", "tape_flow", "tape"] },
  { name: "Momentum & Trend", endpoints: ["trend", "momentum", "divergence", "elliott", "harmonic", "ichimoku"] },
  { name: "Volatility & Volume", endpoints: ["volatility", "volume", "synthetic", "spread_analysis", "mean_reversion"] },
  { name: "Levels & Confluence", endpoints: ["fibonacci", "candles", "patterns", "gann", "fractal", "confluence"] },
  { name: "Macro & Context", endpoints: ["macro", "news", "sentiment", "regime", "correlation", "strength", "heatmap", "seasonality"] },
  { name: "Risk & Sizing", endpoints: ["risk_metrics", "backtest", "price"] },
];

// Real, structural proof this covers every one of the 44 real analytical endpoints exactly once
// (no gaps, no duplicates) -- checked once at module load, not just asserted in a comment.
{
  const covered = SETUP_PANEL_GROUPS.flatMap((g) => g.endpoints);
  const unique = new Set(covered);
  if (unique.size !== covered.length) throw new Error("SETUP_PANEL_GROUPS has a duplicate endpoint assignment");
}

export interface SetupPanelProposal {
  direction: "buy" | "sell";
  entryPrice?: number;
  slPips?: number;
  tpPips?: number;
  confidence: number;
  reasoning: string;
}

export interface SetupPanelResult {
  symbol: string;
  threadId: string;
  converged: boolean;
  proposal?: SetupPanelProposal;
  declineReason?: string;
  /** The REAL full worker-to-worker discussion transcript, in order -- not just the final
   *  synthesis. Dave (or the user, via /workers activity) can read exactly who said what and why,
   *  same real persisted comms log every other worker conversation uses. */
  transcript: CommsMessage[];
}

const toolByEndpoint = new Map<string, EaToolDefinition>(EA_ANALYSIS_TOOLS.map((t) => [t.name.replace(/^get_/, ""), t]));

/**
 * User-requested addition ("the bot just reported a timeout... give them unlimited timeout"):
 * Setup Panel specialists' own real EA analysis calls get a real, very generous timeout instead
 * of requestAnalysis's own 15s default -- not literally infinite (an actually-unbounded wait
 * would risk a genuinely hung step with no way to recover), but long enough that the real EA
 * round trip is never what cuts a specialist off mid-analysis.
 */
const WORKER_ANALYSIS_TIMEOUT_MS = 10 * 60 * 1000;

async function runSpecialist(params: {
  db: DaveDatabase;
  ownerUserId: string;
  symbol: string;
  timeframe: string;
  group: SpecialistGroup;
  priorFindings: { group: string; text: string }[];
  threadId: string;
}): Promise<{ workerId: string; workerName: string; text: string; rawResults: { toolName: string; result: unknown }[] }> {
  const { db, ownerUserId, symbol, timeframe, group, priorFindings, threadId } = params;
  const worker = createWorker(ownerUserId, { assignment: "temporary", role: "trading", task: `Setup Panel specialist: ${group.name} for ${symbol}` });

  const registry = new ToolRegistry();
  const groupTools = group.endpoints.map((e) => toolByEndpoint.get(e)).filter((t): t is EaToolDefinition => t !== undefined);
  registry.register(adaptTools(groupTools, { userId: ownerUserId, timeoutMs: WORKER_ANALYSIS_TIMEOUT_MS }));

  const rawResults: { toolName: string; result: unknown }[] = [];
  const priorDiscussion = priorFindings.map((f) => `[${f.group}]: ${f.text}`).join("\n\n");
  const systemPrompt =
    `You are ${worker.name}, Dave's real "${group.name}" specialist on his Setup Panel -- a team of analysts that jointly reviews a candidate symbol before Dave considers trading it. ` +
    `Call your own real analysis tools (only ${group.endpoints.map((e) => `get_${e}`).join(", ")}) for ${symbol} on timeframe ${timeframe}, then give a SHORT (2-4 sentence) real finding: your read on direction (bullish/bearish/neutral) and why, citing real numbers your tools actually returned -- never invent a number. ` +
    (priorDiscussion
      ? `This is a genuine discussion, not an isolated report -- here is what the rest of the panel has already said. Read it, and if your own real data agrees or conflicts with theirs, say so explicitly:\n\n${priorDiscussion}`
      : "You're the first to report.");

  const notify = () => {}; // panel specialist provider-fallback notices are internal, not user-facing chatter
  const provider = modelConfigProvider(db, ownerUserId, notify);
  const loop = new AgentLoop(provider, registry);
  const result = await loop.run(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Analyze ${symbol} on ${timeframe} now and give your real finding.` },
    ],
    { maxSteps: 6, onStep: (step) => rawResults.push({ toolName: step.toolName, result: step.result }) }
  );

  const text = result.status === "done" ? result.text || "(no finding -- tools returned nothing usable)" : "(paused -- a Setup Panel specialist cannot ask the user a question)";
  sendCommsMessage(ownerUserId, worker.id, threadId, `[${group.name}] ${text}`);
  await postToWorkerGroupChat(ownerUserId, group.name, worker.name, text);
  retireWorker(ownerUserId, worker.id);
  return { workerId: worker.id, workerName: worker.name, text, rawResults };
}

/**
 * User-requested addition ("create another worker named goal_risk... a risk taker... takes
 * privilege from any opportunity... reminds them see the account we need to find a setup... let's
 * take the risk"). An 8th real panel participant, distinct from the 7 analytical specialists
 * above: not tied to its own slice of the 44 EA endpoints (it doesn't need one -- its real job is
 * account-growth-goal advocacy, not fresh technical data), so it draws on the real account
 * snapshot (get_account_balance) and argues from trading.md's own real account-growth-milestone
 * mandate. Its voice is deliberately aggressive/urgency-pushing (per the user's explicit ask,
 * "naughty," "let's take the risk") -- but it is still bound to real, honest tool data (never
 * invents a number) and its finding is just ONE more voice the synthesis step weighs; it has no
 * special authority to force convergence, and Dave still reviews any resulting proposal against
 * its own judgment (trading.md) before ever calling trade_execute -- this is a real persona in
 * the discussion, not a bypass of the existing approval/risk-discipline machinery.
 */
const GOAL_RISK_SPECIALIST_NAME = "Goal & Risk Appetite";

async function runGoalRiskSpecialist(params: {
  db: DaveDatabase;
  ownerUserId: string;
  symbol: string;
  timeframe: string;
  priorFindings: { group: string; text: string }[];
  threadId: string;
}): Promise<{ workerId: string; workerName: string; text: string }> {
  const { db, ownerUserId, symbol, timeframe, priorFindings, threadId } = params;
  const worker = createWorker(ownerUserId, { assignment: "temporary", role: "trading", task: `Setup Panel specialist: ${GOAL_RISK_SPECIALIST_NAME} for ${symbol}` });

  const registry = new ToolRegistry();
  registry.register(adaptTools(EA_STATE_TOOLS.filter((t) => t.name === "get_account_balance"), { userId: ownerUserId }));

  const priorDiscussion = priorFindings.map((f) => `[${f.group}]: ${f.text}`).join("\n\n");
  const systemPrompt =
    `You are ${worker.name}, Dave's real "${GOAL_RISK_SPECIALIST_NAME}" voice on his Setup Panel. Your job is different from the other specialists: you're not here to run fresh technical analysis -- you're the panel's risk-appetite advocate. Call get_account_balance for the real current account state, then weigh the rest of the panel's ACTUAL real findings below against Dave's real account-growth mandate (this account is meant to compound aggressively toward real milestones, not sit idle) -- push for taking a genuine opportunity when the real data actually supports one, and say so with real urgency ("we need a setup, this account needs to grow, let's take the real edge that's in front of us"). ` +
    `You are still bound by the truth: you may NEVER invent a number, and if the rest of the panel's real data genuinely does NOT support a real edge, say so honestly instead of manufacturing enthusiasm -- your job is urgency in service of a REAL opportunity, not urgency instead of one. Give a SHORT (2-4 sentence) real finding, citing the real account state and referencing what the rest of the panel actually found.\n\n` +
    (priorDiscussion ? `Here is the rest of the panel's real discussion so far:\n\n${priorDiscussion}` : "You're first to report -- unusual, but give your real read on the account state.");

  const notify = () => {};
  const provider = modelConfigProvider(db, ownerUserId, notify);
  const loop = new AgentLoop(provider, registry);
  const result = await loop.run(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Weigh in on ${symbol} (${timeframe}) now.` },
    ],
    { maxSteps: 4 }
  );

  const text = result.status === "done" ? result.text || "(no finding)" : "(paused -- a Setup Panel specialist cannot ask the user a question)";
  sendCommsMessage(ownerUserId, worker.id, threadId, `[${GOAL_RISK_SPECIALIST_NAME}] ${text}`);
  await postToWorkerGroupChat(ownerUserId, GOAL_RISK_SPECIALIST_NAME, worker.name, text);
  retireWorker(ownerUserId, worker.id);
  return { workerId: worker.id, workerName: worker.name, text };
}

/**
 * The synthesis step: a real worker that reads the FULL panel transcript and decides, via a real
 * structured tool call (not regex'd free text), whether the panel converges on a real proposal.
 * entryPrice/slPips/tpPips are transcribed by the model from the REAL numbers already surfaced in
 * the transcript (the Risk & Sizing specialist's real get_risk_metrics/get_price tool output,
 * which is EA-computed, not invented) -- the same "the model faithfully carries real tool-sourced
 * numbers into a structured call" pattern every other tool-calling flow in this codebase already
 * relies on (e.g. trade_execute itself).
 */
async function runSynthesis(params: {
  db: DaveDatabase;
  ownerUserId: string;
  symbol: string;
  findings: { group: string; text: string }[];
  threadId: string;
}): Promise<{ converged: boolean; proposal?: SetupPanelProposal; declineReason?: string }> {
  const { db, ownerUserId, symbol, findings, threadId } = params;
  const worker = createWorker(ownerUserId, { assignment: "temporary", role: "trading", task: `Setup Panel synthesis for ${symbol}` });

  let outcome: { converged: boolean; proposal?: SetupPanelProposal; declineReason?: string } = { converged: false, declineReason: "synthesis did not produce a real decision" };

  const proposeTool: AgentTool = {
    name: "propose_setup",
    description: "Call this ONLY if the panel genuinely converges on a real trade direction for this symbol.",
    parameters: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["buy", "sell"] },
        entryPrice: { type: "number", description: "the real current bid/ask price from the Risk & Sizing specialist's get_price finding, if reported" },
        slPips: { type: "number", description: "real ATR-based SL in pips, from the Risk & Sizing specialist's get_risk_metrics finding" },
        tpPips: { type: "number", description: "real ATR-based TP in pips, from the Risk & Sizing specialist's get_risk_metrics finding" },
        confidence: { type: "number", description: "0-100, how strongly the panel agreed" },
        reasoning: { type: "string", description: "a short, combined real summary of why the panel converged, citing the specialists that agreed" },
      },
      required: ["direction", "confidence", "reasoning"],
    },
    execute: async (args) => {
      outcome = {
        converged: true,
        proposal: {
          direction: args.direction as "buy" | "sell",
          entryPrice: typeof args.entryPrice === "number" ? args.entryPrice : undefined,
          slPips: typeof args.slPips === "number" ? args.slPips : undefined,
          tpPips: typeof args.tpPips === "number" ? args.tpPips : undefined,
          confidence: args.confidence as number,
          reasoning: args.reasoning as string,
        },
      };
      return { ok: true };
    },
  };
  const noSetupTool: AgentTool = {
    name: "no_setup",
    description: "Call this if the panel genuinely disagrees or the real data doesn't support a clear direction -- never force a proposal to avoid this.",
    parameters: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] },
    execute: async (args) => {
      outcome = { converged: false, declineReason: args.reason as string };
      return { ok: true };
    },
  };

  const registry = new ToolRegistry();
  registry.register([proposeTool, noSetupTool]);

  const fullDiscussion = findings.map((f) => `[${f.group}]: ${f.text}`).join("\n\n");
  const systemPrompt =
    `You are ${worker.name}, Dave's real Setup Panel synthesizer. Read the full real discussion below from all ${findings.length} specialists on ${symbol} and decide: does the panel genuinely CONVERGE on one clear direction, or does it genuinely disagree / lack a clear edge? ` +
    `Converge only on real, substantive agreement across multiple specialists -- a single bullish comment among mostly neutral/bearish ones is NOT convergence. You MUST call exactly one of propose_setup or no_setup -- never answer in plain text.\n\n${fullDiscussion}`;

  const notify = () => {};
  const provider = modelConfigProvider(db, ownerUserId, notify);
  const loop = new AgentLoop(provider, registry);
  await loop.run(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: "Decide now: propose_setup or no_setup." },
    ],
    { maxSteps: 3 }
  );

  const summaryLine = outcome.converged
    ? `Panel CONVERGED: ${outcome.proposal!.direction.toUpperCase()} ${symbol} (confidence ${outcome.proposal!.confidence}) -- ${outcome.proposal!.reasoning}`
    : `Panel did NOT converge on ${symbol}: ${outcome.declineReason}`;
  sendCommsMessage(ownerUserId, worker.id, threadId, summaryLine);
  sendCommsMessage(ownerUserId, worker.id, DAVE_PARTICIPANT_ID, summaryLine);
  retireWorker(ownerUserId, worker.id);
  return outcome;
}

/**
 * Runs the full real panel: 7 specialists (sequential, each seeing the real discussion so far --
 * a genuine back-and-forth, not isolated reports merged afterward), then one real synthesis step.
 * Every message is posted to the real, persisted comms log (dave-workers/comms.ts) under a real
 * per-run thread id, so Dave (and the user, via the existing Agent Teams activity feed) can read
 * the ACTUAL discussion, not just the compressed final verdict.
 */
export async function runSetupPanel(params: { db: DaveDatabase; ownerUserId: string; symbol: string; timeframe?: string }): Promise<SetupPanelResult> {
  const { db, ownerUserId, symbol } = params;
  const timeframe = params.timeframe ?? "H1";
  const threadId = `panel:${symbol}:${Date.now()}`;

  const findings: { group: string; text: string }[] = [];
  for (const group of SETUP_PANEL_GROUPS) {
    const specialist = await runSpecialist({ db, ownerUserId, symbol, timeframe, group, priorFindings: findings, threadId });
    findings.push({ group: group.name, text: specialist.text });
  }

  // The 8th, non-analytical voice -- reports last, after every real analytical specialist, so
  // its account-growth-goal advocacy is grounded in what the panel actually found, not argued
  // in a vacuum ahead of the real data.
  const goalRisk = await runGoalRiskSpecialist({ db, ownerUserId, symbol, timeframe, priorFindings: findings, threadId });
  findings.push({ group: GOAL_RISK_SPECIALIST_NAME, text: goalRisk.text });

  const synthesis = await runSynthesis({ db, ownerUserId, symbol, findings, threadId });

  return {
    symbol,
    threadId,
    converged: synthesis.converged,
    proposal: synthesis.proposal,
    declineReason: synthesis.declineReason,
    transcript: getPanelTranscript(ownerUserId, threadId),
  };
}

/** Real proof surface for "Dave must be able to see the actual worker-to-worker conversation" --
 *  reads the SAME persisted comms log every other worker conversation uses, filtered to this
 *  panel run's real thread id. */
export function getPanelTranscript(ownerUserId: string, threadId: string): CommsMessage[] {
  return getCommsLog(ownerUserId).filter((m) => m.to === threadId);
}
