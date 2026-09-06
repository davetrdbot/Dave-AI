import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * Step 11.1: the real EA<->Dave webhook contract. Distinct token
 * namespace from Step 4's `/hooks/user/<token>` (Dave-to-user pushes)
 * and the reserved `/hooks/worker/<id>/<token>` (Step 12) -- this one is
 * specifically the EA data-exchange channel, replacing the Step 8
 * stopgap that reused Step 4's generic webhook ahead of this step
 * existing.
 *
 * MT5's WebRequest is one-directional outbound HTTP -- an EA cannot run
 * a server or receive a push. So Dave->EA instructions (open/modify/
 * close) ride back in the HTTP RESPONSE to the EA's own heartbeat/
 * snapshot POST: the EA posts its state, Dave's response carries
 * whatever commands are queued for it, and the EA executes them on its
 * next tick, reporting results on ITS next heartbeat. This is the real
 * mechanism -- not a queue Dave can push into out of band.
 */

const EA_HOOK_PREFIX = "/hooks/ea";

export interface EaPosition {
  ticket: string;
  symbol: string;
  type: "buy" | "sell";
  lots: number;
  openPrice: number;
  sl?: number;
  tp?: number;
  /** Real current bid (sell) / ask (buy) for this position's symbol -- the same price the position could close at right now. Drives breakeven/trailing without depending on a separate DAVEMA round-trip. */
  currentPrice?: number;
}

export interface EaPendingOrder {
  ticket: string;
  symbol: string;
  type: "buy_limit" | "sell_limit" | "buy_stop" | "sell_stop";
  lots: number;
  price: number;
}

export interface EaCommandResult {
  commandId: string;
  status: "ok" | "error";
  message?: string;
  ticket?: string; // for open commands, the real ticket MT5 assigned
  /**
   * Item 5 (DAVEMA retirement): the real computed payload for an "analyze" command --
   * whatever JSON the EA's own on-demand computation produced for the requested endpoint
   * (trend/momentum/volatility/etc), symbol, and timeframe. Absent for trade commands.
   */
  data?: unknown;
}

/**
 * Update 10 (trade notifications): a real, EA-side deal-reason lookup
 * (MT5's own `DEAL_REASON`, confirmed real enum values) -- "tp"/"sl"
 * mean MT5 itself closed it; "dave" means DEAL_REASON_EXPERT (this EA,
 * acting on Dave's own queued close command); "manual" means the user
 * closed it themselves in the terminal/mobile/web UI (DEAL_REASON_
 * CLIENT/MOBILE/WEB). Real data from the EA's own deal history, not
 * inferred Dave-side.
 */
export interface EaClosedPosition {
  ticket: string;
  symbol: string;
  pnl: number;
  reason: "tp" | "sl" | "dave" | "manual";
}

export interface EaReport {
  type: "heartbeat" | "snapshot";
  account: string;
  balance: number;
  equity?: number;
  margin?: number;
  freeMargin?: number;
  positions: EaPosition[];
  pendingOrders: EaPendingOrder[];
  results?: EaCommandResult[];
  closedPositions?: EaClosedPosition[];
}

/** Real gap fixed: balance/equity/margin/freeMargin were reported by the EA but never actually PERSISTED anywhere -- nothing could read them back later (e.g. for /account). */
export interface AccountSnapshot {
  account: string;
  balance: number;
  equity?: number;
  margin?: number;
  freeMargin?: number;
  updatedAt: number;
}

export type EaCommand =
  | { id: string; action: "open"; symbol: string; type: string; lots: number; price?: number; sl?: number; tp?: number }
  | { id: string; action: "modify"; ticket: string; sl?: number | null; tp?: number | null; price?: number }
  | { id: string; action: "close"; ticket: string; lots?: number }
  | { id: string; action: "delete_pending"; ticket: string }
  /**
   * Item 5 (DAVEMA retirement): the on-demand analysis request -- DAVEMA used to compute this
   * externally over HTTP; now the EA itself computes it locally (real ported MQL5 logic, see
   * ea/DaveEA.mq5's Ep_* functions) and reports it back via the SAME command-result channel
   * every trade command already uses, not a new push/stream. `symbol` can be ANY symbol in the
   * terminal's Market Watch, not just the chart the EA is attached to (item 13).
   */
  | { id: string; action: "analyze"; endpoint: string; symbol: string; timeframe: string };

function tokensPath(): string {
  return join(process.cwd(), "data", "ea-bridge", "tokens.json");
}

