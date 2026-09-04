import type { DaveDatabase } from "@dave/db";

/**
 * Step 17.3: versioned releases with real lineage -- every version
 * references what it evolved from (a real foreign-key-style link, not
 * just a timestamp ordering), a full changelog entry per version, and
 * rollback support that itself produces a new version (rolling back is
 * an evolution, not a history rewrite -- the fact that a rollback
 * happened, and to what, stays in the lineage).
 */

export interface VersionRecord {
  id: string;
  targetFile: string;
  evolvedFrom: string | null;
  changelogEntry: string;
  snapshotContent: string;
  createdAt: number;
}

interface VersionRow {
  id: string;
  target_file: string;
  evolved_from: string | null;
  changelog_entry: string;
  snapshot_content: string;
  created_at: number;
}

const TABLE = "versions";

function ensureTable(db: DaveDatabase): void {
  db.createTable(TABLE, [
    { name: "target_file", type: "TEXT" },
    { name: "evolved_from", type: "TEXT" },
    { name: "changelog_entry", type: "TEXT" },
    { name: "snapshot_content", type: "TEXT" },
  ]);
}

function toRecord(row: VersionRow): VersionRecord {
  return {
    id: row.id,
    targetFile: row.target_file,
    evolvedFrom: row.evolved_from,
    changelogEntry: row.changelog_entry,
    snapshotContent: row.snapshot_content,
    createdAt: row.created_at,
  };
}

export function createVersion(
  db: DaveDatabase,
  ownerUserId: string,
  params: { targetFile: string; evolvedFrom: string | null; changelogEntry: string; snapshotContent: string }
): VersionRecord {
  ensureTable(db);
  const id = db.insert(TABLE, ownerUserId, {
    target_file: params.targetFile,
    evolved_from: params.evolvedFrom,
    changelog_entry: params.changelogEntry,
    snapshot_content: params.snapshotContent,
  });
  return getVersion(db, ownerUserId, id)!;
}

export function getVersion(db: DaveDatabase, ownerUserId: string, versionId: string): VersionRecord | undefined {
  ensureTable(db);
  const row = db.getById(TABLE, ownerUserId, versionId) as unknown as VersionRow | undefined;
  return row ? toRecord(row) : undefined;
}

/** Full changelog for one file, oldest first -- real lineage order, not just insertion order (though here they're the same by construction). */
export function getVersionHistory(db: DaveDatabase, ownerUserId: string, targetFile: string): VersionRecord[] {
  ensureTable(db);
  const rows = db.query(TABLE, ownerUserId, { target_file: targetFile }) as unknown as VersionRow[];
  return rows.map(toRecord).sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Rollback support (17.3): writes the target version's snapshot back
 * out via the caller-supplied `writeFile` (keeps this module agnostic
 * to WHERE the real file lives -- production code, a workspace copy,
 * whatever), then records the rollback itself as a NEW version that
 * evolved from the CURRENT tip, referencing what it rolled back to in
 * its changelog entry -- so the lineage honestly shows "we went back",
 * it doesn't pretend the intervening versions never happened.
 */
export function rollbackToVersion(
  db: DaveDatabase,
  ownerUserId: string,
  versionId: string,
  currentTipVersionId: string,
  writeFile: (content: string) => void
): VersionRecord {
  const target = getVersion(db, ownerUserId, versionId);
  if (!target) throw new Error(`no version "${versionId}" to roll back to`);
  writeFile(target.snapshotContent);
  return createVersion(db, ownerUserId, {
    targetFile: target.targetFile,
    evolvedFrom: currentTipVersionId,
    changelogEntry: `Rolled back to version ${versionId} ("${target.changelogEntry}")`,
    snapshotContent: target.snapshotContent,
  });
}
