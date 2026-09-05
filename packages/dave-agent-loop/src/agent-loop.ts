import type { CompletionMessage, Provider } from "@dave/brain";
import type { ToolRegistry } from "./tool-registry.js";
import { ASK_USER_TOOL_NAME, type PendingQuestion } from "./ask-user.js";

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

export type AgentRunResult =
  | { status: "done"; text: string; history: CompletionMessage[]; steps: AgentStep[] }
  | { status: "awaiting_user"; question: PendingQuestion; toolCallId: string; history: CompletionMessage[]; steps: AgentStep[] };

export class MaxStepsExceededError extends Error {
  constructor(public readonly maxSteps: number) {
    super(`Agent loop exceeded ${maxSteps} steps without reaching a final answer -- stopped rather than looping forever.`);
    this.name = "MaxStepsExceededError";
  }
}

export class AgentLoop {
  constructor(
    private readonly provider: Provider,
    private readonly registry: ToolRegistry
  ) {}

  async run(messages: CompletionMessage[], opts: { maxSteps?: number; timeoutMs?: number; onStep?: (step: AgentStep) => void } = {}): Promise<AgentRunResult> {
    const maxSteps = opts.maxSteps ?? 8;
    const timeoutMs = opts.timeoutMs ?? 20000;
    const history = [...messages];
    const steps: AgentStep[] = [];

    for (let i = 0; i < maxSteps; i++) {
      const result = await this.provider.generate({ messages: history, tools: this.registry.toSpecs() }, timeoutMs);

      if (!result.toolCalls || result.toolCalls.length === 0) {
        return { status: "done", text: result.text, history, steps };
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
          return { status: "awaiting_user", question, toolCallId: call.id, history, steps };
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
      }
    }
    throw new MaxStepsExceededError(maxSteps);
  }

  /** Continues a paused (`awaiting_user`) run with the user's real answer. */
  async resume(paused: Extract<AgentRunResult, { status: "awaiting_user" }>, userAnswer: string, opts: { maxSteps?: number; timeoutMs?: number } = {}): Promise<AgentRunResult> {
    const history: CompletionMessage[] = [...paused.history, { role: "tool", toolCallId: paused.toolCallId, content: userAnswer }];
    return this.run(history, opts);
  }
}
