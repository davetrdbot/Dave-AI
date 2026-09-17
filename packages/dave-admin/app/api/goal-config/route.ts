import { NextResponse } from "next/server";

// goal.yaml has been removed -- trading goals and principles are now built
// directly into the bot's prompts/trading.md, not a user-editable override.
export function GET() {
  return NextResponse.json({ removed: true }, { status: 410 });
}
export function POST() {
  return NextResponse.json({ removed: true }, { status: 410 });
}
