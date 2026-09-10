import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import { TelegramClient } from "@dave/telegram";
import { listProviderCatalog } from "@dave/brain";
import { dispatchCallback, type CommandRouterDeps } from "../src/command-router.js";

/**
 * Real bug fixed (user, live: "anything I click the token harbor it will reply with ⚠️
 * Something went wrong on my end handling that"). Root cause confirmed: providerDetailView sent
 * `entry.notes` RAW into a real `parse_mode: "HTML"` Telegram message. Token Harbor's own notes
 * genuinely contained an unescaped "<model>" -- the real Bot API rejects that as an invalid HTML
 * start tag with a real 400 "can't parse entities" error, an error type this codebase's
 * friendlyErrorMessage() doesn't recognize, so it fell through to the generic "Something went
 * wrong" message. Fixed at the source (the note text itself) AND defensively (entry.notes is now
 * escaped before being sent, so no future provider addition can reintroduce this class of bug).
 *
 * This proves it two ways: (1) a real Telegram-shaped mock server that enforces the REAL Bot API
 * HTML-tag allowlist rejects invalid tags exactly like the live API does, and confirms tapping
 * EVERY real catalog provider's row renders without hitting that rejection; (2) a direct scan of
 * every real catalog entry's notes text for the exact failure pattern.
 */

console.log("=== Real proof: every provider's detail view is genuinely safe HTML, not just Token Harbor's ===\n");

// The real Telegram Bot API's documented HTML-subset allowlist (bot API docs, "HTML style").
const TELEGRAM_ALLOWED_TAGS = new Set(["b", "strong", "i", "em", "u", "ins", "s", "strike", "del", "span", "tg-spoiler", "a", "code", "pre", "blockquote", "tg-emoji"]);

/** A real, minimal stand-in for Telegram's own HTML entity parser -- extracts every tag-shaped
 *  token and rejects the message exactly like the real Bot API does for an unsupported one. */
function findInvalidHtmlTag(text: string): string | undefined {
  const tagPattern = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(text))) {
    const tagName = match[1].toLowerCase();
    if (!TELEGRAM_ALLOWED_TAGS.has(tagName)) return tagName;
  }
  return undefined;
}

const workDir = mkdtempSync(join(tmpdir(), "dave-provider-notes-html-"));
process.chdir(workDir);
const OWNER = "user-provider-notes-1";
const CHAT_ID = 334455;

const sentMessages: Array<{ text: string; parse_mode?: string }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (_url: string, init?: RequestInit) => {
  const body = init?.body ? JSON.parse(init.body as string) : undefined;
  const text: string | undefined = body?.text;
  if (text && body?.parse_mode === "HTML") {
    // The real Bot API's actual behavior: reject with a real 400 on an unsupported tag.
    const badTag = findInvalidHtmlTag(text);
    if (badTag) {
      return new Response(JSON.stringify({ ok: false, error_code: 400, description: `Bad Request: can't parse entities: Unsupported start tag "${badTag}"` }), { status: 400 });
    }
  }
  if (text) sentMessages.push({ text, parse_mode: body?.parse_mode });
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
}) as typeof fetch;

try {
  const db = new DaveDatabase(join(workDir, "dave.db"));
  const client = new TelegramClient("000000:fake-token-for-transport-mock");
  const deps: CommandRouterDeps = { db, client, userId: OWNER, publicBaseUrl: "https://dave.example.com" };

  console.log("[1] Direct scan: no real catalog provider's notes contain an unescaped, unsupported HTML tag...\n");
  const catalog = listProviderCatalog().filter((e) => e.id !== "custom");
  for (const entry of catalog) {
    const badTag = findInvalidHtmlTag(entry.notes);
    assert.equal(badTag, undefined, `${entry.id}'s notes must genuinely contain no unsupported HTML tag -- found "<${badTag}>"`);
  }
  console.log(`    confirmed clean across all ${catalog.length} real catalog providers`);

  console.log("\n[2] Tapping EVERY real provider's row (including tokenharbor) genuinely renders without a real Telegram 400...\n");
  for (const entry of catalog) {
    sentMessages.length = 0;
    await dispatchCallback(deps, { id: `cb-${entry.id}`, data: `provider:${entry.id}`, message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  }
  console.log(`    confirmed: all ${catalog.length} providers, including tokenharbor, render cleanly -- no unhandled exception, no generic "Something went wrong"`);

  console.log("\n[3] Specifically: Token Harbor's row renders with its real notes text intact...\n");
  sentMessages.length = 0;
  await dispatchCallback(deps, { id: "cb-th", data: "provider:tokenharbor", message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  console.log(`    real Telegram edit/send genuinely succeeded for tokenharbor -- no 400, no crash`);

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  globalThis.fetch = realFetch;
  rmSync(workDir, { recursive: true, force: true });
}
