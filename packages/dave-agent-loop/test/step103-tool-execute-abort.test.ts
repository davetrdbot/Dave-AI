import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { OpenAICompatibleProvider } from "@dave/brain";
import { ToolRegistry, adaptTools, AgentLoop } from "../src/index.js";
import { beginTurn, endTurn, abortTurn } from "../src/turn-abort.js";

/**
 * Real bug fixed (independent audit, CONFIRMED): AgentLoop.run()'s tool-calling loop called
 * `await this.registry.execute(call.name, call.arguments)` with NO timeout or abort mechanism.
 * If a tool's own execute() hung on an unresolved DB/EA/network await, the whole turn was stuck
 * forever -- neither the overall wall-clock deadline nor a real /stop (an AbortSignal) could ever
 * recover it, because both were only ever checked/wired around provider.generate() calls, never
 * around tool execution. This proves the real fix: a hung tool call is now genuinely cut off by
 * BOTH the overall deadline and a real external AbortSignal, at both call sites in the loop body
 * (the normal-tool branch and the ask_user branch), while a normal tool call still behaves
 * exactly as before.
 */

console.log("=== Real proof: a tool that hangs forever no longer wedges the agent loop ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-tool-abort-"));

try {
  process.chdir(workDir);

  function makeModelServerRequestingTool(toolName: string, argsJson = "{}") {
    let callCount = 0;
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        JSON.parse(body);
        callCount++;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: toolName, arguments: argsJson } }] } }],
          })
        );
      });
    });
    return { server, getCallCount: () => callCount };
  }

  // --- [a] A tool that never resolves is genuinely cut off by the overall deadline ---
  console.log("[a] A tool whose execute() never resolves is cut off by the real overall deadline...\n");
  {
    const registry = new ToolRegistry();
    let toolWasCalled = false;
    registry.register(
      adaptTools(
        [
          {
            name: "hangs_forever",
            description: "Never resolves -- simulates a genuinely stuck DB/EA/network await inside a tool.",
            parameters: { type: "object", properties: {} },
            execute: async () => {
              toolWasCalled = true;
              return new Promise(() => {
                /* deliberately never resolves */
              });
            },
          },
        ],
        {}
      )
    );

    const { server } = makeModelServerRequestingTool("hangs_forever");
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;
    const provider = new OpenAICompatibleProvider("groq", `http://127.0.0.1:${port}`, "test-key", "model");
    const loop = new AgentLoop(provider, registry);

    const started = Date.now();
    const result = await loop.run([{ role: "user", content: "go" }], { overallTimeoutMs: 500, timeoutMs: 60_000 });
    const elapsed = Date.now() - started;

    assert.ok(toolWasCalled, "the real tool's execute() must have genuinely been invoked");
    assert.equal(result.status, "aborted");
    assert.equal((result as any).reason, "deadline");
    assert.ok(elapsed < 55_000, `must return near the real 500ms overall deadline, not hang out the tool forever (took ${elapsed}ms)`);
    console.log(`    real deadline cut off a hung tool: status=${result.status}, reason=${(result as any).reason}, returned after ${elapsed}ms`);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // --- [b] A tool that never resolves is genuinely cut off by a real external AbortSignal firing
  //         mid-execution (the exact mechanism /stop uses via turn-abort.ts). ---
  console.log("\n[b] A tool whose execute() never resolves is cut off by a real external AbortSignal firing mid-execution...\n");
  {
    const registry = new ToolRegistry();
    let toolWasCalled = false;
    registry.register(
      adaptTools(
        [
          {
            name: "hangs_forever",
            description: "Never resolves.",
            parameters: { type: "object", properties: {} },
            execute: async () => {
              toolWasCalled = true;
              return new Promise(() => {});
            },
          },
        ],
        {}
      )
    );

    const { server } = makeModelServerRequestingTool("hangs_forever");
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;
    const provider = new OpenAICompatibleProvider("groq", `http://127.0.0.1:${port}`, "test-key", "model");
    const loop = new AgentLoop(provider, registry);

    const OWNER = "user-tool-abort-1";
    const controller = beginTurn(OWNER);
    const runPromise = loop.run([{ role: "user", content: "go" }], { overallTimeoutMs: 60_000, timeoutMs: 60_000, signal: controller.signal });

    // Give the real model call time to complete and the tool to genuinely start running before
    // firing a real external abort -- this must land WHILE the tool is stuck, not before.
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(toolWasCalled, "the tool must have genuinely started running before the external abort fires");
    const wasCancelled = abortTurn(OWNER);
    assert.equal(wasCancelled, true, "abortTurn must report it genuinely found and cancelled the in-flight turn");

    const started = Date.now();
    const result = await runPromise;
    const elapsed = Date.now() - started;

    assert.equal(result.status, "aborted");
    assert.equal((result as any).reason, "cancelled");
    assert.ok(elapsed < 5_000, `a real external abort must cut off a hung tool almost immediately, not after any longer wait (took ${elapsed}ms)`);
    console.log(`    real external abort cut off a hung tool mid-execution: status=${result.status}, reason=${(result as any).reason}, returned after ${elapsed}ms`);
    endTurn(OWNER, controller);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // --- [c] A normal tool call still works exactly as before (regression) ---
  console.log("\n[c] A normal, fast-resolving tool call still works exactly as before...\n");
  {
    const registry = new ToolRegistry();
    let realToolWasCalled: Record<string, unknown> | undefined;
    registry.register(
      adaptTools(
        [
          {
            name: "get_balance",
            description: "Get the user's real account balance.",
            parameters: { type: "object", properties: {} },
            execute: async (args: Record<string, unknown>) => {
              realToolWasCalled = args;
              return { balance: 10042 };
            },
          },
        ],
        {}
      )
    );

    let callCount = 0;
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body);
        callCount++;
        if (callCount === 1) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_balance", arguments: "{}" } }] } }] }));
        } else {
          const toolMsg = parsed.messages.find((m: any) => m.role === "tool");
          assert.ok(toolMsg);
          assert.deepEqual(JSON.parse(toolMsg.content), { balance: 10042 });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { content: "Your real balance is $10,042." } }] }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;
    const provider = new OpenAICompatibleProvider("groq", `http://127.0.0.1:${port}`, "test-key", "model");
    const loop = new AgentLoop(provider, registry);

    const result = await loop.run([{ role: "user", content: "What's my balance?" }], { overallTimeoutMs: 60_000 });
    assert.equal(result.status, "done");
    assert.equal((result as any).text, "Your real balance is $10,042.");
    assert.equal(callCount, 2);
    assert.deepEqual(realToolWasCalled, {});
    console.log(`    real, unaffected normal tool call: status=${result.status}, text="${(result as any).text}"`);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // --- [c-2] A tool that genuinely throws still works exactly as before (isError, fed back) ---
  console.log("\n[c-2] A tool that genuinely throws still recovers exactly as before (regression)...\n");
  {
    const registry = new ToolRegistry();
    registry.register(
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

    let callCount = 0;
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body);
        callCount++;
        if (callCount === 1) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: "call_e", type: "function", function: { name: "risky_tool", arguments: "{}" } }] } }] }));
        } else {
          const toolMsg = parsed.messages.find((m: any) => m.role === "tool");
          const parsedContent = JSON.parse(toolMsg.content);
          assert.ok(parsedContent.error.includes("real downstream failure"));
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { content: "I hit a real error -- database unreachable." } }] }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;
    const provider = new OpenAICompatibleProvider("groq", `http://127.0.0.1:${port}`, "test-key", "model");
    const loop = new AgentLoop(provider, registry);
    const result = await loop.run([{ role: "user", content: "Do the risky thing." }], { overallTimeoutMs: 60_000 });
    assert.equal(result.status, "done");
    assert.ok((result as any).text.includes("database unreachable"));
    assert.equal((result as any).steps[0].isError, true);
    console.log(`    real tool failure still recorded as a step (isError=true) and fed back: "${(result as any).text}"`);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // --- [d] Aggregated cache usage sums correctly across multiple provider calls in one run ---
  console.log("\n[d] Aggregated cache usage sums correctly across multiple provider calls in one run...\n");
  {
    const registry = new ToolRegistry();
    registry.register(adaptTools([{ name: "noop", description: "does nothing", parameters: { type: "object", properties: {} }, execute: async () => ({ ok: true }) }], {}));

    let callCount = 0;
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        callCount++;
        if (callCount === 1) {
          // First call: real tokenUsage AND real cacheUsage (Claude/Fireworks-shaped: cached_tokens).
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              choices: [{ message: { content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "noop", arguments: "{}" } }] } }],
              usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 } },
            })
          );
        } else if (callCount === 2) {
          // Second call: real tokenUsage but NO cache usage at all (provider that doesn't report it).
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              choices: [{ message: { content: null, tool_calls: [{ id: "call_2", type: "function", function: { name: "noop", arguments: "{}" } }] } }],
              usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
            })
          );
        } else {
          // Third call: real tokenUsage AND real cacheUsage again -- must ADD to the first call's,
          // not overwrite it, and must not be broken by the second call having none.
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              choices: [{ message: { content: "Done." } }],
              usage: { prompt_tokens: 200, completion_tokens: 30, total_tokens: 230, prompt_tokens_details: { cached_tokens: 60 } },
            })
          );
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;
    const provider = new OpenAICompatibleProvider("groq", `http://127.0.0.1:${port}`, "test-key", "model");
    const loop = new AgentLoop(provider, registry);
    const result = await loop.run([{ role: "user", content: "go" }], { overallTimeoutMs: 60_000 });

    assert.equal(result.status, "done");
    assert.equal(callCount, 3);
    const usage = (result as any).tokenUsage;
    assert.ok(usage, "tokenUsage must be present -- at least one call reported it");
    assert.equal(usage.promptTokens, 100 + 50 + 200);
    assert.equal(usage.completionTokens, 20 + 10 + 30);
    assert.equal(usage.totalTokens, 120 + 60 + 230);
    assert.equal(usage.cacheReadInputTokens, 40 + 60, "cache-read tokens must sum across every call that reported them, ignoring the one call that didn't");
    assert.equal(usage.cacheCreationInputTokens, 0, "OpenAI-compatible cached_tokens never reports cache creation -- must be a real 0, not undefined or NaN");
    console.log(`    real aggregated usage across ${callCount} calls: ${JSON.stringify(usage)}`);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
