import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Step 10.8: real trades on either Dave's own connected MT5 account, or
 * the user's own separate account. If the user provides their own
 * separate credentials, store them securely -- same secure-credential
 * path as everything else (0600 file, masked accessor, raw value only
 * ever read for building an outgoing request), same pattern as
 * dave-davema/credentials.ts.
 */

export type AccountChoice = "dave-default" | "own-account";

export interface Mt5Credentials {
  login: string;
  password: string;
  server: string;
}

function credentialPath(userId: string): string {
  return join(process.cwd(), "data", "credentials", userId, "mt5-own-account.json");
}

function choicePath(userId: string): string {
  return join(process.cwd(), "data", "trading", userId, "account-choice.json");
}

export function storeOwnMt5Credentials(userId: string, creds: Mt5Credentials): void {
  const path = credentialPath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(creds), "utf8");
  chmodSync(path, 0o600);
}

/** Raw credentials -- only for building the outgoing EA/broker connection. Never log or display this. */
export function getOwnMt5Credentials(userId: string): Mt5Credentials | undefined {
  const path = credentialPath(userId);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8"));
}

export function getMaskedOwnMt5Credentials(userId: string): { login: string; server: string } | undefined {
  const creds = getOwnMt5Credentials(userId);
  if (!creds) return undefined;
  return { login: creds.login, server: creds.server }; // login/server are identifiers, not secrets; password never returned
}

export function deleteOwnMt5Credentials(userId: string): boolean {
  const path = credentialPath(userId);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

export function setAccountChoice(userId: string, choice: AccountChoice): void {
  if (choice === "own-account" && !getOwnMt5Credentials(userId)) {
    throw new Error('Cannot select "own-account" before storing MT5 credentials for it.');
  }
  const path = choicePath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify({ choice }), "utf8");
}

export function getAccountChoice(userId: string): AccountChoice {
  const path = choicePath(userId);
  if (!existsSync(path)) return "dave-default";
  return JSON.parse(readFileSync(path, "utf8")).choice;
}
