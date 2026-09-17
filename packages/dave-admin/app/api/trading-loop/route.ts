import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { NextRequest, NextResponse } from "next/server";

/**
 * The trader's explicit request: a real UI control in the admin panel for the autonomous scan
 * interval ("every 1 min to analyze"), not just Telegram's /start_trading <minutes>.
 *
 * Deliberately self-contained rather than importing @dave/agent-loop: that package's only export
 * is its full barrel (package.json's "exports" map has just "."), which re-exports
 * telegram-bot-server.ts/main.ts and their entire real transitive dependency graph (workers,
 * safety, sandbox, e2b, firecrawl, notifications, vision, self-improve, mcp-manager, ...) -- way
 * too heavy to pull into one lightweight Next.js API route just to read/write a one-field JSON
 * file. Same real, established convention this codebase already uses elsewhere (the admin panel
 * is its own child process, per provider-router.ts's own comment on this exact fact) -- both
 * processes independently read/write the SAME shared file under DAVE_DATA_ROOT, without importing
 * each other's TS modules. Constants and path shape kept in exact sync with
 * packages/dave-agent-loop/src/trading-loop-config.ts by hand -- if that file's real path/shape
 * ever changes, this needs the matching update.
 */
const MIN_TRADING_LOOP_MINUTES = 1;
const MAX_TRADING_LOOP_MINUTES = 60;
const DEFAULT_TRADING_LOOP_MINUTES = 5;

function configPath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "trading-loop", userId, "config.json");
}

function readIntervalMinutes(userId: string): number {
  const path = configPath(userId);
  if (!existsSync(path)) return DEFAULT_TRADING_LOOP_MINUTES;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { intervalMinutes?: number };
  return parsed.intervalMinutes ?? DEFAULT_TRADING_LOOP_MINUTES;
}

function enabledFlagPath(userId: string, name: "autonomous-trading-enabled" | "autonomous-execution-enabled"): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "trading", userId, `${name}.json`);
}

function readEnabledFlag(userId: string, name: "autonomous-trading-enabled" | "autonomous-execution-enabled", defaultValue: boolean): boolean {
  const path = enabledFlagPath(userId, name);
  if (!existsSync(path)) return defaultValue;
  return JSON.parse(readFileSync(path, "utf8")) === true;
}

// Real gap fixed (a dedicated investigation subagent, the trader's "why isn't it trading"
// report): every autonomous-cycle skip reason (EA disconnected, circuit breaker, drawdown,
// a pending question, busy-state, a plain model SKIP) used to reach ONLY a server-side
// console.log -- see autonomous-cycle-status.ts's own comment for the real fix that persists it.
// Same self-contained cross-process file convention as the rest of this route.
function lastCycleOutcomePath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "agent-loop", userId, "last-cycle-outcome.json");
}

function readLastCycleOutcome(userId: string): { ts: number; reason: string } | null {
  const path = lastCycleOutcomePath(userId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  return NextResponse.json({
    intervalMinutes: readIntervalMinutes(userId),
    min: MIN_TRADING_LOOP_MINUTES,
    max: MAX_TRADING_LOOP_MINUTES,
    // Real, persisted (cross-process-readable) intent flags -- see autonomous-trading-state.ts.
    // NOT the same thing as "is the loop literally armed right now" (that's in-memory, only the
    // live bot process itself knows that) -- this is the trader's last stated intent, which is
    // what actually survives a restart and is genuinely useful to show here.
    enabled: readEnabledFlag(userId, "autonomous-trading-enabled", false),
    executionEnabled: readEnabledFlag(userId, "autonomous-execution-enabled", true),
    lastCycle: readLastCycleOutcome(userId),
  });
}

export async function POST(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  const body = (await req.json()) as { intervalMinutes?: number; enabled?: boolean };

  // Allow setting the persisted enabled flag directly -- useful to re-arm auto-resume
  // after a manual /stop without having to open Telegram. The in-memory loop itself
  // only starts when the bot process boots or receives /start_trading; this just sets
  // the flag so the NEXT boot auto-resumes instead of staying off.
  if (typeof body.enabled === "boolean") {
    const path = enabledFlagPath(userId, "autonomous-trading-enabled");
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(body.enabled), "utf8");
    return NextResponse.json({ ok: true, enabled: body.enabled });
  }

  const minutes = body.intervalMinutes;
  if (minutes === undefined || !Number.isInteger(minutes) || minutes < MIN_TRADING_LOOP_MINUTES || minutes > MAX_TRADING_LOOP_MINUTES) {
    return NextResponse.json({ ok: false, error: `Trading loop interval must be a whole number of minutes between ${MIN_TRADING_LOOP_MINUTES} and ${MAX_TRADING_LOOP_MINUTES} (got ${minutes}).` }, { status: 400 });
  }
  const path = configPath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify({ intervalMinutes: minutes }, null, 2), "utf8");
  return NextResponse.json({ ok: true, intervalMinutes: minutes });
}
