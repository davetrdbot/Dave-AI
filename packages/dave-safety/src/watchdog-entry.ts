import { existsSync, readFileSync } from "node:fs";

/**
 * Step 19.4: this file runs as a GENUINELY SEPARATE OS process --
 * launched via `child_process.fork()` in watchdog-controller.ts, never
 * imported/called in-process. If Dave's main process crashes outright
 * (not just an unhandled promise rejection it survives), this process
 * keeps running and can still detect it and alert, which an in-process
 * watchdog could never do (it would die with everything else).
 *
 * Config arrives via env vars (fork() passes a real, separate env),
 * alerts go back to the parent via the real IPC channel `fork()`
 * establishes (`process.send`) -- not a shared in-memory variable,
 * since there genuinely isn't one between two OS processes.
 */

const heartbeatPath = process.env.DAVE_HEARTBEAT_PATH!;
const timeoutMs = Number(process.env.DAVE_HEARTBEAT_TIMEOUT_MS ?? "10000");
const pollIntervalMs = Number(process.env.DAVE_WATCHDOG_POLL_MS ?? "1000");

let currentlyDown = false;

function readLastHeartbeatTs(): number | null {
  if (!existsSync(heartbeatPath)) return null;
  try {
    const { ts } = JSON.parse(readFileSync(heartbeatPath, "utf8"));
    return typeof ts === "number" ? ts : null;
  } catch {
    return null; // a partial/corrupted write mid-read counts as "no fresh heartbeat", not a crash
  }
}

function tick(): void {
  const lastTs = readLastHeartbeatTs();
  const staleness = lastTs === null ? Infinity : Date.now() - lastTs;
  const isStale = staleness > timeoutMs;

  if (isStale && !currentlyDown) {
    currentlyDown = true;
    process.send?.({ type: "down", ts: Date.now(), staleness });
  } else if (!isStale && currentlyDown) {
    currentlyDown = false;
    process.send?.({ type: "recovered", ts: Date.now() });
  }
}

const interval = setInterval(tick, pollIntervalMs);
process.on("disconnect", () => clearInterval(interval)); // parent tore down the IPC channel -- stop polling, nothing left to report to
tick();
