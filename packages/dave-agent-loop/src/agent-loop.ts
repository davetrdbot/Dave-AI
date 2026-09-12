import type { CompletionMessage, Provider } from "@dave/brain";
import type { ToolRegistry } from "./tool-registry.js";
import { ASK_USER_TOOL_NAME, type PendingQuestion } from "./ask-user.js";
import { CORE_TOOL_NAMES, MAX_TOOLS_PER_REQUEST } from "./tool-selection.js";

const SEARCH_TOOLS_NAME = "search_tools";

/**
 * Update 9: the actual, real, multi-turn tool-calling loop -- the
 * piece that was genuinely missing across every "not yet done" note in
 * PROGRESS.md ("no real agent loop exists yet"). Calls a real
 * `Provider.generate()` with the real tool specs; when the model
 * requests tool calls, genuinely executes them through the
 * `ToolRegistry` and feeds the real results back, looping until the
 * model returns plain text (or `ask_user` pauses it, or the step cap
 * is hit).
 */
export interface AgentStep {
  toolName: string;
  arguments: Record<string, unknown>;
  result: unknown;
  isError: boolean;
}

/**
 * User-requested addition ("show a small follow-up message/edit indicating token usage for that
 * exchange"): the real, summed token usage across every provider.generate() call this run made
 * (a single user turn can involve several calls when tools are used in between) -- not a single
 * call's usage in isolation. Undefined when no provider response in this run reported usage.
 */
export interface RunTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type AgentRunResult =
  | { status: "done"; text: string; history: CompletionMessage[]; steps: AgentStep[]; tokenUsage?: RunTokenUsage }
  | { status: "awaiting_user"; question: PendingQuestion; toolCallId: string; history: CompletionMessage[]; steps: AgentStep[]; tokenUsage?: RunTokenUsage }
  /**
   * Real bug fixed (user, live: a turn got stuck "thinking" forever, immune to a changed timeout
   * setting, `/stop`, and `/reset`). Returned when the run is cut short by the new overall
   * wall-clock deadline ("deadline") or by a genuine external cancel via `opts.signal`
   * ("cancelled") -- see turn-abort.ts. `history`/`steps` reflect everything that had genuinely
   * completed before the cut -- never a half-finished step, see the loop body below.
   */
  | { status: "aborted"; reason: "deadline" | "cancelled"; history: CompletionMessage[]; steps: AgentStep[]; tokenUsage?: RunTokenUsage };

export class MaxStepsExceededError extends Error {
  constructor(public readonly maxSteps: number) {
    super(`Agent loop exceeded ${maxSteps} steps without reaching a final answer -- stopped rather than looping forever.`);
    this.name = "MaxStepsExceededError";
  }
}

/**
 * Real bug fixed (user, live: "the bot was wasting time to respond... it was still thinking"
 * even after lowering the AI Response Timeout setting to 10s). `timeoutMs` only ever bounded ONE
 * `provider.generate()` call -- a multi-step turn (hunt -> analyze -> execute -> report) with no
 * step cap (`maxSteps ?? Infinity`, a deliberate earlier fix) had no ceiling on its TOTAL
 * duration. This is that real, separate ceiling: generous enough for a genuine multi-tool-call
 * turn with real EA round trips, but never truly unbounded.
 */
const DEFAULT_OVERALL_TURN_TIMEOUT_MS = 4 * 60_000;

/** Combines two optional AbortSignals into one that fires the instant EITHER does. Needed so the
 *  overall-deadline timer (below) can genuinely cut off a call already in flight -- not just stop
 *  new ones from starting -- alongside a real caller-supplied cancel signal, without either one
 *  having to know about the other. */
function combineSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (!a) return b;
  if (!b) return a;
  const combined = new AbortController();
  if (a.aborted || b.aborted) {
    combined.abort();
  } else {
    a.addEventListener("abort", () => combined.abort(), { once: true });
    b.addEventListener("abort", () => combined.abort(), { once: true });
  }
  return combined.signal;
}

export class AgentLoop {
  constructor(
    private readonly provider: Provider,
    private readonly registry: ToolRegistry
  ) {}

