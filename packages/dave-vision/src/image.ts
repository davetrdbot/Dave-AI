import type { ImageContentBlock } from "@dave/brain";

/**
 * Step 20.1: images -- the raw file handed directly to the model call.
 * No OCR, no captioning pre-step, no description-in-the-middle -- the
 * downloaded file's actual bytes (Step 15's real Telegram download)
 * become a real Anthropic image content block, base64-encoded, nothing
 * more. Real limits confirmed against the current API docs: 10MB per
 * image (base64-encoded) via the direct API, max 8000x8000px (not
 * checked here -- that needs real image decoding this module
 * deliberately doesn't do, staying true to "raw file handed directly",
 * not re-encoded or inspected).
 */

export type SupportedImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

const EXTENSION_TO_MEDIA_TYPE: Record<string, SupportedImageMediaType> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const MAX_BASE64_BYTES = 10 * 1024 * 1024; // 10MB, confirmed real Claude direct-API limit

export class UnsupportedImageTypeError extends Error {
  constructor(extension: string) {
    super(`"${extension}" is not a supported image type -- expected one of: ${Object.keys(EXTENSION_TO_MEDIA_TYPE).join(", ")}`);
    this.name = "UnsupportedImageTypeError";
  }
}

export class ImageTooLargeError extends Error {
  constructor(base64Bytes: number) {
    super(`base64-encoded image is ${base64Bytes} bytes, exceeds the real 10MB Claude API limit`);
    this.name = "ImageTooLargeError";
  }
}

export function mediaTypeFromExtension(filename: string): SupportedImageMediaType {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  const mediaType = EXTENSION_TO_MEDIA_TYPE[ext];
  if (!mediaType) throw new UnsupportedImageTypeError(ext);
  return mediaType;
}

/** The real, unmodified raw bytes -- base64-encoded, handed straight into the model call. */
export function buildImageContentBlock(rawBytes: Buffer, filename: string): ImageContentBlock {
  const mediaType = mediaTypeFromExtension(filename);
  const data = rawBytes.toString("base64");
  if (data.length > MAX_BASE64_BYTES) throw new ImageTooLargeError(data.length);
  return { type: "image", source: { type: "base64", media_type: mediaType, data } };
}
