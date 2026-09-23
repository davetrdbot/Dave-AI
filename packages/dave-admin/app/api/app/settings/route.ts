import { NextResponse } from "next/server";
import { withDevice } from "../../../../server/require-device";
import { InvalidSettingError, applyAppSetting, readAppSettings } from "../../../../server/app-settings";

/**
 * Every bot setting the trader can change, for the app's Settings screen. POST changes one:
 * `{ id, value }`. The response is always the full, freshly read settings, so the screen shows
 * what was actually stored rather than what it asked for.
 */

export const GET = withDevice(async ({ userId }) => NextResponse.json(readAppSettings(userId)));

/** The setters' own validation errors are the trader's input being out of range -- a 400 with
 *  the setter's message, which is written to be read by a person. */
function isValidationError(err: unknown): err is Error {
  return err instanceof InvalidSettingError || (err instanceof Error && /Invalid|Unknown|Requires/.test(err.constructor.name));
}

export const POST = withDevice(async ({ userId, req }) => {
  let body: { id?: unknown; value?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  if (typeof body.id !== "string") return NextResponse.json({ error: "id is required." }, { status: 400 });
  try {
    applyAppSetting(userId, body.id, body.value);
  } catch (err) {
    if (isValidationError(err)) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
  return NextResponse.json(readAppSettings(userId));
});
