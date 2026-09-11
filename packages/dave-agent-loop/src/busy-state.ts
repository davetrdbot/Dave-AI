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

function busyPath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "agent-loop", userId, "busy.json");
}

export function setBusy(userId: string, taskDescription: string): void {
  const path = busyPath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const state: BusyState = { taskDescription, startedAt: Date.now() };
  writeFileSync(path, JSON.stringify(state), "utf8");
}

export function clearBusy(userId: string): void {
  const path = busyPath(userId);
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
const MAX_BUSY_AGE_MS = 5 * 60_000;

export function getBusyState(userId: string): BusyState | null {
  const path = busyPath(userId);
  if (!existsSync(path)) return null;
  const state = JSON.parse(readFileSync(path, "utf8")) as BusyState | null;
  if (state && Date.now() - state.startedAt > MAX_BUSY_AGE_MS) return null;
  return state;
}
