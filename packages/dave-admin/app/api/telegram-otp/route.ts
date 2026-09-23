import { NextRequest, NextResponse } from "next/server";
import { DaveDatabase } from "@dave/db";
import { dbPathFor } from "../../../server/db-path";
import { startTelegramOtpPairing, checkTelegramOtpPairing, getTelegramPairingStatus, readTelegramStatus, InvalidTelegramBotTokenError } from "@dave/telegram";

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
    // The bot's own report of whether it is running, so the panel can say "online" -- or why not --
    // instead of leaving the trader to guess after pairing.
    return NextResponse.json({ ...getTelegramPairingStatus(db, userId), bot: readTelegramStatus() ?? null });
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
        const chatId = body.chatId === undefined || String(body.chatId).trim() === "" ? undefined : Number(body.chatId);
        if (chatId !== undefined && !Number.isFinite(chatId)) return NextResponse.json({ error: "Chat ID must be a number (or leave it empty)." }, { status: 400 });
        const result = await startTelegramOtpPairing(db, userId, String(body.botToken ?? "").trim(), chatId);
        return NextResponse.json(result);
      } catch (err) {
        if (err instanceof InvalidTelegramBotTokenError) return NextResponse.json({ error: err.message }, { status: 400 });
        // Every failure reaches the page as a sentence -- a thrown error here used to become a bare
        // 500 the page could not even parse, so "Start pairing" appeared to do nothing.
        return NextResponse.json({ error: `Could not start pairing: ${err instanceof Error ? err.message : String(err)}` }, { status: 500 });
      }
    }
    if (body.action === "check") {
      try {
        return NextResponse.json(await checkTelegramOtpPairing(db, userId));
      } catch (err) {
        return NextResponse.json({ confirmed: false, reason: `Could not check with Telegram: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } finally {
    db.close();
  }
}
