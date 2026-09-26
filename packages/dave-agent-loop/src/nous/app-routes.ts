import type { IncomingMessage, ServerResponse } from "node:http";
import { verifyDeviceToken } from "@dave/db";
import { getNousConfig, listNousSignals, listNousTrades, updateNousConfig, type NousChat } from "./store.js";
import * as realUserbot from "./userbot.js";
import { closeNousTrade, ensureNousListening, nousDepsFor, nousLots } from "./service.js";

/**
 * Nous from the phone app, at /api/app/nous/*: log Telegram in, pick the channels and groups,
 * set the options -- everything /nous does in Telegram. Served by the bot process, because the
 * Telegram login in progress lives in its memory.
 *
 * The api_hash, the login code and the 2-step password pass through these handlers only: never
 * logged, never in a conversation or on the activity feed. Same paired-device token as the rest
 * of the app.
 *
 *   GET  state                 connection, picked chats, options, open trades, recent signals
 *   POST login/begin           {apiId, apiHash, phone} -- Telegram sends a code
 *   POST login/code            {code} -> {done, account} | {needPassword: true}
 *   POST login/password        {password}
 *   POST login/cancel
 *   GET  chats                 the account's channels and groups, each with `picked`
 *   POST chats                 {ids} -- read these; starts listening
 *   POST settings              {autoApprove?, lots? (null = auto), maxAgeMinutes?}
 *   POST logout
 *   POST close                 {ticket} -- close an open Nous trade
 */

export const APP_NOUS_PREFIX = "/api/app/nous/";
const MAX_BODY_BYTES = 64 * 1024;

type Userbot = Pick<typeof realUserbot, "nousLoginBegin" | "nousLoginCode" | "nousLoginPassword" | "cancelNousLogin" | "listNousDialogs" | "nousLogout" | "stopNousListener" | "isNousListening">;

export interface AppNousDeps {
  userId: string;
  /** Overridable for tests (no Telegram there). */
  userbot?: Userbot;
  ensureListening?: (userId: string) => Promise<boolean>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Too large.");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Expected a JSON body.");
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The chat list last shown per account, so a save can carry ids only. */
const shownDialogs = new Map<string, NousChat[]>();

