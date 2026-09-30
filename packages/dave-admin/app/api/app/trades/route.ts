import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { enqueueCommand, getEaConnectionStatus, getLastKnownState, recordAppClose } from "@dave/ea-bridge";
import { withDevice } from "../../../../server/require-device";

/**
 * Close an open position, or cancel a pending order, from the phone.
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
  let body: { action?: string; ticket?: unknown; sl?: unknown; tp?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  if (body.action !== "close" && body.action !== "modify" && body.action !== "cancel") return NextResponse.json({ error: "action must be close, cancel or modify." }, { status: 400 });
  const ticket = typeof body.ticket === "string" || typeof body.ticket === "number" ? String(body.ticket) : "";
  if (!ticket) return NextResponse.json({ error: "ticket is required." }, { status: 400 });

  if (body.action === "modify") {
    // SL / TP on an open position OR a pending order (the EA handles both). Each side: a number to
    // set it, null to remove it, left out to leave it as it is.
    const state = getLastKnownState(userId);
    const target = state.positions.find((p) => p.ticket === ticket) ?? state.pendingOrders.find((o) => o.ticket === ticket);
    if (!target) return NextResponse.json({ error: "That order or trade is no longer there." }, { status: 404 });
    const level = (v: unknown): number | null | undefined => (v === null ? null : v === undefined ? undefined : Number(v) > 0 ? Number(v) : NaN);
    const sl = level(body.sl);
    const tp = level(body.tp);
    if (Number.isNaN(sl) || Number.isNaN(tp)) return NextResponse.json({ error: "SL and TP must be prices above 0." }, { status: 400 });
    if (sl === undefined && tp === undefined) return NextResponse.json({ error: "Give an SL, a TP or both." }, { status: 400 });
    const commandId = randomBytes(8).toString("hex");
    enqueueCommand(userId, { id: commandId, action: "modify", ticket, ...(sl !== undefined ? { sl } : {}), ...(tp !== undefined ? { tp } : {}) });
    return NextResponse.json({ ok: true, queued: { commandId, ticket, symbol: target.symbol } });
  }

  if (body.action === "cancel") {
    // Cancel a pending order (buy/sell limit or stop) -- the EA's own delete_pending command.
    const order = getLastKnownState(userId).pendingOrders.find((o) => o.ticket === ticket);
    if (!order) return NextResponse.json({ error: "That pending order is no longer there." }, { status: 404 });
    const commandId = randomBytes(8).toString("hex");
    enqueueCommand(userId, { id: commandId, action: "delete_pending", ticket });
    return NextResponse.json({ ok: true, queued: { commandId, ticket, symbol: order.symbol }, eaConnected: getEaConnectionStatus(userId).connected });
  }

  const open = getLastKnownState(userId).positions.find((p) => p.ticket === ticket);
  if (!open) return NextResponse.json({ error: "That trade is no longer open." }, { status: 404 });

  const commandId = randomBytes(8).toString("hex");
  // Recorded first, so the close is attributed to the trader -- not to Dave -- when it lands.
  recordAppClose(userId, ticket);
  enqueueCommand(userId, { id: commandId, action: "close", ticket });
  return NextResponse.json({ ok: true, queued: { commandId, ticket, symbol: open.symbol }, eaConnected: getEaConnectionStatus(userId).connected });
});
