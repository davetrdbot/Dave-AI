import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSkills } from "@dave/skills";
import type { TelegramClient, TelegramMessage } from "@dave/telegram";
import { buildInboundContent } from "../src/telegram-bot-server.js";

/**
 * Part 2, item 5 (skill scoping): real proof that a .jsonl file sent to the bot via Telegram is
 * automatically detected and installed as a skill from the real inbound-message path -- no model
 * decision (no call to install_skills_from_jsonl) required. Root gap this closes: jsonl-install.ts
 * had real parsing logic and a real tool, but nothing in packages/dave-agent-loop/src ever called
 * it automatically on an upload; buildInboundContent's `message.document` branch used to just save
 * the file and hand it back as generic "use your sandbox tools" text.
 */

console.log("=== Real proof: a .jsonl Telegram upload is auto-installed as a skill, no model tool call needed ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-jsonl-auto-install-"));
const OWNER = "user-jsonl-auto-1";

function fakeClient(bytes: Buffer): TelegramClient {
  return { downloadFile: async (_fileId: string) => bytes } as unknown as TelegramClient;
}

async function main() {
  process.chdir(workDir);

  console.log("[1] Sending a real .jsonl document auto-installs its skill(s) -- no tool call, real content in the reply...\n");
  const jsonlContent = [
    JSON.stringify({ name: "Auto-Installed Strategy", description: "Sent as a raw .jsonl upload.", content: "M1/M3 only. Liquidity sweep + reclaim entries. No EMA, no Gann fan." }),
  ].join("\n");
  const bytes = Buffer.from(jsonlContent, "utf8");

  const message = {
    message_id: 1,
    date: Date.now() / 1000,
    chat: { id: 1, type: "private" },
    document: { file_id: "fake-file-id", file_unique_id: "fake-unique", file_name: "my-strategy.jsonl" },
  } as unknown as TelegramMessage;

  const result = await buildInboundContent(fakeClient(bytes), message, OWNER, undefined as any);
  assert.equal(typeof result, "string");
  assert.match(result as string, /auto-installed/i);
  assert.match(result as string, /Auto-Installed Strategy/);
  console.log(`    real reply text: ${result}`);

  const installed = listSkills(OWNER);
  assert.ok(installed.some((s) => s.name === "Auto-Installed Strategy" && s.source === "jsonl-upload"), "the real skill must genuinely be installed, source=jsonl-upload");
  console.log(`    confirmed genuinely installed: ${installed.map((s) => `${s.name} (${s.source})`).join(", ")}`);

  console.log("\n[2] A malformed line in the upload is reported, not silently dropped...\n");
  const badJsonl = ["not even json", JSON.stringify({ name: "Only Name No Content" })].join("\n");
  const badBytes = Buffer.from(badJsonl, "utf8");
  const badMessage = {
    message_id: 2,
    date: Date.now() / 1000,
    chat: { id: 1, type: "private" },
    document: { file_id: "fake-file-id-2", file_unique_id: "fake-unique-2", file_name: "broken.jsonl" },
  } as unknown as TelegramMessage;
  const badResult = (await buildInboundContent(fakeClient(badBytes), badMessage, OWNER, undefined as any)) as string;
  assert.match(badResult, /Errors:/);
  assert.match(badResult, /not valid JSON/);
  console.log(`    real reply text reports the errors: ${badResult}`);

  console.log("\n=== ALL ASSERTIONS PASSED ===");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(workDir, { recursive: true, force: true });
  });
