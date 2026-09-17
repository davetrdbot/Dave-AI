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

export interface SequentialThought {
  thought: string;
  thoughtNumber: number;
  totalThoughts: number;
  nextThoughtNeeded: boolean;
  isRevision?: boolean;
  revisesThought?: number;
}

export interface SequentialThinkingResult {
  thoughts: SequentialThought[];
  /** A single real block ready to append to the decision prompt's context lines. */
  summary: string;
}

const THOUGHT_TOOL_NAME = "submit_thought";

/** Hard cap on real extra model round trips this pass will ever make -- the real bound on its
 *  own worst-case cost/latency, never open-ended. */
export const MAX_SEQUENTIAL_THOUGHTS = 5;

function buildThoughtTool(): ToolSpec {
  return {
    name: THOUGHT_TOOL_NAME,
    description:
      "Submit your next real reasoning step toward this ONE trade decision -- not your final answer yet, just this step. " +
      "Build on, or explicitly revise, the thoughts before it. Set nextThoughtNeeded to false only once you've genuinely reasoned it through.",
    parameters: {
      type: "object",
      properties: {
        thought: { type: "string", description: "This step's real, specific reasoning -- not a restatement of the last one." },
        thoughtNumber: { type: "number", description: "1-indexed position of this thought." },
        totalThoughts: { type: "number", description: "your current honest estimate of how many thoughts this will take -- revise it as you go, it's not a fixed plan" },
        nextThoughtNeeded: { type: "boolean", description: "true if you genuinely need another thought before you're ready to decide; false once you are" },
        isRevision: { type: "boolean", description: "true if this thought revises an earlier one instead of building forward" },
        revisesThought: { type: "number", description: "required when isRevision is true -- which earlier thoughtNumber this reconsiders" },
      },
      required: ["thought", "thoughtNumber", "totalThoughts", "nextThoughtNeeded"],
    },
  };
}

function renderThought(t: SequentialThought): string {
  const tag = t.isRevision ? `[revises thought ${t.revisesThought}] ` : "";
  return `${tag}Thought ${t.thoughtNumber}/${t.totalThoughts}: ${t.thought}`;
}

export interface RunSequentialThinkingDeps {
  provider: Provider;
  systemPrompt: string;
  /** The same real context (symbol, price, account state, full analysis suite, etc) the final
   *  decision call itself will see -- the thinking pass reasons over the real data, not a summary. */
  contextLines: string[];
  /** Real per-thought progress callback -- the caller wires this to the SAME automatic
   *  `ThinkingIndicator` mechanism the real chat turn itself uses (tools.ts's activeIndicators),
   *  never a separate indicator. During a silent autonomous cycle there is normally no active
   *  indicator at all, so this is a safe no-op in the common case -- it only does anything if the
   *  user happens to have a live chat turn's indicator open on this chat already. */
  onProgress?: (text: string) => void;
  maxThoughts?: number;
  timeoutMs?: number;
}

/** Real, bounded pre-pass -- never called for anything but the one trade-decision path this is
 *  wired into (autonomous-tick.ts), and always gated behind getSequentialThinkingEnabled(). A
 *  failure at any step is swallowed (best-effort): a broken or slow thinking pass must never
 *  block the real trade decision that follows it, only skip the extra context it would have added. */
export async function runSequentialThinking(deps: RunSequentialThinkingDeps): Promise<SequentialThinkingResult> {
  const maxThoughts = deps.maxThoughts ?? MAX_SEQUENTIAL_THOUGHTS;
  const timeoutMs = deps.timeoutMs ?? 30_000;
  const thoughts: SequentialThought[] = [];
  const tool = buildThoughtTool();

  for (let i = 0; i < maxThoughts; i++) {
    const rendered = thoughts.map(renderThought);
    const userPrompt = [
      ...deps.contextLines,
      "",
      "Before you finalize this trade decision, reason through it step by step -- call submit_thought with your next real thought.",
      rendered.length > 0 ? `THOUGHTS SO FAR:\n${rendered.join("\n")}` : "This is your first thought -- start with the single most important real question this setup raises.",
      `You have used ${thoughts.length}/${maxThoughts} thoughts. Once you're genuinely ready to decide, set nextThoughtNeeded to false.`,
    ].join("\n");

    let genResult;
    try {
      genResult = await deps.provider.generate(
        { messages: [{ role: "system", content: deps.systemPrompt }, { role: "user", content: userPrompt }], tools: [tool], toolChoice: { name: THOUGHT_TOOL_NAME } },
        timeoutMs
      );
    } catch {
      break; // best-effort -- a failed thinking pass must never block the real decision that follows it
    }

    const call = genResult.toolCalls?.find((c) => c.name === THOUGHT_TOOL_NAME);
    if (!call) break;
    const args = call.arguments as Record<string, unknown>;
    const t: SequentialThought = {
      thought: typeof args.thought === "string" ? args.thought : "",
      thoughtNumber: typeof args.thoughtNumber === "number" ? args.thoughtNumber : thoughts.length + 1,
      totalThoughts: typeof args.totalThoughts === "number" ? args.totalThoughts : maxThoughts,
      nextThoughtNeeded: args.nextThoughtNeeded === true,
      isRevision: args.isRevision === true ? true : undefined,
      revisesThought: typeof args.revisesThought === "number" ? args.revisesThought : undefined,
    };
    if (!t.thought) break; // an empty thought means nothing real to add -- stop rather than pad the trace
    thoughts.push(t);
    deps.onProgress?.(renderThought(t).slice(0, 200));
    if (!t.nextThoughtNeeded) break;
  }

  const summary =
    thoughts.length > 0
      ? `SEQUENTIAL THINKING TRACE (${thoughts.length} real reasoning step(s), opt-in pass -- weigh it, don't just repeat it back): ${thoughts.map(renderThought).join(" | ")}`
      : "";
  return { thoughts, summary };
}
