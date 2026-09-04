import { NextResponse } from "next/server";
import { checkSandboxHealth } from "@dave/sandbox";

export async function GET() {
  const health = await checkSandboxHealth("/tmp/dave-admin-sandbox-check");
  return NextResponse.json(health);
}
