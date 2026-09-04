import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Step 19.4 (controller side): launches the real separate watchdog
 * process and exposes its real alerts. `fork()` is Node's real
 * mechanism for spawning a genuinely separate Node.js process with an
 * IPC channel -- confirmed distinct from the parent by PID.
 */

export type WatchdogEvent = { type: "down"; ts: number; staleness: number } | { type: "recovered"; ts: number };

export interface Watchdog {
  process: ChildProcess;
  pid: number;
  onEvent: (handler: (event: WatchdogEvent) => void) => void;
  stop: () => void;
}

export interface WatchdogOptions {
  heartbeatPath: string;
  timeoutMs: number;
  pollIntervalMs?: number;
}

export function startWatchdog(options: WatchdogOptions): Watchdog {
  const entryPath = fileURLToPath(new URL("./watchdog-entry.js", import.meta.url));
  const child = fork(entryPath, [], {
    env: {
      ...process.env,
      DAVE_HEARTBEAT_PATH: options.heartbeatPath,
      DAVE_HEARTBEAT_TIMEOUT_MS: String(options.timeoutMs),
      DAVE_WATCHDOG_POLL_MS: String(options.pollIntervalMs ?? 1000),
    },
  });

  if (child.pid === process.pid) {
    // Cannot actually happen (fork() always creates a new PID) -- a real assertion,
    // not decorative, since "genuinely separate process" is the whole point of 19.4.
    throw new Error("watchdog process shares the parent's PID -- fork() did not create a separate process");
  }

  return {
    process: child,
    pid: child.pid!,
    onEvent: (handler) => child.on("message", (msg) => handler(msg as WatchdogEvent)),
    stop: () => child.kill(),
  };
}
