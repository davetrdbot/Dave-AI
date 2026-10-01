import type { Provider, ToolSpec } from "@dave/brain";

/**
 * Part 3: a focused "sequential thinking" pass, scoped ONLY to the autonomous tick's final trade
 * decision (see its one real call site in autonomous-tick.ts) -- never general chat, never every
 * message. Adapted from the Model Context Protocol's "sequential-thinking" reference server
 * (https://github.com/modelcontextprotocol/servers, package
 * @modelcontextprotocol/server-sequential-thinking): its core technique is forcing reasoning into
 * explicit, numbered "thought" steps the model submits one at a time (not one big free-text
 * block), each carrying its own thought number, a live running estimate of how many thoughts the
 * problem will take, and an explicit `nextThoughtNeeded` flag the model sets itself -- plus
 * optional revision (a later thought can say "actually, revise thought N") so the model can
 * genuinely reconsider an earlier step instead of only ever building forward. That server exposes
 * this as a general-purpose MCP tool for any task; this module keeps the same mechanic but wires
 * it to nothing but ONE bounded pre-pass ahead of ONE real trade decision, with a hard cap on how
 * many thoughts it will ever request.
 *
 * Honest cost/latency tradeoff (why this is a real opt-in toggle, OFF by default -- see
 * risk-settings.ts's getSequentialThinkingEnabled): each thought is its own real model round trip
 * (its own network call, its own token cost), so a run that uses the full cap adds up to
 * MAX_THOUGHTS extra real provider calls -- and therefore up to roughly MAX_THOUGHTS times the
 * latency and token spend of the plain single-call decision -- on top of the tick's own real
 * decision request. This is a genuine quality/cost tradeoff, not a free improvement: the
 * underlying providers already reason internally on a single well-formed prompt, so this is only
 * worth its extra cost when the user specifically wants a slower, more deliberate trade-decision
 * pass and has said so by turning the toggle on.
 */

export type ThinkingEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/** The stages a high/max-effort pass has to cover before it may stop -- a trader's checklist. */
export const THINKING_STAGES = ["bias", "spike", "trigger", "sniper", "scalp", "invalidation", "target", "edge", "counter", "memory", "scenario", "verdict"] as const;
/** A step id: a built-in one, or one the trader added (thinking-stages.ts in @dave/trading). */
export type ThinkingStage = string;

/** Every pass looks at these, whatever the level (the trader: "in each sequential thinking add the
 *  spike aspect, scalping, sniper and the advantage aspect"). */
export const FOCUS_FOUR: ThinkingStage[] = ["spike", "sniper", "scalp", "edge"];

const STAGE_HELP: Record<string, string> = {
  bias: "higher-timeframe bias -- which way the bigger picture leans, and how strongly",
  // The trader's four (spike, scalping, sniper, advantage) -- part of every pass.
  spike: "the spike -- on Boom/Crash/Storm/synthetics: where the next spike is likely, which way it fires, and is this trade WITH it or exposed to it; on forex: a news/volatility spike that could hit the stop",
  trigger: "the entry trigger on the lower timeframe -- is it actually there right now, or hoped for",
  sniper: "the sniper entry -- the exact level (order block, sweep, range edge, spike ignition) where the entry risks least; is price there NOW, or is it a limit order",
  scalp: "the scalp -- is there a quick, high-probability move to grab on M1/M5 right now, how big, and the tight exit",
  invalidation: "where the idea is wrong -- the stop from structure, not from a number",
  target: "where price is genuinely likely to reach, and whether the exact R:R target is realistic",
  edge: "the advantage -- what edge this trade has over a coin flip (spike direction, confluence, liquidity, structure), and whether it is strong enough to take",
  counter: "the strongest case AGAINST this trade -- argue it like you'd lose money if you ignore it",
  memory: "your own rules, strategy card, brain facts and past graded calls on this pair -- do any of them say no",
  scenario: "the alternative path -- what price does if you're wrong, and what you'd see first",
  verdict: "the call, with an honest confidence -- or why no trade",
};

export interface EffortProfile {
  maxThoughts: number;
  /** The pass may not stop before this many thoughts. */
  minThoughts: number;
  /** Stages that must each appear at least once before it may stop. */
  requiredStages: ThinkingStage[];
  /** An independent critic reads the whole trace and attacks its weakest point (X-High and max). */
  critic: boolean;
  timeoutMs: number;
  /** Wall-clock budget for the whole pass -- a scan never waits longer than this for thinking. */
  budgetMs: number;
}