function queuePath(userId: string): string {
  return join(process.cwd(), "data", "ea-bridge", userId, "command-queue.json");
}

function lastKnownStatePath(userId: string): string {
  return join(process.cwd(), "data", "ea-bridge", userId, "last-known-state.json");
}

function accountSnapshotPath(userId: string): string {
  return join(process.cwd(), "data", "ea-bridge", userId, "account-snapshot.json");
}

function lastSeenPath(userId: string): string {
  return join(process.cwd(), "data", "ea-bridge", userId, "last-seen.json");
}

function analysisResultsPath(userId: string): string {
  return join(process.cwd(), "data", "ea-bridge", userId, "analysis-results.json");
}

/** Item 5: caps how many recent analyze results are kept per user -- these are short-lived (a
 * requestAnalysis() call consumes its own result within seconds), this is just a safety bound
 * against an abandoned request's result piling up forever. */
const MAX_STORED_ANALYSIS_RESULTS = 50;

/** Real gap this closes: report.results were only ever handed to the caller-supplied onReport
 * hook, with nothing durable a separate async caller (requestAnalysis, polling from a totally
 * different request) could read back by commandId. */
function storeAnalysisResults(userId: string, results: EaCommandResult[]): void {
  // A successful TRADE result (open/modify/close/delete_pending) has no `data` and is already
  // handled by its own real caller elsewhere -- excluded here so this store isn't flooded with
  // irrelevant entries on every heartbeat. An ERROR result is kept regardless of origin (an
  // analyze command's real failure must still reach takeAnalysisResult -- there's no cheap way
  // to tell an analyze error from a trade error by shape alone, and an unrelated trade error
  // sitting here unconsumed is harmless, just evicted eventually by the cap below).
  const relevant = results.filter((r) => r.data !== undefined || r.status === "error");
  if (relevant.length === 0) return;
  const existing = readJson<EaCommandResult[]>(analysisResultsPath(userId), []);
  const merged = [...existing, ...relevant].slice(-MAX_STORED_ANALYSIS_RESULTS);
  writeJson(analysisResultsPath(userId), merged);
}

/** Real gap this closes: nothing let a caller read back a specific analyze command's real
 * result by id -- this is what requestAnalysis() polls. Consumes (removes) the result once
 * read, same "no double-delivery" contract the command queue itself already follows. */
export function takeAnalysisResult(userId: string, commandId: string): EaCommandResult | undefined {
  const existing = readJson<EaCommandResult[]>(analysisResultsPath(userId), []);
  const index = existing.findIndex((r) => r.commandId === commandId);
  if (index === -1) return undefined;
  const [result] = existing.splice(index, 1);
  writeJson(analysisResultsPath(userId), existing);
  return result;
}

/**
 * Update 10 (trade notifications): "when the Dave EA connects/comes
 * online, send a Telegram notification confirming the connection."
 * Real, testable connection detection -- no report ever seen for this
 * user, OR the gap since the last one exceeds this threshold (well
 * above the EA's own PushSeconds heartbeat interval), counts as a
 * genuine (re)connection, not just a normal heartbeat.
 */
export const CONNECTION_GAP_MS = 2 * 60 * 1000;

export function isNewConnection(userId: string, now = Date.now()): boolean {
  const lastSeen = readJson<number | null>(lastSeenPath(userId), null);
  return lastSeen === null || now - lastSeen > CONNECTION_GAP_MS;
}

export interface EaConnectionStatus {
  connected: boolean;
  lastSeenAt: number | null;
  secondsSinceLastSeen: number | null;
}

/**
 * Real gap fixed: isNewConnection() only ever answers "did a (re)connect edge
 * just happen" (used once, to fire a notification) -- nothing exposed a
 * queryable "is the EA connected RIGHT NOW" status for /connection or /account
 * to show honestly. Same lastSeen/CONNECTION_GAP_MS data, read as a level, not
 * an edge.
 */
export function getEaConnectionStatus(userId: string, now = Date.now()): EaConnectionStatus {
  const lastSeen = readJson<number | null>(lastSeenPath(userId), null);
  if (lastSeen === null) return { connected: false, lastSeenAt: null, secondsSinceLastSeen: null };
  const secondsSinceLastSeen = Math.floor((now - lastSeen) / 1000);
  return { connected: now - lastSeen <= CONNECTION_GAP_MS, lastSeenAt: lastSeen, secondsSinceLastSeen };
}

