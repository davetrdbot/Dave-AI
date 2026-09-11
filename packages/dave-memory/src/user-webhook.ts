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
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "webhooks", "user-tokens.json");
}

function inboxPath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "webhooks", "inbox", `${userId}.jsonl`);
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

/**
 * Step 12.3: auto-generated endpoint/sub-path per worker, real now (the
 * Step 4 stub reserved this namespace and returned 501, pointing here).
 * Distinct token store from the per-user webhook, keyed by workerId so
 * a leaked worker token only ever resolves that one worker's identity,
 * not the user's own hidden channel.
 */
export interface WorkerWebhook {
  ownerUserId: string;
  workerId: string;
  tag: string; // e.g. "#martins" -- how this worker's output gets tagged
  token: string;
  path: string;
}

interface WorkerTokenRecord {
  ownerUserId: string;
  workerId: string;
  tag: string;
}

function workerTokensPath(): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "webhooks", "worker-tokens.json");
}

function readWorkerTokens(): Record<string, WorkerTokenRecord> {
  const path = workerTokensPath();
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeWorkerTokens(tokens: Record<string, WorkerTokenRecord>): void {
  const path = workerTokensPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(tokens, null, 2), "utf8");
}

export function getOrCreateWorkerWebhook(ownerUserId: string, workerId: string, tag: string): WorkerWebhook {
  const tokens = readWorkerTokens();
  const existing = Object.entries(tokens).find(([, r]) => r.workerId === workerId);
  const token = existing ? existing[0] : randomBytes(24).toString("hex");
  if (!existing) {
    tokens[token] = { ownerUserId, workerId, tag };
    writeWorkerTokens(tokens);
  }
  return { ownerUserId, workerId, tag, token, path: `${WORKER_HOOK_PREFIX}/${workerId}/${token}` };
}

export function resolveWorkerToken(workerId: string, token: string): WorkerTokenRecord | undefined {
  const record = readWorkerTokens()[token];
  if (!record || record.workerId !== workerId) return undefined; // token must match ITS OWN worker id, not just be valid for someone
  return record;
}

export interface WebhookPush {
  ts: number;
  // "heartbeat"/"snapshot" are what the real DaveEA.mq5 template sends
  // today (ea/DaveEA.mq5, packages/dave-telegram/src/ea-file.ts) -- the
  // other four are Dave-to-user pushes. Full EA protocol handling
  // (positions, pending orders, results) is Step 11's job; this only
  // needs the type vocabulary to honestly match what's real right now.
  type: "file" | "image" | "journal-entry" | "settings-change" | "heartbeat" | "snapshot" | "worker-report";
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
 * and the real per-worker webhook route (Step 12.3) -- two genuinely
 * distinct URL/token namespaces sharing one process.
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
      const validTypes: WebhookPush["type"][] = ["file", "image", "journal-entry", "settings-change", "heartbeat", "snapshot", "worker-report"];
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
      // Real route now: /hooks/worker/<workerId>/<token>
      const rest = url.slice(`${WORKER_HOOK_PREFIX}/`.length);
      const [workerId, token] = rest.split("/");
      const record = workerId && token ? resolveWorkerToken(workerId, token) : undefined;
      if (!record) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unknown worker or token" }));
        return;
      }
      const body = await readBody(req);
      let parsed: { content: string; tag?: string };
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid JSON body" }));
        return;
      }
      if (typeof parsed.content !== "string" || parsed.content.length === 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "content is required" }));
        return;
      }
      const tag = parsed.tag ?? record.tag;
      const push: WebhookPush = { ts: Date.now(), type: "worker-report", payload: { workerId: record.workerId, tag, content: parsed.content } };
      appendInbox(record.ownerUserId, push);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, tag }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
}
