import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "dave-mt5-screen-"));
process.env.DAVE_DATA_ROOT = root;

/** The MT5 screen relay: only a paired phone gets in, files and the live WebSocket both pass. */
const { createMt5ScreenProxy, MT5_SCREEN_PREFIX } = await import("../src/mt5-screen.js");
const { hashDeviceToken } = await import("@dave/db");
console.log("=== Step 170: MT5 screen relay ===\n");

const userId = "owner";
mkdirSync(join(root, "data", "device-auth", userId), { recursive: true });
writeFileSync(join(root, "data", "device-auth", userId, "state.json"), JSON.stringify({ devices: [{ id: "d1", tokenHash: hashDeviceToken("tok"), label: "p", pairedAt: 1 }] }));

// A fake noVNC: a page, and a WebSocket-ish echo after the upgrade.
const seen: string[] = [];
const fake = createServer((req, res) => {
  seen.push(`${req.url} cookie=${req.headers.cookie ?? "-"}`);
  res.end("<html>noVNC</html>");
});
fake.on("upgrade", (req, socket) => {
  seen.push(`upgrade ${req.url}`);
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
  socket.on("data", (d) => socket.write(d));
});
await new Promise<void>((r) => fake.listen(0, r));
const proxy = createMt5ScreenProxy(userId, Buffer.from("k"), { host: "127.0.0.1", port: (fake.address() as { port: number }).port });
const bot = createServer((req, res) => proxy.handle(req, res));
bot.on("upgrade", (req, socket, head) => proxy.upgrade(req, socket, head));
await new Promise<void>((r) => bot.listen(0, r));
const port = (bot.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}${MT5_SCREEN_PREFIX}`;

console.log("[1] No token, bad token: refused; nothing reaches the container");
assert.equal((await fetch(`${base}vnc.html`)).status, 401);
assert.equal((await fetch(`${base}vnc.html?token=nope`, { redirect: "manual" })).status, 401);
assert.deepEqual(seen, []);
console.log("   ✓\n");

console.log("[2] The paired token becomes a cookie; the token itself is dropped from the URL");
const r = await fetch(`${base}vnc.html?autoconnect=1&token=tok`, { redirect: "manual" });
assert.equal(r.status, 302);
assert.equal(r.headers.get("location"), "/mt5-screen/vnc.html?autoconnect=1");
const cookie = r.headers.get("set-cookie")!.split(";")[0];
const page = await fetch(`${base}vnc.html?autoconnect=1`, { headers: { cookie } });
assert.equal(await page.text(), "<html>noVNC</html>");
assert.equal(seen.at(-1), "/vnc.html?autoconnect=1 cookie=-", "prefix stripped, cookie not forwarded");
assert.equal((await fetch(`${base}vnc.html`, { headers: { cookie: cookie.replace(/.$/, "x") } })).status, 401, "a tampered cookie fails");
console.log("   ✓\n");

console.log("[3] The live connection (WebSocket upgrade) passes both ways");
const sock = connect(port, "127.0.0.1");
await new Promise((res) => sock.on("connect", res));
sock.write(`GET /mt5-screen/websockify HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nCookie: ${cookie}\r\n\r\n`);
let got = "";
sock.on("data", (d) => (got += d.toString()));
await new Promise((res) => setTimeout(res, 150));
sock.write("mouse-move");
await new Promise((res) => setTimeout(res, 150));
assert.match(got, /101 Switching Protocols[\s\S]*mouse-move/);
assert.ok(seen.includes("upgrade /websockify"));
sock.destroy();
const bad = connect(port, "127.0.0.1");
await new Promise((res) => bad.on("connect", res));
bad.write("GET /mt5-screen/websockify HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
let badGot = "";
bad.on("data", (d) => (badGot += d.toString()));
await new Promise((res) => setTimeout(res, 150));
assert.match(badGot, /401/);
console.log("   ✓\n");

console.log("=== ALL ASSERTIONS PASSED ===");
process.exit(0);
