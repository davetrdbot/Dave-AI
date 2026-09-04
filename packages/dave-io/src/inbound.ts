import { writeWorkspaceFileBuffer } from "@dave/sandbox";
import type { TelegramClient } from "@dave/telegram";

/**
 * Step 15.1: any file type the user sends (document, image, video) gets
 * pulled into the sandbox workspace and read -- this is the real pull
 * step. Reading its *content* once it's a real file on disk is whatever
 * later step needs it (Step 20 for images/video, plain text read for
 * documents); this module's job stops at "genuinely on disk, in the
 * right workspace, real bytes, not a stub".
 */
export interface DownloadedFile {
  /** Path relative to the workspace root -- matches what writeWorkspaceFileBuffer/readWorkspaceFileBuffer expect. */
  relativePath: string;
  /** Absolute path, for callers that need it directly. */
  absolutePath: string;
  byteLength: number;
}

export async function pullTelegramFileIntoWorkspace(
  client: TelegramClient,
  fileId: string,
  workspaceRoot: string,
  filename: string
): Promise<DownloadedFile> {
  const bytes = await client.downloadFile(fileId);
  const relativePath = `inbox/${filename}`;
  const absolutePath = writeWorkspaceFileBuffer(workspaceRoot, relativePath, bytes);
  return { relativePath, absolutePath, byteLength: bytes.byteLength };
}
