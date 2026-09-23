import type { DaveDatabase } from "@dave/db";
import { addE2BKey, listE2BKeys, removeE2BKey, checkE2BKeyHealth, createSandboxWithKeyFailover } from "./e2b-keys.js";
import {
  runScriptInE2B,
  listUserUploads,
  SANDBOX_IN_DIR,
  SANDBOX_OUT_DIR,
  DEFAULT_RUN_TIMEOUT_MS,
  MAX_RUN_TIMEOUT_MS,
  type ScriptLanguage,
  type TaskFileIn,
} from "./e2b-exec.js";

/**
 * Update 12: E2B as real agent tools -- disposable compute Dave or a
 * worker can spin up for an isolated task WITHOUT touching the main
 * DSH/OpenSandbox chosen in Step 1.3.
 *
 * Real capability added (the trader: "expand the background tool and the
 * subtask so it can run any script to check for anything in the market
 * and you can connect the main agent to the e2b, and also give the bot
 * input and output, task files inside and task files outside"):
 * `run_script` is now genuinely here. The old header on this file said it
 * was deliberately absent because execution is E2B's gRPC data plane and
 * not a REST call -- that was true of the hand-rolled REST client, and is
 * why the real `e2b` SDK is now a dependency (see e2b-exec.ts). Execution,
 * file-in, and file-out are all real.
 */
export interface E2BToolContext {
  userId: string;
  db: DaveDatabase;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: E2BToolContext) => Promise<unknown>;
}

export const E2B_TOOLS: ToolDefinition[] = [
  {
    name: "add_e2b_key",
    description: "Store a real E2B API key (up to 10).",
    parameters: { type: "object", properties: { label: { type: "string" }, apiKey: { type: "string" } }, required: ["label", "apiKey"] },
    execute: async (args, ctx) => addE2BKey(ctx.db, ctx.userId, args.label as string, args.apiKey as string),
  },
  {
    name: "list_e2b_keys",
    description: "List stored E2B keys and their real health status.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => listE2BKeys(ctx.db, ctx.userId),
  },
  {
    name: "remove_e2b_key",
    description: "Delete a stored E2B key.",
    parameters: { type: "object", properties: { keyId: { type: "string" } }, required: ["keyId"] },
    execute: async (args, ctx) => ({ removed: removeE2BKey(ctx.db, ctx.userId, args.keyId as string) }),
  },
  {
    name: "check_e2b_key_health",
    description: "Run a real health check against one stored E2B key right now.",
    parameters: { type: "object", properties: { keyId: { type: "string" } }, required: ["keyId"] },
    execute: async (args, ctx) => {
      const key = listE2BKeys(ctx.db, ctx.userId).find((k) => k.id === args.keyId);
      if (!key) throw new Error(`no stored E2B key "${args.keyId}"`);
      return { healthy: await checkE2BKeyHealth(ctx.db, ctx.userId, key) };
    },
  },
  {
    name: "create_e2b_sandbox",
    description: "Spin up a disposable E2B sandbox for an isolated task (e.g. R_Feed backtest analysis) -- separate from the main sandbox, auto-fails over across stored keys.",
    parameters: {
      type: "object",
      properties: { templateID: { type: "string" }, timeoutSeconds: { type: "number" }, metadata: { type: "object" } },
    },
    execute: async (args, ctx) => createSandboxWithKeyFailover(ctx.db, ctx.userId, { templateID: args.templateID as string | undefined, timeoutSeconds: args.timeoutSeconds as number | undefined, metadata: args.metadata as Record<string, string> | undefined }),
  },
  {
    name: "run_script",
    description:
      "Run a REAL script in a disposable E2B sandbox and get back its real stdout, stderr, exit code, and any files it produced. This is general-purpose compute: use it to check anything about the market you can express as code -- pull a live price or news feed over HTTP, compute an indicator or correlation across a series, backtest a rule, parse a CSV the user sent, do maths too fiddly to do in your head, or verify a number before you quote it. Network access is available. " +
      `Input files you pass land in ${SANDBOX_IN_DIR} (a bare filename resolves there, and the path is also in $DAVE_IN_DIR). Anything the script writes to ${SANDBOX_OUT_DIR} ($DAVE_OUT_DIR) is automatically read back out and returned to you. ` +
      "The sandbox is fresh every call and destroyed afterwards, so nothing persists between runs -- pass what the script needs in, and write what you want back out. A non-zero exit code is a real result, not a crash: read stderr and fix the script. " +
      "IMPORTANT -- synthetic pairs (VOL_80, CRASH_100, BOOM_500, STORM_500, VOL_10 and the rest) are generated inside the connected MT5 terminal and exist on NO public API: a script can never fetch one from the internet, and must never substitute a real-world instrument for one. To compute on a synthetic pair, call get_all_analysis for it first and pass that result in via filesIn.",
    parameters: {
      type: "object",
      properties: {
        script: {
          type: "string",
          description: "The actual script source to run. Write it as a complete standalone program -- it runs from a file, so quotes, newlines, and shell metacharacters are all safe to use literally.",
        },
        language: { type: "string", enum: ["bash", "python", "node"], description: "Defaults to bash. python3 and node are both available in the sandbox." },
        filesIn: {
          type: "array",
          description: `Files to put INTO the sandbox before the script runs (the "task files inside"). Use for data the script needs: a CSV the user sent, a price series you already pulled, a config.`,
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: `Filename or full path. A bare name lands in ${SANDBOX_IN_DIR}.` },
              content: { type: "string" },
              encoding: { type: "string", enum: ["utf8", "base64"], description: "Use base64 for binary content. Defaults to utf8." },
            },
            required: ["path", "content"],
          },
        },
        attachUserFiles: {
          type: "array",
          items: { type: "string" },
          description: `Names of files the USER sent you (call list_user_files to see them) to copy into ${SANDBOX_IN_DIR} for this run. This is how a document the user uploaded actually reaches your script -- e.g. they send trades.csv, you attach it and parse it.`,
        },
        filesOut: {
          type: "array",
          items: { type: "string" },
          description: `Extra paths to read back after the run. Usually unnecessary -- anything written to ${SANDBOX_OUT_DIR} comes back automatically.`,
        },
        envVars: { type: "object", description: "Environment variables for the run (e.g. an API key the script needs). Never hardcode a secret into the script itself." },
        timeoutMs: { type: "number", description: `Wall-clock budget for the script. Default ${DEFAULT_RUN_TIMEOUT_MS}ms, max ${MAX_RUN_TIMEOUT_MS}ms.` },
      },
      required: ["script"],
    },
    execute: async (args, ctx) =>
      runScriptInE2B(ctx.db, ctx.userId, {
        script: args.script as string,
        language: args.language as ScriptLanguage | undefined,
        filesIn: args.filesIn as TaskFileIn[] | undefined,
        attachUserFiles: args.attachUserFiles as string[] | undefined,
        filesOut: args.filesOut as string[] | undefined,
        envVars: args.envVars as Record<string, string> | undefined,
        timeoutMs: args.timeoutMs as number | undefined,
      }),
  },
  {
    name: "list_user_files",
    description:
      "List the real files the user has actually sent you (documents, spreadsheets, exports), newest first. Pass any of these names to run_script's attachUserFiles to load one into a sandbox and actually process it. Check here first whenever the user refers to a file they sent.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => listUserUploads(ctx.userId),
  },
];
