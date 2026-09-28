import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "dave-app-files-"));
process.env.DAVE_DATA_ROOT = root;
process.env.DAVE_CREDENTIALS_KEY ??= "test-only-master-key-not-for-production";

/** The trader: "input and output of files in the app, so the bot can send files to the app". */
const bus = await import("../src/activity-bus.js");
const { createAppSink } = await import("../src/app-chat.js");
const { createAppChatHandler } = await import("../src/app-chat-routes.js");
const { safeFileName } = await import("../src/app-files.js");
const { userUploadDir } = await import("@dave/e2b");
const { DaveDatabase, hashDeviceToken } = await import("@dave/db");

console.log("=== Step 179: files in and out of the app chat ===\n");
const userId = "owner";

console.log("[1] Names can't walk out of the folder");
assert.equal(safeFileName("../../etc/passwd"), "passwd");
assert.equal(safeFileName("my report (final).csv"), "my_report_final_.csv");
console.log("   ✓\n");

console.log("[2] OUT: send_file_to_user in the app -> a file card + a download");
const sink = createAppSink(userId, () => ({ turnId: "t1", channel: "app" }));
const before = bus.latestActivityId(userId);
await sink.sendDocument({ chat_id: 0, document: { buffer: Buffer.from("symbol,pnl\nXAUUSD,12.5\n"), filename: "results.csv" }, caption: "Backtest results" });
const card = bus.activityAfter(userId, before).find((e) => e.kind === "file")!;
assert.equal(card.data.name, "results.csv");
assert.equal(card.data.caption, "Backtest results");
assert.equal(card.data.mime, "text/csv");
await assert.rejects(() => sink.sendDocument({ chat_id: 0, document: "AgADBAAD" }), /content itself/);

const token = "phone-token-xyz";
const statePath = join(root, "data", "device-auth", userId, "state.json");
mkdirSync(dirname(statePath), { recursive: true });
writeFileSync(statePath, JSON.stringify({ devices: [{ id: "d1", tokenHash: hashDeviceToken(token), label: "phone", pairedAt: 1 }] }));
const db = new DaveDatabase(join(root, "dave.db"));
const turns: { text: string; images: number; display?: unknown }[] = [];
const handler = createAppChatHandler({ userId, db, executor: {} as never, systemPrompt: "x", runTurn: async (_d, input) => (turns.push({ text: input.text, images: input.images?.length ?? 0, display: input.display }), undefined) });
const server = createServer(handler);
await new Promise<void>((r) => server.listen(0, r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/app/chat`;
const H = { authorization: `Bearer ${token}`, "content-type": "application/json" };
assert.equal((await fetch(`${base}/file/${card.data.id}`)).status, 401, "needs the phone's token");
const dl = await fetch(`${base}/file/${card.data.id}`, { headers: H });
assert.equal(dl.status, 200);
assert.equal(await dl.text(), "symbol,pnl\nXAUUSD,12.5\n");
assert.match(dl.headers.get("content-disposition") ?? "", /results\.csv/);
assert.equal((await fetch(`${base}/file/../../dave.db`, { headers: H })).status, 404);
console.log("   ✓\n");

console.log("[3] IN: a document and a picture attached in the app");
const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
const r = await fetch(`${base}/send`, { method: "POST", headers: H, body: JSON.stringify({ text: "look at these", files: [{ name: "trades.csv", data: Buffer.from("a,b\n1,2\n").toString("base64") }, { name: "chart.png", data: png.toString("base64") }] }) });
assert.equal(r.status, 202, await r.clone().text());
await new Promise((res) => setTimeout(res, 30));
const t = turns[0];
assert.match(t.text, /look at these/);
assert.match(t.text, /attachUserFiles: \["trades\.csv"\]/, "Dave is told how to open it");
assert.equal(t.images, 1, "the picture reaches him as a picture");
assert.deepEqual(t.display, { text: "look at these", files: ["trades.csv", "chart.png"] }, "the bubble shows names, not instructions");
assert.equal(readFileSync(join(userUploadDir(userId), "trades.csv"), "utf8"), "a,b\n1,2\n", "in the inbox run_script reads");
// Same name again: kept apart, never overwritten.
await fetch(`${base}/send`, { method: "POST", headers: H, body: JSON.stringify({ files: [{ name: "trades.csv", data: Buffer.from("new").toString("base64") }] }) });
await new Promise((res) => setTimeout(res, 30));
assert.equal(readFileSync(join(userUploadDir(userId), "trades.csv"), "utf8"), "a,b\n1,2\n");
assert.ok(existsSync(userUploadDir(userId)));
server.close();
console.log("   ✓\n");
console.log("All Step 179 checks passed.");
process.exit(0);
