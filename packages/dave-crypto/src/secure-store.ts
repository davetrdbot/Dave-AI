import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * Step 19.5: credentials stored securely, never dumped in plain
 * readable config. Real audit before writing this found MT5 passwords
 * and the DAVEMA API key were both written to disk as plain JSON
 * (0600-permissioned, but genuinely readable plaintext) -- this module
 * is what actually fixes that, applied to both call sites.
 *
 * AES-256-GCM (authenticated encryption -- a tampered ciphertext fails
 * to decrypt rather than silently returning garbage), a 256-bit key
 * derived from a master secret via scrypt (a deliberately memory-hard
 * KDF, not a bare hash), and a fresh random 96-bit IV per encryption
 * (the standard recommended GCM IV size -- reusing an IV under the
 * same key is what actually breaks GCM's security guarantees, so a new
 * one is generated every single call, never cached or derived
 * deterministically).
 *
 * The master key comes from `DAVE_CREDENTIALS_KEY` (an env var, real
 * secret management on Railway -- not committed, not written to disk
 * by this repo). Deliberately fails closed: encrypting or decrypting
 * without that env var set throws rather than silently falling back to
 * plaintext.
 *
 * Lives in its own leaf package (@dave/crypto, zero dependencies) --
 * not inside @dave/safety -- specifically so dave-trading and
 * dave-davema (whose credential files this fixes) can depend on it
 * directly without creating a cycle (dave-safety depends on
 * @dave/workers, which depends on @dave/trading).
 */

const IV_LENGTH = 12; // 96 bits, the recommended GCM IV size
const KEY_LENGTH = 32; // 256 bits
const SALT = "dave-credentials-v1"; // fixed, non-secret -- scrypt's memory-hardness is the real protection here, not salt secrecy

export class MissingCredentialsKeyError extends Error {
  constructor() {
    super("DAVE_CREDENTIALS_KEY is not set -- refusing to encrypt or decrypt credentials rather than fall back to plaintext");
    this.name = "MissingCredentialsKeyError";
  }
}

function deriveKey(masterKey: string): Buffer {
  if (!masterKey) throw new MissingCredentialsKeyError();
  return scryptSync(masterKey, SALT, KEY_LENGTH);
}

/** Encrypts one string value. Returns `iv:authTag:ciphertext`, all hex -- a single self-contained blob safe to store as one JSON string field. */
export function encryptSecret(plaintext: string, masterKey: string): string {
  const key = deriveKey(masterKey);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

export class DecryptionError extends Error {
  constructor(reason: string) {
    super(`failed to decrypt credential: ${reason}`);
    this.name = "DecryptionError";
  }
}

export function decryptSecret(blob: string, masterKey: string): string {
  const parts = blob.split(":");
  if (parts.length !== 3) throw new DecryptionError("malformed blob -- expected iv:authTag:ciphertext");
  const [ivHex, authTagHex, ciphertextHex] = parts;
  const key = deriveKey(masterKey);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, "hex")), decipher.final()]);
    return plaintext.toString("utf8");
  } catch (err) {
    // GCM's auth tag check failing (tampered/corrupted data, or wrong key) throws here --
    // surfaced as a real, distinguishable error rather than returning corrupted plaintext.
    throw new DecryptionError(err instanceof Error ? err.message : String(err));
  }
}
