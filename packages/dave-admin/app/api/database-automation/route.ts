import { NextRequest, NextResponse } from "next/server";
import { join } from "node:path";
import { DaveDatabase } from "@dave/db";

/**
 * Step 16 is real now -- this used to honestly report "not built yet".
 * Same DB-file convention as every other per-user store in this repo:
 * `data/db/<userId>.db`. Real table list + real row counts, not
 * fabricated -- an empty/never-used DB genuinely reports zero tables.
 */
export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  const db = new DaveDatabase(join(process.cwd(), "data", "db", `${userId}.db`));
  try {
    const tables = db.listTables().filter((t) => t !== "workflow_runs");
    const tableCounts = Object.fromEntries(tables.map((t) => [t, db.aggregate(t, userId, "COUNT")]));
    const workflowRuns = db.listTables().includes("workflow_runs") ? db.query("workflow_runs", userId, {}) : [];
    return NextResponse.json({
      implemented: true,
      tables,
      tableCounts,
      activeWorkflowRuns: workflowRuns.filter((r) => r.status === "running" || r.status === "waiting").length,
      note: "Dave creates its own tables as it needs them -- this list is genuinely empty until it does.",
    });
  } finally {
    db.close();
  }
}
