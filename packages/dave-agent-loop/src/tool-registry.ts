import type { ToolSpec } from "@dave/brain";

/**
 * Update 9: "give the agent tools" -- a real, unified registry every
 * package's tools funnel into so a real LLM call can actually see and
 * invoke them, instead of each package's `TOOLS` array sitting unused.
 * Each source package's own `ToolDefinition` shape differs slightly in
 * its `ctx` type (dave-trading's is `{userId, davema, executor}`,
 * dave-rfeed's is `{userId, db, executor, historyManager}`, etc.) --
 * `adaptTools()` binds a package's own real context once at registry-
 * build time via closure, so every entry ends up the same shape here:
 * `(args) => Promise<unknown>`, no context threading needed downstream.
 */
export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface SourceToolDefinition<C> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: C) => Promise<unknown>;
}

export function adaptTools<C>(tools: SourceToolDefinition<C>[], ctx: C): AgentTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    execute: (args: Record<string, unknown>) => t.execute(args, ctx),
  }));
}

export class DuplicateToolNameError extends Error {
  constructor(name: string) {
    super(`Tool "${name}" is already registered -- two packages tried to expose the same tool name.`);
    this.name = "DuplicateToolNameError";
  }
}

export class UnknownToolError extends Error {
  constructor(name: string) {
    super(`No tool named "${name}" is registered.`);
    this.name = "UnknownToolError";
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  /** Real collision detection -- a silently-shadowed tool would be a genuine bug, not a feature. */
  register(tools: AgentTool[]): this {
    for (const tool of tools) {
      if (this.tools.has(tool.name)) throw new DuplicateToolNameError(tool.name);
      this.tools.set(tool.name, tool);
    }
    return this;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): AgentTool[] {
    return [...this.tools.values()];
  }

  toSpecs(): ToolSpec[] {
    return this.list().map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  }

  async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new UnknownToolError(name);
    return tool.execute(args);
  }
}
