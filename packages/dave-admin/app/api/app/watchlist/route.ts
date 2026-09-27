import { NextResponse } from "next/server";
import { listActiveWatches, cancelWatch, listSetups, cancelSetup, describeSetup } from "@dave/trading";
import { listReminders, deleteReminder, listBackgroundChecks, finalizeBackgroundCheck } from "@dave/workers";
import { withDevice } from "../../../../server/require-device";

/**
 * What Dave is waiting on, for the phone's Settings: the reminders he set himself, the price
 * levels he marked, his setups ("if price does this, then that, place"), and his background checks -- each one cancellable from the phone.
 */
export const dynamic = "force-dynamic";

function view(userId: string) {
  return {
    reminders: listReminders(userId).map((r) => ({ id: r.id, text: r.text, reason: r.reason, symbol: r.symbol ?? null, dueAt: r.dueAt })),
    levels: listActiveWatches(userId).map((w) => ({ id: w.id, symbol: w.symbol, kind: w.kind, level: w.level, reason: w.reason, createdAt: w.createdAt })),
    setups: listSetups(userId, { includeFinished: true })
      .reverse()
      .slice(0, 30)
      .map((s) => ({ id: s.id, symbol: s.symbol, reason: s.reason, plan: describeSetup(s), status: s.status, stage: s.stage, steps: s.steps.length, outcome: s.outcome ?? null, expiresAt: s.expiresAt })),
    checks: listBackgroundChecks(userId).map((c) => ({ id: c.id, reason: c.reason, whatToCheck: c.whatToCheck, symbols: c.symbols ?? [], expiresAt: c.expiresAt, checkCount: c.checkCount })),
  };
}

export const GET = withDevice(async ({ userId }) => NextResponse.json(view(userId)));

export const POST = withDevice(async ({ userId, req }) => {
  let body: { action?: string; id?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const id = String(body.id ?? "");
  if (!id) return NextResponse.json({ error: "id is required." }, { status: 400 });
  try {
    switch (body.action) {
      case "cancel-reminder":
        if (!deleteReminder(userId, id)) return NextResponse.json({ error: "That reminder is gone." }, { status: 404 });
        break;
      case "cancel-level":
        cancelWatch(userId, id);
        break;
      case "cancel-setup":
        cancelSetup(userId, id, "Cancelled from the app.");
        break;
      case "stop-check":
        finalizeBackgroundCheck(userId, id, "stopped", "Stopped from the app.");
        break;
      default:
        return NextResponse.json({ error: "action must be cancel-reminder, cancel-level, cancel-setup or stop-check." }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 404 });
  }
  return NextResponse.json(view(userId));
});
