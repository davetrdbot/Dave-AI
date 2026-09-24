import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * One-click deploys (a Railway template) can't generate a fresh DAVE_CREDENTIALS_KEY per deploy, so
 * the bot makes its own on first start and keeps it on the volume. It must survive a restart (or
 * every saved API key becomes unreadable), and an explicit env var must always win.
 */
const { ensureCredentialsKey, ensureAdminLogin } = await import("../src/main.js");
const { derivedMt5Secret } = await import("@dave/ea-bridge");
const { execFileSync } = await import("node:child_process");

console.log("=== Step 163: the bot creates its own credentials key when none is set ===\n");
const root = mkdtempSync(join(tmpdir(), "dave-key-"));

const first: NodeJS.ProcessEnv = {};
assert.equal(ensureCredentialsKey(first, root), "created");
assert.match(first.DAVE_CREDENTIALS_KEY ?? "", /^[0-9a-f]{64}$/, "a real 256-bit key");
const file = join(root, ".dave-credentials-key");
assert.equal(readFileSync(file, "utf8").trim(), first.DAVE_CREDENTIALS_KEY, "saved on the volume");
assert.equal(statSync(file).mode & 0o777, 0o600, "readable by the bot only");

const afterRestart: NodeJS.ProcessEnv = {};
assert.equal(ensureCredentialsKey(afterRestart, root), "file");
assert.equal(afterRestart.DAVE_CREDENTIALS_KEY, first.DAVE_CREDENTIALS_KEY, "the same key after a restart -- saved keys stay readable");

const explicit: NodeJS.ProcessEnv = { DAVE_CREDENTIALS_KEY: "set-by-the-owner" };
assert.equal(ensureCredentialsKey(explicit, root), "env");
assert.equal(explicit.DAVE_CREDENTIALS_KEY, "set-by-the-owner", "an explicit setting always wins");

console.log("[2] The web panel is never left without a password");
const a1: NodeJS.ProcessEnv = {};
assert.equal(ensureAdminLogin(a1, root), "created");
assert.equal(a1.ADMIN_USERNAME, "admin");
assert.ok((a1.ADMIN_PASSWORD ?? "").length >= 16, "a real password");
assert.equal(statSync(join(root, ".dave-admin-password")).mode & 0o777, 0o600);
const a2: NodeJS.ProcessEnv = {};
assert.equal(ensureAdminLogin(a2, root), "file");
assert.equal(a2.ADMIN_PASSWORD, a1.ADMIN_PASSWORD, "the same login after a restart");
const a3: NodeJS.ProcessEnv = { ADMIN_USERNAME: "Dave", ADMIN_PASSWORD: "mine" };
assert.equal(ensureAdminLogin(a3, root), "env");
assert.deepEqual([a3.ADMIN_USERNAME, a3.ADMIN_PASSWORD], ["Dave", "mine"], "the owner's own login always wins");

console.log("[3] Bot and MT5 service work out the same secret from the project, with nothing stored");
const env = { RAILWAY_PROJECT_ID: "p-123", RAILWAY_ENVIRONMENT_ID: "e-456" };
const fromBot = derivedMt5Secret(env);
const fromAgent = execFileSync("python3", ["-c", "import sys; sys.path.insert(0, 'mt5'); import agent; print(agent.SECRET)"], {
  env: { ...process.env, ...env, MT5_AGENT_SECRET: "", DAVE_STATE_DIR: join(root, "agent-state") },
}).toString().trim();
assert.equal(fromBot, fromAgent, "the bot and mt5/agent.py agree");
assert.notEqual(derivedMt5Secret({ ...env, RAILWAY_PROJECT_ID: "p-other" }), fromBot, "different per project");
assert.equal(derivedMt5Secret({}), undefined, "off Railway there is nothing to derive from");

console.log("=== ALL ASSERTIONS PASSED ===");
process.exit(0);
