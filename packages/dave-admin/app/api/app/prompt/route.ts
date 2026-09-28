import { NextResponse } from "next/server";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withDevice } from "../../../../server/require-device";

/**
 * Dave's prompt, open and editable from the phone (Settings -> Dave's prompt). Each part can be
 * rewritten; a rewrite is saved to data/prompts/<file> and wins over the shipped copy, and the
 * bot picks it up on its next turn. Reset deletes the rewrite and goes back to the shipped text.
 */
export const dynamic = "force-dynamic";

const FILES: { file: string; title: string; about: string }[] = [
  { file: "SOUL.md", title: "Personality", about: "Who Dave is and how he carries himself." },
  { file: "IDENTITY.md", title: "How Dave works", about: "Tools, requests, memory, messages, the rules of the job." },
  { file: "trading.md", title: "Trading", about: "How he hunts, enters, manages and closes trades." },
  { file: "SECURITY.md", title: "Safety", about: "What he must never do." },
  { file: "BOOTSTRAP.md", title: "First contact", about: "How he introduces himself the first time." },
];
const MAX_CHARS = 200_000;

const root = () => process.env.DAVE_DATA_ROOT ?? join(process.cwd(), "..", "..");
const customPath = (file: string) => join(root(), "data", "prompts", file);
/** The shipped prompts live with the code, not in the data folder -- on the server DAVE_DATA_ROOT
 *  is the volume, which has no prompts/ of its own, so the editor opened empty (the trader: "when
 *  I want to write my own prompt, the existing prompt should show"). Tried in order. */
const shippedPath = (file: string) => {
  const candidates = [join(process.cwd(), "..", "..", "prompts", file), join(process.cwd(), "prompts", file), join(root(), "prompts", file)];
  return candidates.find((c) => existsSync(c)) ?? candidates[0];
};

function read(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function view() {
  return {
    parts: FILES.map((f) => {
      const custom = existsSync(customPath(f.file));
      return { ...f, custom, text: custom ? read(customPath(f.file)) : read(shippedPath(f.file)) };
    }),
  };
}

export const GET = withDevice(async () => NextResponse.json(view()));

export const POST = withDevice(async ({ req }) => {
  let body: { file?: string; text?: unknown; reset?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const part = FILES.find((f) => f.file === body.file);
  if (!part) return NextResponse.json({ error: "Unknown prompt part." }, { status: 400 });
  if (body.reset) {
    rmSync(customPath(part.file), { force: true });
    return NextResponse.json(view());
  }
  const text = typeof body.text === "string" ? body.text : "";
  if (!text.trim()) return NextResponse.json({ error: "The prompt can't be empty -- use Reset to go back to the original." }, { status: 400 });
  if (text.length > MAX_CHARS) return NextResponse.json({ error: "That's too long." }, { status: 413 });
  mkdirSync(join(root(), "data", "prompts"), { recursive: true });
  writeFileSync(customPath(part.file), text, "utf8");
  return NextResponse.json(view());
});
