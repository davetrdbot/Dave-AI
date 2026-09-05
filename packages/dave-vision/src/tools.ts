import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DaveDatabase } from "@dave/db";
import { generateWithKeyFailover } from "@dave/brain";
import { buildImageContentBlock } from "./image.js";
import { extractKeyframes, transcribeAudioBytesWithKeyFailover } from "./video.js";

/**
 * Update 18 (bulk tool-coverage expansion): Step 20's real vision
 * capability (raw bytes -> content block -> Claude, real ffmpeg
 * keyframe extraction, real Groq timestamped transcription) had no
 * agent-tool surface.
 */
export interface VisionToolContext {
  userId: string;
  db: DaveDatabase;
}

export interface VisionToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: VisionToolContext) => Promise<unknown>;
}

export const VISION_TOOLS: VisionToolDefinition[] = [
  {
    name: "read_image",
    description: "Read a local image file's real raw bytes into a content block, ready to hand directly to a vision-capable model -- no OCR/description step in between.",
    parameters: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] },
    execute: async (args) => buildImageContentBlock(readFileSync(args.filePath as string), args.filePath as string),
  },
  {
    name: "analyze_image",
    description: "Read a real local image and ask your vision-capable provider (Claude) a real question about it, using your own stored provider keys.",
    parameters: { type: "object", properties: { filePath: { type: "string" }, question: { type: "string" } }, required: ["filePath", "question"] },
    execute: async (args, ctx) => {
      const block = buildImageContentBlock(readFileSync(args.filePath as string), args.filePath as string);
      const result = await generateWithKeyFailover(ctx.db, ctx.userId, "claude", {
        messages: [{ role: "user", content: [{ type: "text", text: args.question as string }, block] }],
      });
      return { text: result.text };
    },
  },
  {
    name: "process_video",
    description: "Real scene-aware keyframe extraction from a local video, inside the sandbox (real ffmpeg).",
    parameters: { type: "object", properties: { videoRelativePath: { type: "string" }, workspaceRoot: { type: "string" } }, required: ["videoRelativePath", "workspaceRoot"] },
    execute: async (args) => extractKeyframes(args.videoRelativePath as string, args.workspaceRoot as string),
  },
  {
    name: "transcribe_voice_note",
    description: "Real timestamped transcription of a local audio/video file via Groq, using your own stored Groq provider key (no key-passing needed) -- no separate audio-extraction step needed for video.",
    parameters: { type: "object", properties: { videoRelativePath: { type: "string" }, workspaceRoot: { type: "string" } }, required: ["videoRelativePath", "workspaceRoot"] },
    execute: async (args, ctx) => {
      const bytes = readFileSync(join(args.workspaceRoot as string, args.videoRelativePath as string));
      const filename = (args.videoRelativePath as string).split("/").pop() ?? "voice.ogg";
      return transcribeAudioBytesWithKeyFailover(ctx.db, ctx.userId, bytes, filename);
    },
  },
];
