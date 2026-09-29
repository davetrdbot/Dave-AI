import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Dave's drawing board (the trader: "give the AI like a canvas so it can draw and illustrate a
 * setup -- put candles, small candles, write and draw... so I can tell it: draw what you meant").
 *
 * Dave describes the picture as data -- a handful of candles (real or illustrative, and "projected"
 * ones for what he expects next), the entry/SL/TP lines, zones, arrows and short notes -- and it is
 * drawn the same way everywhere: an SVG turned into a PNG for Telegram, and natively in the app.
 */

export type LineKind = "entry" | "sl" | "tp" | "level";
export type ZoneKind = "demand" | "supply" | "fvg" | "ob" | "range";

export interface DrawCandle {
  o: number;
  h: number;
  l: number;
  c: number;
  /** What Dave expects next, drawn hollow and dashed. */
  projected?: boolean;
}

export interface SetupDrawing {
  title: string;
  symbol?: string;
  timeframe?: string;
  candles: DrawCandle[];
  lines: { price: number; label?: string; kind: LineKind }[];
  zones: { from: number; to: number; label?: string; kind: ZoneKind; fromIndex?: number; toIndex?: number }[];
  arrows: { fromIndex: number; fromPrice: number; toIndex: number; toPrice: number; label?: string }[];
  notes: { index: number; price: number; text: string }[];
  caption?: string;
}

const MAX_CANDLES = 80;
const n = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && Number.isFinite(Number(v)) ? Number(v) : undefined);
const s = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : []);

/** Turns whatever the model sent into a clean drawing, or explains what's missing. */
export function parseDrawing(args: Record<string, unknown>): SetupDrawing {
  const candles: DrawCandle[] = [];
  for (const c of arr(args.candles).slice(0, MAX_CANDLES)) {
    const o = n(c.o ?? c.open);
    const cl = n(c.c ?? c.close);
    if (o === undefined || cl === undefined) continue;
    const h = Math.max(n(c.h ?? c.high) ?? Math.max(o, cl), o, cl);
    const l = Math.min(n(c.l ?? c.low) ?? Math.min(o, cl), o, cl);
    candles.push({ o, h, l, c: cl, ...(c.projected === true ? { projected: true } : {}) });
  }
  if (candles.length < 2) throw new Error("draw_setup needs at least 2 candles, each {o, h, l, c} (add projected: true for the ones you expect next).");
  const kinds: LineKind[] = ["entry", "sl", "tp", "level"];
  const zoneKinds: ZoneKind[] = ["demand", "supply", "fvg", "ob", "range"];
  return {
    title: s(args.title, 80) ?? "Setup",
    symbol: s(args.symbol, 24),
    timeframe: s(args.timeframe, 8),
    candles,
    lines: arr(args.lines)
      .map((x) => ({ price: n(x.price)!, label: s(x.label, 40), kind: (kinds.includes(x.kind as LineKind) ? x.kind : "level") as LineKind }))
      .filter((x) => x.price !== undefined)
      .slice(0, 12),
    zones: arr(args.zones)
      .map((x) => {
        const a = n(x.from);
        const b = n(x.to);
        return a === undefined || b === undefined
          ? undefined
          : { from: Math.min(a, b), to: Math.max(a, b), label: s(x.label, 40), kind: (zoneKinds.includes(x.kind as ZoneKind) ? x.kind : "range") as ZoneKind, fromIndex: n(x.fromIndex), toIndex: n(x.toIndex) };
      })
      .filter((x): x is NonNullable<typeof x> => !!x)
      .slice(0, 8),
    arrows: arr(args.arrows)
      .map((x) => ({ fromIndex: n(x.fromIndex)!, fromPrice: n(x.fromPrice)!, toIndex: n(x.toIndex)!, toPrice: n(x.toPrice)!, label: s(x.label, 40) }))
      .filter((x) => [x.fromIndex, x.fromPrice, x.toIndex, x.toPrice].every((v) => v !== undefined))
      .slice(0, 8),
    notes: arr(args.notes)
      .map((x) => ({ index: n(x.index)!, price: n(x.price)!, text: s(x.text, 60)! }))
      .filter((x) => x.index !== undefined && x.price !== undefined && !!x.text)
      .slice(0, 10),
    caption: s(args.caption, 240),
  };
}

/**
 * The picture of a trade Dave just placed (the trader: "the drawing feature, I haven't seen it yet
 * in the app"): the last real candles, the entry/SL/TP lines, and an arrow from price to target.
 * Built from the order itself -- no model call.
 */
