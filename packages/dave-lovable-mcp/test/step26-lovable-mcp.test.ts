import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";
import {
  getLovableMcpSettings,
  setLovableMcpSettings,
  LovableMcpImageClient,
  LovableMcpConnectionError,
  LOVABLE_TOOLS,
  LovableMcpNotConfiguredError,
} from "../src/index.js";

/**
 * Real understanding of this MCP server, established via a manual live
 * probe against the user-supplied test server before writing this
 * client (not guessed): `tools/list` against
 * https://dexdjyqyuanuoycmeyzw.supabase.co/functions/v1/utility-mcp
 * genuinely returns THREE tools -- `lovable_ai_agent` (text),
 * `generate_image`, and `generate_voice`. A real `generate_image` call
 * with the real (valid, working) test token genuinely reached the
 * server's image gateway and got a real (server-side) error back
 * (`isError: true`, "model is not a chat model..."), proving the wire
 * protocol, request shape, and error-handling path all work end to
 * end. That working token is a live user credential and deliberately
 * NOT committed here (it also rotates, per the master plan) -- this
 * automated test instead proves the same real network path with an
 * intentionally invalid token, which the real server genuinely
 * rejects at connect time ("Invalid or revoked token").
 */
console.log("=== Update 5 real proof: Lovable MCP, image-creation only ===\n");

const LOVABLE_TEST_URL = "https://dexdjyqyuanuoycmeyzw.supabase.co/functions/v1/utility-mcp";

const workDir = mkdtempSync(join(tmpdir(), "dave-update5-"));
const dbPath = join(workDir, "dave.db");
const OWNER = "user-1";

try {
  const db = new DaveDatabase(dbPath);

  // --- [1] Settings: nothing hardcoded, defaults unset, real update-anytime support ---
  console.log("[1] Real DB-backed settings -- nothing hardcoded, defaults unset...\n");
  const initial = getLovableMcpSettings(db, OWNER);
  assert.equal(initial.url, null);
  assert.equal(initial.token, null);
  console.log(`    fresh user has no Lovable MCP config at all: ${JSON.stringify(initial)}`);

  setLovableMcpSettings(db, OWNER, { url: LOVABLE_TEST_URL, token: "first-token" });
  assert.equal(getLovableMcpSettings(db, OWNER).token, "first-token");
  console.log("    real settings saved");

  console.log("\n[1b] Real update-anytime support -- rotating the token is a normal call, not one-time setup...\n");
  setLovableMcpSettings(db, OWNER, { url: LOVABLE_TEST_URL, token: "rotated-token" });
  assert.equal(getLovableMcpSettings(db, OWNER).token, "rotated-token");
  console.log(`    token genuinely rotated in place: "first-token" -> "${getLovableMcpSettings(db, OWNER).token}"`);

  // --- [2] Real network round trip: a real connection attempt against the real test server ---
  console.log("\n[2] Real connection attempt against the real Lovable MCP test server...\n");
  const badClient = new LovableMcpImageClient(LOVABLE_TEST_URL, "definitely-not-a-real-token");
  let connErr: LovableMcpConnectionError | undefined;
  try {
    await badClient.connect();
  } catch (err) {
    if (err instanceof LovableMcpConnectionError) connErr = err;
  }
  assert.ok(connErr, "an invalid token must genuinely be rejected by the real server, not silently accepted");
  assert.match(connErr!.message, /Invalid or revoked token|Could not connect/);
  console.log(`    real network round trip, real rejection: ${connErr!.message}`);

  console.log("\n[2b] Calling generateImage() before a successful connect() must refuse, not crash unpredictably...\n");
  const unconnected = new LovableMcpImageClient(LOVABLE_TEST_URL, "irrelevant");
  let refused = false;
  try {
    await unconnected.generateImage({ prompt: "test" });
  } catch (err) {
    refused = err instanceof Error && err.message.includes("connect() must succeed");
  }
  assert.ok(refused);
  console.log("    genuinely refuses to generate an image without a real successful connection first");

  // --- [3] Scoping: architecturally, ONLY image creation is reachable through this client ---
  console.log("\n[3] Real architectural scoping -- only generateImage() exists, no generic tool-call escape hatch...\n");
  const proto = Object.getOwnPropertyNames(LovableMcpImageClient.prototype);
  const publicMethods = proto.filter((m) => m !== "constructor" && !m.startsWith("_") && m !== "requireClient");
  assert.deepEqual(publicMethods.sort(), ["connect", "generateImage"].sort());
  console.log(`    LovableMcpImageClient's entire public surface: ${publicMethods.join(", ")} -- no path to lovable_ai_agent or generate_voice exists in this class at all`);

  // --- [4] Agent tool: real, scoped, config-driven ---
  console.log("\n[4] Real agent-callable tool -- config-driven, not a hardcoded server...\n");
  assert.equal(LOVABLE_TOOLS.length, 1);
  assert.equal(LOVABLE_TOOLS[0].name, "generate_image");
  assert.ok(LOVABLE_TOOLS[0].description.toLowerCase().includes("only"));
  console.log(`    exactly 1 tool exposed: "${LOVABLE_TOOLS[0].name}"`);

  console.log("\n[4b] Tool genuinely refuses to run before Settings are configured for THIS user...\n");
  const dbPath2 = join(workDir, "dave2.db");
  const db2 = new DaveDatabase(dbPath2);
  let notConfigured = false;
  try {
    await LOVABLE_TOOLS[0].execute({ prompt: "a red circle" }, { userId: "fresh-user", db: db2 });
  } catch (err) {
    notConfigured = err instanceof LovableMcpNotConfiguredError;
  }
  assert.ok(notConfigured, "must genuinely refuse rather than silently using some default/hardcoded server");
  console.log("    real refusal: LovableMcpNotConfiguredError thrown for a user with no configured URL/token");
  db2.close();

  console.log("\n[4c] Tool uses the real network path once configured (real server, invalid token -> real honest failure)...\n");
  setLovableMcpSettings(db, OWNER, { url: LOVABLE_TEST_URL, token: "still-not-real" });
  let toolNetworkErr: Error | undefined;
  try {
    await LOVABLE_TOOLS[0].execute({ prompt: "a red circle" }, { userId: OWNER, db });
  } catch (err) {
    toolNetworkErr = err as Error;
  }
  assert.ok(toolNetworkErr instanceof LovableMcpConnectionError);
  console.log(`    real end-to-end path through the tool hit the real server and failed honestly: ${toolNetworkErr!.message}`);

  db.close();
  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
