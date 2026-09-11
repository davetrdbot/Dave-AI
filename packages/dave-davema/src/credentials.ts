import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { encryptSecret, decryptSecret } from "@dave/crypto";
import { isValidDavemaKeyFormat, maskDavemaKey } from "./endpoints.js";

/**
 * Secure-credential path for the user's DAVEMA API key, per SECURITY.md
 * ("Any credential you're given... is stored through the secure path,
 * never dumped into plain chat or logged in the open").
 *
 * Real implementation here: file-level restriction (0600, owner read/
 * write only), the key genuinely encrypted at rest (AES-256-GCM via
 * @dave/crypto, Step 19.5 -- an earlier version of this file wrote the
 * raw key straight into the JSON file, and a real audit flagged that
 * as still plaintext on disk regardless of file permissions), plus a
 * hard rule that the raw key never appears in any return value except
 * getDavemaKey() itself (used only to build the outgoing request
 * header) -- every other accessor is masked.
 */

function credentialPath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "credentials", userId, "davema.json");
}

function credentialsKey(): string {
  const key = process.env.DAVE_CREDENTIALS_KEY;
  if (!key) throw new Error("DAVE_CREDENTIALS_KEY is not set -- cannot store or read the DAVEMA key securely");
  return key;
}

export class InvalidDavemaKeyError extends Error {
  constructor() {
    super('That doesn\'t look like a DAVEMA key -- expected "sk_live_" followed by 48 hex characters.');
    this.name = "InvalidDavemaKeyError";
  }
}

export function storeDavemaKey(userId: string, key: string): void {
  const trimmed = key.trim();
  if (!isValidDavemaKeyFormat(trimmed)) throw new InvalidDavemaKeyError();
  const path = credentialPath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ encryptedKey: encryptSecret(trimmed, credentialsKey()), storedAt: Date.now() }), "utf8");
  chmodSync(path, 0o600);
}

/** Raw key -- only for building the outgoing x-api-key header. Never log or display this. */
export function getDavemaKey(userId: string): string | undefined {
  const path = credentialPath(userId);
  if (!existsSync(path)) return undefined;
  const onDisk = JSON.parse(readFileSync(path, "utf8"));
  return decryptSecret(onDisk.encryptedKey, credentialsKey());
}

export function hasDavemaKey(userId: string): boolean {
  return existsSync(credentialPath(userId));
}

/**
 * Real gap this fills: SECURITY.md requires "if a credential appears
 * exposed anywhere, tell the user immediately" and the DAVEMA docs call
 * out revoking a leaked key -- there was no way to actually remove a
 * stored key at all, only overwrite it via storeDavemaKey() (which does
 * work for rotation, but not for "just delete it").
 */
export function deleteDavemaKey(userId: string): boolean {
  const path = credentialPath(userId);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

/** Safe to show the user or log -- e.g. "sk_live_4f9a2b1c****...9d3e". */
export function getMaskedDavemaKey(userId: string): string | undefined {
  const key = getDavemaKey(userId);
  return key ? maskDavemaKey(key) : undefined;
}