export function tradeDrawing(t: {
  symbol: string;
  side: "buy" | "sell";
  orderType?: string;
  entry: number;
  sl?: number;
  tp?: number;
  candles: { o: number; h: number; l: number; c: number }[];
  timeframe?: string;
  reason?: string;
  lots?: number;
}): SetupDrawing | null {
  const candles = t.candles.slice(-30).map((c) => ({ o: c.o, h: c.h, l: c.l, c: c.c }));
  if (candles.length < 2 || !(t.entry > 0)) return null;
  const kind = (t.orderType ?? t.side).replace(/_/g, " ").toUpperCase();
  const lines: SetupDrawing["lines"] = [{ price: t.entry, label: `Entry ${t.entry}`, kind: "entry" }];
  if (t.sl && t.sl > 0) lines.push({ price: t.sl, label: `SL ${t.sl}`, kind: "sl" });
  if (t.tp && t.tp > 0) lines.push({ price: t.tp, label: `TP ${t.tp}`, kind: "tp" });
  const last = candles.length - 1;
  const arrows: SetupDrawing["arrows"] =
    t.tp && t.tp > 0 ? [{ fromIndex: last, fromPrice: t.entry, toIndex: last, toPrice: t.tp, label: "target" }] : [];
  const rr = t.sl && t.tp && t.sl !== t.entry ? Math.abs(t.tp - t.entry) / Math.abs(t.entry - t.sl) : null;
  const reason = t.reason?.replace(/\s+/g, " ").trim();
  return {
    title: `${t.symbol} ${kind}${t.lots ? ` ${t.lots} lots` : ""}`,
    symbol: t.symbol,
    timeframe: t.timeframe,
    candles,
    lines,
    zones: [],
    arrows,
    notes: [],
    caption: [rr ? `Risk:reward 1:${rr.toFixed(1)}` : null, reason ? (reason.length > 200 ? `${reason.slice(0, 197)}...` : reason) : null].filter(Boolean).join(" -- ") || undefined,
  };
}

// --- SVG --------------------------------------------------------------------------------------

