import { NextResponse } from "next/server";
import { DaveDatabase } from "@dave/db";
import { addE2BKey, listE2BKeys, removeE2BKey, checkE2BKeyHealth } from "@dave/e2b";
import { addFirecrawlKey, listFirecrawlKeys, removeFirecrawlKey } from "@dave/firecrawl";
import { dbPathFor } from "../../../../server/db-path";
import { maskSecret } from "../../../../server/mask-secret";
import { withDevice } from "../../../../server/require-device";

/**
 * The service keys Dave's tools run on, for the phone: E2B (runs scripts for him) and Firecrawl
 * (reads web pages). Same store and functions as the web panel's Credentials tab. A key is sent
 * once and only ever comes back masked.
 */
export const dynamic = "force-dynamic";

type Service = "e2b" | "firecrawl";

function view(db: DaveDatabase, userId: string) {
  const mask = (k: { id: string; label: string; apiKey: string }) => ({ id: k.id, label: k.label, key: maskSecret(k.apiKey) });
  return {
    e2b: { title: "E2B", about: "Lets Dave run real scripts (calculations, backtests, file work).", link: "https://e2b.dev/dashboard", keys: listE2BKeys(db, userId).map(mask) },
    firecrawl: { title: "Firecrawl", about: "Lets Dave read web pages and news.", link: "https://www.firecrawl.dev/app/api-keys", keys: listFirecrawlKeys(db, userId).map(mask) },
  };
}

function withDb<T>(userId: string, fn: (db: DaveDatabase) => T): T {
  const db = new DaveDatabase(dbPathFor(userId));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export const GET = withDevice(async ({ userId }) => NextResponse.json(withDb(userId, (db) => view(db, userId))));

export const POST = withDevice(async ({ userId, req }) => {
  let body: { action?: string; service?: Service; label?: string; apiKey?: string; keyId?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  if (body.service !== "e2b" && body.service !== "firecrawl") return NextResponse.json({ error: "service must be e2b or firecrawl." }, { status: 400 });
  const db = new DaveDatabase(dbPathFor(userId));
  try {
    if (body.action === "add") {
      const apiKey = String(body.apiKey ?? "").trim();
      if (apiKey.length < 8) return NextResponse.json({ error: "That doesn't look like an API key." }, { status: 400 });
      const label = String(body.label ?? "").trim() || `${body.service === "e2b" ? "E2B" : "Firecrawl"} key`;
      if (body.service === "e2b") addE2BKey(db, userId, label, apiKey);
      else addFirecrawlKey(db, userId, label, apiKey);
    } else if (body.action === "remove") {
      const id = String(body.keyId ?? "");
      const removed = body.service === "e2b" ? removeE2BKey(db, userId, id) : removeFirecrawlKey(db, userId, id);
      if (!removed) return NextResponse.json({ error: "That key is already gone." }, { status: 404 });
    } else if (body.action === "check" && body.service === "e2b") {
      const key = listE2BKeys(db, userId).find((k) => k.id === body.keyId);
      if (!key) return NextResponse.json({ error: "That key is gone." }, { status: 404 });
      return NextResponse.json({ ...view(db, userId), healthy: await checkE2BKeyHealth(db, userId, key) });
    } else {
      return NextResponse.json({ error: "action must be add, remove or check." }, { status: 400 });
    }
    return NextResponse.json(view(db, userId));
  } finally {
    db.close();
  }
});
