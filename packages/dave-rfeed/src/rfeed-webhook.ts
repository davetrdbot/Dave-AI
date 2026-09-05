import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * Step 22 (R_Feed): the shared demo/practice MT5 account's own
 * webhook<->EA contract. Deliberately a SEPARATE token namespace,
 * `/hooks/rfeed/<token>`, from Step 11's `/hooks/ea/<token>` (the real
 * Dave EA) -- R_Feed's EA is a genuinely different .mq5 file talking to
 * a genuinely different webhook, on purpose: a bug that ever confused
 * the two token spaces would be a real-money incident, so they don't
 * share any code path that could leak a command meant for one into the
 * other's queue.
 *
 * Same one-directional WebRequest mechanics as the real Dave EA
 * (commands ride back in the response to the EA's own report), plus
 * two things the real EA never needed: a `request_history` command
 * (CopyRates-backed) and every reported position/pending order
 * carrying a real `isCustom` flag (MQL5's own `SYMBOL_CUSTOM`,
 * confirmed via research) -- the actual safety data this package's
 * refusal logic is enforced against.
 */

const RFEED_HOOK_PREFIX = "/hooks/rfeed";

export interface RFeedPosition {
  ticket: string;
  symbol: string;
  type: "buy" | "sell";
  lots: number;
  openPrice: number;
  sl?: number;
  tp?: number;
  isCustom: boolean;
}

export interface RFeedPendingOrder {
  ticket: string;
  symbol: string;
  type: "buy_limit" | "sell_limit" | "buy_stop" | "sell_stop";
  lots: number;
  price: number;
  isCustom: boolean;
}

export interface RFeedCommandResult {
  commandId: string;
  status: "ok" | "error";
  message?: string;
  ticket?: string;
}

export interface HistoryCandle {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  tickVolume: number;
}

export interface HistoryResult {
  commandId: string;
  status: "ok" | "error";
  message?: string;
  symbol?: string;
  candles?: HistoryCandle[];
}

/** Update 10 (trade notifications): same real EA-side DEAL_REASON lookup as the real Dave EA -- see RFeedEA.mq5's own comment. */
export interface RFeedClosedPosition {
  ticket: string;
  symbol: string;
  pnl: number;
  reason: "tp" | "sl" | "dave" | "manual";
}

export interface RFeedReport {
  type: "heartbeat" | "snapshot";
  account: string;
  balance: number;
  equity?: number;
  margin?: number;
  freeMargin?: number;
  positions: RFeedPosition[];
  pendingOrders: RFeedPendingOrder[];
  results?: RFeedCommandResult[];
  historyResults?: HistoryResult[];
  closedPositions?: RFeedClosedPosition[];
}

export interface RFeedAccountSnapshot {
  account: string;
  balance: number;
  equity?: number;
  margin?: number;
  freeMargin?: number;
  updatedAt: number;
}

export type RFeedCommand =
  | { id: string; action: "open"; symbol: string; type: string; lots: number; price?: number; sl?: number; tp?: number; comment?: string }
  | { id: string; action: "modify"; ticket: string; sl?: number | null; tp?: number | null; price?: number }
  | { id: string; action: "close"; ticket: string; lots?: number }
  | { id: string; action: "delete_pending"; ticket: string }
  | { id: string; action: "request_history"; symbol: string; timeframe: string; startTime: number; endTime: number };

function tokensPath(): string {
  return join(process.cwd(), "data", "rfeed", "tokens.json");
}

function queuePath(userId: string): string {
  return join(process.cwd(), "data", "rfeed", userId, "command-queue.json");
}

function lastKnownStatePath(userId: string): string {
  return join(process.cwd(), "data", "rfeed", userId, "last-known-state.json");
}

function accountSnapshotPath(userId: string): string {
  return join(process.cwd(), "data", "rfeed", userId, "account-snapshot.json");
}

function lastSeenPath(userId: string): string {
  return join(process.cwd(), "data", "rfeed", userId, "last-seen.json");
}

/** Update 10: same real connection-detection idea as the real Dave EA's webhook. */
export const RFEED_CONNECTION_GAP_MS = 2 * 60 * 1000;

export function isNewRFeedConnection(userId: string, now = Date.now()): boolean {
  const lastSeen = readJson<number | null>(lastSeenPath(userId), null);
  return lastSeen === null || now - lastSeen > RFEED_CONNECTION_GAP_MS;
}

function markRFeedSeen(userId: string, now = Date.now()): void {
  writeJson(lastSeenPath(userId), now);
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path: string, value: unknown): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

export interface RFeedWebhook {
  userId: string;
  token: string;
  path: string;
}

export function getOrCreateRFeedWebhook(userId: string): RFeedWebhook {
  const tokens = readJson<Record<string, string>>(tokensPath(), {});
  const existing = Object.entries(tokens).find(([, uid]) => uid === userId);
  const token = existing ? existing[0] : randomBytes(24).toString("hex");
  if (!existing) {
    tokens[token] = userId;
    writeJson(tokensPath(), tokens);
    chmodSync(tokensPath(), 0o600);
  }
  return { userId, token, path: `${RFEED_HOOK_PREFIX}/${token}` };
}

export function resolveRFeedToken(token: string): string | undefined {
  return readJson<Record<string, string>>(tokensPath(), {})[token];
}

export function enqueueRFeedCommand(userId: string, command: RFeedCommand): void {
  const queue = readJson<RFeedCommand[]>(queuePath(userId), []);
  queue.push(command);
  writeJson(queuePath(userId), queue);
}

function drainQueue(userId: string): RFeedCommand[] {
  const queue = readJson<RFeedCommand[]>(queuePath(userId), []);
  writeJson(queuePath(userId), []);
  return queue;
}

export function getLastKnownRFeedState(userId: string): { positions: RFeedPosition[]; pendingOrders: RFeedPendingOrder[] } {
  return readJson(lastKnownStatePath(userId), { positions: [], pendingOrders: [] });
}

function saveLastKnownState(userId: string, positions: RFeedPosition[], pendingOrders: RFeedPendingOrder[]): void {
  writeJson(lastKnownStatePath(userId), { positions, pendingOrders });
}

export function getLastKnownRFeedAccountSnapshot(userId: string): RFeedAccountSnapshot | undefined {
  return readJson<RFeedAccountSnapshot | undefined>(accountSnapshotPath(userId), undefined);
}

function saveAccountSnapshot(userId: string, report: RFeedReport): void {
  writeJson(accountSnapshotPath(userId), {
    account: report.account,
    balance: report.balance,
    equity: report.equity,
    margin: report.margin,
    freeMargin: report.freeMargin,
    updatedAt: Date.now(),
  } satisfies RFeedAccountSnapshot);
}

export interface RFeedReportHandlers {
  onReport?: (userId: string, report: RFeedReport, previous: { positions: RFeedPosition[]; pendingOrders: RFeedPendingOrder[] }) => void;
  onConnect?: (userId: string) => void;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

export function createRFeedWebhookServer(handlers: RFeedReportHandlers = {}): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    if (req.method !== "POST" || !url.startsWith(`${RFEED_HOOK_PREFIX}/`)) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    const token = url.slice(`${RFEED_HOOK_PREFIX}/`.length);
    const userId = resolveRFeedToken(token);
    if (!userId) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unknown R_Feed token" }));
      return;
    }

    let report: RFeedReport;
    try {
      report = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid JSON body" }));
      return;
    }

    if (isNewRFeedConnection(userId)) {
      handlers.onConnect?.(userId);
    }
    markRFeedSeen(userId);

    const previous = getLastKnownRFeedState(userId);
    saveLastKnownState(userId, report.positions ?? [], report.pendingOrders ?? []);
    saveAccountSnapshot(userId, report);
    handlers.onReport?.(userId, report, previous);

    const commands = drainQueue(userId);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ commands }));
  });
}