  async run(
    messages: CompletionMessage[],
    opts: { maxSteps?: number; timeoutMs?: number; overallTimeoutMs?: number; signal?: AbortSignal; onStep?: (step: AgentStep) => void } = {}
  ): Promise<AgentRunResult> {
    // Real bug fixed (user: "maxSteps: 8, remove that, no max step, unlimited max step"): a real
    // trade decision (hunt -> analyze -> execute -> report, sometimes with a search_tools detour
    // or a retry) can genuinely need more than 8 provider round trips, and a hard cap here meant
    // the loop could throw MaxStepsExceededError mid-decision, silently killing a cycle before it
    // ever reached trade_execute. No cap by default now -- callers that genuinely want one (tests
    // proving the cap mechanism itself still works) pass maxSteps explicitly.
    const maxSteps = opts.maxSteps ?? Infinity;
    const timeoutMs = opts.timeoutMs ?? 20000;
    const history = [...messages];
    const steps: AgentStep[] = [];

    // Real overall deadline as an ACTUAL abort trigger, not just a between-iterations check --
    // otherwise a single provider call already in flight (bounded only by its own, possibly much
    // longer, per-call timeoutMs) could still run well past this deadline. Combined with the
    // caller's own external `signal` (turn-abort.ts, wired to /stop/panic/reset) so either one
    // genuinely cuts off an in-flight call, not merely stops the loop from awaiting it further.
    const deadlineController = new AbortController();
    const deadlineTimer = setTimeout(() => deadlineController.abort(), opts.overallTimeoutMs ?? DEFAULT_OVERALL_TURN_TIMEOUT_MS);
    const combinedSignal = combineSignals(opts.signal, deadlineController.signal);

    // Real bug fixed (user, with a real Grok error: "'tools': maximum number of items is 128"):
    // every turn used to send the ENTIRE registry (205+ tools once the full build is composed).
    // A registry that's already small enough to fit under the cap (tests, and worker-loop.ts's
    // deliberately restricted per-worker registries) is sent whole, unchanged -- filtering only
    // ever kicks in when it's actually needed. Once it does, only the curated CORE set goes out
    // by default; a real search_tools call below genuinely adds whatever it finds to
    // `activeNames` for the rest of THIS run, so every tool stays reachable, just not paid for on
    // turns that never need it.
    const allNames = this.registry.list().map((t) => t.name);
    const activeNames = new Set(allNames.length <= MAX_TOOLS_PER_REQUEST ? allNames : CORE_TOOL_NAMES.filter((n) => this.registry.has(n)));

    let tokenUsage: RunTokenUsage | undefined;
    const accumulateUsage = (u?: RunTokenUsage) => {
      if (!u) return;
      tokenUsage = tokenUsage
        ? { promptTokens: tokenUsage.promptTokens + u.promptTokens, completionTokens: tokenUsage.completionTokens + u.completionTokens, totalTokens: tokenUsage.totalTokens + u.totalTokens }
        : { ...u };
    };

    try {
      for (let i = 0; i < maxSteps; i++) {
        // Real cancel/deadline check -- BEFORE starting a new provider call, so a turn that's
        // already been told to stop never fires one more round trip it doesn't need to.
        if (opts.signal?.aborted) return { status: "aborted", reason: "cancelled", history, steps, tokenUsage };
        if (deadlineController.signal.aborted) return { status: "aborted", reason: "deadline", history, steps, tokenUsage };

        const tools = this.registry.toSpecsFor(activeNames).slice(0, MAX_TOOLS_PER_REQUEST);
        let result;
        try {
          result = await this.provider.generate({ messages: history, tools }, timeoutMs, combinedSignal);
        } catch (err) {
          // A genuine abort (external `signal` or the overall deadline) surfaces here as the
          // underlying fetch rejecting -- report it as a clean "aborted" result, with the real
          // reason, rather than an unhandled provider error. History never ends up with a
          // half-completed step: nothing is pushed until a call fully resolves.
          if (opts.signal?.aborted) return { status: "aborted", reason: "cancelled", history, steps, tokenUsage };
          if (deadlineController.signal.aborted) return { status: "aborted", reason: "deadline", history, steps, tokenUsage };
          throw err;
        }
        accumulateUsage(result.tokenUsage);

        if (!result.toolCalls || result.toolCalls.length === 0) {
          return { status: "done", text: result.text, history, steps, tokenUsage };
        }

        history.push({ role: "assistant", content: result.text, toolCalls: result.toolCalls });

        for (const call of result.toolCalls) {
          if (call.name === ASK_USER_TOOL_NAME) {
            const question = (await this.registry.execute(call.name, call.arguments)) as PendingQuestion;
            const step: AgentStep = { toolName: call.name, arguments: call.arguments, result: question, isError: false };
            steps.push(step);
            opts.onStep?.(step);
            // Genuinely pause -- no tool_result exists yet for this call, so the
            // conversation cannot continue until resume() supplies the real answer.
            return { status: "awaiting_user", question, toolCallId: call.id, history, steps, tokenUsage };
          }

          let output: unknown;
          let isError = false;
          try {
            output = await this.registry.execute(call.name, call.arguments);
          } catch (err) {
            isError = true;
            output = { error: err instanceof Error ? err.message : String(err) };
          }
          const step: AgentStep = { toolName: call.name, arguments: call.arguments, result: output, isError };
          steps.push(step);
          opts.onStep?.(step);
          history.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(output) });

          // Real dynamic tool loading: whatever search_tools genuinely found becomes callable on
          // the VERY NEXT turn, not just visible as text the model can't act on -- capped so a
          // pathological query can't itself blow past the request limit. search_tools' own real
          // result shape is `{ matches: [{name, description}, ...] }` (full-registry.ts).
          if (call.name === SEARCH_TOOLS_NAME) {
            const matches = (output as { matches?: unknown })?.matches;
            if (Array.isArray(matches)) {
              for (const found of matches as { name?: unknown }[]) {
                if (typeof found?.name === "string" && activeNames.size < MAX_TOOLS_PER_REQUEST) activeNames.add(found.name);
              }
            }
          }
        }
      }
      throw new MaxStepsExceededError(maxSteps);
    } finally {
      clearTimeout(deadlineTimer);
    }
  }

  /** Continues a paused (`awaiting_user`) run with the user's real answer. */
  async resume(
    paused: Extract<AgentRunResult, { status: "awaiting_user" }>,
    userAnswer: string,
    opts: { maxSteps?: number; timeoutMs?: number; overallTimeoutMs?: number; signal?: AbortSignal; onStep?: (step: AgentStep) => void } = {}
  ): Promise<AgentRunResult> {
    const history: CompletionMessage[] = [...paused.history, { role: "tool", toolCallId: paused.toolCallId, content: userAnswer }];
    return this.run(history, opts);
  }
}
