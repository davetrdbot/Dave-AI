import { NextResponse } from "next/server";
import {
  getMt5CloudAgent,
  mt5CloudStatus,
  mt5CloudConnect,
  mt5CloudSettings,
  mt5CloudRestart,
  mt5CloudEaVersion,
  describeMt5CloudStatus,
  mt5CloudEaBaseUrl,
  MT5_CLOUD_EDITABLE_INPUTS,
  MT5_MARKET_WATCH_MAX,
  parseMarketWatch,
  parseMetaquotesIds,
} from "@dave/ea-bridge";
import { getActiveGroupInfo } from "@dave/trading";
import { getLastKnownAccountSnapshot } from "@dave/ea-bridge";
import { decryptSecret, encryptSecret } from "@dave/crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The MT5 accounts this trader has connected, so switching between them is one tap. The password
 * is kept encrypted with DAVE_CREDENTIALS_KEY (like every other stored credential) and only ever
 * decrypted to hand straight to the MT5 container on a switch. It never goes back to the phone.
 */
interface SavedAccount {
  login: string;
  server: string;
  passwordEnc: string;
  /** The holder's name as the EA reported it while this account was live. */
  name?: string;
  addedAt: number;
}

function accountsPath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "mt5-accounts", userId, "accounts.json");
}

function loadAccounts(userId: string): SavedAccount[] {
  try {
    return existsSync(accountsPath(userId)) ? (JSON.parse(readFileSync(accountsPath(userId), "utf8")) as SavedAccount[]) : [];
  } catch {
    return [];
  }
}

function saveAccounts(userId: string, accounts: SavedAccount[]): void {
  mkdirSync(dirname(accountsPath(userId)), { recursive: true });
  writeFileSync(accountsPath(userId), JSON.stringify(accounts, null, 2), { mode: 0o600 });
}

function masterKey(): string {
  const key = process.env.DAVE_CREDENTIALS_KEY;
  if (!key) throw new Error("DAVE_CREDENTIALS_KEY is not set -- can't store an MT5 password safely.");
  return key;
}

function rememberAccount(userId: string, login: string, server: string, password: string): void {
  let passwordEnc: string;
  try {
    passwordEnc = encryptSecret(password, masterKey());
  } catch {
    return; // no key: the connect still works, the account just isn't remembered
  }
  const rest = loadAccounts(userId).filter((a) => !(a.login === login && a.server === server));
  const prev = loadAccounts(userId).find((a) => a.login === login && a.server === server);
  saveAccounts(userId, [...rest, { login, server, passwordEnc, name: prev?.name, addedAt: prev?.addedAt ?? Date.now() }]);
}

/** Records the live account's holder name on its saved entry (it comes from the EA's report). */
function learnNames(userId: string): SavedAccount[] {
  const accounts = loadAccounts(userId);
  const snap = getLastKnownAccountSnapshot(userId);
  if (snap?.accountName) {
    const hit = accounts.find((a) => a.login === snap.account && a.name !== snap.accountName);
    if (hit) {
      hit.name = snap.accountName;
      saveAccounts(userId, accounts);
    }
  }
  return accounts;
}

/** The active pair group -- what Dave trades, and Market Watch's default. */
function pairGroup(userId: string): string[] {
  try {
    return [...(getActiveGroupInfo(userId).effectiveSymbols ?? [])].slice(0, MT5_MARKET_WATCH_MAX);
  } catch {
    return [];
  }
}

/**
 * Shared handlers for the MT5 container, used by the phone app (/api/app/mt5, device token) and the
 * web panel (/api/mt5, panel password). The password in a connect request goes straight through to
 * the container and is not kept here.
 */

export async function mt5CloudView(userId: string) {
  const base = await baseView(userId);
  const snap = getLastKnownAccountSnapshot(userId);
  const activeLogin = (base.status as { account?: { login?: string } } | null)?.account?.login ?? snap?.account;
  const accounts = learnNames(userId).map((a) => ({ login: a.login, server: a.server, name: a.name ?? null, active: a.login === activeLogin }));
  return {
    ...base,
    pairGroup: pairGroup(userId),
    // Whose account MT5 is on right now, from the EA's own report.
    accountName: snap && snap.account === activeLogin ? (snap.accountName ?? null) : null,
    accounts,
  };
}

