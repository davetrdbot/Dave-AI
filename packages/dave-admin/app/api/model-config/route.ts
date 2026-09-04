import { NextRequest, NextResponse } from "next/server";
import { getModelConfig, setModelConfig, type ModelConfig } from "@dave/brain";

export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  return NextResponse.json(getModelConfig(userId));
}

export async function POST(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  const config = (await req.json()) as ModelConfig;
  setModelConfig(userId, config);
  return NextResponse.json({ ok: true, ...getModelConfig(userId) });
}
