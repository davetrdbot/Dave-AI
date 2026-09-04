import { NextResponse } from "next/server";
import { DavemaClient } from "@dave/davema";

export async function GET() {
  try {
    const ping = await new DavemaClient(undefined).ping();
    return NextResponse.json({ reachable: true, ...ping });
  } catch (err) {
    return NextResponse.json({ reachable: false, error: err instanceof Error ? err.message : String(err) });
  }
}
