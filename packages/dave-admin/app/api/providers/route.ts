import { NextRequest, NextResponse } from "next/server";
import { DaveDatabase } from "@dave/db";
import { dbPathFor } from "../../../server/db-path";
import { listProviderCatalog, listCustomProviders, createCustomProvider, editCustomProvider, deleteCustomProvider } from "@dave/brain";

/**
 * Update 4: "admin UI has same capability" as the agent tools in
 * provider-tools.ts -- create/edit/delete a custom provider (endpoint
 * + key), plus list the full built-in catalog.
 */
function dbFor(userId: string): DaveDatabase {
  return new DaveDatabase(dbPathFor(userId));
}

export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  const db = dbFor(userId);
  try {
    return NextResponse.json({
      builtIn: listProviderCatalog().map((p) => ({ id: p.id, displayName: p.displayName, openAICompatible: p.openAICompatible, manualModelEntry: p.manualModelEntry })),
      custom: listCustomProviders(db, userId),
    });
  } finally {
    db.close();
  }
}

export async function POST(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  const body = await req.json();
  const db = dbFor(userId);
  try {
    if (body.id) {
      const updated = editCustomProvider(db, userId, body.id, body);
      if (!updated) return NextResponse.json({ error: "not found" }, { status: 404 });
      return NextResponse.json(updated);
    }
    const created = createCustomProvider(db, userId, { name: body.name, baseUrl: body.baseUrl, apiKey: body.apiKey, model: body.model, chatPath: body.chatPath });
    return NextResponse.json(created);
  } finally {
    db.close();
  }
}

export async function DELETE(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "default";
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const db = dbFor(userId);
  try {
    return NextResponse.json({ removed: deleteCustomProvider(db, userId, id) });
  } finally {
    db.close();
  }
}