function markSeen(userId: string, now = Date.now()): void {
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

export interface EaWebhook {
  userId: string;
  token: string;
  path: string;
}

export function getOrCreateEaWebhook(userId: string): EaWebhook {
  const tokens = readJson<Record<string, string>>(tokensPath(), {});
  const existing = Object.entries(tokens).find(([, uid]) => uid === userId);
  const token = existing ? existing[0] : randomBytes(24).toString("hex");
  if (!existing) {
    tokens[token] = userId;
    writeJson(tokensPath(), tokens);
    // Step 19.5 fix: tighten this specific file's permissions -- flagged by a real
    // audit as the one credential-shaped file in the repo with NO chmod at all
    // (MT5/DAVEMA credential files already had 0600, this had nothing).
    chmodSync(tokensPath(), 0o600);
  }
  return { userId, token, path: `${EA_HOOK_PREFIX}/${token}` };
}

export function resolveEaToken(token: string): string | undefined {
  return readJson<Record<string, string>>(tokensPath(), {})[token];
}

/** Enqueues a command for the EA to pick up on its next report. This is the ONLY way Dave->EA instructions travel. */
export function enqueueCommand(userId: string, command: EaCommand): void {
  const queue = readJson<EaCommand[]>(queuePath(userId), []);
  queue.push(command);
  writeJson(queuePath(userId), queue);
}

export function peekQueue(userId: string): EaCommand[] {
  return readJson<EaCommand[]>(queuePath(userId), []);
}

/** Real fact of the EA<->Dave contract: commands are drained (removed) the moment they're handed back in a response, not left for double-delivery. */
function drainQueue(userId: string): EaCommand[] {
  const queue = readJson<EaCommand[]>(queuePath(userId), []);
  writeJson(queuePath(userId), []);
  return queue;
}

export function getLastKnownState(userId: string): { positions: EaPosition[]; pendingOrders: EaPendingOrder[] } {
  return readJson(lastKnownStatePath(userId), { positions: [], pendingOrders: [] });
}

function saveLastKnownState(userId: string, positions: EaPosition[], pendingOrders: EaPendingOrder[]): void {
  writeJson(lastKnownStatePath(userId), { positions, pendingOrders });
}

/**
 * Real gap fixed: balance/equity/margin/freeMargin were reported by the
 * EA on every heartbeat but never actually persisted anywhere -- there
 * was no way to read the user's current account financials back later
 * (e.g. for a real /account command). This is that persistence.
 */
export function getLastKnownAccountSnapshot(userId: string): AccountSnapshot | undefined {
  return readJson<AccountSnapshot | undefined>(accountSnapshotPath(userId), undefined);
}

function saveAccountSnapshot(userId: string, report: EaReport): void {
  writeJson(accountSnapshotPath(userId), {
    account: report.account,
    balance: report.balance,
    equity: report.equity,
    margin: report.margin,
    freeMargin: report.freeMargin,
    updatedAt: Date.now(),
  } satisfies AccountSnapshot);
}

export interface EaReportHandlers {
  /**
   * Called for every report, with the state as it was BEFORE this
   * report overwrote it -- callers doing manual-close detection need
   * the previous snapshot to compare against, and reading
   * getLastKnownState() from inside this handler would already return
   * the NEW state (a real bug this signature exists to prevent).
   */
  onReport?: (userId: string, report: EaReport, previous: { positions: EaPosition[]; pendingOrders: EaPendingOrder[] }) => void;
  /** Fires once per genuine (re)connection -- see `isNewConnection`. */
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

export function createEaWebhookServer(handlers: EaReportHandlers = {}): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    if (req.method !== "POST" || !url.startsWith(`${EA_HOOK_PREFIX}/`)) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    const token = url.slice(`${EA_HOOK_PREFIX}/`.length);
    const userId = resolveEaToken(token);
    if (!userId) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unknown EA token" }));
      return;
    }

    let report: EaReport;
    try {
      report = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid JSON body" }));
      return;
    }

    if (isNewConnection(userId)) {
      handlers.onConnect?.(userId);
    }
    markSeen(userId);

    const previous = getLastKnownState(userId);
    saveLastKnownState(userId, report.positions ?? [], report.pendingOrders ?? []);
    saveAccountSnapshot(userId, report);
    storeAnalysisResults(userId, report.results ?? []);
    handlers.onReport?.(userId, report, previous);

    const commands = drainQueue(userId);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ commands }));
  });
}
