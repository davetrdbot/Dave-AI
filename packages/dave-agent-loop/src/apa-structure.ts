/**
 * The APA (Lowkey Forex Trader) structure read, computed from raw candles (the trader: "the EA
 * doesn't have invalidation, validation, liquidity sweep, fair value gap, OB identification, market
 * structure, liquidity engineering, BOS ... how will the bot use the setup?"). Plain code, so the
 * model gets facts, not guesses:
 *   - swings (2-left/2-right fractals) and the trend they make (HH/HL, LH/LL, range);
 *   - the last break of structure, the SHIFT point (close beyond the level that invalidates the
 *     trend), the RECLAIM point, and TRANSITION (shifted but no new structure yet);
 *   - the current area of liquidity: its VALIDATION point (the level whose break confirmed the
 *     side in control) and INVALIDATION point (close beyond it = dominance shifted);
 *   - liquidity sweeps (wick beyond a swing, close back inside), equal highs/lows;
 *   - Type 1 engulfing areas of liquidity, fair value gaps, order blocks -- each with whether price
 *     has already CONSUMED it (traded through 50%).
 */

export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

interface Swing {
  i: number;
  price: number;
  kind: "high" | "low";
}

export interface Zone {
  kind: "engulfing_aol" | "fvg" | "ob";
  side: "bullish" | "bearish";
  low: number;
  high: number;
  at: number;
  consumed: boolean;
}

export interface ApaRead {
  trend: "bullish" | "bearish" | "range";
  lastBos?: { side: "bullish" | "bearish"; level: number; at: number };
  shift?: { side: "bullish" | "bearish"; level: number; at: number; transition: boolean };
  reclaim?: { level: number; reclaimed: boolean };
  validation?: number;
  invalidation?: number;
  sweeps: { side: "buy-side" | "sell-side"; level: number; at: number }[];
  equalHighs?: number;
  equalLows?: number;
  zones: Zone[];
  /** Liquidity engineering: a level swept by a thrust candle, its furthest-most deviation (the
   *  stop goes beyond it), and whether a change of character back the other way followed. */
  engineering?: { side: "bullish" | "bearish"; level: number; fmd: number; choch: boolean; at: number };
  /** Flip zones: a level touched 2+ times, then closed through -- it now works the other way. */
  flips: { side: "bullish" | "bearish"; level: number; touches: number }[];
  lastClose: number;
}

function swings(bars: Bar[], k = 2): Swing[] {
  const out: Swing[] = [];
  for (let i = k; i < bars.length - k; i++) {
    const win = bars.slice(i - k, i + k + 1);
    if (win.every((b) => b.h <= bars[i].h)) out.push({ i, price: bars[i].h, kind: "high" });
    if (win.every((b) => b.l >= bars[i].l)) out.push({ i, price: bars[i].l, kind: "low" });
  }
  return out;
}

/** 50% of the zone traded through by any bar after it formed. */
function consumed(bars: Bar[], from: number, low: number, high: number, side: "bullish" | "bearish"): boolean {
  const mid = (low + high) / 2;
  for (let j = from + 1; j < bars.length; j++) {
    if (side === "bullish" ? bars[j].l <= mid : bars[j].h >= mid) return true;
  }
  return false;
}

