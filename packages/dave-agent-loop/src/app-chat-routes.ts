import type { IncomingMessage, ServerResponse } from "node:http";
import { verifyDeviceToken } from "@dave/db";
import type { CompletionMessage, ContentBlock } from "@dave/brain";
import { buildImageContentBlock } from "@dave/vision";
import { activityAfter, latestActivityId, subscribeActivity, type ActivityEvent, type ActivityFeed } from "./activity-bus.js";
import { runAppChatTurn, sharedHistoryKey, newTurnId, type AppChatDeps } from "./app-chat.js";
import { loadConversationHistory } from "./conversation-store.js";
import { getBusyState, getAutonomousBusyState } from "./busy-state.js";
import { abortTurn, isTurnRunning } from "./turn-abort.js";
import { nousDepsFor, placeNousSignal, skipNousSignal, applyNousUpdate, skipNousUpdate, closeNousTrade } from "./nous/service.js";

/**
 * The app's chat, served by the bot process itself (where Dave runs), at /api/app/chat/*. Every
 * other /api/app route lives in the admin panel; these can't, because they need the live turn --
 * its events as they happen, and a real Stop. Same paired-device token as the admin routes
 * (verifyDeviceToken, @dave/db), same answer for any bad token.
 *
 *   GET  history            the shared conversation (app + Telegram), for display
 *   POST send               {text, images?: [{data: base64, mediaType}], whenFree?: bool}
 *   GET  stream             Server-Sent Events of the activity bus (Last-Event-ID / ?after=, ?feeds=)
 *   GET  activity           the same events as JSON (catch-up, background notifications)
 *   GET  state              is Dave busy, and with what
 *   POST stop               stop whatever Dave is doing right now
 *   POST action             {callback} -- a card button from the app (Nous Place/Skip, ...)
 */

export const APP_CHAT_PREFIX = "/api/app/chat/";
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const PING_MS = 25_000;
const WAIT_FOR_FREE_MS = 10 * 60_000;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("That's too large to send (16 MB max)."), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw Object.assign(new Error("Expected a JSON body."), { status: 400 });
  }
}

function feedsParam(url: URL): ActivityFeed[] | undefined {
  const raw = url.searchParams.get("feeds");
  if (!raw) return undefined;
  const feeds = raw.split(",").filter((f): f is ActivityFeed => f === "chat" || f === "loop" || f === "background");
  return feeds.length ? feeds : undefined;
}

/** A stored conversation message -> what the chat list shows. */
export interface ChatHistoryItem {
  role: "user" | "assistant";
  text: string;
  pictures?: number;
  tools?: { name: string }[];
}

export function historyForDisplay(history: CompletionMessage[], limit = 60): ChatHistoryItem[] {
  const items: ChatHistoryItem[] = [];
  for (const m of history) {
    if (m.role === "user") {
      const text = typeof m.content === "string" ? m.content : m.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
      const pictures = typeof m.content === "string" ? 0 : m.content.filter((b) => b.type === "image").length;
      items.push({ role: "user", text: text.trim(), ...(pictures ? { pictures } : {}) });
    } else if (m.role === "assistant") {
      const text = typeof m.content === "string" ? m.content : "";
      const last = items.at(-1);
      const tools = (m.toolCalls ?? []).map((c) => ({ name: c.name }));
      // A run of tool-calling steps and the final answer read as ONE Dave message.
      if (last?.role === "assistant") {
        last.tools = [...(last.tools ?? []), ...tools];
        if (text.trim()) last.text = last.text ? `${last.text}\n\n${text.trim()}` : text.trim();
      } else {
        items.push({ role: "assistant", text: text.trim(), ...(tools.length ? { tools } : {}) });
      }
    }
  }
  return items.filter((i) => i.text || i.pictures || i.tools?.length).slice(-limit);
}

export interface AppChatRouteDeps extends AppChatDeps {
  /** Overridable for tests. */
  runTurn?: typeof runAppChatTurn;
}

