import { NextResponse } from "next/server";
import { addThinkingStage, deleteThinkingStage, getThinkingStages, resetThinkingStages, setThinkingStageEnabled, ThinkingStageError } from "@dave/trading";
import { withDevice } from "../../../../server/require-device";

/**
 * The steps of Dave's sequential thinking, edited from the app: switch each on or off, delete one,
 * add your own, or reset to the built-in list. Every enabled step is mandatory in the thinking pass.
 *
 *   GET                                         -> {stages}
 *   POST {action:"toggle", id, enabled}         -> {stages}
 *   POST {action:"delete", id}                  -> {stages}
 *   POST {action:"add", label, help}            -> {stages}
 *   POST {action:"reset"}                       -> {stages}
 */

export const GET = withDevice(async ({ userId }) => NextResponse.json({ stages: getThinkingStages(userId) }));

export const POST = withDevice(async ({ userId, req }) => {
  let body: { action?: string; id?: string; enabled?: boolean; label?: string; help?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  try {
    switch (body.action) {
      case "toggle":
        if (typeof body.id !== "string" || typeof body.enabled !== "boolean") return NextResponse.json({ error: "Which step, on or off?" }, { status: 400 });
        return NextResponse.json({ stages: setThinkingStageEnabled(userId, body.id, body.enabled) });
      case "delete":
        if (typeof body.id !== "string") return NextResponse.json({ error: "Which step?" }, { status: 400 });
        return NextResponse.json({ stages: deleteThinkingStage(userId, body.id) });
      case "add":
        return NextResponse.json({ stages: addThinkingStage(userId, String(body.label ?? ""), String(body.help ?? "")) });
      case "reset":
        return NextResponse.json({ stages: resetThinkingStages(userId) });
      default:
        return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    }
  } catch (err) {
    if (err instanceof ThinkingStageError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
});
