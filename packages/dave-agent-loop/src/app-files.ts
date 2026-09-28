import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { userUploadDir } from "@dave/e2b";

/**
 * Files in and out of the app's chat (the trader: "input and output of files in the app, so the
 * bot can send files to the app").
 *
 *   OUT -- whatever Dave sends with send_file_to_user (a CSV, a report, a chart) is kept here and
 *          shown in the chat as a file card; the app downloads it from /api/app/chat/file/<id>.
 *   IN  -- a file the trader attaches goes into the SAME inbox Telegram documents use, so Dave's
 *          run_script(attachUserFiles) and list_user_files already reach it.
 */

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const KEEP_FILES = 200;

function outDir(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "app-files", userId);
}

/** Letters, digits, dot, dash, underscore -- nothing that can walk out of the folder. */
export function safeFileName(name: string): string {
  const base = basename(name || "file").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "");
  return (base || "file").slice(0, 120);
}

const MIME: Record<string, string> = {
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".zip": "application/zip",
  ".html": "text/html",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".mq5": "text/plain",
  ".py": "text/plain",
};

export function mimeFor(name: string): string {
  return MIME[extname(name).toLowerCase()] ?? "application/octet-stream";
}

export interface AppFile {
  id: string;
  name: string;
  bytes: number;
  mime: string;
}

/** Keeps a file Dave sent, for the app to download. */
export function saveAppFile(userId: string, name: string, data: Buffer): AppFile {
  if (data.byteLength > MAX_FILE_BYTES) throw new Error(`That file is ${(data.byteLength / 1e6).toFixed(1)} MB -- the app takes up to 20 MB.`);
  const dir = outDir(userId);
  mkdirSync(dir, { recursive: true });
  const id = randomBytes(8).toString("hex");
  const safe = safeFileName(name);
  writeFileSync(join(dir, `${id}__${safe}`), data);
  prune(dir);
  return { id, name: safe, bytes: data.byteLength, mime: mimeFor(safe) };
}

export function readAppFile(userId: string, id: string): (AppFile & { data: Buffer }) | null {
  if (!/^[a-f0-9]{16}$/.test(id)) return null;
  const dir = outDir(userId);
  if (!existsSync(dir)) return null;
  const file = readdirSync(dir).find((f) => f.startsWith(`${id}__`));
  if (!file) return null;
  const data = readFileSync(join(dir, file));
  const name = file.slice(id.length + 2);
  return { id, name, bytes: data.byteLength, mime: mimeFor(name), data };
}

function prune(dir: string): void {
  const files = readdirSync(dir).map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  for (const old of files.slice(KEEP_FILES)) rmSync(join(dir, old.f), { force: true });
}

/** A file the trader attached in the app: into the shared inbox. Returns the name Dave uses. */
export function saveUserUpload(userId: string, name: string, data: Buffer): string {
  if (data.byteLength > MAX_FILE_BYTES) throw new Error(`"${name}" is ${(data.byteLength / 1e6).toFixed(1)} MB -- 20 MB max.`);
  const dir = userUploadDir(userId);
  let safe = safeFileName(name);
  // Never overwrite an earlier upload with the same name -- Dave may still be using it.
  if (existsSync(join(dir, safe))) safe = `${safe.replace(/(\.[^.]*)?$/, "")}-${Date.now().toString(36)}${extname(safe)}`;
  writeFileSync(join(dir, safe), data);
  return safe;
}

export const isImageName = (name: string) => /\.(png|jpe?g|gif|webp)$/i.test(name);
