import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

/**
 * Device pairing for the mobile app.
 *
 * The trader's flow: deploy to Railway, get an endpoint, put that endpoint in the app, and the
 * app "powers up" -- then never has to be told again.
 *
 * Why this exists rather than reusing the Basic Auth in middleware.ts: Basic Auth is a fine gate
 * for a browser (the browser owns the prompt, and closing it ends the session) and a bad one for
 * an app. An app has to STORE the password to re-send it on every request, there is no way to
 * revoke one phone without changing the password for every client including the web panel, and a
 * rotated password silently bricks the app with a 401 it cannot explain. A per-device token fixes
 * all three: each phone gets its own, any one can be revoked alone, and the web panel is
 * untouched.
 *
 * Shape of the exchange:
 *   1. The web panel (already behind Basic Auth) mints a short, human-typable PAIRING CODE.
 *   2. The app is given the endpoint + that code once.
 *   3. The app exchanges the code for a long-lived device token, and stores the token.
 *   4. The code is single-use and expires; the token is what every later request carries.
 *
 * The code is short because a person types it on a phone. That is exactly why it must be
 * single-use and short-lived -- those two properties, not its length, are what make it safe.
 */

/** Long enough that guessing is hopeless even though nothing rate-limits the exchange. */
const TOKEN_BYTES = 32;
/** Six characters from an unambiguous alphabet -- no O/0, no I/1/l -- because it is typed by hand. */
const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_CODE_LENGTH = 6;
/** A pairing code is meant to be used within a minute or two of being shown. */
export const PAIRING_CODE_TTL_MS = 10 * 60_000;

export interface PairedDevice {
  id: string;
  /** SHA-256 of the token. The raw token is shown ONCE, at pairing, and never stored -- so a
   *  leaked state file cannot be replayed against the API. */
  tokenHash: string;
  label: string;
  pairedAt: number;
  lastSeenAt?: number;
}

interface PairingCode {
  code: string;
  createdAt: number;
  /** Single-use: set the moment it is redeemed, so a shoulder-surfed code is already spent. */
  usedAt?: number;
}

interface DeviceAuthState {
  devices: PairedDevice[];
  pending?: PairingCode;
}

const EMPTY: DeviceAuthState = { devices: [] };

function statePath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "device-auth", userId, "state.json");
}

function read(userId: string): DeviceAuthState {
  const path = statePath(userId);
  if (!existsSync(path)) return { devices: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DeviceAuthState>;
    return { devices: Array.isArray(parsed.devices) ? parsed.devices : [], pending: parsed.pending };
  } catch {
    // A corrupt file must fail CLOSED -- no devices means no access, never "allow everyone".
    return { ...EMPTY };
  }
}

function write(userId: string, state: DeviceAuthState): void {
  const path = statePath(userId);
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2), "utf8");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}


/** Mints a fresh pairing code, replacing any previous unused one -- only one can ever be live. */
export function createPairingCode(userId: string): { code: string; expiresAt: number } {
  const bytes = randomBytes(PAIRING_CODE_LENGTH);
  let code = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) code += PAIRING_CODE_ALPHABET[bytes[i] % PAIRING_CODE_ALPHABET.length];
  const state = read(userId);
  state.pending = { code, createdAt: Date.now() };
  write(userId, state);
  return { code, expiresAt: Date.now() + PAIRING_CODE_TTL_MS };
}

export class PairingCodeInvalidError extends Error {
  constructor(reason: "unknown" | "expired" | "already-used") {
    super(
      reason === "expired"
        ? "That pairing code has expired. Generate a new one in the web panel."
        : reason === "already-used"
          ? "That pairing code has already been used. Generate a new one in the web panel."
          : "That pairing code is not valid. Check it and try again."
    );
    this.name = "PairingCodeInvalidError";
  }
}

/** Redeems a pairing code for a device token. The token is returned ONCE and never recoverable. */
export function redeemPairingCode(userId: string, code: string, label: string): { token: string; device: PairedDevice } {
  const state = read(userId);
  const pending = state.pending;
  if (!pending || pending.code !== code.trim().toUpperCase()) throw new PairingCodeInvalidError("unknown");
  if (pending.usedAt !== undefined) throw new PairingCodeInvalidError("already-used");
  if (Date.now() - pending.createdAt > PAIRING_CODE_TTL_MS) throw new PairingCodeInvalidError("expired");

  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const device: PairedDevice = {
    id: randomBytes(6).toString("hex"),
    tokenHash: hashToken(token),
    label: label.trim().slice(0, 60) || "Phone",
    pairedAt: Date.now(),
  };
  state.devices.push(device);
  // Spent, not deleted: keeping it marked used means a replay gets "already used" rather than
  // the indistinguishable "not valid", which is the difference between a clear message and a
  // confusing one for the person holding the phone.
  state.pending = { ...pending, usedAt: Date.now() };
  write(userId, state);
  return { token, device };
}

/** True when this token belongs to a paired device. Records the sighting for the devices list. */
/** The token check itself lives in @dave/db so the bot (which serves the app's chat) runs exactly
 *  the same code against the same state file. */
export { verifyDeviceToken } from "@dave/db";

export function listDevices(userId: string): Omit<PairedDevice, "tokenHash">[] {
  return read(userId).devices.map(({ tokenHash: _tokenHash, ...rest }) => rest);
}

/** Revokes one device without touching any other, which is the whole point of per-device tokens. */
export function revokeDevice(userId: string, deviceId: string): boolean {
  const state = read(userId);
  const before = state.devices.length;
  state.devices = state.devices.filter((d) => d.id !== deviceId);
  if (state.devices.length === before) return false;
  write(userId, state);
  return true;
}

/** Whether any device is paired at all -- lets the middleware skip token work entirely when none is. */
export function hasPairedDevices(userId: string): boolean {
  return read(userId).devices.length > 0;
}
