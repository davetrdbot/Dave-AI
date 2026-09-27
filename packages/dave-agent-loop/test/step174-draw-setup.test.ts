import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workDir = mkdtempSync(join(tmpdir(), "dave-draw-"));
process.env.DAVE_DATA_ROOT = workDir;

/**
 * The trader: "give the AI a canvas so it can draw and illustrate a setup -- candles, small
 * candles, write and draw -- so I can tell it: draw what you meant".
 */
const { DaveDatabase } = await import("@dave/db");
const { EaTradeExecutor } = await import("@dave/ea-bridge");
const { buildFullToolRegistry } = await import("../src/full-registry.js");
const { createAppSink } = await import("../src/app-chat.js");
const { activityAfter } = await import("../src/activity-bus.js");
const { parseDrawing, drawingToSvg, renderDrawingPng } = await import("../src/setup-drawing.js");
const { CORE_TOOL_NAMES } = await import("../src/tool-selection.js");

console.log("=== Step 174: Dave's drawing board ===\n");
const args = {
  title: "Sweep then short",
  symbol: "XAUUSD",
  candles: [
    { o: 1, h: 3, l: 0.5, c: 2 },
    { o: 2, h: 4, l: 1.5, c: 3.5 },
    { open: 3.5, high: 5, low: 3, close: 4.8 },
    { o: 4.8, h: 5.2, l: 2, c: 2.2, projected: true },
  ],
  lines: [{ price: 4.9, kind: "entry", label: "SELL" }, { price: 5.5, kind: "sl" }, { price: 1, kind: "tp" }, { price: "oops", kind: "tp" }],
  zones: [{ from: 5.2, to: 4.6, kind: "supply", label: "<b>high</b>" }],
  arrows: [{ fromIndex: 2, fromPrice: 5, toIndex: 4, toPrice: 1.2, label: "down" }],
  notes: [{ index: 2, price: 5, text: "sweep" }],
};

console.log("[1] Whatever the model sends becomes a clean drawing");
const d = parseDrawing(args);
assert.equal(d.candles.length, 4, "open/high/low/close spelled out also works");
assert.equal(d.lines.length, 3, "a line without a real price is dropped");
assert.deepEqual([d.zones[0].from, d.zones[0].to], [4.6, 5.2], "zone edges put in order");
assert.equal(d.candles[3].projected, true);
assert.throws(() => parseDrawing({ title: "x", candles: [{ o: 1, h: 2, l: 0, c: 1 }] }), /at least 2 candles/);
const fixed = parseDrawing({ candles: [{ o: 5, h: 1, l: 9, c: 6 }, { o: 1, h: 2, l: 0, c: 1 }] });
assert.ok(fixed.candles[0].h >= 6 && fixed.candles[0].l <= 5, "a high below the body is widened, never drawn broken");
console.log("   ✓\n");

console.log("[2] SVG escapes text; the PNG is a real PNG");
const svg = drawingToSvg(d);
assert.ok(svg.includes("&lt;b&gt;high&lt;/b&gt;") && !svg.includes("<b>high"), "labels can't break the picture");
const png = await renderDrawingPng(d);
assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
assert.ok(png.length > 5000);
console.log(`   ✓ (${png.length} bytes)\n`);

console.log("[3] In Telegram: a photo with the title as caption");
const db = new DaveDatabase(join(workDir, "dave.db"));
const photos: { chat_id: unknown; caption?: string; bytes: number }[] = [];
const fakeTelegram = new Proxy({} as never, {
  get: (_t, prop) => (prop === "then" ? undefined : async (p: { chat_id: unknown; caption?: string; photo?: { buffer: Buffer } }) => {
    if (prop === "sendPhoto") photos.push({ chat_id: p.chat_id, caption: p.caption, bytes: p.photo!.buffer.length });
    return { message_id: 1 };
  }),
});
const tg = buildFullToolRegistry({ userId: "trader", db, executor: new EaTradeExecutor("trader"), telegram: { client: fakeTelegram, chatId: 42 } });
const r = (await tg.execute("draw_setup", args)) as { drawn: boolean };
assert.equal(r.drawn, true);
assert.equal(photos.length, 1);
assert.equal(photos[0].chat_id, 42);
assert.match(photos[0].caption ?? "", /Sweep then short/);
console.log("   ✓\n");

console.log("[4] In the app: the drawing itself, as a chat event the app draws natively");
const sink = createAppSink("trader", () => ({ turnId: "t1", channel: "app" }));
const app = buildFullToolRegistry({ userId: "trader", db, executor: new EaTradeExecutor("trader"), telegram: { client: sink, chatId: 0 } });
await app.execute("draw_setup", args);
const ev = activityAfter("trader", 0, ["chat"]).find((e) => e.kind === "drawing");
assert.ok(ev, "a drawing event");
assert.equal((ev!.data.drawing as { title: string }).title, "Sweep then short");
assert.equal(ev!.turnId, "t1");
console.log("   ✓\n");

console.log("[5] Always in reach (core tool)");
assert.ok(CORE_TOOL_NAMES.includes("draw_setup"));
console.log("   ✓\n");
console.log("All Step 174 checks passed.");
process.exit(0);
