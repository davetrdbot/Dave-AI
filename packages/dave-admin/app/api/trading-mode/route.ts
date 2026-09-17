import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { NextRequest, NextResponse } from "next/server";

function modePath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "trading", userId, "trading-mode.json");
}

function read(userId: string): { mode: string; lockedSkillId?: string } {
  const path = modePath(userId);
  if (!existsSync(path)) return { mode: "auto" };
  return JSON.parse(readFileSync(path, "utf8"));
}

export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  return NextResponse.json(read(userId));
}

export async function POST(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  const body = await req.json() as { mode: string; lockedSkillId?: string };
  const path = modePath(userId);
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(body), "utf8");
  return NextResponse.json({ ok: true, ...body });
}
