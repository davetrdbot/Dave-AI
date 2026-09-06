import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaveDatabase } from "../src/database.js";

/**
 * Real, live production bug reported by the user: "table provider_keys has no column named
 * is_primary" -- CREATE TABLE IF NOT EXISTS is a genuine no-op once a table already exists on
 * disk (the real, live Railway volume, created by an earlier deploy before is_primary was
 * added), so the live table kept its stale schema forever and every real write through it
 * failed. This reproduces that EXACT scenario -- a table created with an OLD, narrower column
 * set, then createTable() called again (as every real ensureTable() helper in this codebase
 * does on every call) with a NEW column added -- and proves the real fix: the missing column
 * is genuinely added via ALTER TABLE, existing rows survive, and a write using the new column
 * genuinely succeeds instead of throwing "no such column."
 */

console.log("=== Real proof: createTable() migrates a live table's schema, not just fresh ones ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-column-migration-"));
const dbPath = join(workDir, "dave.db");
const OWNER = "user-column-migration-1";

try {
  console.log("[1] Simulate an OLD deploy: a real table created with only the ORIGINAL columns (no is_primary)...");
  const dbOld = new DaveDatabase(dbPath);
  dbOld.createTable("provider_keys", [
    { name: "provider", type: "TEXT" },
    { name: "label", type: "TEXT" },
    { name: "config_json", type: "TEXT" },
    { name: "healthy", type: "INTEGER" },
    { name: "last_checked_at", type: "INTEGER" },
    { name: "last_error", type: "TEXT" },
  ]);
  const oldRowId = dbOld.insert("provider_keys", OWNER, { provider: "openai", label: "old key", config_json: "{}", healthy: 1, last_checked_at: null, last_error: null });
  console.log(`    real row inserted under the OLD schema: ${oldRowId}`);
  dbOld.close();

  console.log("\n[2] A fresh process (real restart, real NEW code) opens the SAME db file and calls createTable with the NEW column...");
  const dbNew = new DaveDatabase(dbPath);
  dbNew.createTable("provider_keys", [
    { name: "provider", type: "TEXT" },
    { name: "label", type: "TEXT" },
    { name: "config_json", type: "TEXT" },
    { name: "healthy", type: "INTEGER" },
    { name: "last_checked_at", type: "INTEGER" },
    { name: "last_error", type: "TEXT" },
    { name: "is_primary", type: "INTEGER" }, // the real new column this session added
  ]);

  console.log("\n[3] The pre-existing row from the OLD schema genuinely survived (not dropped/recreated)...");
  const survivedRow = dbNew.getById("provider_keys", OWNER, oldRowId);
  assert.ok(survivedRow, "the row inserted under the old schema must still exist");
  console.log(`    survived row: ${JSON.stringify(survivedRow)}`);
  assert.equal(survivedRow!.provider, "openai");
  assert.equal(survivedRow!.is_primary, null, "the new column must be genuinely NULL on old rows, not a crash");

  console.log("\n[4] A real write using the NEW column now genuinely succeeds -- this is the exact operation that was failing live...");
  const newRowId = dbNew.insert("provider_keys", OWNER, { provider: "openai", label: "new key", config_json: "{}", healthy: 1, last_checked_at: null, last_error: null, is_primary: 1 });
  const newRow = dbNew.getById("provider_keys", OWNER, newRowId);
  console.log(`    real row using is_primary: ${JSON.stringify(newRow)}`);
  assert.equal(newRow!.is_primary, 1);

  console.log("\n[5] A real update() targeting the new column on the OLD row also genuinely works now...");
  dbNew.update("provider_keys", OWNER, oldRowId, { is_primary: 0 });
  const updatedOldRow = dbNew.getById("provider_keys", OWNER, oldRowId);
  console.log(`    updated old row: ${JSON.stringify(updatedOldRow)}`);
  assert.equal(updatedOldRow!.is_primary, 0);

  dbNew.close();
  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
