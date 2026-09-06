import { NextRequest, NextResponse } from "next/server";
import { readLive, writeLive } from "@dave/memory";

/** Item 12: a real way to read/write the user's own goal.yaml -- previously only readable via
 * get_goal_config, with no writer anywhere (admin panel or Telegram). */
export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  return NextResponse.json({ goal: readLive(userId, "goal.yaml") });
}

export async function POST(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  const body = (await req.json()) as { goal: string };
  writeLive(userId, "goal.yaml", body.goal);
  return NextResponse.json({ ok: true, goal: readLive(userId, "goal.yaml") });
}