export function readApa(bars: Bar[]): ApaRead | undefined {
  if (bars.length < 20) return undefined;
  const sw = swings(bars);
  const highs = sw.filter((s) => s.kind === "high");
  const lows = sw.filter((s) => s.kind === "low");
  const lastClose = bars[bars.length - 1].c;

  // Trend from the last two swing highs and lows.
  let trend: ApaRead["trend"] = "range";
  if (highs.length >= 2 && lows.length >= 2) {
    const [h1, h2] = highs.slice(-2);
    const [l1, l2] = lows.slice(-2);
    if (h2.price > h1.price && l2.price > l1.price) trend = "bullish";
    else if (h2.price < h1.price && l2.price < l1.price) trend = "bearish";
  }

  // Breaks of structure: a CLOSE beyond a prior swing.
  let lastBos: ApaRead["lastBos"];
  for (const s of sw) {
    for (let j = s.i + 3; j < bars.length; j++) {
      const broke = s.kind === "high" ? bars[j].c > s.price : bars[j].c < s.price;
      if (broke) {
        if (!lastBos || j > lastBos.at) lastBos = { side: s.kind === "high" ? "bullish" : "bearish", level: s.price, at: j };
        break;
      }
    }
  }

  // Shift point = the level that invalidates the trend: in a bullish market the last higher low,
  // in a bearish market the last lower high. A close beyond it = shift; no new structure after = transition.
  let shift: ApaRead["shift"];
  let reclaim: ApaRead["reclaim"];
  let validation: number | undefined;
  let invalidation: number | undefined;
  const lastHigh = highs[highs.length - 1];
  const lastLow = lows[lows.length - 1];
  if (lastBos?.side === "bullish") {
    validation = lastBos.level;
    const hl = lows.filter((l) => l.i < lastBos!.at).pop();
    invalidation = hl?.price;
  } else if (lastBos?.side === "bearish") {
    validation = lastBos.level;
    const lh = highs.filter((h) => h.i < lastBos!.at).pop();
    invalidation = lh?.price;
  }
  if (invalidation !== undefined && lastBos) {
    const bullish = lastBos.side === "bullish";
    for (let j = lastBos.at + 1; j < bars.length; j++) {
      if (bullish ? bars[j].c < invalidation : bars[j].c > invalidation) {
        const after = sw.filter((s) => s.i > j);
        shift = { side: bullish ? "bearish" : "bullish", level: invalidation, at: j, transition: after.length < 2 };
        // Reclaim point: the previous extreme; a close back beyond it = old dominance returns.
        const extreme = bullish ? Math.max(...bars.slice(lastBos.at, j + 1).map((b) => b.h)) : Math.min(...bars.slice(lastBos.at, j + 1).map((b) => b.l));
        const reclaimed = bars.slice(j + 1).some((b) => (bullish ? b.c > extreme : b.c < extreme));
        reclaim = { level: extreme, reclaimed };
        break;
      }
    }
  }

  // Liquidity sweeps: a wick beyond a swing that closes back inside (the engineering).
  const sweeps: ApaRead["sweeps"] = [];
  for (const s of sw) {
    for (let j = s.i + 3; j < bars.length; j++) {
      const b = bars[j];
      if (s.kind === "high" && b.h > s.price) {
        if (b.c < s.price) sweeps.push({ side: "buy-side", level: s.price, at: j });
        break;
      }
      if (s.kind === "low" && b.l < s.price) {
        if (b.c > s.price) sweeps.push({ side: "sell-side", level: s.price, at: j });
        break;
      }
    }
  }
  sweeps.sort((a, b) => a.at - b.at);

  // Equal highs/lows (resting liquidity) within 10% of the average bar range.
  const avgRange = bars.slice(-50).reduce((a, b) => a + (b.h - b.l), 0) / Math.min(50, bars.length);
  const tol = avgRange * 0.1;
  const eq = (list: Swing[]) => {
    const last = list.slice(-4);
    for (let a = last.length - 1; a > 0; a--) for (let b = a - 1; b >= 0; b--) if (Math.abs(last[a].price - last[b].price) <= tol) return last[a].price;
    return undefined;
  };

  // Zones.
  const zones: Zone[] = [];
  for (let i = 1; i < bars.length; i++) {
    const p = bars[i - 1];
    const b = bars[i];
    // Type 1 engulfing AOL: two candles of the same colour; the latest sweeps past the previous one's
    // extreme with its wick and closes beyond the previous close, engulfing it including its wick.
    if (p.c < p.o && b.c < b.o && b.h > p.h && b.c < p.l) zones.push({ kind: "engulfing_aol", side: "bearish", low: b.c, high: b.h, at: i, consumed: consumed(bars, i, b.c, b.h, "bearish") });
    if (p.c > p.o && b.c > b.o && b.l < p.l && b.c > p.h) zones.push({ kind: "engulfing_aol", side: "bullish", low: b.l, high: b.c, at: i, consumed: consumed(bars, i, b.l, b.c, "bullish") });
    // Fair value gap: candle i-1 .. i+1 leave a gap.
    if (i + 1 < bars.length) {
      const n = bars[i + 1];
      if (n.l - p.h >= avgRange * 0.3) zones.push({ kind: "fvg", side: "bullish", low: p.h, high: n.l, at: i, consumed: consumed(bars, i + 1, p.h, n.l, "bullish") });
      if (p.l - n.h >= avgRange * 0.3) zones.push({ kind: "fvg", side: "bearish", low: n.h, high: p.l, at: i, consumed: consumed(bars, i + 1, n.h, p.l, "bearish") });
    }
  }
  // Order block: the last opposite candle before the last break of structure.
  if (lastBos) {
    for (let j = lastBos.at - 1; j >= Math.max(0, lastBos.at - 15); j--) {
      const b = bars[j];
      if (lastBos.side === "bullish" && b.c < b.o) {
        zones.push({ kind: "ob", side: "bullish", low: b.l, high: b.h, at: j, consumed: consumed(bars, lastBos.at, b.l, b.h, "bullish") });
        break;
      }
      if (lastBos.side === "bearish" && b.c > b.o) {
        zones.push({ kind: "ob", side: "bearish", low: b.l, high: b.h, at: j, consumed: consumed(bars, lastBos.at, b.l, b.h, "bearish") });
        break;
      }
    }
  }
  void lastHigh;
  void lastLow;

  // Liquidity engineering: the latest sweep (thrust candle through the level, close back inside),
  // its FMD (the extreme reached from the sweep onward), and a CHoCH = a close beyond the last swing
  // on the other side, after the sweep.
  let engineering: ApaRead["engineering"];
  const lastSweep = sweeps[sweeps.length - 1];
  if (lastSweep) {
    const bullish = lastSweep.side === "sell-side";
    const after = bars.slice(lastSweep.at);
    const fmd = bullish ? Math.min(...after.map((b) => b.l)) : Math.max(...after.map((b) => b.h));
    const opp = sw.filter((x) => x.i < lastSweep.at && x.kind === (bullish ? "high" : "low")).pop();
    const choch = !!opp && bars.slice(lastSweep.at + 1).some((b) => (bullish ? b.c > opp.price : b.c < opp.price));
    engineering = { side: bullish ? "bullish" : "bearish", level: lastSweep.level, fmd, choch, at: lastSweep.at };
  }

  // Flip zones: swing levels touched 2+ times (within tolerance) and later CLOSED through.
  const flips: ApaRead["flips"] = [];
  const levelTol = avgRange * 0.3;
  for (const kind of ["high", "low"] as const) {
    const list = sw.filter((x) => x.kind === kind);
    const used = new Set<number>();
    for (let a = 0; a < list.length; a++) {
      if (used.has(a)) continue;
      const group = list.filter((x, b) => b >= a && Math.abs(x.price - list[a].price) <= levelTol);
      if (group.length < 2) continue;
      list.forEach((x, b) => group.includes(x) && used.add(b));
      const level = group.reduce((t, x) => t + x.price, 0) / group.length;
      const lastTouch = Math.max(...group.map((x) => x.i));
      const broke = bars.slice(lastTouch + 1).some((b) => (kind === "high" ? b.c > level + levelTol : b.c < level - levelTol));
      if (broke) flips.push({ side: kind === "high" ? "bullish" : "bearish", level, touches: group.length });
    }
  }

  return { trend, lastBos, shift, reclaim, validation, invalidation, sweeps: sweeps.slice(-3), equalHighs: eq(highs), equalLows: eq(lows), zones, engineering, flips: flips.slice(-2), lastClose };
}

