import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    implemented: true,
    connections: [{ name: "EA/MT5 trade placement", kind: "custom", status: "not connected (no MCP trade server configured)" }],
  });
}
