import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { decryptSecret, encryptSecret } from "@dave/crypto";

/**
 * Nous -- the copy-trading side of Dave (the trader: "Nous is a copy trading bot... reads the
 * signal channels and places the trade, but with my permission"). Everything it keeps lives on the
 * bot's volume under data/nous/<userId>/. The Telegram login (api hash + session) is stored
 * encrypted with the same DAVE_CREDENTIALS_KEY every other saved credential uses -- a session
 * string is a full login to the trader's account, so it is never written in the clear.
 */

export interface NousChat {
  id: string;
  title: string;
  kind: "channel" | "group";
}

export interface NousConfig {
  apiId?: number;
  apiHashEnc?: string;
  sessionEnc?: string;
  /** The trader's own Telegram account, once logged in -- display only. */
  account?: string;
  chats: NousChat[];
  autoApprove: boolean;
  /** Lots per copied signal. Undefined = Dave's fixed lot if set, else the broker minimum. */
  lots?: number;
  /** A signal older than this (from the moment it was posted) is never placed. */
  maxAgeMinutes: number;
}

export type SignalSide = "buy" | "sell";
export type SignalOrderKind = "market" | "limit" | "stop";

export interface ParsedSignal {
  symbol: string;
  side: SignalSide;
  orderKind: SignalOrderKind;
  /** Single entry price; a range is reduced to its midpoint by the parser. */
  entry?: number;
  sl: number;
  tp1: number;
  tp2?: number;
  /** The provider's own reason for the trade, in their words (may be empty). */
  reason: string;
}

export type UpdateAction = "close" | "close_partial" | "breakeven" | "move_sl" | "move_tp" | "cancel";

/** A provider's follow-up about a trade they already gave ("close now", "SL to BE"). */
export interface ParsedUpdate {
  action: UpdateAction;
  symbol?: string;
  /** New SL/TP for move_sl / move_tp. */
  price?: number;
  /** Part to close for close_partial (0-1). */
  fraction?: number;
  /** "close all" -- every copied trade from the channel, not just the latest. */
  all: boolean;
}

export interface NousUpdate {
  id: string;
  chatId: string;
  chatTitle: string;
  messageId: number;
  postedAt: number;
  text: string;
  update: ParsedUpdate;
  tickets: string[];
  status: "awaiting" | "done" | "skipped" | "expired" | "failed";
  note?: string;
  cardMessageId?: number;
}

export interface NousSignal {
  id: string;
  chatId: string;
  chatTitle: string;
  messageId: number;
  /** When the provider posted it (ms). */
  postedAt: number;
  text: string;
  signal: ParsedSignal;
  status: "awaiting" | "placed" | "skipped" | "expired" | "failed";
  note?: string;
  ticket?: string;
  /** The approval card in the trader's chat, so it can be updated in place. */
  cardMessageId?: number;
}

export interface NousTrade {
  ticket: string;
  signalId: string;
  symbol: string;
  side: SignalSide;
  lots: number;
  entry: number;
  sl: number;
  tp1: number;
  tp2?: number;
  reason: string;
  chatTitle: string;
  /** The channel it came from -- a follow-up post from the same channel can act on it. */
  chatId?: string;
  /** The provider's post, so a reply to it is recognised as about this trade. */
  messageId?: number;
  placedAt: number;
  /** "tp1": riding to TP1; "tp2": stop at entry, riding to TP2. */
  stage: "tp1" | "tp2";
  losingSince?: number;
  /** Last time Dave was asked whether the setup still holds -- re-asked at most every 30 min. */
  validityAskedAt?: number;
  knowledgeId?: string;
  /** Last floating P/L seen -- the outcome recorded when the position disappears. */
  lastPnl?: number;
  /** Seen as an open position at least once (a pending order that never filled isn't a result). */
  filled?: boolean;
}

const DEFAULT_CONFIG: NousConfig = { chats: [], autoApprove: false, maxAgeMinutes: 10 };

