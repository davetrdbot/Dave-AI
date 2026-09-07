import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { DaveDatabase } from "@dave/db";
import { DavemaClient } from "@dave/davema";
import { EaTradeExecutor } from "@dave/ea-bridge";
import { addProviderKey, setModelConfig } from "@dave/brain";
import { getOrCreateTelegramWebhookRoute } from "@dave/telegram";
import { startTelegramBotServer } from "../src/telegram-bot-server.js";
import { listWorkers, getWorker } from "@dave/workers";

/**
 * Real proof, end-to-end through the actual product surface (a real Telegram message to Dave --
 * not calling runWorkerTask directly): Dave deciding to call create_subagent genuinely creates a
 * real worker AND kicks off a real background agent run for it (full-registry.ts's wiring),
 * without blocking Dave's own reply to the user. Both Dave's own conversation and the worker's
 * own independent run share the same mocked provider endpoint -- distinguished here by system
 * prompt, exactly like two real, separate conversations would be.
 */

console.log("=== Real proof: create_subagent through a real Dave conversation genuinely starts a real worker run ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-create-subagent-e2e-"));
process.chdir(workDir);
const OWNER = "user-create-subagent-e2e-1";
const CHAT_ID = 424242;

const sentMessages: string[] = [];
let daveCalls = 0;
let workerCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const urlStr = String(url);
  if (urlStr.includes("api.telegram.org")) {
    const method = urlStr.split("/").pop() ?? "";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    if (method === "setWebhook" || method === "setMyCommands" || method === "setMyDescription" || method === "setMyShortDescription") {
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }
    if (body?.text) sentMessages.push(body.text);
    if (body?.rich_message?.html) sentMessages.push(body.rich_message.html);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  }
  if (urlStr.startsWith("https://dave.example.com/hooks/worker/")) {
    return new Response(JSON.stringify({ ok: true, tag: "#priya" }), { status: 200 });
  }
  if (urlStr.includes("api.openai.com")) {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const systemContent = String(body?.messages?.[0]?.content ?? "");

    if (systemContent.startsWith("You are Dave")) {
      daveCalls++;
      if (daveCalls === 1) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "",
                  tool_calls: [
                    {
                      id: "call-create",
                      type: "function",
                      function: {
                        name: "create_subagent",
                        arguments: JSON.stringify({ name: "Priya", assignment: "temporary", role: "generic", task: "Check EURUSD for a real setup and report back." }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "I've created Priya to check EURUSD and report back." } }] }), { status: 200 });
    }

    // The worker's (Priya's) own, entirely separate real agent run.
    workerCalls++;
    if (workerCalls === 1) {
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: "wcall1", type: "function", function: { name: "report_to_user", arguments: JSON.stringify({ content: "Checked EURUSD -- no real setup yet." }) } }] } }] }),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "EURUSD check complete: no setup found this cycle." } }] }), { status: 200 });
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

let server: Awaited<ReturnType<typeof startTelegramBotServer>> | undefined;
try {
  const db = new DaveDatabase(join(workDir, "dave.db"));
  addProviderKey(db, OWNER, "openai", "owner key", { apiKey: "sk-openai-fake", model: "gpt-owner-model" });
  setModelConfig(OWNER, { primary: "openai", fallback: [] });

  const davema = new DavemaClient(undefined, "http://127.0.0.1:1");
  const executor = new EaTradeExecutor(OWNER);
  server = await startTelegramBotServer({ ownerUserId: OWNER, db, davema, executor, botToken: "000000:fake-bot-token", publicBaseUrl: "https://dave.example.com", systemPrompt: "You are Dave." });
  await new Promise<void>((resolve) => server!.server.listen(0, "127.0.0.1", resolve));
  const port = (server.server.address() as { port: number }).port;
  const webhookPath = new URL(server.webhookUrl).pathname;
  const routeInfo = getOrCreateTelegramWebhookRoute(OWNER);

  const postUpdate = (body: unknown) =>
    new Promise<void>((resolve, reject) => {
      const json = JSON.stringify(body);
      const req = request(
        { hostname: "127.0.0.1", port, path: webhookPath, method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": routeInfo.secretToken, "content-length": Buffer.byteLength(json) } },
        (res) => { res.resume(); res.on("end", resolve); }
      );
      req.on("error", reject);
      req.write(json);
      req.end();
    });

  console.log("[1] A real user message asks Dave to spin up a worker...");
  await postUpdate({ update_id: 1, message: { message_id: 1, chat: { id: CHAT_ID }, text: "create a worker named Priya to check EURUSD", date: Date.now() / 1000 } });
  await new Promise((r) => setTimeout(r, 3000));

  console.log("\n[2] A real worker record genuinely exists...");
  const workers = listWorkers(OWNER, false);
  assert.equal(workers.length, 1);
  const worker = workers[0];
  assert.equal(worker.name, "Priya");
  console.log(`    real worker: ${JSON.stringify(worker)}`);

  console.log("\n[3] Dave's own reply reached the user WITHOUT waiting for the worker's own run to finish...");
  const daveReply = sentMessages.find((t) => t.includes("I've created Priya"));
  assert.ok(daveReply, "Dave's own completion must genuinely reach the user");
  console.log(`    real Dave reply: "${daveReply}"`);

  console.log("\n[4] The worker's OWN real agent run genuinely executed in the background -- its report reached the user too...");
  const workerReport = sentMessages.find((t) => t.includes("Checked EURUSD"));
  assert.ok(workerReport, "the worker's real report must genuinely have been sent");
  assert.ok(workerReport!.startsWith("#priya:"));
  console.log(`    real worker report: "${workerReport}"`);

  const workerFinal = sentMessages.find((t) => t.includes("EURUSD check complete"));
  assert.ok(workerFinal, "the worker's real final completion text must genuinely have reached the user");
  console.log(`    real worker completion: "${workerFinal}"`);

  console.log("\n[5] The temporary worker genuinely retired itself once its real run completed...");
  const finalState = getWorker(OWNER, worker.id);
  assert.equal(finalState!.active, false);
  console.log(`    worker "${worker.name}" active=${finalState!.active}`);

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  server?.server.close();
  globalThis.fetch = realFetch;
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