export const EFFORT_PROFILES: Record<ThinkingEffortLevel, EffortProfile> = {
  // Low/medium: the spike/sniper/scalp/advantage four as a checklist to keep in view (FOCUS_FOUR).
  low: { maxThoughts: 4, minThoughts: 1, requiredStages: [], critic: false, timeoutMs: 30_000, budgetMs: 120_000 },
  medium: { maxThoughts: 6, minThoughts: 2, requiredStages: [], critic: false, timeoutMs: 30_000, budgetMs: 180_000 },
  high: { maxThoughts: 14, minThoughts: 8, requiredStages: ["bias", "spike", "trigger", "sniper", "scalp", "invalidation", "target", "edge", "counter", "memory", "verdict"], critic: false, timeoutMs: 45_000, budgetMs: 360_000 },
  // X-High (the trader: "overthinks ... 10 or 11 times or more"): at least 11 thoughts over every
  // stage, going back over its own steps, then the critic.
  xhigh: { maxThoughts: 16, minThoughts: 13, requiredStages: [...THINKING_STAGES], critic: true, timeoutMs: 45_000, budgetMs: 540_000 },
  max: { maxThoughts: 18, minThoughts: 14, requiredStages: [...THINKING_STAGES], critic: true, timeoutMs: 60_000, budgetMs: 660_000 },
};

export interface SequentialThought {
  thought: string;
  thoughtNumber: number;
  totalThoughts: number;
  nextThoughtNeeded: boolean;
  isRevision?: boolean;
  revisesThought?: number;
  stage?: ThinkingStage;
  /** A thought written in answer to the critic (max effort). */
  answersCritic?: boolean;
}

export interface SequentialThinkingResult {
  thoughts: SequentialThought[];
  /** A single real block ready to append to the decision prompt's context lines. */
  summary: string;
  effort: ThinkingEffortLevel;
  critique?: { weakestPoint: string; holds: boolean; adjustment?: string };
  /** Required stages the pass never reached (budget ran out). */
  missedStages: ThinkingStage[];
}

const THOUGHT_TOOL_NAME = "submit_thought";
const CRITIC_TOOL_NAME = "submit_critique";

/** Kept for callers that used the old constant: the medium profile's cap. */
export const MAX_SEQUENTIAL_THOUGHTS = EFFORT_PROFILES.medium.maxThoughts;

function buildThoughtTool(staged: boolean, stageIds: string[] = [...THINKING_STAGES]): ToolSpec {
  const properties: Record<string, unknown> = {
    thought: { type: "string", description: "This step's real, specific reasoning with numbers from the data -- not a restatement of the last one." },
    thoughtNumber: { type: "number", description: "1-indexed position of this thought." },
    totalThoughts: { type: "number", description: "your current honest estimate of how many thoughts this will take -- revise it as you go, it's not a fixed plan" },
    nextThoughtNeeded: { type: "boolean", description: "true if you genuinely need another thought before you're ready to decide; false once you are" },
    isRevision: { type: "boolean", description: "true if this thought revises an earlier one instead of building forward" },
    revisesThought: { type: "number", description: "required when isRevision is true -- which earlier thoughtNumber this reconsiders" },
  };
  if (staged) properties.stage = { type: "string", enum: stageIds, description: "which step of the checklist this thought covers" };
  return {
    name: THOUGHT_TOOL_NAME,
    description:
      "Submit your next real reasoning step toward this ONE trade decision -- not your final answer yet, just this step. " +
      "Build on, or explicitly revise, the thoughts before it. Set nextThoughtNeeded to false only once you've genuinely reasoned it through.",
    parameters: { type: "object", properties, required: staged ? ["thought", "thoughtNumber", "totalThoughts", "nextThoughtNeeded", "stage"] : ["thought", "thoughtNumber", "totalThoughts", "nextThoughtNeeded"] },
  };
}

function buildCriticTool(): ToolSpec {
  return {
    name: CRITIC_TOOL_NAME,
    description: "Your critique of the reasoning trace.",
    parameters: {
      type: "object",
      properties: {
        weakestPoint: { type: "string", description: "the single weakest link in the reasoning, specifically" },
        holds: { type: "boolean", description: "does the conclusion still hold once that weakness is taken seriously?" },
        adjustment: { type: "string", description: "what should change (entry, stop, size, or no trade) if it doesn't fully hold" },
      },
      required: ["weakestPoint", "holds"],
    },
  };
}

function renderThought(t: SequentialThought): string {
  const tag = t.isRevision ? `[revises thought ${t.revisesThought}] ` : "";
  const stage = t.stage ? ` (${t.stage})` : "";
  const critic = t.answersCritic ? "[answers critic] " : "";
  return `${critic}${tag}Thought ${t.thoughtNumber}/${t.totalThoughts}${stage}: ${t.thought}`;
}

