import { NextRequest, NextResponse } from "next/server";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";

/**
 * Step 17 is real now -- this used to honestly report "not built yet".
 * Same per-user DB file as Step 16's own panel (`data/db/<userId>.db`)
 * -- self-improvement's version lineage lives in the same real
 * database, not a separate store. An empty/never-used history genuinely
 * reports zero versions.
 */
export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  const db = new DaveDatabase(join(process.cwd(), "data", "db", `${userId}.db`));
  try {
    const hasVersions = db.listTables().includes("versions");
    const versions = hasVersions ? (db.query("versions", userId, {}) as unknown as Record<string, unknown>[]) : [];
    const hasPatches = db.listTables().includes("patch_proposals");
    const patches = hasPatches ? (db.query("patch_proposals", userId, {}) as unknown as Record<string, unknown>[]) : [];
    return NextResponse.json({
      implemented: true,
      versionCount: versions.length,
      lineage: versions
        .sort((a, b) => (a.created_at as number) - (b.created_at as number))
        .map((v) => ({ id: v.id, targetFile: v.target_file, evolvedFrom: v.evolved_from, changelogEntry: v.changelog_entry, createdAt: v.created_at })),
      pendingPatches: patches.filter((p) => p.status === "proposed" || p.status === "tested").length,
      note: "Real version lineage from Dave's own patch/version store -- genuinely empty until Dave proposes and applies its first patch.",
    });
  } finally {
    db.close();
  }
}
