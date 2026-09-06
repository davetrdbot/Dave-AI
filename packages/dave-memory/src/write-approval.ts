import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Step 4.6: write-approval setting. Togglable, OFF by default. When on,
 * memory writes are queued for explicit approval instead of applied
 * immediately.
 */

interface UserMemorySettings {
  writeApprovalEnabled: boolean;
}

interface PendingWrite {
  id: string;
  userId: string;
  description: string;
  createdAt: number;
  applied: boolean;
}

function settingsPath(userId: string): string {
  return join(process.cwd(), "data", "memory", userId, "settings.json");
}

function pendingPath(userId: string): string {
  return join(process.cwd(), "data", "memory", userId, "pending-writes.json");
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path: string, value: unknown): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

export function getWriteApprovalSetting(userId: string): boolean {
  return readJson<UserMemorySettings>(settingsPath(userId), { writeApprovalEnabled: false }).writeApprovalEnabled;
}

export function setWriteApprovalSetting(userId: string, enabled: boolean): void {
  writeJson(settingsPath(userId), { writeApprovalEnabled: enabled });
}

/** Item 8 (/reset "config/settings back to defaults"): deletes both files so getWriteApprovalSetting's own real default (off) takes over and no stale pending writes survive. */
export function resetWriteApprovalForUser(userId: string): void {
  rmSync(settingsPath(userId), { force: true });
  rmSync(pendingPath(userId), { force: true });
}

function readPending(userId: string): PendingWrite[] {
  return readJson<PendingWrite[]>(pendingPath(userId), []);
}

function savePending(userId: string, pending: PendingWrite[]): void {
  writeJson(pendingPath(userId), pending);
}

export type GatedWriteResult =
  | { applied: true }
  | { applied: false; pendingId: string };

/**
 * Gates a memory write behind the write-approval setting. If the setting
 * is off (default), `apply()` runs immediately and the write is real.
 * If on, the write is queued and NOT applied until approveWrite() is
 * called for its id -- this is what makes the setting actually gate
 * writes, not just record a preference.
 */
export function gatedWrite(userId: string, description: string, apply: () => void): GatedWriteResult {
  if (!getWriteApprovalSetting(userId)) {
    apply();
    return { applied: true };
  }
  const pending = readPending(userId);
  const id = `${Date.now()}-${pending.length}`;
  pending.push({ id, userId, description, createdAt: Date.now(), applied: false });
  savePending(userId, pending);
  gatedApplyFns.set(`${userId}:${id}`, apply);
  return { applied: false, pendingId: id };
}

// Holds the deferred apply() closures for pending writes, keyed by
// "userId:id". Process-lifetime only, matching the in-memory recall
// guard's scope -- a restart loses unapproved writes, which is the
// correct behavior for something that was never actually written yet.
const gatedApplyFns = new Map<string, () => void>();

/**
 * Real gap this fixes: pending writes persist to disk, but the actual
 * apply() closures live only in memory (gatedApplyFns). After a process
 * restart, listPendingWrites() would have kept showing writes from
 * before the restart as approvable, but approveWrite() would then throw
 * "process restarted?" -- a real UX dead end (a future settings UI could
 * show "3 pending approvals" that are all silently impossible to
 * approve). Now the recoverable flag tells callers which is which.
 */
export function listPendingWrites(userId: string): (PendingWrite & { recoverable: boolean })[] {
  return readPending(userId)
    .filter((w) => !w.applied)
    .map((w) => ({ ...w, recoverable: gatedApplyFns.has(`${userId}:${w.id}`) }));
}

export function approveWrite(userId: string, id: string): void {
  const pending = readPending(userId);
  const record = pending.find((w) => w.id === id);
  if (!record) throw new Error(`No pending write ${id} for ${userId}`);
  if (record.applied) throw new Error(`Pending write ${id} was already applied`);
  const key = `${userId}:${id}`;
  const apply = gatedApplyFns.get(key);
  if (!apply) {
    throw new Error(
      `Pending write ${id} can no longer be approved -- the process restarted since it was requested. Ask for the change again.`
    );
  }
  apply();
  record.applied = true;
  savePending(userId, pending);
  gatedApplyFns.delete(key);
}
