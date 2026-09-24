import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * One-click deploys (a Railway template) can't generate a fresh DAVE_CREDENTIALS_KEY per deploy, so
 * the bot makes its own on first start and keeps it on the volume. It must survive a restart (or
 * every saved API key becomes unreadable), and an explicit env var must always win.
 */
const { ensureCredentialsKey } = await import("../src/main.js");

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

console.log("=== ALL ASSERTIONS PASSED ===");
process.exit(0);
