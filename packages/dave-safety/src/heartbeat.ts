import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Step 19.4 (main-process side): Dave's own process writes a real
 * timestamp to a real file on a real interval. This is the only thing
 * the main process needs to know about the watchdog -- it has no idea
 * anything is watching it, it just tells the truth about being alive.
 */

export function emitHeartbeat(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify({ ts: Date.now() }), "utf8");
}

export interface HeartbeatLoop {
  stop: () => void;
}

export function startHeartbeatLoop(path: string, intervalMs: number): HeartbeatLoop {
  emitHeartbeat(path);
  const timer = setInterval(() => emitHeartbeat(path), intervalMs);
  return { stop: () => clearInterval(timer) };
}