export interface RunSequentialThinkingDeps {
  provider: Provider;
  systemPrompt: string;
  /** The same real context (symbol, price, account state, full analysis suite, etc) the final
   *  decision call itself will see -- the thinking pass reasons over the real data, not a summary. */
  contextLines: string[];
  /** Real per-thought progress callback -- shown live (the app's Live tab, a chat indicator). */
  onProgress?: (text: string) => void;
  /** How hard to think. Defaults to medium (the original pass). */
  effort?: ThinkingEffortLevel;
  /** The trader's enabled thinking steps (id + what to answer). Default: the built-in list. Every
   *  one given is mandatory at high/X-High/max; low/medium must cover the spike/sniper/scalp/edge
   *  four, the trader's own added steps, and the verdict. */
  stages?: { id: string; help: string }[];
  /** Overrides of the effort profile (tests). */
  maxThoughts?: number;
  timeoutMs?: number;
  now?: () => number;
}

/** Real, bounded pre-pass -- never called for anything but the one trade-decision path this is
 *  wired into (autonomous-tick.ts), and always gated behind getSequentialThinkingEnabled(). A
 *  failure at any step is swallowed (best-effort): a broken or slow thinking pass must never
 *  block the real trade decision that follows it, only skip the extra context it would have added.
 *
 *  Effort (the trader: "so it can think like high"):
 *    low/medium -- free-form numbered thoughts, as before (3 / 5 at most)
 *    high       -- a checklist: bias, trigger, invalidation, target, counter-case, own memory,
 *                  verdict. It may not stop early while any is missing, and must argue AGAINST
 *                  its own trade. Up to 10 thoughts.
 *    max        -- all of high, plus the alternative scenario, up to 16 thoughts, then an
 *                  independent critic attacks the weakest link and gets one answer.
 */
