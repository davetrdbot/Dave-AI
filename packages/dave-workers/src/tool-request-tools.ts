import { requestTool, decideToolRequest, listPendingToolRequests, listToolRequestsForWorker } from "./tool-requests.js";

/**
 * Update 7: the real request/grant exchange, as agent-callable tools --
 * a worker calls `request_tool` mid-task instead of getting stuck or
 * Dave guessing every possible tool upfront; Dave calls
 * `decide_tool_request` to grant/deny.
 */
export interface WorkerToolRequestContext {
  ownerUserId: string;
  workerId: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: WorkerToolRequestContext) => Promise<unknown>;
}

/** Given to every worker unconditionally -- the one thing a worker can always do, even with zero other tools. */
export const WORKER_TOOL_REQUEST_TOOLS: ToolDefinition[] = [
  {
    name: "request_tool",
    description: "Ask Dave for a specific tool you realize you need mid-task but weren't given. Real request -- Dave decides grant/deny; if granted, you get access on your very next check, no restart needed.",
    parameters: {
      type: "object",
      properties: { toolName: { type: "string" }, reason: { type: "string" } },
      required: ["toolName", "reason"],
    },
    execute: async (args, ctx) => requestTool(ctx.ownerUserId, ctx.workerId, args.toolName as string, args.reason as string),
  },
  {
    name: "check_my_tool_requests",
    description: "Check the status of tool requests you've made -- pending, granted, or denied.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => listToolRequestsForWorker(ctx.ownerUserId, ctx.workerId),
  },
];

/** Dave-side (not worker-scoped -- Dave is the one deciding). */
export interface DaveToolRequestContext {
  ownerUserId: string;
}

export interface DaveToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: DaveToolRequestContext) => Promise<unknown>;
}

export const DAVE_TOOL_REQUEST_TOOLS: DaveToolDefinition[] = [
  {
    name: "list_pending_tool_requests",
    description: "List every tool request from your workers that's still waiting on your decision.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => listPendingToolRequests(ctx.ownerUserId),
  },
  {
    name: "decide_tool_request",
    description: "Grant or deny a worker's tool request. If granted, the worker's tool access updates live -- no restart.",
    parameters: {
      type: "object",
      properties: { requestId: { type: "string" }, granted: { type: "boolean" } },
      required: ["requestId", "granted"],
    },
    execute: async (args, ctx) => decideToolRequest(ctx.ownerUserId, args.requestId as string, Boolean(args.granted)),
  },
];