export function createAppChatHandler(deps: AppChatRouteDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const runTurn = deps.runTurn ?? runAppChatTurn;
  return (req, res) => {
    void handle(req, res).catch((err: Error & { status?: number }) => {
      if (!res.headersSent) send(res, err.status ?? 500, { error: err.message || "Something went wrong." });
      else res.end();
    });
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://local");
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const userId = url.searchParams.get("userId")?.trim() || deps.userId;
    if (!token || userId !== deps.userId || !verifyDeviceToken(userId, token)) {
      send(res, 401, { error: "unpaired", message: "This device is not paired. Pair it again from the web panel." });
      return;
    }
    const path = url.pathname.slice(APP_CHAT_PREFIX.length).replace(/\/$/, "");
    const method = req.method ?? "GET";

    if (method === "GET" && path === "history") {
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 60, 1), 200);
      send(res, 200, { items: historyForDisplay(loadConversationHistory(deps.db, sharedHistoryKey(deps.db, userId)), limit), latestEventId: latestActivityId(userId) });
      return;
    }
    if (method === "GET" && path === "state") {
      send(res, 200, stateOf(userId));
      return;
    }
    if (method === "GET" && path === "activity") {
      const after = Number(url.searchParams.get("after") ?? 0) || 0;
      send(res, 200, { events: activityAfter(userId, after, feedsParam(url)), latestEventId: latestActivityId(userId) });
      return;
    }
    if (method === "GET" && path === "stream") {
      stream(req, res, url, userId);
      return;
    }
    if (method === "POST" && path === "send") {
      const body = await readJson(req);
      const text = typeof body.text === "string" ? body.text.trim() : "";
      let images: ContentBlock[] = [];
      try {
        images = Array.isArray(body.images) ? (body.images as { data?: string; mediaType?: string }[]).slice(0, 4).map((img) => buildImageContentBlock(Buffer.from(String(img.data ?? ""), "base64"), img.mediaType === "image/png" ? "photo.png" : "photo.jpg")) : [];
      } catch (err) {
        send(res, 400, { error: err instanceof Error ? err.message : String(err) });
        return;
      }
      if (!text && !images.length) {
        send(res, 400, { error: "Type a message or attach a picture." });
        return;
      }
      const busy = stateOf(userId);
      if (busy.busy && !body.whenFree) {
        send(res, 409, { error: "busy", ...busy });
        return;
      }
      const turnId = newTurnId();
      void (async () => {
        if (busy.busy) {
          const until = Date.now() + WAIT_FOR_FREE_MS;
          while (stateOf(userId).busy && Date.now() < until) await new Promise((r) => setTimeout(r, 1000));
        }
        await runTurn(deps, { text, images }, turnId);
      })().catch((err) => console.error("[app-chat] turn failed:", err));
      send(res, 202, { turnId, queued: busy.busy });
      return;
    }
    if (method === "POST" && path === "stop") {
      send(res, 200, { stopped: abortTurn(userId) });
      return;
    }
    if (method === "POST" && path === "action") {
      const body = await readJson(req);
      send(res, 200, { result: await runCardAction(userId, String(body.callback ?? "")) });
      return;
    }
    send(res, 404, { error: "not found" });
  }

  function stateOf(userId: string): { busy: boolean; task?: string; since?: number; autonomous?: string; appTurn: boolean } {
    const user = getBusyState(userId);
    const auto = getAutonomousBusyState(userId);
    return { busy: !!user, task: user?.taskDescription, since: user?.startedAt, autonomous: auto?.taskDescription, appTurn: isTurnRunning(userId, "app") };
  }

  function stream(req: IncomingMessage, res: ServerResponse, url: URL, userId: string): void {
    const feeds = feedsParam(url);
    const lastId = Number(req.headers["last-event-id"] ?? url.searchParams.get("after") ?? latestActivityId(userId)) || 0;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write(`retry: 5000\n\n`);
    const write = (e: ActivityEvent) => {
      if (feeds && !feeds.includes(e.feed)) return;
      res.write(`id: ${e.id}\nevent: activity\ndata: ${JSON.stringify(e)}\n\n`);
    };
    for (const e of activityAfter(userId, lastId, feeds)) write(e);
    res.write(`event: ready\ndata: ${JSON.stringify({ latestEventId: latestActivityId(userId), ...stateOf(userId) })}\n\n`);
    const unsubscribe = subscribeActivity(userId, write);
    const ping = setInterval(() => res.write(`: ping\n\n`), PING_MS);
    const close = () => {
      clearInterval(ping);
      unsubscribe();
    };
    req.on("close", close);
    res.on("close", close);
  }
}

/** The same buttons Telegram shows on Nous's cards, tapped in the app. */
export async function runCardAction(userId: string, callback: string): Promise<string> {
  const [prefix, action, arg] = callback.split(":");
  if (prefix !== "nous" || !arg) return "Unknown button.";
  const nous = nousDepsFor(userId);
  if (!nous) return "Nous isn't running on this server.";
  switch (action) {
    case "y":
      return placeNousSignal(nous, arg);
    case "n":
      await skipNousSignal(nous, arg);
      return "Skipped.";
    case "uy":
      return applyNousUpdate(nous, arg);
    case "un":
      await skipNousUpdate(nous, arg);
      return "Ignored.";
    case "c":
      await closeNousTrade(nous, arg);
      return `Closing #${arg}.`;
    case "k":
      return `Keeping #${arg} open.`;
    default:
      return "Unknown button.";
  }
}
