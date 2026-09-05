import { runCode, writeWorkspaceFile, readWorkspaceFile } from "./sandbox-client.js";
import { checkSandboxHealth } from "./degradation.js";

/**
 * Update 18 (bulk tool-coverage expansion): the MAIN sandbox (DSH-
 * native, chosen Step 1.3) had a real client (Step 6.1) but no agent-
 * tool surface -- distinct from Update 12's E2B tools (the ADDITIONAL,
 * disposable option).
 */
export interface SandboxToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

export const SANDBOX_TOOLS: SandboxToolDefinition[] = [
  {
    name: "davesbx",
    description: "Run a real command inside your main sandbox (DSH-native confinement, fails closed and reports honestly if unconfined). Use for code execution, not E2B -- that's the separate disposable option.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" }, args: { type: "array", items: { type: "string" } }, workspaceRoot: { type: "string" }, timeoutMs: { type: "number" } },
      required: ["command", "workspaceRoot"],
    },
    execute: async (args) => runCode(args.command as string, (args.args as string[]) ?? [], args.workspaceRoot as string, (args.timeoutMs as number) ?? 30_000),
  },
  {
    name: "davesbx_health",
    description: "Check the real health of your main sandbox -- confirms real confinement, or honestly reports degraded/unconfined mode.",
    parameters: { type: "object", properties: { workspaceRoot: { type: "string" } }, required: ["workspaceRoot"] },
    execute: async (args) => checkSandboxHealth(args.workspaceRoot as string),
  },
  {
    name: "davesbx_write_file",
    description: "Write a real file into your main sandbox's workspace.",
    parameters: { type: "object", properties: { workspaceRoot: { type: "string" }, relativePath: { type: "string" }, content: { type: "string" } }, required: ["workspaceRoot", "relativePath", "content"] },
    execute: async (args) => ({ path: writeWorkspaceFile(args.workspaceRoot as string, args.relativePath as string, args.content as string) }),
  },
  {
    name: "davesbx_read_file",
    description: "Read a real file from your main sandbox's workspace.",
    parameters: { type: "object", properties: { workspaceRoot: { type: "string" }, relativePath: { type: "string" } }, required: ["workspaceRoot", "relativePath"] },
    execute: async (args) => ({ content: readWorkspaceFile(args.workspaceRoot as string, args.relativePath as string) }),
  },
];
