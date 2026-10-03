import type { TradeExecutor } from "@dave/trading";
import { getRiskSettings } from "@dave/trading";
import { listNousTrades } from "./nous/store.js";
import { publishActivity } from "./activity-bus.js";

/**
 * SL off means NO stop loss -- from any path (the trader: "anytime SL is off the bot still places
 * the trade with an SL, and even if I remove it, it puts the SL back").
 *
 * Every order and every modify Dave makes goes through this one executor, so the rule is enforced
 * here rather than trusted to each caller:
 *   - a new order with SL off goes in WITHOUT its stop (the trade still goes in);
 *   - a modify that sets a stop is refused with a clear message Dave reads ("SL is off -- manage
 *     the exit with an exit rule or close it"); a target change in the same call still goes through;
 *   - removing a stop is always allowed.
 * Copy-trading signals (Nous) keep their channel's SL: those levels are the signal, not Dave's.
 */
export class SlOffError extends Error {}

export const SL_OFF_MESSAGE =
  "SL is OFF in the trader's settings -- no stop loss can be placed or moved. Manage this trade yourself: arm set_exit_rule with exitBelow (buy) / exitAbove (sell) at your invalidation, or close it when the idea is broken.";

export function slIsOff(userId: string): boolean {
  return getRiskSettings(userId).slMode === "off";
}

function isCopyTrade(userId: string, ticket: string): boolean {
  try {
    return listNousTrades(userId).some((t) => t.ticket === ticket);
  } catch {
    return false;
  }
}

export class SlOffGuardExecutor implements TradeExecutor {
  constructor(
    private readonly userId: string,
    private readonly inner: TradeExecutor
  ) {}

  async openOrder(order: Parameters<TradeExecutor["openOrder"]>[0]) {
    const copy = /^nous/i.test(order.comment ?? "");
    if (!copy && order.sl !== undefined && order.sl > 0 && slIsOff(this.userId)) {
      const { sl, ...rest } = order;
      publishActivity(this.userId, "loop", "notice", { text: `🛑 SL is off -- ${order.symbol} went in WITHOUT the stop (${sl}) Dave gave. He manages the exit himself.` });
      return this.inner.openOrder(rest);
    }
    return this.inner.openOrder(order);
  }

  async modifyOrder(ticket: string, changes: Parameters<TradeExecutor["modifyOrder"]>[1]) {
    const setsStop = typeof changes.sl === "number" && changes.sl > 0;
    if (setsStop && slIsOff(this.userId) && !isCopyTrade(this.userId, ticket)) {
      const { sl: _sl, ...rest } = changes;
      void _sl;
      publishActivity(this.userId, "loop", "notice", { text: `🛑 Refused a stop loss on ${ticket}: SL is off.` });
      if (rest.tp !== undefined || rest.price !== undefined) {
        await this.inner.modifyOrder(ticket, rest);
        throw new SlOffError(`Target/price updated on ${ticket}, but the stop was NOT set. ${SL_OFF_MESSAGE}`);
      }
      throw new SlOffError(SL_OFF_MESSAGE);
    }
    return this.inner.modifyOrder(ticket, changes);
  }

  closePosition(ticket: string, lots?: number) {
    return this.inner.closePosition(ticket, lots);
  }
  deletePendingOrder(ticket: string) {
    return this.inner.deletePendingOrder(ticket);
  }
  listOpenPositions() {
    return this.inner.listOpenPositions();
  }
  listPendingOrders() {
    return this.inner.listPendingOrders();
  }
}