export function createAppNousHandler(deps: AppNousDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const bot = deps.userbot ?? realUserbot;
  const ensureListening = deps.ensureListening ?? ensureNousListening;
  return (req, res) => {
    void handle(req, res).catch((err: unknown) => {
      if (res.headersSent) return void res.end();
      // Telegram's own refusals come back already phrased for a person (userbot.friendlyError).
      send(res, err instanceof HttpError ? err.status : 400, { error: message(err) || "Something went wrong." });
    });
  };

  function state(userId: string) {
    const c = getNousConfig(userId);
    return {
      loggedIn: !!c.sessionEnc,
      account: c.account ?? null,
      listening: bot.isNousListening(userId),
      running: !!nousDepsFor(userId),
      chats: c.chats,
      autoApprove: c.autoApprove,
      lots: nousLots(userId),
      lotsAuto: c.lots === undefined,
      maxAgeMinutes: c.maxAgeMinutes,
      trades: listNousTrades(userId).map((t) => ({ ticket: t.ticket, symbol: t.symbol, side: t.side, lots: t.lots, entry: t.entry, sl: t.sl, tp1: t.tp1, tp2: t.tp2 ?? null, from: t.chatTitle, placedAt: t.placedAt })),
      signals: listNousSignals(userId)
        .slice(-15)
        .reverse()
        .map((s) => ({ id: s.id, symbol: s.signal.symbol, side: s.signal.side, from: s.chatTitle, postedAt: s.postedAt, status: s.status })),
    };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://local");
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const userId = url.searchParams.get("userId")?.trim() || deps.userId;
    if (!token || userId !== deps.userId || !verifyDeviceToken(userId, token)) {
      send(res, 401, { error: "unpaired", message: "This device is not paired. Pair it again from the web panel." });
      return;
    }
    const path = url.pathname.slice(APP_NOUS_PREFIX.length).replace(/\/$/, "");
    const method = req.method ?? "GET";
    const route = `${method} ${path}`;

    if (route === "GET state") return send(res, 200, state(userId));

    if (route === "GET chats") {
      const dialogs = await bot.listNousDialogs(userId);
      shownDialogs.set(userId, dialogs);
      const picked = new Set(getNousConfig(userId).chats.map((c) => c.id));
      return send(res, 200, { chats: dialogs.map((d) => ({ ...d, picked: picked.has(d.id) })) });
    }

    if (method !== "POST") return send(res, 404, { error: "not found" });
    const body = await readJson(req);

    switch (path) {
      case "login/begin": {
        const apiId = Number(body.apiId);
        const apiHash = String(body.apiHash ?? "").trim();
        const phone = String(body.phone ?? "").replace(/[\s-]/g, "");
        if (!Number.isInteger(apiId) || apiId <= 0) throw new HttpError(400, "The api_id is a number only, e.g. 1234567.");
        if (!/^[0-9a-f]{32}$/i.test(apiHash)) throw new HttpError(400, "That doesn't look like an api_hash (32 letters and numbers).");
        if (!/^\+?\d{7,15}$/.test(phone)) throw new HttpError(400, "Enter the phone number with its country code, e.g. +2348012345678.");
        await bot.stopNousListener(userId); // a new login replaces the old session's connection
        await bot.nousLoginBegin(userId, apiId, apiHash, phone);
        return send(res, 200, { codeSent: true });
      }
      case "login/code": {
        const code = String(body.code ?? "").replace(/\D/g, "");
        if (code.length < 4) throw new HttpError(400, "Enter the code Telegram sent you.");
        const step = await bot.nousLoginCode(userId, code);
        return send(res, 200, step.done ? { done: true, account: step.account } : { done: false, needPassword: true });
      }
      case "login/password": {
        const password = String(body.password ?? "");
        if (!password) throw new HttpError(400, "Enter your two-step verification password.");
        const step = await bot.nousLoginPassword(userId, password);
        return send(res, 200, step.done ? { done: true, account: step.account } : { done: false, needPassword: true });
      }
      case "login/cancel":
        bot.cancelNousLogin(userId);
        return send(res, 200, { ok: true });
      case "chats": {
        const ids = Array.isArray(body.ids) ? body.ids.map(String) : null;
        if (!ids) throw new HttpError(400, "Expected {ids: [...]}.");
        const known = new Map([...(shownDialogs.get(userId) ?? []), ...getNousConfig(userId).chats].map((c) => [c.id, c]));
        const chats = ids.map((id) => known.get(id)).filter((c): c is NousChat => !!c);
        updateNousConfig(userId, { chats });
        let listening = false;
        let warning: string | undefined;
        try {
          listening = await ensureListening(userId);
        } catch (err) {
          warning = message(err);
        }
        return send(res, 200, { ...state(userId), listening, warning });
      }
      case "settings": {
        const patch: Parameters<typeof updateNousConfig>[1] = {};
        if (typeof body.autoApprove === "boolean") patch.autoApprove = body.autoApprove;
        if ("lots" in body) {
          if (body.lots === null) patch.lots = undefined;
          else {
            const lots = Number(body.lots);
            if (!(lots >= 0.01 && lots <= 100)) throw new HttpError(400, "A lot size from 0.01 to 100.");
            patch.lots = Math.round(lots * 100) / 100;
          }
        }
        if ("maxAgeMinutes" in body) {
          const n = Number(body.maxAgeMinutes);
          if (!Number.isInteger(n) || n < 1 || n > 60) throw new HttpError(400, "A whole number of minutes from 1 to 60.");
          patch.maxAgeMinutes = n;
        }
        updateNousConfig(userId, patch);
        return send(res, 200, state(userId));
      }
      case "logout":
        await bot.nousLogout(userId);
        return send(res, 200, state(userId));
      case "close": {
        const ticket = String(body.ticket ?? "");
        const nous = nousDepsFor(userId);
        if (!nous) throw new HttpError(503, "Nous isn't running on this server.");
        if (!listNousTrades(userId).some((t) => t.ticket === ticket)) throw new HttpError(404, `No open Nous trade #${ticket}.`);
        await closeNousTrade(nous, ticket);
        return send(res, 200, state(userId));
      }
    }
    send(res, 404, { error: "not found" });
  }
}