function dir(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "nous", userId);
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
}

function masterKey(): string {
  const key = process.env.DAVE_CREDENTIALS_KEY;
  if (!key) throw new Error("DAVE_CREDENTIALS_KEY is not set -- can't store the Telegram login safely.");
  return key;
}

export function getNousConfig(userId: string): NousConfig {
  return { ...DEFAULT_CONFIG, ...readJson<Partial<NousConfig>>(join(dir(userId), "config.json"), {}) };
}

export function updateNousConfig(userId: string, patch: Partial<NousConfig>): NousConfig {
  const next = { ...getNousConfig(userId), ...patch };
  writeJson(join(dir(userId), "config.json"), next);
  return next;
}

export function saveNousLogin(userId: string, login: { apiId: number; apiHash: string; session: string; account: string }): void {
  updateNousConfig(userId, {
    apiId: login.apiId,
    apiHashEnc: encryptSecret(login.apiHash, masterKey()),
    sessionEnc: encryptSecret(login.session, masterKey()),
    account: login.account,
  });
}

export function getNousLogin(userId: string): { apiId: number; apiHash: string; session: string } | undefined {
  const c = getNousConfig(userId);
  if (!c.apiId || !c.apiHashEnc || !c.sessionEnc) return undefined;
  try {
    return { apiId: c.apiId, apiHash: decryptSecret(c.apiHashEnc, masterKey()), session: decryptSecret(c.sessionEnc, masterKey()) };
  } catch {
    return undefined;
  }
}

export function clearNousLogin(userId: string): void {
  updateNousConfig(userId, { apiId: undefined, apiHashEnc: undefined, sessionEnc: undefined, account: undefined });
}

const signalsPath = (userId: string) => join(dir(userId), "signals.json");
const updatesPath = (userId: string) => join(dir(userId), "updates.json");

export function listNousUpdates(userId: string): NousUpdate[] {
  return readJson<NousUpdate[]>(updatesPath(userId), []);
}

export function getNousUpdate(userId: string, id: string): NousUpdate | undefined {
  return listNousUpdates(userId).find((u) => u.id === id);
}

export function saveNousUpdate(userId: string, update: NousUpdate): void {
  const all = listNousUpdates(userId).filter((u) => u.id !== update.id);
  all.push(update);
  writeJson(updatesPath(userId), all.slice(-MAX_SIGNALS));
}
const tradesPath = (userId: string) => join(dir(userId), "trades.json");
const MAX_SIGNALS = 200;

export function listNousSignals(userId: string): NousSignal[] {
  return readJson<NousSignal[]>(signalsPath(userId), []);
}

export function getNousSignal(userId: string, id: string): NousSignal | undefined {
  return listNousSignals(userId).find((s) => s.id === id);
}

export function saveNousSignal(userId: string, signal: NousSignal): void {
  const all = listNousSignals(userId).filter((s) => s.id !== signal.id);
  all.push(signal);
  writeJson(signalsPath(userId), all.slice(-MAX_SIGNALS));
}

/** The same post seen twice (a reconnect, an edit) is one signal. */
export function hasNousSignalFor(userId: string, chatId: string, messageId: number): boolean {
  return listNousSignals(userId).some((s) => s.chatId === chatId && s.messageId === messageId) || listNousUpdates(userId).some((u) => u.chatId === chatId && u.messageId === messageId);
}

export function listNousTrades(userId: string): NousTrade[] {
  return readJson<NousTrade[]>(tradesPath(userId), []);
}

export function saveNousTrades(userId: string, trades: NousTrade[]): void {
  writeJson(tradesPath(userId), trades);
}

/** Lagos time (UTC+1) -- the trader's clock, for everything Nous shows. */
export function lagosTime(ms: number): string {
  return new Date(ms).toLocaleString("en-GB", { timeZone: "Africa/Lagos", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }) + " (Lagos)";
}
