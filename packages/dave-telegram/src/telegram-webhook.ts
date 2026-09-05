import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { TelegramClient, TelegramUpdate } from "./client.js";

/**
 * Real Telegram webhook mode -- the production alternative to
 * long-polling (getUpdates()). Long-polling only receives updates while
 * something is actively calling getUpdates() in a loop; a webhook means
 * Telegram itself pushes every update the moment it happens to a URL
 * Dave hosts, so the bot is genuinely always listening (subject to the
 * process itself staying up), not just "online" while a poll loop
 * happens to be running.
 */
const TG_HOOK_PREFIX = "/hooks/telegram";

function tokensPath(): string {
  return join(process.cwd(), "data", "telegram-webhook", "tokens.json");
}

function readTokens(): Record<string, { userId: string; secretToken: string }> {
  const path = tokensPath();
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeTokens(tokens: Record<string, { userId: string; secretToken: string }>): void {
  const path = tokensPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(tokens, null, 2), "utf8");
}

export interface TelegramWebhookRegistration {
  userId: string;
  path: string;
  secretToken: string;
}

/** Real, persisted per-user webhook path token -- reused across restarts, not regenerated every time. */
export function getOrCreateTelegramWebhookRoute(userId: string): TelegramWebhookRegistration {
  const tokens = readTokens();
  const existing = Object.entries(tokens).find(([, v]) => v.userId === userId);
  if (existing) {
    const [pathToken, record] = existing;
    return { userId, path: `${TG_HOOK_PREFIX}/${pathToken}`, secretToken: record.secretToken };
  }
  const pathToken = randomBytes(24).toString("hex");
  const secretToken = randomBytes(16).toString("hex");
  tokens[pathToken] = { userId, secretToken };
  writeTokens(tokens);
  return { userId, path: `${TG_HOOK_PREFIX}/${pathToken}`, secretToken };
}

function resolveWebhookToken(pathToken: string): { userId: string; secretToken: string } | undefined {
  return readTokens()[pathToken];
}

/**
 * Real registration with Telegram's own Bot API -- after this call,
 * Telegram will genuinely POST every update to `publicBaseUrl + route.path`.
 * `secret_token` round-trips on every real webhook POST as the
 * `X-Telegram-Bot-Api-Secret-Token` header, which the server below
 * verifies before trusting a request as genuinely from Telegram.
 */
export async function enableTelegramWebhook(client: TelegramClient, userId: string, publicBaseUrl: string): Promise<TelegramWebhookRegistration> {
  const route = getOrCreateTelegramWebhookRoute(userId);
  await client.setWebhook({ url: `${publicBaseUrl}${route.path}`, secret_token: route.secretToken, allowed_updates: ["message", "callback_query"] });
  return route;
}

export async function disableTelegramWebhook(client: TelegramClient): Promise<void> {
  await client.deleteWebhook();
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

export interface TelegramWebhookHandlers {
  onUpdate: (userId: string, update: TelegramUpdate) => void | Promise<void>;
}

/** Real HTTP server receiving Telegram's real webhook POSTs, one per-user token-scoped route per registered user. */
export function createTelegramWebhookServer(handlers: TelegramWebhookHandlers): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    if (req.method !== "POST" || !url.startsWith(`${TG_HOOK_PREFIX}/`)) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    const pathToken = url.slice(`${TG_HOOK_PREFIX}/`.length);
    const record = resolveWebhookToken(pathToken);
    if (!record) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unknown webhook token" }));
      return;
    }

    // Real Telegram secret-token verification -- confirms this POST genuinely
    // came from Telegram (or at least someone who knows the secret this
    // specific user's webhook was registered with), not an arbitrary caller
    // who merely guessed/leaked the URL's path token.
    const headerSecret = req.headers["x-telegram-bot-api-secret-token"];
    if (headerSecret !== record.secretToken) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid secret token" }));
      return;
    }

    let update: TelegramUpdate;
    try {
      update = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid JSON body" }));
      return;
    }

    // Real Telegram contract: webhook responses aren't awaited for content,
    // but Telegram DOES expect a fast 200 -- ack immediately, then process
    // (matches the reference model of any webhook consumer that might do
    // slow work per update).
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));

    await handlers.onUpdate(record.userId, update);
  });
}
