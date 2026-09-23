import { NextResponse } from "next/server";
import {
  isBotRunning,
  setBotRunning,
  isExecutionEnabled,
  setExecutionEnabled,
  getIntervalMinutes,
  setIntervalMinutes,
  InvalidIntervalError,
  MIN_TRADING_LOOP_MINUTES,
  MAX_TRADING_LOOP_MINUTES,
} from "../../../../server/bot-control";
import { withDevice } from "../../../../server/require-device";

/**
 * Start / stop the bot, set the scan interval, and switch execution between normal and watch-only.
 *
 * Two levers, not one, because they are genuinely different and the app should not pretend
 * otherwise:
 *   - `running`  -- whether Dave scans for setups at all.
 *   - `execution` -- whether a normal decision may auto-fire. Off means Dave keeps analysing and
 *     keeps managing what is already open, but a normal setup is surfaced for approval instead of
 *     taken. This is what /stop_trading has always done on the Telegram side.
 *
 * What stopping does NOT do: it does not close open positions, and it does not abort a cycle
 * already in flight. Closing a position is a real trading decision and stays an explicit action,
 * never a side effect of a toggle -- the response says so rather than leaving it to be assumed.
 *
 * Timing, honestly: `running` is re-read by the bot on every poll tick (~5s), so a stop lands
 * within one tick. `execution` is re-read per decision and again mid-flight. Neither waits for
 * the next full scan.
 *
 * One real limitation, stated because a stop button that lies is the worst kind: this can HOLD a
 * running loop, not arm a stopped one. The interval lives in the bot process's memory and the
 * admin process cannot reach it. Setting running=true records the intent and the loop comes back
 * on the next restart's boot-time resume -- or immediately, if the loop is still armed.
 */

export const GET = withDevice(async ({ userId }) => {
  return NextResponse.json({
    running: isBotRunning(userId),
    executionEnabled: isExecutionEnabled(userId),
    intervalMinutes: getIntervalMinutes(userId),
    intervalBounds: { min: MIN_TRADING_LOOP_MINUTES, max: MAX_TRADING_LOOP_MINUTES },
  });
});

export const POST = withDevice(async ({ userId, req }) => {
  let body: { running?: boolean; executionEnabled?: boolean; intervalMinutes?: number };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  if (body.intervalMinutes !== undefined) {
    try {
      setIntervalMinutes(userId, body.intervalMinutes);
    } catch (err) {
      if (err instanceof InvalidIntervalError) return NextResponse.json({ error: err.message }, { status: 400 });
      throw err;
    }
  }
  if (body.executionEnabled !== undefined) setExecutionEnabled(userId, body.executionEnabled);
  if (body.running !== undefined) setBotRunning(userId, body.running);

  const running = isBotRunning(userId);
  return NextResponse.json({
    ok: true,
    running,
    executionEnabled: isExecutionEnabled(userId),
    intervalMinutes: getIntervalMinutes(userId),
    note:
      body.running === false
        ? "Scanning stops within about 5 seconds. Open positions are untouched -- close them yourself if that is what you want."
        : body.running === true
          ? "Scanning resumes on the next tick if the loop is armed, or at the next restart if it is not."
          : undefined,
  });
});
