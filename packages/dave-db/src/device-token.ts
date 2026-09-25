import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * The paired-phone token check, shared by both processes that serve the app: the admin panel
 * (every /api/app/* route, via withDevice) and the bot (the chat routes, which run where Dave
 * runs). One implementation, one state file -- data/device-auth/<userId>/state.json, written by the
 * admin's pairing flow -- so a phone paired once is recognised by both, and revoked in both.
 */

interface StoredDevice {
  id: string;
  tokenHash: string;
  lastSeenAt?: number;
}

export function deviceAuthStatePath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "device-auth", userId, "state.json");
}

export function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function hashesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/** True when `token` belongs to a paired, unrevoked device. A missing or corrupt state file fails CLOSED. */
export function verifyDeviceToken(userId: string, token: string): boolean {
  if (!token) return false;
  const path = deviceAuthStatePath(userId);
  if (!existsSync(path)) return false;
  let state: { devices?: StoredDevice[] } & Record<string, unknown>;
  try {
    state = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
  const devices = Array.isArray(state.devices) ? state.devices : [];
  const candidate = hashDeviceToken(token);
  const device = devices.find((d) => typeof d.tokenHash === "string" && hashesEqual(d.tokenHash, candidate));
  if (!device) return false;
  // Best-effort last-seen; a failed write never turns a valid token into a rejected one.
  try {
    device.lastSeenAt = Date.now();
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2), "utf8");
  } catch {
    /* ignore */
  }
  return true;
}
