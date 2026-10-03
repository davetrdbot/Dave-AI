import { NextResponse } from "next/server";
import { exportGrowthBundle, growthShareOwner } from "@dave/trading";

/** Public, read-only: a Growth share link (growth-share.ts). Only the brain is in it -- neurons,
 *  learned rules and avoided pairs -- and the link stops working the moment its owner turns it off. */
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const userId = growthShareOwner(token);
  if (!userId) return NextResponse.json({ error: "This share link is off or does not exist." }, { status: 404 });
  return NextResponse.json(exportGrowthBundle(userId), { headers: { "cache-control": "no-store" } });
}
