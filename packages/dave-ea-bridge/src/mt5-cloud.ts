import { getOrCreateEaWebhook } from "./ea-webhook.js";

/**
 * Dave's own MT5 container ("MT5 cloud") -- MetaTrader 5 running under Wine next to the bot, with
 * the Dave EA already attached and logged in, so a trader needs no Windows VPS (the trader: "deploy
 * a MT5 docker, so the bot asks you MT5 credentials, logs in, loads the EA, and the MT5 settings can
 * be adjusted via the settings").
 *
 * The container runs mt5/agent.py; this is the bot's client for it. Both the bot process and the
 * admin process (phone app, web panel) use it, so its settings live in a file like everything else
 * that crosses that boundary.
 *
 * Where the agent is comes from the server's settings (see getMt5CloudAgent) -- never from the trader.
 */

export interface Mt5CloudAgent {
  url: string;
  secret: string;
}

export interface Mt5CloudStatus {
  installed: boolean;
  compiled: boolean;
  running: boolean;
  /** From the terminal's own journal: logged in, refused, still reaching the broker, or no word yet. */
  login: "logged-in" | "failed" | "connecting" | "unknown";
  loginDetail?: string | null;
  configured: boolean;
  account: { login: string; server: string; symbol: string; period: string } | null;
  inputs: Record<string, string>;
  /** Pairs MT5 itself opens: each is in Market Watch with its own chart (on top of the EA's). */
  marketWatch?: string[];
  /** MetaQuotes IDs (from the MT5 app on the trader's phone) the terminal pushes to. */
  metaquotesIds?: string[];
  /** Whether MT5 can push to the phone: the container enters the ID in MT5's Options window after
   *  every start, and the EA confirms it (eaReports). state: on | off | applying | set | failed | not set. */
  phonePush?: { state: string; detail: string | null; eaReports?: boolean | null };
  relay: { count: number; errors: number; lastAt: number | null; lastStatus: number | null; lastError: string | null };
}

export interface Mt5CloudResult {
  ok: boolean;
  error?: string;
  compileLog?: string;
}

/** The MT5 service's address on Railway's private network when it is deployed under the default
 *  name. MT5_AGENT_URL overrides it (a different name, or a container elsewhere). */
export const DEFAULT_MT5_AGENT_URL = "http://dave-mt5.railway.internal:8081";

/**
 * Where the MT5 container is. The trader never types this: it comes from the server's own
 * settings (MT5_AGENT_SECRET, set when the MT5 service is deployed next to the bot). The trader
 * only ever enters their MT5 login, password and server.
 */
export function getMt5CloudAgent(_userId?: string): Mt5CloudAgent | undefined {
  const secret = process.env.MT5_AGENT_SECRET?.trim();
  if (!secret) return undefined;
  const url = process.env.MT5_AGENT_URL?.trim() || DEFAULT_MT5_AGENT_URL;
  return { url: url.replace(/\/$/, ""), secret };
}

/**
 * The address the EA reports to, from inside the container. Order: an explicit MT5_EA_BASE_URL;
 * Railway's private network when both services share a project (never leaves Railway); the public
 * address otherwise.
 */
export function mt5CloudEaBaseUrl(): string | undefined {
  const explicit = process.env.MT5_EA_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const privateDomain = process.env.RAILWAY_PRIVATE_DOMAIN?.trim();
  const botPort = process.env.DAVE_BOT_PORT ?? process.env.PORT;
  if (privateDomain && botPort) return `http://${privateDomain}:${botPort}`;
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, "");
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return undefined;
}

export class Mt5CloudNotSetUpError extends Error {
  constructor() {
    super("MT5 isn't set up on this server yet -- the MT5 service needs to be added next to the bot (mt5/README.md).");
    this.name = "Mt5CloudNotSetUpError";
  }
}

