import { NextRequest, NextResponse } from "next/server";
import { DaveDatabase } from "@dave/db";
import { dbPathFor } from "../../../server/db-path";
import { startTelegramOtpPairing, checkTelegramOtpPairing, getTelegramPairingStatus, InvalidTelegramBotTokenError } from "@dave/telegram";

/**
 * Real OTP pairing flow: the admin website is where the bot token +
 * chat ID get entered. POST {action:"start"} validates the token
 * (real getMe()) and generates+shows a real OTP. The user pastes that
 * OTP into their bot on Telegram. POST {action:"check"} does a real
 * getUpdates() and confirms once it sees that exact message.
 */
function dbFor(userId: string): DaveDatabase {
  return new DaveDatabase(dbPathFor(userId));
}

export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  const db = dbFor(userId);
  try {
    return NextResponse.json(getTelegramPairingStatus(db, userId));
  } finally {
    db.close();
  }
}

export async function POST(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  const body = await req.json();
  const db = dbFor(userId);
  try {
    if (body.action === "start") {
      try {
        const result = await startTelegramOtpPairing(db, userId, body.botToken, Number(body.chatId));
        return NextResponse.json(result);
      } catch (err) {
        if (err instanceof InvalidTelegramBotTokenError) return NextResponse.json({ error: err.message }, { status: 400 });
        throw err;
      }
    }
    if (body.action === "check") {
      return NextResponse.json(await checkTelegramOtpPairing(db, userId));
    }
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } finally {
    db.close();
  }
}
