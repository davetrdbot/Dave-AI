import { NextResponse } from "next/server";
import { ALL_ANALYSIS_ENDPOINTS, ALL_ANALYSIS_TIMEFRAMES, getAnalysisConfig, resetAnalysisConfigToAll, setCustomEndpoints, setCustomTimeframes } from "@dave/trading";
import { withDevice } from "../../../../server/require-device";

/** Which timeframes and analysis types Dave pulls from the EA on each scan -- fewer is faster. */
export const dynamic = "force-dynamic";

function view(userId: string) {
  const c = getAnalysisConfig(userId);
  return { mode: c.mode, timeframes: c.timeframes, endpoints: c.endpoints, allTimeframes: ALL_ANALYSIS_TIMEFRAMES, allEndpoints: ALL_ANALYSIS_ENDPOINTS };
}

export const GET = withDevice(async ({ userId }) => NextResponse.json(view(userId)));

export const POST = withDevice(async ({ userId, req }) => {
  let body: { action?: string; timeframes?: string[]; endpoints?: string[] };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  try {
    if (body.action === "all") resetAnalysisConfigToAll(userId);
    else if (body.action === "timeframes" && Array.isArray(body.timeframes)) setCustomTimeframes(userId, body.timeframes);
    else if (body.action === "endpoints" && Array.isArray(body.endpoints)) setCustomEndpoints(userId, body.endpoints);
    else return NextResponse.json({ error: "action must be all, timeframes or endpoints." }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
  return NextResponse.json(view(userId));
});