const fmt = (n: number) => +n.toPrecision(8);
const ago = (bars: number, at: number) => `${bars - 1 - at} bars ago`;

/** One block of text for a timeframe -- the fresh (unconsumed) zones nearest price first. */
export function describeApa(tf: string, bars: Bar[]): string | undefined {
  const r = readApa(bars);
  if (!r) return undefined;
  const n = bars.length;
  const parts: string[] = [`${tf}: trend ${r.trend.toUpperCase()}`];
  if (r.lastBos) parts.push(`last BOS ${r.lastBos.side} through ${fmt(r.lastBos.level)} (${ago(n, r.lastBos.at)})`);
  if (r.validation !== undefined) parts.push(`VALIDATION ${fmt(r.validation)}`);
  if (r.invalidation !== undefined) parts.push(`INVALIDATION ${fmt(r.invalidation)} (a close beyond it = shift)`);
  if (r.shift) parts.push(`${r.shift.transition ? "TRANSITION" : "SHIFT"} to ${r.shift.side} -- closed through ${fmt(r.shift.level)} ${ago(n, r.shift.at)}${r.shift.transition ? " with no new structure yet (not confirmed)" : ""}`);
  if (r.reclaim) parts.push(`reclaim point ${fmt(r.reclaim.level)}${r.reclaim.reclaimed ? " -- RECLAIMED (old dominance back)" : ""}`);
  if (r.sweeps.length) parts.push(`sweeps: ${r.sweeps.map((s) => `${s.side} liquidity at ${fmt(s.level)} swept ${ago(n, s.at)}`).join("; ")}`);
  if (r.equalHighs !== undefined) parts.push(`equal highs ${fmt(r.equalHighs)} (buy-side liquidity resting)`);
  if (r.equalLows !== undefined) parts.push(`equal lows ${fmt(r.equalLows)} (sell-side liquidity resting)`);
  const fresh = r.zones
    .filter((z) => !z.consumed)
    .sort((a, b) => Math.abs((a.low + a.high) / 2 - r.lastClose) - Math.abs((b.low + b.high) / 2 - r.lastClose))
    .slice(0, 4);
  if (fresh.length) parts.push(`FRESH zones: ${fresh.map((z) => `${z.side} ${z.kind === "engulfing_aol" ? "Type-1 engulfing AOL" : z.kind.toUpperCase()} ${fmt(z.low)}-${fmt(z.high)}`).join("; ")}`);
  if (r.engineering) parts.push(`LIQUIDITY ENGINEERING ${r.engineering.side}: ${fmt(r.engineering.level)} swept by a thrust candle ${ago(n, r.engineering.at)}, FMD ${fmt(r.engineering.fmd)} (stop goes beyond it), CHoCH ${r.engineering.choch ? "CONFIRMED" : "not yet"}`);
  if (r.flips.length) parts.push(`flip zones: ${r.flips.map((f) => `${fmt(f.level)} (${f.touches} touches, broken -> now ${f.side === "bullish" ? "support" : "resistance"})`).join("; ")}`);
  const used = r.zones.filter((z) => z.consumed).length;
  if (used) parts.push(`${used} older zone(s) already consumed (50%+ traded) -- not points of interest`);
  return parts.join(" | ");
}

