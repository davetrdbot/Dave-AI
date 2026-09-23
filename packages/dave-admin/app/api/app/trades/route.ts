import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { enqueueCommand, getLastKnownState, recordAppClose } from "@dave/ea-bridge";
import { withDevice } from "../../../../server/require-device";

/**
 * Close an open position from the phone.
 *
 * The EA command queue is a file both processes share, so the close is queued exactly like one
 * Dave queues himself and goes out on the EA's next heartbeat. The response means "sent", not
 * "closed": the fill is confirmed the normal way, by the EA's next report -- which also raises
 * the "closed" notification on this phone.
 *
 * Only a ticket that is open right now can be closed, so a stale screen can't fire a command at
 * a position that has already gone.
 */
export const POST = withDevice(async ({ userId, req }) => {
  let body: { action?: string; ticket?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  if (body.action !== "close") return NextResponse.json({ error: "action must be close." }, { status: 400 });
  const ticket = typeof body.ticket === "string" || typeof body.ticket === "number" ? String(body.ticket) : "";
  if (!ticket) return NextResponse.json({ error: "ticket is required." }, { status: 400 });

  const open = getLastKnownState(userId).positions.find((p) => p.ticket === ticket);
  if (!open) return NextResponse.json({ error: "That trade is no longer open." }, { status: 404 });

  const commandId = randomBytes(8).toString("hex");
  // Recorded first, so the close is attributed to the trader -- not to Dave -- when it lands.
  recordAppClose(userId, ticket);
  enqueueCommand(userId, { id: commandId, action: "close", ticket });
  return NextResponse.json({ ok: true, queued: { commandId, ticket, symbol: open.symbol } });
});
