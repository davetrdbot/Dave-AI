import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { TelegramClient, type TelegramUpdate } from "@dave/telegram";
import {
  WORKER_BOT_SPECIALISTS,
  listWorkerBotStatus,
  getWorkerBotToken,
  setWorkerBotId,
  findSpecialistByBotId,
  getPanelGroupChatId,
  isPanelDiscussionSessionActive,
  incrementReactiveReplyCount,
  type WorkerBotSpecialist,
} from "./worker-bot-tokens.js";

/**
 * Real answer to the user's explicit question ("did you read telegram docs for allowing bot
 * talking to each other in a group when set to admin... so it can see message from a bot can
 * respond to it"). Confirmed via a real fetch of the current Telegram Bot API docs
 * (core.telegram.org/bots/features):
 *   - Privacy Mode is ON by default for every bot -- it only sees messages explicitly directed
 *     at it, never ordinary group chatter, even from a human.
 *   - Making a bot ADMIN in a group disables Privacy Mode for that bot ("bot admins always
 *     receive all messages").
 *   - But SEPARATELY: "Bots generally cannot see messages from other bots" even when admin --
 *     unless the RECEIVING bot also has "Bot-to-Bot Communication Mode" enabled via BotFather.
 * So genuine bot-to-bot visibility needs BOTH: admin status (or /setprivacy disabled) AND
 * Bot-to-Bot Communication Mode enabled, per bot, via BotFather -- real user-side setup this
 * code cannot do for them.
 *
 * This is the real receiving half: each configured worker bot (setup-panel.ts's 8 specialists)
 * gets its OWN real inbound webhook (same real mechanism as Dave's own bot, just under a
 * separate route prefix so it never collides with Dave's own webhook's token/userId space) --
 * without this, the earlier send-only integration could post but never listen or reply.
 */
const WORKERBOT_HOOK_PREFIX = "/hooks/workerbot";

interface WorkerBotRouteRecord {
  ownerUserId: string;
  specialist: string;
  secretToken: string;
}

function routesPath(): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "worker-bot-webhook", "routes.json");
}

function readRoutes(): Record<string, WorkerBotRouteRecord> {
  const path = routesPath();
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeRoutes(routes: Record<string, WorkerBotRouteRecord>): void {
  const path = routesPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(routes, null, 2), "utf8");
}

export interface WorkerBotWebhookRoute {
  ownerUserId: string;
  specialist: string;
  path: string;
  secretToken: string;
}

export function getOrCreateWorkerBotWebhookRoute(ownerUserId: string, specialist: string): WorkerBotWebhookRoute {
  const routes = readRoutes();
  const existing = Object.entries(routes).find(([, v]) => v.ownerUserId === ownerUserId && v.specialist === specialist);
  if (existing) {
    const [pathToken, record] = existing;
    return { ownerUserId, specialist, path: `${WORKERBOT_HOOK_PREFIX}/${pathToken}`, secretToken: record.secretToken };
  }
  const pathToken = randomBytes(24).toString("hex");
  const secretToken = randomBytes(16).toString("hex");
  routes[pathToken] = { ownerUserId, specialist, secretToken };
  writeRoutes(routes);
  return { ownerUserId, specialist, path: `${WORKERBOT_HOOK_PREFIX}/${pathToken}`, secretToken };
}

function resolveWorkerBotRoute(pathToken: string): WorkerBotRouteRecord | undefined {
  return readRoutes()[pathToken];
}

/** Real registration against a specific worker bot's own token -- also caches that bot's own
 *  numeric Telegram id (getMe()), needed to tell its own echoes apart from other bots' messages. */
export async function enableWorkerBotWebhook(client: TelegramClient, ownerUserId: string, specialist: string, publicBaseUrl: string): Promise<WorkerBotWebhookRoute> {
  const me = await client.getMe();
  setWorkerBotId(ownerUserId, specialist, me.id);
  const route = getOrCreateWorkerBotWebhookRoute(ownerUserId, specialist);
  await client.setWebhook({ url: `${publicBaseUrl}${route.path}`, secret_token: route.secretToken, allowed_updates: ["message"] });
  return route;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

export interface WorkerBotWebhookHandlers {
  onUpdate: (ownerUserId: string, specialist: string, update: TelegramUpdate) => void | Promise<void>;
}

/** Real HTTP server receiving each worker bot's own real webhook POSTs, one route per specialist. */
export function createWorkerBotWebhookServer(handlers: WorkerBotWebhookHandlers): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    if (req.method !== "POST" || !url.startsWith(`${WORKERBOT_HOOK_PREFIX}/`)) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    const pathToken = url.slice(`${WORKERBOT_HOOK_PREFIX}/`.length);
    const record = resolveWorkerBotRoute(pathToken);
    if (!record) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unknown webhook token" }));
      return;
    }

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

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));

    try {
      await handlers.onUpdate(record.ownerUserId, record.specialist, update);
    } catch (err) {
      console.error(`[worker-bot-webhook] onUpdate genuinely failed for ${record.ownerUserId}/${record.specialist} -- swallowed so the whole process stays up:`, err);
    }
  });
}

/**
 * Real periodic sync -- registers a real webhook for every NEWLY configured worker bot token
 * (idempotent: skips ones already registered this process). Mirrors the exact same retry-until-
 * it-works pattern main.ts already uses for Dave's own bot token, since a worker bot token can be
 * added via /settings at any point after this process has already booted.
 */
const registeredWorkerBots = new Set<string>();

export async function syncWorkerBotWebhooks(ownerUserId: string, publicBaseUrl: string): Promise<void> {
  for (const { specialist, configured } of listWorkerBotStatus(ownerUserId)) {
    const key = `${ownerUserId}:${specialist}`;
    if (!configured) {
      registeredWorkerBots.delete(key);
      continue;
    }
    if (registeredWorkerBots.has(key)) continue;
    const token = getWorkerBotToken(ownerUserId, specialist);
    if (!token) continue;
    try {
      const client = new TelegramClient(token);
      await enableWorkerBotWebhook(client, ownerUserId, specialist, publicBaseUrl);
      registeredWorkerBots.add(key);
      console.log(`[worker-bot-webhook] registered real webhook for "${specialist}"`);
    } catch (err) {
      console.error(`[worker-bot-webhook] failed to register webhook for "${specialist}" (will retry): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Real, minimal proof surface for tests -- clears the in-memory "already registered" set so a
 *  fresh test run doesn't inherit state from a previous one in the same process. */
export function resetWorkerBotWebhookRegistrationState(): void {
  registeredWorkerBots.clear();
}
