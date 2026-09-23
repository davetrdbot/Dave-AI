import { NextResponse } from "next/server";
import {
  getMt5CloudAgent,
  mt5CloudStatus,
  mt5CloudConnect,
  mt5CloudSettings,
  mt5CloudRestart,
  describeMt5CloudStatus,
  mt5CloudEaBaseUrl,
  MT5_CLOUD_EDITABLE_INPUTS,
  MT5_MARKET_WATCH_MAX,
  parseMarketWatch,
} from "@dave/ea-bridge";
import { getActiveGroupInfo } from "@dave/trading";

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
  return { ...(await baseView(userId)), pairGroup: pairGroup(userId) };
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
        result = await mt5CloudConnect(userId, { login, password, server, symbol: str("symbol") ?? group[0], period: str("period"), marketWatch: group });
        break;
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
        result = await mt5CloudSettings(userId, { symbol: str("symbol"), period: str("period"), marketWatch, inputs });
        break;
      }
      case "restart":
        result = await mt5CloudRestart(userId);
        break;
      default:
        return NextResponse.json({ error: "action must be one of: connect, settings, restart." }, { status: 400 });
    }
    if (result && !result.ok) return NextResponse.json({ error: result.error ?? "The MT5 container refused.", compileLog: result.compileLog }, { status: 409 });
    return NextResponse.json(await mt5CloudView(userId));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