async function call<T>(userId: string, method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 20_000): Promise<T> {
  const agent = getMt5CloudAgent(userId);
  if (!agent) throw new Mt5CloudNotSetUpError();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${agent.url}${path}`, {
      method,
      headers: { "x-dave-agent-secret": agent.secret, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (res.status === 401) throw new Error("The MT5 container refused the secret -- check MT5_AGENT_SECRET matches on both services.");
    if (!res.ok && !(json as { error?: string }).error) throw new Error(`The MT5 container answered HTTP ${res.status}.`);
    return json;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw new Error("The MT5 container did not answer in time. It may still be starting (the first start installs MT5 and takes a few minutes).");
    if (err instanceof TypeError) throw new Error(`Could not reach the MT5 container at ${agent.url}: ${(err as Error & { cause?: { code?: string } }).cause?.code ?? err.message}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function mt5CloudStatus(userId: string): Promise<Mt5CloudStatus> {
  return call<Mt5CloudStatus>(userId, "GET", "/status");
}

export function mt5CloudLogs(userId: string): Promise<{ terminal: string; experts: string }> {
  return call(userId, "GET", "/logs");
}

export interface Mt5CloudAccount {
  login: string;
  password: string;
  server: string;
  symbol?: string;
  period?: string;
  /** Pairs for MT5's Market Watch, each on its own chart. */
  marketWatch?: string[];
  /** MetaQuotes IDs for MT5 push to the phone. */
  metaquotesIds?: string[];
}

/** Logs the container's MT5 into this account and starts the EA, reporting to this bot. The
 *  password goes to the container and nowhere else -- it is not stored on the bot side. */
export async function mt5CloudConnect(userId: string, account: Mt5CloudAccount): Promise<Mt5CloudResult> {
  const base = mt5CloudEaBaseUrl();
  if (!base) throw new Error("This server has no address the MT5 container can reach. Set MT5_EA_BASE_URL (or PUBLIC_BASE_URL).");
  const hook = getOrCreateEaWebhook(userId);
  // Compiling the EA and starting the terminal takes a while under Wine.
  return call<Mt5CloudResult>(userId, "POST", "/configure", { ...account, webhookUrl: `${base}${hook.path}`, token: hook.token }, 360_000);
}

/** Changes the chart / EA inputs and restarts the terminal on the same login. */
export function mt5CloudSettings(
  userId: string,
  settings: { symbol?: string; period?: string; marketWatch?: string[]; metaquotesIds?: string[]; inputs?: Record<string, string | number | boolean> },
): Promise<Mt5CloudResult> {
  return call<Mt5CloudResult>(userId, "POST", "/settings", settings, 360_000);
}

export function mt5CloudRestart(userId: string): Promise<Mt5CloudResult> {
  return call<Mt5CloudResult>(userId, "POST", "/restart", {}, 60_000);
}

const SYMBOL_RE = /^[A-Za-z0-9_.#+-]{1,32}$/;
export const MT5_MARKET_WATCH_MAX = 30;

/** "VOL_80, BOOM_100 eurusd" -> ["VOL_80", "BOOM_100", "EURUSD"]: split on commas/spaces, drop
 *  duplicates. Throws with a plain reason when something isn't a symbol or there are too many. */
export function parseMarketWatch(input: string | string[]): string[] {
  const raw = Array.isArray(input) ? input : input.split(/[\s,;]+/);
  const out: string[] = [];
  for (const r of raw) {
    const s = String(r).trim();
    if (!s) continue;
    if (!SYMBOL_RE.test(s)) throw new Error(`"${s}" doesn't look like a symbol.`);
    const norm = /^[a-z]{6}$/.test(s) ? s.toUpperCase() : s;
    if (!out.includes(norm)) out.push(norm);
  }
  if (out.length > MT5_MARKET_WATCH_MAX) throw new Error(`Up to ${MT5_MARKET_WATCH_MAX} pairs -- each one opens a chart in MT5.`);
  return out;
}

/** "12AB34CD, 98ZY76XW" -> ["12AB34CD", "98ZY76XW"]; "off"/"none"/"" -> [] (push off). A MetaQuotes
 *  ID is the 8 letters/digits shown in the MT5 phone app under Settings > Messages; MT5 takes up to 4. */
export function parseMetaquotesIds(input: string | string[]): string[] {
  const raw = Array.isArray(input) ? input : /^\s*(off|none|remove|clear)?\s*$/i.test(input) ? [] : input.split(/[\s,;]+/);
  const out: string[] = [];
  for (const r of raw) {
    const id = String(r).trim().toUpperCase();
    if (!id) continue;
    if (!/^[A-Z0-9]{8}$/.test(id)) throw new Error(`"${String(r).trim()}" isn't a MetaQuotes ID -- it's 8 letters and digits, shown in the MT5 app under Settings > Messages.`);
    if (!out.includes(id)) out.push(id);
  }
  if (out.length > 4) throw new Error("MT5 takes up to 4 MetaQuotes IDs.");
  return out;
}

/** One line for chat about MT5's own push to the phone. */
export function describePhonePush(s: Mt5CloudStatus): string | undefined {
  const p = s.phonePush;
  if (!s.metaquotesIds?.length) return undefined;
  const ids = s.metaquotesIds.join(", ");
  switch (p?.state) {
    case "on":
      return `MT5 phone alerts: on (MetaQuotes ID ${ids}).`;
    case "applying":
      return `MT5 phone alerts: entering MetaQuotes ID ${ids} in MT5...`;
    case "failed":
      return `MT5 phone alerts: not working -- ${p.detail ?? "MT5 did not accept the MetaQuotes ID"}.`;
    default:
      return `MT5 phone alerts: MetaQuotes ID ${ids} set${p?.detail ? ` (${p.detail})` : ""}.`;
  }
}

/** EA inputs the trader may change from settings. Everything else (the URL, token, bridge switch)
 *  is set by Dave and not exposed. */
export const MT5_CLOUD_EDITABLE_INPUTS = ["PushSeconds", "MagicNumber", "SlippagePoints", "EnablePush", "EnableEmail", "SwingLookback", "ZoneMax", "EqTolerancePips"] as const;

/** One line for chat. */
export function describeMt5CloudStatus(s: Mt5CloudStatus): string {
  if (!s.installed) return "MT5 is still installing in the container (first start takes a few minutes).";
  if (!s.configured) return "MT5 is installed and waiting for an account. Send /mt5 and choose Connect account.";
  const acct = s.account ? `${s.account.login} on ${s.account.server}` : "";
  if (!s.running) return `MT5 is not running (account ${acct}). It restarts itself within a minute; if it doesn't, choose Restart.`;
  if (s.login === "failed") return `MT5 could not log in to ${acct}: ${s.loginDetail ?? "the broker refused the login"}. Check the login, password and server name.`;
  if (s.login === "connecting") return `MT5 is running but not connected to ${s.account?.server} yet${s.loginDetail ? ` (${s.loginDetail})` : ""}. If this lasts more than a minute, check the server name.`;
  const relay = s.relay.lastAt ? ` The EA last reported ${Math.max(0, Math.round(Date.now() / 1000 - s.relay.lastAt))}s ago.` : " The EA has not reported yet.";
  const mw = s.marketWatch?.length ? ` Market Watch: ${s.marketWatch.join(", ")}.` : "";
  const push = describePhonePush(s);
  return `MT5 is running${s.login === "logged-in" ? " and logged in" : ""} (${acct}, chart ${s.account?.symbol} ${s.account?.period}).${mw}${relay}${push ? ` ${push}` : ""}`;
}

export interface Mt5CloudToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: { userId: string }) => Promise<unknown>;
}

