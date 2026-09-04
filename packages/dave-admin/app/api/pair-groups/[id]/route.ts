import { NextRequest, NextResponse } from "next/server";
import { listGroups, deleteGroup } from "@dave/trading";

export async function DELETE(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  const { id } = await context.params;
  deleteGroup(userId, id);
  return NextResponse.json({ ok: true, groups: listGroups(userId) });
}
