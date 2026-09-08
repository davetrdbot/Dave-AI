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

  /**
   * Real bug fixed (user, with a real Grok error: "'tools': maximum number of items is 128"):
   * toSpecs() sent EVERY registered tool on EVERY request -- 205+ tools once the full build was
   * composed, well past hard caps several real providers enforce (xAI confirmed at 128; OpenAI
   * documents the same ceiling, and most OpenAI-compatible providers inherit that shape). This
   * returns only the tools whose name is in `names`, preserving registry order -- the real
   * mechanism dynamic tool selection (tool-selection.ts) uses to keep every request under that
   * cap, instead of a blind top-128 slice that could arbitrarily drop a tool the model actually
   * needs this turn.
   */
  toSpecsFor(names: Iterable<string>): ToolSpec[] {
    const wanted = new Set(names);
    return this.list()
      .filter((t) => wanted.has(t.name))
      .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  }

  /** Real substring search over name+description, case-insensitive -- lets Dave discover a tool it doesn't remember the exact name of. */
  search(query: string): { name: string; description: string }[] {
    const q = query.trim().toLowerCase();
    if (q === "") return [];
    return this.list()
      .filter((t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q))
      .map((t) => ({ name: t.name, description: t.description }));
  }

  async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new UnknownToolError(name);
    return tool.execute(args);
  }
}
