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
// cause: a real USER turn's own tool loop has no step cap (agent-loop.ts) and a single EA round
// trip can genuinely take up to ~5 minutes on its own -- a turn with more than one such call
// could legitimately still be running past the old 5-minute mark. When that happened, THIS check
// would force-clear the busy lock out from under a still-live turn, letting a second message
// start a genuinely concurrent second turn -- both load/save conversation history, last write
// wins, and the two replies landing close together read exactly like "sent all in one." Widened
// well past the real worst case (a handful of multi-minute EA round trips in one turn) instead of
// the bare single-call estimate.
const MAX_USER_BUSY_AGE_MS = 15 * 60_000;

// Real regression fixed (caught live, right after widening the user window above to 15 minutes):
// this used to be ONE shared constant for both busy kinds, so a container restart mid-cycle
// (confirmed live: a real BOOM_200 cycle was still "running" when a redeploy killed the process,
// leaving busy-autonomous.json stale) now took up to 15 minutes to self-heal instead of the
// original ~5-6 -- three real trading cycles silently skipped for no good reason. The autonomous
// tick's own real worst case is much tighter than a user turn's unbounded tool loop -- one
// decision call, one optional Journal consult round, and the EA's own analysis fetch -- so its
// staleness window stays close to the original bound instead of inheriting the user turn's wider
// one.
const MAX_AUTONOMOUS_BUSY_AGE_MS = 6 * 60_000;

function maxAgeFor(kind: BusyKind): number {
  return kind === "autonomous" ? MAX_AUTONOMOUS_BUSY_AGE_MS : MAX_USER_BUSY_AGE_MS;
}

function getBusyStateFor(userId: string, kind: BusyKind): BusyState | null {
  const path = busyPath(userId, kind);
  if (!existsSync(path)) return null;
  const state = JSON.parse(readFileSync(path, "utf8")) as BusyState | null;
  if (state && Date.now() - state.startedAt > maxAgeFor(kind)) return null;
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

// Real bug fixed (independent audit, confirmed): the "delegate:pause" button handler in
// telegram-bot-server.ts started a SECOND runAgentTurn() for the queued message(s) as soon as
// the button was tapped, on the assumption that by then the original (still possibly in-flight)
// turn had already finished. It hadn't necessarily -- runAgentTurn's own setBusy()/clearBusy()
// only clears busy when that original loop.run() genuinely returns, and a slow tool call (an EA
// round trip can take minutes) can easily still be running when the user taps the button. Both
// runAgentTurn calls then load conversation-store.ts's history around the same starting point and
// each save their own final result at the end -- last save wins, silently dropping whichever
// turn's exchange finished first. There is no lock in conversation-store.ts to catch this, so the
// fix has to stop the second call from ever starting while the first is still genuinely running:
// poll the real busy flag until it's actually clear (not just assume it is) before letting a
// queued message's runAgentTurn begin, making the two load/save cycles genuinely sequential.
//
// Bounded rather than unbounded: if busy is SOMEHOW still set after a generous ceiling (far past
// any real turn's worst case -- see MAX_USER_BUSY_AGE_MS's own reasoning above), something else is
// already wrong (a stuck turn, a bug), and hanging this button-tap handler forever would just add
// a second bug on top of the first. Proceeds anyway at that point, but logs it loudly so it's
// visible rather than a second silent failure mode.
export interface WaitForBusyClearOptions {
  /** How often to re-check busy state. Real default: fast enough to feel responsive to a user who
   *  just tapped a button, slow enough not to hammer the filesystem. */
  pollIntervalMs?: number;
  /** Upper bound on total wait before giving up and proceeding anyway. */
  timeoutMs?: number;
  /** Injectable for tests -- real callers never pass this. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock for tests -- real callers never pass this. */
  now?: () => number;
  /** Injectable busy check for tests -- real callers never pass this (defaults to the real
   *  file-backed getBusyState). */
  getBusy?: (userId: string) => BusyState | null;
}

export const WAIT_FOR_BUSY_POLL_INTERVAL_MS = 300;
export const WAIT_FOR_BUSY_TIMEOUT_MS = 45_000;

export interface WaitForBusyClearResult {
  /** True if busy genuinely cleared before the timeout; false if the timeout was hit and this
   *  proceeded anyway. */
  cleared: boolean;
  waitedMs: number;
}

/**
 * Polls the given owner's real user-turn busy state until it's actually clear (null), instead of
 * assuming a prior turn has already finished. Resolves as soon as busy clears, or once
 * `timeoutMs` has elapsed -- whichever comes first -- so callers (the delegate:pause handler)
 * never start a second runAgentTurn concurrently with a first one that's still genuinely running.
 */
export async function waitForBusyToClear(userId: string, options: WaitForBusyClearOptions = {}): Promise<WaitForBusyClearResult> {
  const pollIntervalMs = options.pollIntervalMs ?? WAIT_FOR_BUSY_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? WAIT_FOR_BUSY_TIMEOUT_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const getBusy = options.getBusy ?? getBusyState;

  const start = now();
  while (getBusy(userId)) {
    const waitedMs = now() - start;
    if (waitedMs >= timeoutMs) {
      console.warn(
        `[busy-state] waitForBusyToClear: ${userId} still busy after ${waitedMs}ms -- proceeding anyway ` +
          `(the original turn should have finished by now; this may indicate a stuck turn or a bug)`
      );
      return { cleared: false, waitedMs };
    }
    await sleep(pollIntervalMs);
  }
  return { cleared: true, waitedMs: now() - start };
}