const W = 1000;
const H = 620;
const PAD = { l: 24, r: 118, t: 70, b: 56 };
const C = {
  bg: "#0B0D0E",
  grid: "#1C2023",
  text: "#F2F4EF",
  muted: "#8E959A",
  up: "#8BF06B",
  down: "#FF6B6B",
  entry: "#C6F36B",
  sl: "#FF6B6B",
  tp: "#5BD6A0",
  level: "#9AA3A8",
  demand: "#5BD6A0",
  supply: "#FF6B6B",
  fvg: "#B28CFF",
  ob: "#5AA9FF",
  range: "#9AA3A8",
};

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function fmtPrice(p: number, span: number): string {
  const decimals = span >= 100 ? 0 : span >= 1 ? 2 : span >= 0.01 ? 4 : 5;
  return p.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function drawingToSvg(d: SetupDrawing): string {
  const idxMax = Math.max(d.candles.length - 1, ...d.arrows.flatMap((a) => [a.fromIndex, a.toIndex]), ...d.notes.map((x) => x.index), ...d.zones.map((z) => z.toIndex ?? 0));
  const slots = Math.max(idxMax + 2, d.candles.length + 1);
  const prices = [
    ...d.candles.flatMap((c) => [c.h, c.l]),
    ...d.lines.map((x) => x.price),
    ...d.zones.flatMap((z) => [z.from, z.to]),
    ...d.arrows.flatMap((a) => [a.fromPrice, a.toPrice]),
    ...d.notes.map((x) => x.price),
  ];
  let lo = Math.min(...prices);
  let hi = Math.max(...prices);
  if (hi === lo) {
    hi += Math.abs(hi) * 0.01 || 1;
    lo -= Math.abs(lo) * 0.01 || 1;
  }
  const span = hi - lo;
  hi += span * 0.08;
  lo -= span * 0.08;
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;
  const slotW = plotW / slots;
  const x = (i: number) => PAD.l + slotW * (i + 0.5);
  const y = (p: number) => PAD.t + ((hi - p) / (hi - lo)) * plotH;
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="DejaVu Sans">`);
  out.push(`<defs><marker id="ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${C.text}"/></marker></defs>`);
  out.push(`<rect width="${W}" height="${H}" rx="22" fill="${C.bg}"/>`);
  // title
  const sub = [d.symbol, d.timeframe].filter(Boolean).join(" · ");
  out.push(`<text x="${PAD.l + 4}" y="40" font-size="24" font-weight="bold" fill="${C.text}">${esc(d.title)}</text>`);
  if (sub) out.push(`<text x="${W - 24}" y="40" font-size="16" text-anchor="end" fill="${C.muted}">${esc(sub)}</text>`);
  // grid + price axis
  for (let k = 0; k <= 5; k++) {
    const p = lo + ((hi - lo) * k) / 5;
    out.push(`<line x1="${PAD.l}" x2="${W - PAD.r + 8}" y1="${y(p).toFixed(1)}" y2="${y(p).toFixed(1)}" stroke="${C.grid}" stroke-width="1"/>`);
    out.push(`<text x="${W - PAD.r + 14}" y="${(y(p) + 5).toFixed(1)}" font-size="13" fill="${C.muted}">${fmtPrice(p, span)}</text>`);
  }
  // zones
  for (const z of d.zones) {
    const col = C[z.kind];
    const x0 = z.fromIndex !== undefined ? x(z.fromIndex) - slotW / 2 : PAD.l;
    const x1 = z.toIndex !== undefined ? x(z.toIndex) + slotW / 2 : W - PAD.r;
    const y0 = y(z.to);
    const h = Math.max(y(z.from) - y0, 3);
    out.push(`<rect x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" width="${(x1 - x0).toFixed(1)}" height="${h.toFixed(1)}" fill="${col}" fill-opacity="0.14" stroke="${col}" stroke-opacity="0.5" stroke-width="1"/>`);
    if (z.label) out.push(`<text x="${(x0 + 8).toFixed(1)}" y="${(y0 + 17).toFixed(1)}" font-size="13" font-weight="bold" fill="${col}">${esc(z.label)}</text>`);
  }
  // candles
  const bodyW = Math.max(Math.min(slotW * 0.62, 26), 3);
  d.candles.forEach((c, i) => {
    const up = c.c >= c.o;
    const col = up ? C.up : C.down;
    const cx = x(i);
    const top = y(Math.max(c.o, c.c));
    const bh = Math.max(Math.abs(y(c.o) - y(c.c)), 2);
    const dash = c.projected ? ` stroke-dasharray="4 3"` : "";
    out.push(`<line x1="${cx.toFixed(1)}" x2="${cx.toFixed(1)}" y1="${y(c.h).toFixed(1)}" y2="${y(c.l).toFixed(1)}" stroke="${col}" stroke-width="2"${dash} stroke-opacity="${c.projected ? 0.7 : 1}"/>`);
    out.push(
      `<rect x="${(cx - bodyW / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="${c.projected ? C.bg : col}" stroke="${col}" stroke-width="2"${dash}/>`,
    );
  });
  // lines
  for (const ln of d.lines) {
    const col = C[ln.kind];
    const yy = y(ln.price).toFixed(1);
    out.push(`<line x1="${PAD.l}" x2="${W - PAD.r + 8}" y1="${yy}" y2="${yy}" stroke="${col}" stroke-width="2" stroke-dasharray="${ln.kind === "level" ? "3 5" : "8 5"}"/>`);
    const tag = `${ln.label ?? ln.kind.toUpperCase()} ${fmtPrice(ln.price, span)}`;
    const tw = Math.min(tag.length * 7.6 + 16, PAD.r + 60);
    out.push(`<rect x="${(W - PAD.r - tw + 104).toFixed(1)}" y="${(Number(yy) - 12).toFixed(1)}" width="${tw.toFixed(1)}" height="24" rx="6" fill="${col}"/>`);
    out.push(`<text x="${(W - PAD.r - tw + 112).toFixed(1)}" y="${(Number(yy) + 5).toFixed(1)}" font-size="13" font-weight="bold" fill="${C.bg}">${esc(tag)}</text>`);
  }
  // arrows
  for (const a of d.arrows) {
    const x0 = x(a.fromIndex);
    const y0 = y(a.fromPrice);
    const x1 = x(a.toIndex);
    const y1 = y(a.toPrice);
    const mx = (x0 + x1) / 2;
    const my = Math.min(y0, y1) - Math.abs(x1 - x0) * 0.12;
    out.push(`<path d="M${x0.toFixed(1)},${y0.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}" fill="none" stroke="${C.text}" stroke-width="2.5" marker-end="url(#ah)"/>`);
    if (a.label) out.push(`<text x="${mx.toFixed(1)}" y="${(my - 8).toFixed(1)}" font-size="14" text-anchor="middle" fill="${C.text}">${esc(a.label)}</text>`);
  }
  // notes
  for (const nt of d.notes) {
    const nx = x(nt.index);
    const ny = y(nt.price);
    const tw = nt.text.length * 7.4 + 16;
    const left = Math.min(Math.max(nx - tw / 2, PAD.l), W - PAD.r - tw);
    out.push(`<circle cx="${nx.toFixed(1)}" cy="${ny.toFixed(1)}" r="4" fill="${C.text}"/>`);
    out.push(`<rect x="${left.toFixed(1)}" y="${(ny - 36).toFixed(1)}" width="${tw.toFixed(1)}" height="24" rx="12" fill="#1E2326" stroke="#3A4146"/>`);
    out.push(`<text x="${(left + 8).toFixed(1)}" y="${(ny - 19).toFixed(1)}" font-size="13" fill="${C.text}">${esc(nt.text)}</text>`);
  }
  if (d.caption) out.push(`<text x="${PAD.l + 4}" y="${H - 22}" font-size="15" fill="${C.muted}">${esc(d.caption.length > 110 ? `${d.caption.slice(0, 108)}…` : d.caption)}</text>`);
  out.push(`<text x="${W - 24}" y="${H - 22}" font-size="12" text-anchor="end" fill="#4A5156">Dave</text>`);
  out.push("</svg>");
  return out.join("");
}

