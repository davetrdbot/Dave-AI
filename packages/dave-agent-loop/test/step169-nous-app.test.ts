import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "dave-nous-app-"));
process.env.DAVE_DATA_ROOT = root;
process.env.DAVE_CREDENTIALS_KEY ??= "test-only-master-key-not-for-production";

/**
 * Nous connected from the phone app: Telegram login (code, then the 2-step password), channel
 * picking and the options -- the same steps as /nous, over /api/app/nous/*.
 */
const { createAppNousHandler } = await import("../src/nous/app-routes.js");
const { getNousConfig, saveNousLogin } = await import("../src/nous/store.js");
const { hashDeviceToken } = await import("@dave/db");

console.log("=== Step 169: Nous from the app ===\n");
const userId = "owner";
const token = "phone-token-169";
mkdirSync(join(root, "data", "device-auth", userId), { recursive: true });
writeFileSync(join(root, "data", "device-auth", userId, "state.json"), JSON.stringify({ devices: [{ id: "d1", tokenHash: hashDeviceToken(token), label: "phone", pairedAt: 1 }] }));

const calls: string[] = [];
const secrets: string[] = [];
let listening = false;
const userbot = {
  nousLoginBegin: async (_u: string, apiId: number, apiHash: string, phone: string) => {
    calls.push(`begin ${apiId} ${phone}`);
    secrets.push(apiHash);
  },
  nousLoginCode: async (_u: string, code: string) => {
    calls.push(`code ${code}`);
    return { done: false as const, needPassword: true as const };
  },
  nousLoginPassword: async (_u: string, password: string) => {
    secrets.push(password);
    saveNousLogin(userId, { apiId: 1234567, apiHash: "a".repeat(32), session: "sess", account: "Trader (@trader)" });
    return { done: true as const, account: "Trader (@trader)" };
  },
  cancelNousLogin: () => void calls.push("cancel"),
  listNousDialogs: async () => [
    { id: "-1001", title: "Gold Signals", kind: "channel" as const },
    { id: "-1002", title: "FX Room", kind: "group" as const },
  ],
  nousLogout: async () => void calls.push("logout"),
  stopNousListener: async () => void calls.push("stop"),
  isNousListening: () => listening,
};
const logged: string[] = [];
const origLog = console.log;
const origErr = console.error;
console.error = (...a: unknown[]) => void logged.push(a.map(String).join(" "));

const server = createServer(createAppNousHandler({ userId, userbot, ensureListening: async () => (listening = true) }));
await new Promise<void>((r) => server.listen(0, r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/app/nous`;
const H = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const post = (path: string, body: unknown) => fetch(`${base}/${path}`, { method: "POST", headers: H, body: JSON.stringify(body) });
const json = async (r: Response) => (await r.json()) as Record<string, unknown>;

console.log("[1] Only a paired phone");
assert.equal((await fetch(`${base}/state`)).status, 401);
assert.equal((await fetch(`${base}/state`, { headers: { authorization: "Bearer nope" } })).status, 401);
const s0 = await json(await fetch(`${base}/state`, { headers: H }));
assert.equal(s0.loggedIn, false);
assert.equal(s0.autoApprove, false);
console.log("   ✓\n");

console.log("[2] Login: bad inputs are refused before Telegram is asked");
assert.equal((await post("login/begin", { apiId: "abc", apiHash: "f".repeat(32), phone: "+2348012345678" })).status, 400);
assert.equal((await post("login/begin", { apiId: 1234567, apiHash: "short", phone: "+2348012345678" })).status, 400);
assert.equal((await post("login/begin", { apiId: 1234567, apiHash: "f".repeat(32), phone: "call me" })).status, 400);
assert.deepEqual(calls, []);
console.log("   ✓\n");

console.log("[3] Login: begin -> code -> 2-step password -> connected");
const hash = "0123456789abcdef0123456789abcdef";
assert.deepEqual(await json(await post("login/begin", { apiId: 1234567, apiHash: hash, phone: "+234 801 234 5678" })), { codeSent: true });
assert.deepEqual(calls, ["stop", "begin 1234567 +2348012345678"], "the old listener stops first; spaces are stripped");
assert.deepEqual(await json(await post("login/code", { code: "1 2 3 4 5" })), { done: false, needPassword: true });
assert.equal(calls.at(-1), "code 12345");
assert.deepEqual(await json(await post("login/password", { password: "s3cret-pass" })), { done: true, account: "Trader (@trader)" });
const s1 = await json(await fetch(`${base}/state`, { headers: H }));
assert.equal(s1.loggedIn, true);
assert.equal(s1.account, "Trader (@trader)");
console.log("   ✓\n");

console.log("[4] Channels: listed with picked flags; saving starts listening");
const list = (await json(await fetch(`${base}/chats`, { headers: H }))).chats as { id: string; picked: boolean }[];
assert.deepEqual(list.map((c) => [c.id, c.picked]), [["-1001", false], ["-1002", false]]);
const saved = await json(await post("chats", { ids: ["-1001", "-9999"] }));
assert.equal(saved.listening, true);
assert.deepEqual(getNousConfig(userId).chats, [{ id: "-1001", title: "Gold Signals", kind: "channel" }], "unknown ids are dropped");
const list2 = (await json(await fetch(`${base}/chats`, { headers: H }))).chats as { id: string; picked: boolean }[];
assert.equal(list2.find((c) => c.id === "-1001")?.picked, true);
console.log("   ✓\n");

console.log("[5] Options, with the same bounds as /nous");
const o = await json(await post("settings", { autoApprove: true, lots: 0.05, maxAgeMinutes: 10 }));
assert.equal(o.autoApprove, true);
assert.equal(o.lots, 0.05);
assert.equal(o.maxAgeMinutes, 10);
assert.equal((await post("settings", { lots: 500 })).status, 400);
assert.equal((await post("settings", { maxAgeMinutes: 0 })).status, 400);
assert.equal((await json(await post("settings", { lots: null }))).lotsAuto, true);
console.log("   ✓\n");

console.log("[6] Log out; closing an unknown trade is refused");
await post("logout", {});
assert.equal(calls.at(-1), "logout");
assert.notEqual((await post("close", { ticket: "42" })).status, 200);
await post("login/cancel", {});
assert.equal(calls.at(-1), "cancel");
console.log("   ✓\n");

console.log("[7] The api_hash and password never reach a log or the activity feed");
const feed = join(root, "data", "agent-loop", userId, "activity.jsonl");
const feedText = existsSync(feed) ? readFileSync(feed, "utf8") : "";
for (const secret of secrets) {
  assert.ok(!feedText.includes(secret));
  assert.ok(!logged.some((l) => l.includes(secret)));
}
console.log("   ✓\n");

server.close();
console.error = origErr;
origLog("=== ALL ASSERTIONS PASSED ===");
process.exit(0);
