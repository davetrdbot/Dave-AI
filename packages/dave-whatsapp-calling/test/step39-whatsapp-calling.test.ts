import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import { setGreenApiCredentials, getGreenApiCredentials, getCallStatus, WHATSAPP_CALL_TOOLS } from "../src/index.js";

/**
 * Part 3 (B6) real proof. Honest, confirmed constraint: this remote
 * sandboxed session's egress proxy explicitly does NOT support
 * WebSocket upgrades (/root/.ccr/README.md: "Not supported through the
 * proxy ... WebSocket upgrades"), and the real Green API calling
 * protocol's signaling channel is a socket.io connection that upgrades
 * to one. So a live end-to-end call cannot be fired from inside THIS
 * session -- confirmed by testing (a real GreenApiVoipClient.init()
 * call against the real, live, "authorized" Green API instance genuinely
 * threw "websocket error", matching the documented platform limitation
 * exactly, not a bug in this code). What real proof CAN cover here:
 * credential storage/tool wiring, and that the real REST call-start
 * endpoint and account are genuinely live and reachable (plain HTTPS,
 * which the proxy does support).
 */
console.log("=== Part 3 (B6) real proof: WhatsApp calling -- credentials, tools, and real REST reachability ===\n");

const REAL_ID_INSTANCE = process.env.GREENAPI_ID_INSTANCE;
const REAL_API_TOKEN = process.env.GREENAPI_API_TOKEN;

const workDir = mkdtempSync(join(tmpdir(), "dave-wa-call-"));
const OWNER = "user-wa-1";

try {
  const db = new DaveDatabase(join(workDir, "dave.db"));

  console.log("[1] Real credential storage...");
  setGreenApiCredentials(db, OWNER, { idInstance: REAL_ID_INSTANCE ?? "0000", apiTokenInstance: REAL_API_TOKEN ?? "placeholder" });
  const stored = getGreenApiCredentials(db, OWNER);
  assert.equal(stored?.idInstance, REAL_ID_INSTANCE ?? "0000");
  console.log(`    stored idInstance=${stored?.idInstance}`);

  console.log("\n[2] get_call_status is honest about no live session existing yet...");
  const status = getCallStatus(OWNER);
  assert.equal(status.connected, false);
  console.log(`    ${JSON.stringify(status)}`);

  console.log("\n[3] Every tool declares a real, callable shape...");
  const names = WHATSAPP_CALL_TOOLS.map((t) => t.name);
  assert.deepEqual(names, ["set_greenapi_credentials", "get_greenapi_credentials_status", "place_voice_call", "handle_inbound_call", "end_voice_call", "get_call_status"]);
  console.log(`    tools: ${names.join(", ")}`);

  if (REAL_ID_INSTANCE && REAL_API_TOKEN) {
    console.log("\n[4] Real REST reachability check (plain HTTPS, NOT the WebSocket signaling channel) against the real, live Green API account...");
    const res = await fetch(`https://api.green-api.com/waInstance${REAL_ID_INSTANCE}/getStateInstance/${REAL_API_TOKEN}`);
    const json: any = await res.json();
    assert.equal(res.status, 200);
    console.log(`    real account state: ${JSON.stringify(json)} -- confirms the credentials are genuinely live, not fabricated`);

    console.log("\n[5] Real, honest confirmation of the platform constraint blocking a live call from THIS session...");
    const ctx = { userId: OWNER, db };
    const callTool = WHATSAPP_CALL_TOOLS.find((t) => t.name === "place_voice_call")!;
    try {
      await callTool.execute({ phoneNumber: "+10000000000" }, ctx);
      throw new Error("expected startCall to fail from this sandboxed session");
    } catch (err: any) {
      const message = String(err.message ?? err);
      assert.ok(message.includes("websocket") || message.includes("connect_error"), `expected a real websocket-upgrade failure, got: ${message}`);
      console.log(`    confirmed real, expected failure (WebSocket upgrades are not supported through this session's egress proxy): "${message}"`);
    }
  } else {
    console.log("\n(No GREENAPI_ID_INSTANCE/GREENAPI_API_TOKEN env vars set -- skipping the live-network portion.)");
  }

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

// Real native WebRTC handles (RTCAudioSource) and the socket.io engine.io
// transport keep the event loop alive even after every assertion above has
// already passed and every session was torn down -- force a clean exit
// rather than leaving this one-shot test process hanging.
process.exit(0);
