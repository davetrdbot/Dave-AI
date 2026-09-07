import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrCreateEaWebhook, revokeEaToken, resolveEaToken, createEaWebhookServer } from "../src/index.js";

/**
 * Real proof for the user's ask: "the ea token should have only one token which is revokable
 * e.g DAVE-8235751653-B7401D1C -- like this dave + my id is permanent but the other is
 * revokable... add that in the settings ui to revoke it." Proves the real token FORMAT
 * (DAVE-<userId>-<suffix>, permanent prefix + revocable suffix), that the same token is
 * returned on repeat calls (stable, not regenerated every time), and that revoking genuinely
 * invalidates the OLD token (a real heartbeat POST to the old URL now gets a real 404) while
 * issuing a real new one that works.
 */

console.log("=== Real proof: single revocable EA token, DAVE-<userId>-<suffix> format ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-ea-token-revoke-"));
process.chdir(workDir);
const USER_ID = "8235751653";

try {
  console.log("[1] The real token format is DAVE-<userId>-<8-hex-char suffix>, permanent id part...");
  const hook1 = getOrCreateEaWebhook(USER_ID);
  console.log(`    real token: ${hook1.token}`);
  assert.match(hook1.token, /^DAVE-8235751653-[0-9A-F]{8}$/, "must match the exact real format the user specified");
  assert.equal(hook1.path, `/hooks/ea/${hook1.token}`);

  console.log("\n[2] Calling getOrCreateEaWebhook again returns the SAME token -- stable, not regenerated every call...");
  const hook1Again = getOrCreateEaWebhook(USER_ID);
  assert.equal(hook1Again.token, hook1.token, "the token must genuinely be stable across calls, not re-rolled each time");
  console.log("    same token both times, confirmed stable");

  console.log("\n[3] resolveEaToken() genuinely resolves the real current token back to the real userId...");
  assert.equal(resolveEaToken(hook1.token), USER_ID);
  console.log(`    resolveEaToken("${hook1.token}") -> "${USER_ID}"`);

  console.log("\n[4] A real heartbeat POST to the current token's real URL is genuinely accepted...");
  const server = createEaWebhookServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  const heartbeat = { type: "heartbeat", account: "111", balance: 100, positions: [], pendingOrders: [] };
  const res1 = await fetch(`http://127.0.0.1:${port}${hook1.path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(heartbeat) });
  assert.equal(res1.status, 200, "the real, current token must genuinely be accepted");
  console.log(`    POST ${hook1.path} -> ${res1.status}`);

  console.log("\n[5] Revoking genuinely issues a NEW token, different from the old one, same permanent userId prefix...");
  const revoked = revokeEaToken(USER_ID);
  console.log(`    new token: ${revoked.token}`);
  assert.match(revoked.token, /^DAVE-8235751653-[0-9A-F]{8}$/);
  assert.notEqual(revoked.token, hook1.token, "revoking must genuinely produce a DIFFERENT token");
  assert.equal(revoked.userId, USER_ID, "the userId part stays the same real permanent identity");

  console.log("\n[6] The OLD token is genuinely invalidated -- a real POST to the old URL is now refused...");
  const res2 = await fetch(`http://127.0.0.1:${port}${hook1.path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(heartbeat) });
  assert.equal(res2.status, 404, "the OLD token must genuinely stop working after revoke -- this is the real point of revoking");
  console.log(`    POST to the OLD url -> ${res2.status} (correctly refused)`);

  console.log("\n[7] The NEW token genuinely works...");
  const res3 = await fetch(`http://127.0.0.1:${port}${revoked.path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(heartbeat) });
  assert.equal(res3.status, 200, "the new token must genuinely be accepted");
  console.log(`    POST to the NEW url -> ${res3.status}`);

  console.log("\n[8] A second, different user gets their OWN independent token -- no collision...");
  const otherHook = getOrCreateEaWebhook("999888777");
  assert.match(otherHook.token, /^DAVE-999888777-[0-9A-F]{8}$/);
  assert.notEqual(otherHook.token, revoked.token);

  await new Promise<void>((resolve) => server.close(() => resolve()));

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
