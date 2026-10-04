import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { NextRequest, NextResponse } from "next/server";

const ALL_TIMEFRAMES = ["D1", "H4", "H1", "M15", "M5", "M3", "M1"];
const ALL_ENDPOINTS = [
  "price","candles","market_structure","liquidity","zones","trend","momentum","volatility","volume",
  "levels","session","news","intermarket","chart_patterns","summary",
];
const DEFAULT_CONFIG = { mode: "all", timeframes: ALL_TIMEFRAMES, endpoints: ALL_ENDPOINTS };

function configPath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "trading", userId, "analysis-config.json");
}

export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  const path = configPath(userId);
  const config = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : DEFAULT_CONFIG;
  return NextResponse.json(config);
}

export async function POST(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  const body = await req.json() as { mode?: string };
  const config = body.mode === "all" ? DEFAULT_CONFIG : body;
  const path = configPath(userId);
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config), "utf8");
  return NextResponse.json({ ok: true, config });
}