/** Across timeframes (highest first): do at least two agree (the book's coordination rule), and the
 *  FTAs -- a higher timeframe's fresh zone of the OPPOSITE side standing between price and the move. */
export function describeApaCoordination(byTf: { tf: string; bars: Bar[] }[]): string | undefined {
  const reads = byTf.map((x) => ({ tf: x.tf, r: readApa(x.bars) })).filter((x): x is { tf: string; r: ApaRead } => !!x.r);
  if (reads.length < 2) return undefined;
  const bull = reads.filter((x) => x.r.trend === "bullish").map((x) => x.tf);
  const bear = reads.filter((x) => x.r.trend === "bearish").map((x) => x.tf);
  const bias = bull.length >= 2 && bull.length > bear.length ? "BULLISH" : bear.length >= 2 && bear.length > bull.length ? "BEARISH" : "NOT COORDINATED";
  const parts = [`COORDINATION: ${bias}${bull.length ? ` (bullish: ${bull.join(", ")})` : ""}${bear.length ? ` (bearish: ${bear.join(", ")})` : ""}${bias === "NOT COORDINATED" ? " -- fewer than two timeframes agree: no trade from this alone" : ""}`];
  if (bias !== "NOT COORDINATED") {
    const price = reads[reads.length - 1].r.lastClose;
    const against = bias === "BULLISH" ? "bearish" : "bullish";
    const ftas = reads
      .slice(0, -1)
      .flatMap((x) => x.r.zones.filter((z) => !z.consumed && z.side === against && (bias === "BULLISH" ? z.low > price : z.high < price)).map((z) => ({ tf: x.tf, z })))
      .sort((a, b) => Math.abs((a.z.low + a.z.high) / 2 - price) - Math.abs((b.z.low + b.z.high) / 2 - price))
      .slice(0, 2);
    if (ftas.length) parts.push(`FTA (first trouble area -- take or lock profit there): ${ftas.map((f) => `${f.tf} ${f.z.side} ${f.z.kind === "engulfing_aol" ? "AOL" : f.z.kind.toUpperCase()} ${fmt(f.z.low)}-${fmt(f.z.high)}`).join("; ")}`);
  }
  return parts.join(" | ");
}