async function baseView(userId: string) {
  const agent = getMt5CloudAgent(userId);
  if (!agent) return { agent: null, eaBaseUrl: mt5CloudEaBaseUrl() ?? null, status: null, summary: "MT5 isn't set up on this server yet.", editableInputs: MT5_CLOUD_EDITABLE_INPUTS };
  try {
    const status = await mt5CloudStatus(userId);
    return { agent: { url: agent.url }, eaBaseUrl: mt5CloudEaBaseUrl() ?? null, status, summary: describeMt5CloudStatus(status), editableInputs: MT5_CLOUD_EDITABLE_INPUTS };
  } catch (err) {
    return { agent: { url: agent.url }, eaBaseUrl: mt5CloudEaBaseUrl() ?? null, status: null, summary: err instanceof Error ? err.message : String(err), editableInputs: MT5_CLOUD_EDITABLE_INPUTS };
  }
}

export async function mt5CloudAction(userId: string, body: Record<string, unknown>): Promise<NextResponse> {
  const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string).trim() : undefined);
  try {
    let result: { ok: boolean; error?: string; compileLog?: string } | undefined;
    switch (body.action) {
      case "connect": {
        const login = str("login");
        const server = str("server");
        const password = typeof body.password === "string" ? body.password : "";
        if (!login || !/^\d{3,20}$/.test(login)) return NextResponse.json({ error: "The login is the account number (digits only)." }, { status: 400 });
        if (!password) return NextResponse.json({ error: "Enter the account password." }, { status: 400 });
        if (!server) return NextResponse.json({ error: "Enter the server name exactly as MT5 shows it." }, { status: 400 });
        const group = pairGroup(userId);
        let metaquotesIds: string[] | undefined;
        try {
          metaquotesIds = body.metaquotesIds === undefined ? undefined : parseMetaquotesIds(body.metaquotesIds as string | string[]);
        } catch (err) {
          return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
        }
        result = await mt5CloudConnect(userId, { login, password, server, symbol: str("symbol") ?? group[0], period: str("period"), marketWatch: group, metaquotesIds });
        if (result?.ok) rememberAccount(userId, login, server, password);
        break;
      }
      case "switch": {
        // One tap to another account connected before -- its password comes from the encrypted store.
        const login = str("login");
        const saved = loadAccounts(userId).find((a) => a.login === login && (!str("server") || a.server === str("server")));
        if (!saved) return NextResponse.json({ error: "That account isn't saved. Connect it once with its password." }, { status: 404 });
        let password: string;
        try {
          password = decryptSecret(saved.passwordEnc, masterKey());
        } catch {
          return NextResponse.json({ error: "Couldn't unlock the saved password. Connect the account again." }, { status: 409 });
        }
        const group = pairGroup(userId);
        result = await mt5CloudConnect(userId, { login: saved.login, password, server: saved.server, symbol: group[0], marketWatch: group });
        break;
      }
      case "forget": {
        const login = str("login");
        saveAccounts(userId, loadAccounts(userId).filter((a) => a.login !== login));
        return NextResponse.json(await mt5CloudView(userId));
      }
      case "settings": {
        const inputs = body.inputs && typeof body.inputs === "object" ? (body.inputs as Record<string, string | number | boolean>) : undefined;
        const bad = inputs ? Object.keys(inputs).filter((k) => !(MT5_CLOUD_EDITABLE_INPUTS as readonly string[]).includes(k)) : [];
        if (bad.length) return NextResponse.json({ error: `Not editable: ${bad.join(", ")}.` }, { status: 400 });
        let marketWatch: string[] | undefined;
        if (body.marketWatch !== undefined) {
          try {
            marketWatch = parseMarketWatch(Array.isArray(body.marketWatch) ? (body.marketWatch as string[]) : String(body.marketWatch));
          } catch (err) {
            return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
          }
        }
        let metaquotesIds: string[] | undefined;
        try {
          metaquotesIds = body.metaquotesIds === undefined ? undefined : parseMetaquotesIds(body.metaquotesIds as string | string[]);
        } catch (err) {
          return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
        }
        result = await mt5CloudSettings(userId, { symbol: str("symbol"), period: str("period"), marketWatch, metaquotesIds, inputs });
        break;
      }
      case "restart":
        result = await mt5CloudRestart(userId);
        break;
      case "ea-version": {
        const version = str("version");
        if (!version || !/^(latest|\d+(\.\d+)?)$/.test(version)) return NextResponse.json({ error: "Pick an EA version, e.g. latest or 3.7." }, { status: 400 });
        result = await mt5CloudEaVersion(userId, version);
        break;
      }
      default:
        return NextResponse.json({ error: "action must be one of: connect, switch, forget, settings, restart, ea-version." }, { status: 400 });
    }
    if (result && !result.ok) return NextResponse.json({ error: result.error ?? "The MT5 container refused.", compileLog: result.compileLog }, { status: 409 });
    return NextResponse.json(await mt5CloudView(userId));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
