import { getLastKnownAccountSnapshot, type EaPosition, type EaPendingOrder } from "@dave/ea-bridge";
import { isForexSymbol, type AlertToggles } from "@dave/trading";

/**
 * Account and broker safety checks (the trader: "add other safe alert too"), run by the trade
 * monitor's sweep next to the account-heat check. Each has its own switch in Settings -> Alerts and
 * goes out through the monitor's notify, so it lands in the Live feed and in Dave's next scan.
 *
 *  - spread spike: an open trade's spread jumps to 3x its recent normal -- stops can fire on the
 *    spread alone, and a new entry now would start deep in the red;
 *  - margin low: the account's margin level under 200%, and again under 120% (stop-out territory);
 *  - stop too tight: a stop closer to the price than the spread plus the broker's minimum distance
 *    -- it can be hit without price really moving;
 *  - market close: a forex trade still open in the last hour before the Friday close (gaps over
 *    the weekend jump straight past stops).
 */

const SPREAD_SAMPLES = 40;
const SPREAD_MIN_SAMPLES = 10;
export const SPREAD_SPIKE_X = 3;
const SPREAD_COOLDOWN_MS = 15 * 60_000;
export const MARGIN_WARN = 200;
export const MARGIN_CRITICAL = 120;

interface State {
  spreads: Map<string, number[]>;
  spreadToldAt: Map<string, number>;
  marginLevel: "ok" | "warn" | "critical";
  tightTold: Set<string>;
  closeTold: Set<string>;
}
const states = new Map<string, State>();

function stateFor(userId: string): State {
  let s = states.get(userId);
  if (!s) {
    s = { spreads: new Map(), spreadToldAt: new Map(), marginLevel: "ok", tightTold: new Set(), closeTold: new Set() };
    states.set(userId, s);
  }
  return s;
}