export async function runSequentialThinking(deps: RunSequentialThinkingDeps): Promise<SequentialThinkingResult> {
  const effort = deps.effort ?? "medium";
  const base = EFFORT_PROFILES[effort];
  const stageList = deps.stages?.length ? deps.stages : THINKING_STAGES.map((id) => ({ id, help: STAGE_HELP[id] }));
  const helpOf = new Map(stageList.map((st) => [st.id, st.help]));
  const builtIn = new Set<string>(THINKING_STAGES);
  // Every step is important (the trader: "it sometimes refuses to think about a point"): the deep
  // levels cover all of them; the light ones the four + the trader's own steps + the verdict.
  const requiredStages =
    base.requiredStages.length > 0
      ? stageList.map((st) => st.id)
      : stageList.map((st) => st.id).filter((id) => FOCUS_FOUR.includes(id) || !builtIn.has(id) || id === "verdict");
  const profile = { ...base, requiredStages, maxThoughts: Math.max(base.maxThoughts, requiredStages.length + 1) };
  const maxThoughts = deps.maxThoughts ?? profile.maxThoughts;
  const timeoutMs = deps.timeoutMs ?? profile.timeoutMs;
  const now = deps.now ?? Date.now;
  const started = now();
  const staged = profile.requiredStages.length > 0;
  const thoughts: SequentialThought[] = [];
  const tool = buildThoughtTool(staged, stageList.map((st) => st.id));
  const covered = () => new Set(thoughts.map((t) => t.stage).filter(Boolean) as ThinkingStage[]);
  const missing = () => profile.requiredStages.filter((st) => !covered().has(st));
  const overBudget = () => now() - started > profile.budgetMs;

  const ask = async (extra: string[]): Promise<SequentialThought | null> => {
    const rendered = thoughts.map(renderThought);
    const userPrompt = [
      ...deps.contextLines,
      "",
      `Before you finalize this trade decision, reason through it step by step (${effort} effort) -- call ${THOUGHT_TOOL_NAME} with your next real thought.`,
      staged
        ? `Your checklist -- EVERY step is mandatory, one real thought each, tagged with its stage; you can't finish until all are covered, and "not relevant" is not an answer (say what it shows for THIS setup):\n${profile.requiredStages.map((st) => `- ${st}: ${helpOf.get(st) ?? STAGE_HELP[st] ?? st}`).join("\n")}`
        : "",
      rendered.length > 0 ? `THOUGHTS SO FAR:\n${rendered.join("\n")}` : "This is your first thought -- start with the single most important real question this setup raises.",
      ...extra,
      `You have used ${thoughts.length}/${maxThoughts} thoughts. Once you're genuinely ready to decide, set nextThoughtNeeded to false.`,
    ]
      .filter(Boolean)
      .join("\n");
    let genResult;
    try {
      genResult = await deps.provider.generate(
        { messages: [{ role: "system", content: deps.systemPrompt }, { role: "user", content: userPrompt }], tools: [tool], toolChoice: { name: THOUGHT_TOOL_NAME } },
        timeoutMs
      );
    } catch {
      return null;
    }
    const call = genResult.toolCalls?.find((c) => c.name === THOUGHT_TOOL_NAME);
    if (!call) return null;
    const args = call.arguments as Record<string, unknown>;
    const stage = typeof args.stage === "string" && helpOf.has(args.stage) ? (args.stage as ThinkingStage) : undefined;
    const t: SequentialThought = {
      thought: typeof args.thought === "string" ? args.thought : "",
      thoughtNumber: thoughts.length + 1,
      totalThoughts: typeof args.totalThoughts === "number" ? Math.max(args.totalThoughts, thoughts.length + 1) : maxThoughts,
      nextThoughtNeeded: args.nextThoughtNeeded === true,
      isRevision: args.isRevision === true ? true : undefined,
      revisesThought: typeof args.revisesThought === "number" ? args.revisesThought : undefined,
      stage,
    };
    return t.thought ? t : null;
  };

  for (let i = 0; i < maxThoughts && !overBudget(); i++) {
    const gaps = missing();
    const extra: string[] = [];
    if (thoughts.length > 0 && gaps.length && thoughts.length >= maxThoughts - gaps.length) {
      extra.push(`Running out of thoughts -- cover what's still missing now: ${gaps.join(", ")}.`);
    } else if (thoughts.length > 0 && !gaps.length && thoughts.length < profile.minThoughts) {
      extra.push(
        `Keep going: this level thinks at least ${profile.minThoughts} times (${thoughts.length} so far). Go back over an earlier step from a fresh angle -- ` +
          `re-read the data, question the bias, test the stop and target again -- and revise it (isRevision) if it no longer holds.`
      );
    }
    const t = await ask(extra);
    if (!t) break;
    thoughts.push(t);
    deps.onProgress?.(renderThought(t).slice(0, 220));
    if (t.nextThoughtNeeded) continue;
    // It says it's done. Is it allowed to be?
    const stillMissing = missing();
    if (thoughts.length >= profile.minThoughts && stillMissing.length === 0) break;
    // Not yet: keep going (the next prompt names what's missing).
    t.nextThoughtNeeded = true;
    if (stillMissing.length) deps.onProgress?.(`Not done yet -- still to cover: ${stillMissing.join(", ")}`);
  }

  // X-HIGH / MAX: an independent critic attacks the trace, and the thinker answers once.
  let critique: SequentialThinkingResult["critique"];
  if (profile.critic && thoughts.length && !overBudget()) {
    try {
      const res = await deps.provider.generate(
        {
          messages: [
            { role: "system", content: "You are a sceptical senior trader reviewing a junior's reasoning before real money goes in. Find the single weakest link. Be concrete; don't nitpick style." },
            { role: "user", content: [...deps.contextLines, "", "THE REASONING TO REVIEW:", ...thoughts.map(renderThought)].join("\n") },
          ],
          tools: [buildCriticTool()],
          toolChoice: { name: CRITIC_TOOL_NAME },
        },
        timeoutMs
      );
      const args = res.toolCalls?.find((c) => c.name === CRITIC_TOOL_NAME)?.arguments as Record<string, unknown> | undefined;
      if (args && typeof args.weakestPoint === "string") {
        critique = { weakestPoint: args.weakestPoint, holds: args.holds !== false, adjustment: typeof args.adjustment === "string" ? args.adjustment : undefined };
        deps.onProgress?.(`Critic: ${critique.weakestPoint}${critique.holds ? " (still holds)" : " -- DOES NOT HOLD"}`.slice(0, 220));
        if (!overBudget()) {
          const answer = await ask([`A SCEPTICAL REVIEWER SAYS the weakest link is: "${critique.weakestPoint}" -- ${critique.holds ? "but the conclusion still holds" : "and the conclusion does NOT hold as it stands"}${critique.adjustment ? `; suggested: ${critique.adjustment}` : ""}. Answer it in one thought (stage: verdict): concede and adjust, or show with the data why it's wrong.`]);
          if (answer) {
            answer.answersCritic = true;
            answer.stage = answer.stage ?? "verdict";
            thoughts.push(answer);
            deps.onProgress?.(renderThought(answer).slice(0, 220));
          }
        }
      }
    } catch {
      /* the critic is best-effort too */
    }
  }

  const missedStages = missing();
  const parts = thoughts.map(renderThought);
  if (critique) parts.push(`CRITIC: weakest link -- ${critique.weakestPoint}; ${critique.holds ? "conclusion holds" : "conclusion does NOT hold"}${critique.adjustment ? `; suggested: ${critique.adjustment}` : ""}`);
  const summary =
    thoughts.length > 0
      ? `SEQUENTIAL THINKING TRACE (${effort} effort, ${thoughts.length} step(s)${missedStages.length ? `, never reached: ${missedStages.join(", ")}` : ""} -- weigh it, don't just repeat it back${critique && !critique.holds ? "; the critic says the conclusion does NOT hold -- address that before trading" : ""}): ${parts.join(" | ")}`
      : "";
  return { thoughts, summary, effort, critique, missedStages };
}
