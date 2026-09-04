import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * Step 4.7: a hidden, per-user webhook -- a private endpoint Dave uses
 * to push files, images, journal entries, and settings changes for that
 * specific user. Deliberately a SEPARATE URL namespace from worker
 * sub-paths (Step 12.3 owns those; this file only needs to prove the
 * namespaces don't collide).
 */

const USER_HOOK_PREFIX = "/hooks/user";
const WORKER_HOOK_PREFIX = "/hooks/worker"; // reserved, implemented for real in Step 12

function tokensPath(): string {
  return join(process.cwd(), "data", "webhooks", "user-tokens.json");
}

function inboxPath(userId: string): string {
  return join(process.cwd(), "data", "webhooks", "inbox", `${userId}.jsonl`);
}

function readTokens(): Record<string, string> {
  const path = tokensPath();
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeTokens(tokens: Record<string, string>): void {
  const path = tokensPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(tokens, null, 2), "utf8");
}

export interface UserWebhook {
  userId: string;
  token: string;
  path: string;
}

/** Generates (or returns the existing) hidden webhook for a user. */
export function getOrCreateUserWebhook(userId: string): UserWebhook {
  const tokens = readTokens();
  const existingEntry = Object.entries(tokens).find(([, uid]) => uid === userId);
  const token = existingEntry ? existingEntry[0] : randomBytes(24).toString("hex");
  if (!existingEntry) {
    tokens[token] = userId;
    writeTokens(tokens);
  }
  return { userId, token, path: `${USER_HOOK_PREFIX}/${token}` };
}

export function resolveUserWebhookToken(token: string): string | undefined {
  return readTokens()[token];
}

export interface WebhookPush {
  ts: number;
  // "heartbeat"/"snapshot" are what the real DaveEA.mq5 template sends
  // today (ea/DaveEA.mq5, packages/dave-telegram/src/ea-file.ts) -- the
  // other four are Dave-to-user pushes. Full EA protocol handling
  // (positions, pending orders, results) is Step 11's job; this only
  // needs the type vocabulary to honestly match what's real right now.
  type: "file" | "image" | "journal-entry" | "settings-change" | "heartbeat" | "snapshot";
  payload: unknown;
}

function appendInbox(userId: string, push: WebhookPush): void {
  const path = inboxPath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const line = JSON.stringify(push) + "\n";
  if (existsSync(path)) writeFileSync(path, readFileSync(path, "utf8") + line, "utf8");
  else writeFileSync(path, line, "utf8");
}

export function readInbox(userId: string): WebhookPush[] {
  const path = inboxPath(userId);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/**
 * Starts a real HTTP server exposing the hidden per-user webhook route
 * and a reserved (stub, 501) worker-webhook route -- enough to prove the
 * two namespaces are genuinely distinct URL spaces. Full worker webhook
 * behavior is implemented in Step 12.
 */
export function createHiddenWebhookServer(): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";

    if (req.method === "POST" && url.startsWith(`${USER_HOOK_PREFIX}/`)) {
      const token = url.slice(`${USER_HOOK_PREFIX}/`.length);
      const userId = resolveUserWebhookToken(token);
      if (!userId) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unknown webhook token" }));
        return;
      }
      const body = await readBody(req);
      let parsed: { type: WebhookPush["type"]; payload: unknown };
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid JSON body" }));
        return;
      }
      // TS's WebhookPush["type"] union is compile-time only -- validate
      // it for real at runtime instead of trusting whatever string an
      // arbitrary POST body claims, otherwise this route silently
      // accepts and stores anything.
      const validTypes: WebhookPush["type"][] = ["file", "image", "journal-entry", "settings-change", "heartbeat", "snapshot"];
      if (!validTypes.includes(parsed.type)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `unknown push type "${parsed.type}"` }));
        return;
      }
      const push: WebhookPush = { ts: Date.now(), type: parsed.type, payload: parsed.payload };
      appendInbox(userId, push);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, userId, received: push.type }));
      return;
    }

    if (req.method === "POST" && url.startsWith(`${WORKER_HOOK_PREFIX}/`)) {
      res.writeHead(501, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "worker webhook routes are implemented in Step 12, not here" }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
}