function median(xs: number[]): number {
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function fmt(n: number, digits?: number): string {
  return typeof digits === "number" ? n.toFixed(digits) : String(Number(n.toPrecision(6)));
}

type SafetyToggles = Pick<AlertToggles, "spread_spike" | "margin_low" | "stop_too_tight" | "market_close">;

export function safetyChecks(userId: string, positions: EaPosition[], now: number, toggles: SafetyToggles): string[] {
  const st = stateFor(userId);
  const out: string[] = [];

  // Spread: learn each symbol's normal from every sweep, alert on a jump.
  const seenSymbols = new Set<string>();
  for (const p of positions) {
    if (typeof p.spread !== "number" || !(p.spread > 0) || seenSymbols.has(p.symbol)) continue;
    seenSymbols.add(p.symbol);
    const hist = st.spreads.get(p.symbol) ?? [];
    const normal = hist.length >= SPREAD_MIN_SAMPLES ? median(hist) : undefined;
    const spiking = normal !== undefined && normal > 0 && p.spread >= normal * SPREAD_SPIKE_X;
    // A spike doesn't become the new normal.
    if (!spiking) {
      hist.push(p.spread);
      if (hist.length > SPREAD_SAMPLES) hist.shift();
      st.spreads.set(p.symbol, hist);
    }
    const last = st.spreadToldAt.get(p.symbol);
    if (spiking && toggles.spread_spike && (last === undefined || now - last >= SPREAD_COOLDOWN_MS)) {
      st.spreadToldAt.set(p.symbol, now);
      const open = positions.filter((q) => q.symbol === p.symbol).map((q) => `#${q.ticket}`).join(", ");
      out.push(
        `⚠️ SPREAD SPIKE on ${p.symbol}\n\nThe spread is ${fmt(p.spread, p.digits)} -- ${(p.spread / (normal as number)).toFixed(1)}x its normal ${fmt(normal as number, p.digits)}. Open: ${open}.\n` +
          `Stops close to price can be hit by the spread alone, and a new entry now starts deep in the red. Self-check: is any stop within a spread of price? Hold off new ${p.symbol} entries until it settles.`
      );
    }
  }

  // Margin level: once on the way down past each line, re-armed when it recovers.
  const snap = getLastKnownAccountSnapshot(userId);
  const ml = snap?.marginLevel;
  if (positions.length > 0 && typeof ml === "number" && ml > 0) {
    const level = ml < MARGIN_CRITICAL ? "critical" : ml < MARGIN_WARN ? "warn" : "ok";
    const worse = (level === "critical" && st.marginLevel !== "critical") || (level === "warn" && st.marginLevel === "ok");
    if (worse && toggles.margin_low) {
      out.push(
        level === "critical"
          ? `🚨 MARGIN CRITICAL\n\nMargin level is ${ml.toFixed(0)}% -- under ${MARGIN_CRITICAL}%. The broker starts closing trades on its own near its stop-out level. Close or cut the weakest trade now; no new trades.`
          : `⚠️ MARGIN LOW\n\nMargin level is ${ml.toFixed(0)}% -- under ${MARGIN_WARN}%. ${positions.length} trade${positions.length === 1 ? "" : "s"} open. No new trades until it's back up; consider cutting the weakest.`
      );
    }
    // Recovery re-arms with a little room so it doesn't flap on the line.
    if (level === "ok" && ml >= MARGIN_WARN * 1.25) st.marginLevel = "ok";
    else if (level === "warn" && st.marginLevel === "critical" && ml >= MARGIN_CRITICAL * 1.25) st.marginLevel = "warn";
    else if (worse) st.marginLevel = level;
  } else if (positions.length === 0) st.marginLevel = "ok";

  // Stop too tight: closer than the spread plus the broker's minimum -- once per ticket and stop.
  for (const p of positions) {
    if (typeof p.sl !== "number" || !(p.sl > 0) || typeof p.currentPrice !== "number" || typeof p.spread !== "number") continue;
    const room = Math.abs(p.currentPrice - p.sl);
    const need = p.spread + (p.stopsLevel ?? 0);
    const key = `${p.ticket}@${p.sl}`;
    if (room < need && !st.tightTold.has(key)) {
      st.tightTold.add(key);
      if (toggles.stop_too_tight) {
        out.push(
          `⚠️ STOP TOO TIGHT: ${p.symbol} #${p.ticket}\n\nThe stop (${fmt(p.sl, p.digits)}) is only ${fmt(room, p.digits)} from price, less than the spread${p.stopsLevel ? " plus the broker's minimum" : ""} (${fmt(need, p.digits)}). ` +
            `It can be hit by a normal spread flicker, not a real move. Self-check: does the idea still need this stop, or should it sit behind real structure?`
        );
      }
    }
  }

  // Forex weekend close: the last hour before Friday 22:00 UTC, once per trade per week.
  const d = new Date(now);
  if (d.getUTCDay() === 5 && d.getUTCHours() === 21) {
    const week = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    const fx = positions.filter((p) => isForexSymbol(p.symbol, null) && !st.closeTold.has(`${p.ticket}:${week}`));
    for (const p of fx) st.closeTold.add(`${p.ticket}:${week}`);
    if (fx.length && toggles.market_close) {
      out.push(
        `🕘 MARKET CLOSES IN UNDER AN HOUR\n\nForex closes for the weekend at 22:00 UTC and ${fx.map((p) => `${p.symbol} #${p.ticket}`).join(", ")} ${fx.length === 1 ? "is" : "are"} still open. ` +
          `Monday can open with a gap straight past the stop. Self-check: close, take partial profit, or hold on purpose -- decide now, not after the bell.`
      );
    }
  }
  return out;
}

/** A pending order waiting this long gets rechecked (the trader: "if a pending order has been there
 *  for like 10 minutes it should recheck"), and again every PENDING_REPEAT_MS while it waits. */
export const PENDING_STALE_MS = 10 * 60_000;
export const PENDING_REPEAT_MS = 30 * 60_000;
const pendingSeen = new Map<string, Map<string, { firstSeen: number; toldAt?: number }>>();

/** Pending orders that have waited too long, one alert each, with its pair so mode 2 rechecks it. */
export function stalePendingChecks(userId: string, pending: EaPendingOrder[], positions: EaPosition[], now: number, enabled: boolean): { symbol: string; text: string }[] {
  const seen = pendingSeen.get(userId) ?? new Map<string, { firstSeen: number; toldAt?: number }>();
  pendingSeen.set(userId, seen);
  const live = new Set(pending.map((o) => String(o.ticket)));
  for (const t of [...seen.keys()]) if (!live.has(t)) seen.delete(t);
  const out: { symbol: string; text: string }[] = [];
  for (const o of pending) {
    const rec = seen.get(String(o.ticket)) ?? { firstSeen: now };
    seen.set(String(o.ticket), rec);
    const age = now - rec.firstSeen;
    const due = rec.toldAt === undefined ? age >= PENDING_STALE_MS : now - rec.toldAt >= PENDING_REPEAT_MS;
    if (!due) continue;
    rec.toldAt = now;
    if (!enabled) continue;
    const price = positions.find((p) => p.symbol === o.symbol && typeof p.currentPrice === "number")?.currentPrice;
    const mins = Math.round(age / 60_000);
    out.push({
      symbol: o.symbol,
      text:
        `⏳ PENDING ORDER STILL WAITING: ${o.symbol} ${o.type.toUpperCase().replace("_", " ")} ${o.lots} lots @ ${o.price} #${o.ticket} -- ${mins} min and not filled` +
        `${price !== undefined ? ` (price now ${price})` : ""}.${o.sl ? ` SL ${o.sl}` : ""}${o.tp ? ` TP ${o.tp}` : ""}${o.comment ? ` Note: ${o.comment}.` : ""}\n` +
        `Recheck it on fresh candles: is the level and the idea behind it still valid? Keep it (say why), move it to where price will really come, or cancel it (DELETE_TICKET #${o.ticket}).`,
    });
  }
  return out;
}

/** Test seam. */
export function resetSafetyState(): void {
  states.clear();
  pendingSeen.clear();
  limitSeen.clear();
}

/**
 * STALE LIMIT REMINDER (the trader's spec). A BUY LIMIT with price above it, a SELL LIMIT with
 * price below it, never touched since it was placed, and price moving AWAY from it: price ran
 * without us. One reminder per order every 5 minutes, each with fresh numbers; stops the moment the
 * order is gone or price touches the level.
 */
export const STALE_LIMIT_EVERY_MS = 5 * 60_000;
const limitSeen = new Map<string, Map<string, { firstSeen: number; firstGap: number; touched: boolean; toldAt?: number; lastGap?: number }>>();

export function staleLimitChecks(
  userId: string,
  pending: EaPendingOrder[],
  priceOf: (symbol: string) => number | undefined,
  reasonOf: (ticket: string) => string,
  now: number,
  enabled = true
): { symbol: string; text: string }[] {
  const seen = limitSeen.get(userId) ?? new Map();
  limitSeen.set(userId, seen);
  const live = new Set(pending.map((o) => String(o.ticket)));
  for (const t of [...seen.keys()]) if (!live.has(t)) seen.delete(t);
  const out: { symbol: string; text: string }[] = [];
  for (const o of pending) {
    if (o.type !== "buy_limit" && o.type !== "sell_limit") continue;
    const price = priceOf(o.symbol);
    if (price === undefined || !(price > 0)) continue;
    const buy = o.type === "buy_limit";
    const gap = buy ? price - o.price : o.price - price; // > 0: price is on the far side, waiting
    const key = String(o.ticket);
    let rec = seen.get(key);
    if (!rec) {
      rec = { firstSeen: now, firstGap: Math.max(0, gap), touched: false };
      seen.set(key, rec);
    }
    if (gap <= 0) rec.touched = true; // price came back to the level
    if (rec.touched) continue;
    // Ran away (seen live 2 Oct: VOL_10 BUY LIMIT 1046960 never filled, price went straight to its
    // TP 1048045 and beyond, and no reminder came because "further than first seen" never held
    // after a restart). Stale = a third of the way to the order's own TP, or a full stop-distance
    // away from the entry, or -- with neither set -- half again further than when first seen.
    const tpWay = o.tp && o.tp > 0 ? (buy ? (price - o.price) / (o.tp - o.price) : (o.price - price) / (o.price - o.tp)) : undefined;
    const r1 = o.sl && o.sl > 0 ? Math.abs(o.price - o.sl) : undefined;
    const ranAway = tpWay !== undefined ? tpWay >= 0.33 : r1 !== undefined ? gap >= r1 : gap > rec.firstGap * 1.5 && gap > 0;
    if (!ranAway) continue;
    if (rec.toldAt !== undefined && now - rec.toldAt < STALE_LIMIT_EVERY_MS) continue;
    const lastGap = rec.lastGap;
    rec.toldAt = now;
    rec.lastGap = gap;
    if (!enabled) continue;
    const side = buy ? "BUY" : "SELL";
    const mins = Math.max(1, Math.round((now - rec.firstSeen) / 60_000));
    const pts = +gap.toFixed(5);
    out.push({
      symbol: o.symbol,
      text:
        `🏃 STALE LIMIT: ${o.symbol} ${side} LIMIT at ${o.price} (ticket ${o.ticket}) has been pending for ${mins} minutes.\n` +
        `Price is now ${price}, ${pts} points past the limit level${lastGap !== undefined ? ` (was ${+lastGap.toFixed(5)} points at the last reminder)` : ""}${tpWay !== undefined ? ` -- ${Math.round(tpWay * 100)}% of the way to its own TP ${o.tp}` : ""}.\n` +
        `It has not come back to the level and is unlikely to reach it.\n` +
        `Entry reason: ${reasonOf(key)}\n` +
        `Should I place a ${side} at market instead?\n` +
        `Decide: 1) is the idea still valid in the same direction? 2) valid -> DELETE_TICKET ${o.ticket} first, then a market ${side} (same lot, SL/TP from the current price) -- never a second trade for the same idea; 3) R:R too poor or the target already passed -> DELETE_TICKET ${o.ticket} and say "missed entry, no chase". Max trades, risk and spread rules still apply.`,
    });
  }
  return out;
}

/** A BUY/SELL LIMIT whose own take profit was reached without it ever filling: the move is gone.
 *  The trader's spec, step 3 -- cancel it, "missed entry, no chase". Plain code: it doesn't wait for
 *  an AI that may be out of credit. */
export function limitsPastTarget(pending: EaPendingOrder[], priceOf: (symbol: string) => number | undefined): EaPendingOrder[] {
  return pending.filter((o) => {
    if ((o.type !== "buy_limit" && o.type !== "sell_limit") || !o.tp || !(o.tp > 0)) return false;
    const p = priceOf(o.symbol);
    if (p === undefined) return false;
    return o.type === "buy_limit" ? p >= o.tp : p <= o.tp;
  });
}