/**
 * What Dave can do with the container from a conversation. Connecting an account is deliberately
 * NOT a tool: a password typed to the model would sit in the conversation history and go to the AI
 * provider. mt5_cloud_status tells Dave to point the trader at /mt5 for that.
 */
export const MT5_CLOUD_TOOLS: Mt5CloudToolDefinition[] = [
  {
    name: "mt5_cloud_status",
    description:
      "Status of MetaTrader 5 running in Dave's own container (no VPS): installed, logged in, which account and chart, and when the EA last reported. To connect or change the account, tell the trader to send /mt5 -- never ask for an MT5 password in chat.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => {
      if (!getMt5CloudAgent(ctx.userId)) return { connected: false, message: "MT5 isn't set up on this server yet (the MT5 service needs adding, mt5/README.md). Once it is, the trader sends /mt5 and enters their login, password and server." };
      const status = await mt5CloudStatus(ctx.userId);
      return { ...status, summary: describeMt5CloudStatus(status) };
    },
  },
  {
    name: "mt5_cloud_settings",
    description:
      `Change the container's MT5 setup and restart it on the same login: the EA's chart symbol/timeframe, the pairs in MT5's Market Watch (each gets its own chart), the MetaQuotes ID for MT5's push alerts to the phone, and EA inputs (${MT5_CLOUD_EDITABLE_INPUTS.join(", ")}). Only when the trader asks for it. The EA analyses any symbol regardless of its chart.`,
    parameters: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Chart symbol, exactly as the broker names it." },
        period: { type: "string", enum: ["M1", "M5", "M15", "M30", "H1", "H4", "D1"] },
        metaquotesIds: { type: "array", items: { type: "string" }, description: "MetaQuotes IDs (8 letters/digits, from the MT5 phone app: Settings > Messages) for MT5's own push alerts to the phone. [] turns them off. Up to 4." },
        marketWatch: { type: "array", items: { type: "string" }, description: `The pairs MT5 shows in Market Watch, each on its own chart (replaces the list; up to ${MT5_MARKET_WATCH_MAX}). Exactly as the broker names them.` },
        inputs: { type: "object", description: `EA inputs to change, e.g. {"PushSeconds": 8}. Allowed: ${MT5_CLOUD_EDITABLE_INPUTS.join(", ")}.` },
      },
    },
    execute: async (args, ctx) => {
      const inputs = (args.inputs && typeof args.inputs === "object" ? args.inputs : undefined) as Record<string, string | number | boolean> | undefined;
      const bad = inputs ? Object.keys(inputs).filter((k) => !(MT5_CLOUD_EDITABLE_INPUTS as readonly string[]).includes(k)) : [];
      if (bad.length) throw new Error(`Not editable: ${bad.join(", ")}. Allowed: ${MT5_CLOUD_EDITABLE_INPUTS.join(", ")}.`);
      const marketWatch = Array.isArray(args.marketWatch) ? parseMarketWatch(args.marketWatch as string[]) : undefined;
      const metaquotesIds = Array.isArray(args.metaquotesIds) ? parseMetaquotesIds(args.metaquotesIds as string[]) : undefined;
      return mt5CloudSettings(ctx.userId, { symbol: args.symbol as string | undefined, period: args.period as string | undefined, marketWatch, metaquotesIds, inputs });
    },
  },
  {
    name: "mt5_cloud_restart",
    description: "Restart MT5 in the container (same account and settings). For when it's stuck or disconnected.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => mt5CloudRestart(ctx.userId),
  },
];
