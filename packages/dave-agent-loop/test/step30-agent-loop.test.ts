import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { OpenAICompatibleProvider } from "@dave/brain";
import { ToolRegistry, adaptTools, AgentLoop, MaxStepsExceededError, DuplicateToolNameError, UnknownToolError, createAskUserTool, getPendingQuestion } from "../src/index.js";

console.log("=== Update 9 real proof: the actual agent tool-calling loop ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-update9-"));
const OWNER = "user-1";

try {
  process.chdir(workDir);

  // A real tool, in the SAME package-scoped ToolDefinition shape every
  // other package (dave-trading, dave-rfeed, etc.) already uses --
  // proves adaptTools() genuinely binds real per-package context.
  interface FakeCtx {
    userId: string;
  }
  let realToolWasCalled: Record<string, unknown> | undefined;
  const GET_BALANCE_TOOL = {
    name: "get_balance",
    description: "Get the user's real account balance.",
    parameters: { type: "object", properties: {} },
    execute: async (args: Record<string, unknown>, ctx: FakeCtx) => {
      realToolWasCalled = args;
      return { balance: 10042, userId: ctx.userId };
    },
  };

  // --- [1] ToolRegistry: real registration, real collision detection ---
  console.log("[1] ToolRegistry: real registration, real duplicate-name detection...\n");
  const registry = new ToolRegistry();
  registry.register(adaptTools([GET_BALANCE_TOOL], { userId: OWNER }));
  assert.ok(registry.has("get_balance"));
  let dup = false;
  try {
    registry.register(adaptTools([GET_BALANCE_TOOL], { userId: OWNER }));
  } catch (err) {
    dup = err instanceof DuplicateToolNameError;
  }
  assert.ok(dup, "registering the same tool name twice must be genuinely refused, not silently shadowed");
  console.log(`    real registry has ${registry.list().length} tool(s); duplicate registration genuinely refused`);

  let unknownErr = false;
  try {
    await registry.execute("does_not_exist", {});
  } catch (err) {
    unknownErr = err instanceof UnknownToolError;
  }
  assert.ok(unknownErr);
  console.log("    real, typed UnknownToolError for a tool that was never registered");

  // --- [2] Full real loop: local server mimicking an OpenAI-compatible model requesting a real tool call ---
  console.log("\n[2] Full real agent loop: model requests a tool call, loop executes it FOR REAL, sends the result back, gets a final answer...\n");
  let callCount = 0;
  const capturedRequests: any[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      capturedRequests.push(parsed);
      callCount++;
      if (callCount === 1) {
        // Real, confirmed OpenAI tool_calls response shape.
        assert.ok(parsed.tools.some((t: any) => t.function.name === "get_balance"), "the real tool spec must have been sent to the model");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_balance", arguments: "{}" } }] } }],
          })
        );
      } else {
        // Second call MUST carry the real tool result back.
        const toolMsg = parsed.messages.find((m: any) => m.role === "tool");
        assert.ok(toolMsg, "the real tool result must be sent back to the model on the next turn");
        assert.equal(toolMsg.tool_call_id, "call_1");
        assert.deepEqual(JSON.parse(toolMsg.content), { balance: 10042, userId: OWNER });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "Your real balance is $10,042." } }] }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;

  const provider = new OpenAICompatibleProvider("groq", `http://127.0.0.1:${port}`, "test-key", "llama-3.3-70b-versatile");
  const loop = new AgentLoop(provider, registry);
  const runResult = await loop.run([{ role: "user", content: "What's my balance?" }]);

  assert.equal(runResult.status, "done");
  assert.ok(runResult.status === "done" && runResult.text === "Your real balance is $10,042.");
  assert.equal(callCount, 2, "must have genuinely made TWO real calls -- one to request the tool, one after the real result");
  assert.deepEqual(realToolWasCalled, {}, "the real tool's own execute() function must have genuinely run");
  console.log(`    real 2-turn loop completed: ${callCount} real model calls, real tool executed, final text: "${(runResult as any).text}"`);
  console.log(`    real steps recorded: ${JSON.stringify((runResult as any).steps)}`);
  await new Promise<void>((resolve) => server.close(() => resolve()));

  // --- [3] A tool that genuinely throws -- the loop feeds the real error back instead of crashing ---
  console.log("\n[3] A tool that genuinely fails: the loop feeds the real error back to the model instead of crashing...\n");
  const registry2 = new ToolRegistry();
  registry2.register(
    adaptTools(
      [
        {
          name: "risky_tool",
          description: "Always fails.",
          parameters: { type: "object", properties: {} },
          execute: async () => {
            throw new Error("real downstream failure -- database unreachable");
          },
        },
      ],
      {}
    )
  );
  let errCallCount = 0;
  const errServer = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      errCallCount++;
      if (errCallCount === 1) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: "call_e", type: "function", function: { name: "risky_tool", arguments: "{}" } }] } }] }));
      } else {
        const toolMsg = parsed.messages.find((m: any) => m.role === "tool");
        const parsedContent = JSON.parse(toolMsg.content);
        assert.ok(parsedContent.error.includes("real downstream failure"), "the real error message must reach the model, not a generic placeholder");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "I hit a real error trying that -- database unreachable." } }] }));
      }
    });
  });
  await new Promise<void>((resolve) => errServer.listen(0, resolve));
  const errPort = (errServer.address() as any).port;
  const errProvider = new OpenAICompatibleProvider("groq", `http://127.0.0.1:${errPort}`, "test-key", "llama-3.3-70b-versatile");
  const errLoop = new AgentLoop(errProvider, registry2);
  const errResult = await errLoop.run([{ role: "user", content: "Do the risky thing." }]);
  assert.equal(errResult.status, "done");
  assert.ok((errResult as any).text.includes("database unreachable"));
  assert.equal((errResult as any).steps[0].isError, true);
  console.log(`    real tool failure recorded as a step (isError=true), fed back, loop recovered gracefully: "${(errResult as any).text}"`);
  await new Promise<void>((resolve) => errServer.close(() => resolve()));

  // --- [4] Real infinite-loop guard: a model that NEVER stops requesting tools ---
  console.log("\n[4] Real step-cap guard: a model that keeps requesting tool calls forever is genuinely stopped...\n");
  const registry3 = new ToolRegistry();
  registry3.register(adaptTools([{ name: "noop", description: "does nothing", parameters: { type: "object", properties: {} }, execute: async () => ({ ok: true }) }], {}));
  const loopyServer = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: "call_x", type: "function", function: { name: "noop", arguments: "{}" } }] } }] }));
  });
  await new Promise<void>((resolve) => loopyServer.listen(0, resolve));
  const loopyPort = (loopyServer.address() as any).port;
  const loopyProvider = new OpenAICompatibleProvider("groq", `http://127.0.0.1:${loopyPort}`, "test-key", "model");
  const loopyLoop = new AgentLoop(loopyProvider, registry3);
  let cappedErr: MaxStepsExceededError | undefined;
  try {
    await loopyLoop.run([{ role: "user", content: "go" }], { maxSteps: 3 });
  } catch (err) {
    if (err instanceof MaxStepsExceededError) cappedErr = err;
  }
  assert.ok(cappedErr, "a real model that never stops requesting tools must be genuinely capped, not looped forever");
  assert.equal(cappedErr!.maxSteps, 3);
  console.log(`    real cap enforced after ${cappedErr!.maxSteps} steps: ${cappedErr!.message}`);
  await new Promise<void>((resolve) => loopyServer.close(() => resolve()));

  // --- [5] ask_user: the loop genuinely PAUSES, no fake answer invented ---
  console.log("\n[5] ask_user: the loop genuinely pauses for a real user answer, then genuinely resumes...\n");
  const registry4 = new ToolRegistry();
  registry4.register([createAskUserTool(OWNER)]);
  let askCallCount = 0;
  const askServer = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      askCallCount++;
      if (askCallCount === 1) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: null, tool_calls: [{ id: "call_ask", type: "function", function: { name: "ask_user", arguments: JSON.stringify({ question: "Should I close the XAUUSD position now?" }) } }] } }],
          })
        );
      } else {
        const toolMsg = parsed.messages.find((m: any) => m.role === "tool" && m.tool_call_id === "call_ask");
        assert.ok(toolMsg, "the resumed call must carry the real user answer back as this exact tool's result");
        assert.equal(toolMsg.content, "Yes, close it.");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "Closing XAUUSD now." } }] }));
      }
    });
  });
  await new Promise<void>((resolve) => askServer.listen(0, resolve));
  const askPort = (askServer.address() as any).port;
  const askProvider = new OpenAICompatibleProvider("groq", `http://127.0.0.1:${askPort}`, "test-key", "model");
  const askLoop = new AgentLoop(askProvider, registry4);

  const paused = await askLoop.run([{ role: "user", content: "Handle my XAUUSD position." }]);
  assert.equal(paused.status, "awaiting_user");
  assert.equal((paused as any).question.question, "Should I close the XAUUSD position now?");
  assert.equal(askCallCount, 1, "must NOT have made a second model call while genuinely paused");
  console.log(`    real pause: status=${paused.status}, real question stored: "${(paused as any).question.question}"`);

  const storedQuestion = getPendingQuestion(OWNER);
  assert.equal(storedQuestion?.question, "Should I close the XAUUSD position now?");
  console.log(`    real pending question persisted for owner "${OWNER}": ${JSON.stringify(storedQuestion)}`);

  const resumed = await askLoop.resume(paused as any, "Yes, close it.");
  assert.equal(resumed.status, "done");
  assert.equal((resumed as any).text, "Closing XAUUSD now.");
  assert.equal(askCallCount, 2, "resuming must genuinely make the second real model call, carrying the real answer");
  console.log(`    real resume completed with the real user's answer: "${(resumed as any).text}"`);
  await new Promise<void>((resolve) => askServer.close(() => resolve()));

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
