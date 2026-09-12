import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Real gap fixed (user: "if a new request comes in while Dave is busy with something else,
 * Dave doesn't just silently switch or silently ignore it"). This is the "is Dave currently
 * busy" half -- set right before a real agent-loop run starts, cleared when it finishes
 * (success or failure), same file-backed per-owner state pattern as ask-user.ts's pending
 * question.
 */
export interface BusyState {
  taskDescription: string;
  startedAt: number;
}

// Real bug fixed (user: "busy disturbing me if I change the settings -- I didn't change the
// settings did you, bro fix that"). Root cause: this module used ONE shared busy record per
// user for both a real live user turn AND the autonomous trading cycle. The autonomous loop
// now runs every 1 minute (compulsory) with no step cap and up to 5-minute EA round trips per
// tool call, so it can legitimately stay "busy" for long, overlapping stretches -- during which
// the user's own genuine attempt to talk to Dave (e.g. "set my lot size to 0.5") hit the SAME
// busy flag and got redirected into the mid-task delegation prompt ("I'm busy, queue this?"),
// even though the user never started anything and the autonomous cycle runs on its own separate
// conversation history. Split into two independent busy records -- "kind" picks the file -- so
// an in-flight autonomous scan can never block, delay, or delegate-prompt the user's own live
// conversation. The reverse still holds: the autonomous cycle itself still checks the real
// user-turn busy state (see telegram-bot-server.ts) before starting, so it never collides with
// a trade the user is actively placing by hand.
type BusyKind = "user" | "autonomous";

function busyPath(userId: string, kind: BusyKind): string {
  const file = kind === "autonomous" ? "busy-autonomous.json" : "busy.json";
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "agent-loop", userId, file);
}

function setBusyState(userId: string, kind: BusyKind, taskDescription: string): void {
  const path = busyPath(userId, kind);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const state: BusyState = { taskDescription, startedAt: Date.now() };
  writeFileSync(path, JSON.stringify(state), "utf8");
}

function clearBusyState(userId: string, kind: BusyKind): void {
  const path = busyPath(userId, kind);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(null), "utf8");
}

// Real bug fixed (user: "it doesn't trade... check anything limiting it"): busy.json was only
// ever cleared by the SAME process's own finally block. A hard crash/OOM/redeploy mid-turn (this
// really happens -- Railway logs have shown crashed deployments) skips that finally entirely and
// leaves a stale "busy" record on the persistent volume forever. Every future autonomous cycle and
// every future user message then reads busy=true and silently backs off, permanently, with no
// error anywhere -- a real, silent "it just stopped trading" bug with no exception to catch it.
// A busy state older than this is almost certainly stale from a dead process, not a real run still
// in flight (no real single turn -- including a full analysis suite + trade_execute -- legitimately
// takes this long), so it's treated as cleared rather than trusted forever.
//
// Real bug fixed (user, live: two messages minutes apart got answered "bundled" together). Root
// cause: a real turn's own tool loop has no step cap (agent-loop.ts) and a single EA round trip
// can genuinely take up to ~5 minutes on its own -- a turn with more than one such call could
// legitimately still be running past the old 5-minute mark. When that happened, THIS check would
// force-clear the busy lock out from under a still-live turn, letting a second message start a
// genuinely concurrent second turn -- both load/save conversation history, last write wins, and
// the two replies landing close together read exactly like "sent all in one." Widened well past
// the real worst case (a handful of multi-minute EA round trips in one turn) instead of the bare
// single-call estimate.
const MAX_BUSY_AGE_MS = 15 * 60_000;

function getBusyStateFor(userId: string, kind: BusyKind): BusyState | null {
  const path = busyPath(userId, kind);
  if (!existsSync(path)) return null;
  const state = JSON.parse(readFileSync(path, "utf8")) as BusyState | null;
  if (state && Date.now() - state.startedAt > MAX_BUSY_AGE_MS) return null;
  return state;
}

/** The real, live user conversation's busy state -- set around a real agent-loop turn started by
 *  something the user actually sent (a message, a resumed question). Never set by the autonomous
 *  trading cycle -- see setAutonomousBusy. */
export function setBusy(userId: string, taskDescription: string): void {
  setBusyState(userId, "user", taskDescription);
}

export function clearBusy(userId: string): void {
  clearBusyState(userId, "user");
}

export function getBusyState(userId: string): BusyState | null {
  return getBusyStateFor(userId, "user");
}

/** The autonomous trading cycle's OWN busy state -- completely separate from the real user's
 *  conversation, so an in-flight scan never blocks or delegate-prompts a real user message. */
export function setAutonomousBusy(userId: string, taskDescription: string): void {
  setBusyState(userId, "autonomous", taskDescription);
}

export function clearAutonomousBusy(userId: string): void {
  clearBusyState(userId, "autonomous");
}

export function getAutonomousBusyState(userId: string): BusyState | null {
  return getBusyStateFor(userId, "autonomous");
}