// --- PNG --------------------------------------------------------------------------------------

const fontFiles = ["DejaVuSans.ttf", "DejaVuSans-Bold.ttf"].map((f) => fileURLToPath(new URL(`../assets/fonts/${f}`, import.meta.url)));

/** The drawing as a PNG, for Telegram. */
export async function renderDrawingPng(d: SetupDrawing): Promise<Buffer> {
  const { Resvg } = await import("@resvg/resvg-js");
  const fonts = fontFiles.filter((f) => existsSync(f));
  const r = new Resvg(drawingToSvg(d), { font: { fontFiles: fonts, loadSystemFonts: fonts.length === 0, defaultFontFamily: "DejaVu Sans" }, fitTo: { mode: "width", value: 1200 } });
  return Buffer.from(r.render().asPng());
}

export const DRAW_SETUP_TOOL_DESCRIPTION =
  "Draw a picture of a setup and send it to the trader -- small candles, entry/SL/TP lines, zones, arrows and short notes -- like sketching on a chart. " +
  "Use it whenever the trader asks you to draw, show or illustrate something (\"draw what you mean\", \"show me the setup\"), and whenever a picture explains a setup better than words: " +
  "the sweep-then-reversal you're waiting for, where a limit sits, what a Setup's steps look like. Candles can be the real recent ones (from get_candles) or illustrative -- " +
  "keep them few (8-30) and mark the ones you EXPECT with projected: true. Use real prices for lines and zones. Put an arrow for the move you expect and a note or two, not a paragraph. " +
  "The picture is the message: after it, answer in one short line.";

export const DRAW_SETUP_PARAMETERS = {
  type: "object",
  required: ["title", "candles"],
  properties: {
    title: { type: "string", description: "e.g. 'Sweep of the Asian high, then short'" },
    symbol: { type: "string" },
    timeframe: { type: "string" },
    candles: {
      type: "array",
      description: "Oldest first. 8-30 candles is plenty.",
      items: { type: "object", required: ["o", "h", "l", "c"], properties: { o: { type: "number" }, h: { type: "number" }, l: { type: "number" }, c: { type: "number" }, projected: { type: "boolean" } } },
    },
    lines: { type: "array", items: { type: "object", required: ["price", "kind"], properties: { price: { type: "number" }, kind: { type: "string", enum: ["entry", "sl", "tp", "level"] }, label: { type: "string" } } } },
    zones: {
      type: "array",
      items: {
        type: "object",
        required: ["from", "to", "kind"],
        properties: { from: { type: "number" }, to: { type: "number" }, kind: { type: "string", enum: ["demand", "supply", "fvg", "ob", "range"] }, label: { type: "string" }, fromIndex: { type: "number" }, toIndex: { type: "number" } },
      },
    },
    arrows: {
      type: "array",
      items: { type: "object", required: ["fromIndex", "fromPrice", "toIndex", "toPrice"], properties: { fromIndex: { type: "number" }, fromPrice: { type: "number" }, toIndex: { type: "number" }, toPrice: { type: "number" }, label: { type: "string" } } },
    },
    notes: { type: "array", items: { type: "object", required: ["index", "price", "text"], properties: { index: { type: "number" }, price: { type: "number" }, text: { type: "string" } } } },
    caption: { type: "string", description: "One line under the picture." },
  },
};
