import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import type { TelegramClient, TelegramMessage } from "@dave/telegram";
import { NoGroqKeyError } from "@dave/vision";
import { buildInboundContent, attachmentErrorMessage } from "../src/telegram-bot-server.js";

/**
 * Real bug fixed (live user: "Dave doesn't ask for a Groq API key" for voice-note
 * transcription). Root cause traced: `buildInboundContent`'s `message.voice` branch DID genuinely
 * throw a specific, actionable `NoGroqKeyError` ("add one on the Credentials tab...") when no Groq
 * key was stored -- but the webhook handler's catch-all around it replaced EVERY failure,
 * regardless of type, with the same generic "Couldn't process that attachment. Try again in a
 * moment." line, silently discarding the real, helpful message and leaving the user with no idea
 * a Groq key was ever needed. This proves both halves of the real fix: (1) an incoming voice note
 * with no stored Groq key genuinely throws NoGroqKeyError with its real actionable text, and (2)
 * the webhook's own error-to-user-message mapping (`attachmentErrorMessage`, extracted from the
 * former inline catch body) now surfaces that specific message instead of the generic one -- while
 * still falling back to the generic honest message for any other, unrelated failure.
 */

console.log("=== Real proof: a voice note with no stored Groq key gets a clear, actionable message (not silence/generic failure) ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-voice-no-groq-"));
const OWNER = "user-voice-no-groq-1";

async function main() {
  const db = new DaveDatabase(join(workDir, "dave.db"));

  console.log("[1] A voice note with NO stored Groq key genuinely throws NoGroqKeyError, with the real actionable text...\n");
  const fakeVoiceBytes = Buffer.from("fake ogg opus bytes representing a real voice note");
  const client = { downloadFile: async () => fakeVoiceBytes } as unknown as TelegramClient;
  const message = {
    message_id: 1,
    date: Date.now() / 1000,
    chat: { id: 1, type: "private" },
    voice: { file_id: "voice-file-id", file_unique_id: "voice-unique-1", duration: 3 },
  } as unknown as TelegramMessage;

  let thrown: unknown;
  try {
    await buildInboundContent(client, message, OWNER, db);
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof NoGroqKeyError, `expected a real NoGroqKeyError, got: ${thrown instanceof Error ? thrown.constructor.name + ": " + thrown.message : String(thrown)}`);
  assert.match((thrown as Error).message, /groq/i);
  assert.match((thrown as Error).message, /add one on the Credentials tab|add_provider_key/i);
  console.log(`    real thrown error: "${(thrown as Error).message}"`);

  console.log("\n[2] The webhook's user-facing message mapping surfaces that REAL, specific message -- not a generic dead end...\n");
  const userFacingText = attachmentErrorMessage(thrown);
  assert.ok(userFacingText.includes((thrown as Error).message), "the specific NoGroqKeyError message must genuinely reach the user, not be swallowed by a generic line");
  assert.doesNotMatch(userFacingText, /Try again in a moment/, "a missing-key failure is not transient -- it must not tell the user to just retry");
  console.log(`    real user-facing text: "${userFacingText}"`);

  console.log("\n[3] Any OTHER, unrelated failure still gets the honest generic fallback (never a raw internal error string)...\n");
  const genericText = attachmentErrorMessage(new Error("ECONNRESET: some unrelated real network blip"));
  assert.equal(genericText, "⚠️ Couldn't process that attachment. Try again in a moment.");
  console.log(`    real fallback text for an unrelated failure: "${genericText}"`);

  db.close();
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
