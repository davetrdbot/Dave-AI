import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { getStrategyState, saveStrategyState, currentVersion, learnFact, listNeurons, type Neuron } from "./growth.js";

/**
 * Growth share link (the trader: "copy a link from my friend's Growth page and paste it in mine,
 * and everything comes in"). The owner creates a link; anyone holding it can read this bot's
 * brain (neurons and their facts, the learned rules, the pairs Dave avoids) -- nothing else: no
 * account, keys, trades or settings. The token is 24 random bytes and can be revoked any time.
 */

export interface GrowthBundle {
  kind: "dave-growth";
  version: 1;
  exportedAt: number;
  neurons: Pick<Neuron, "id" | "label" | "facts">[];
  rules: string[];
  avoidSymbols: string[];
}

interface ShareIndex {
  [token: string]: { userId: string; createdAt: number };
}

function indexPath(): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "trading", "growth-shares.json");
}
function readIndex(): ShareIndex {
  try {
    if (existsSync(indexPath())) return JSON.parse(readFileSync(indexPath(), "utf8")) as ShareIndex;
  } catch {
    /* a broken file means no links */
  }
  return {};
}
function writeIndex(i: ShareIndex): void {
  mkdirSync(dirname(indexPath()), { recursive: true });
  writeFileSync(indexPath(), JSON.stringify(i, null, 2), "utf8");
}

/** The user's current share token, or null. */
export function getGrowthShareToken(userId: string): string | null {
  const hit = Object.entries(readIndex()).find(([, v]) => v.userId === userId);
  return hit ? hit[0] : null;
}

/** Creates (or returns the existing) share token for this user. */
export function createGrowthShareToken(userId: string, now = Date.now()): string {
  const existing = getGrowthShareToken(userId);
  if (existing) return existing;
  const token = randomBytes(24).toString("base64url");
  const i = readIndex();
  i[token] = { userId, createdAt: now };
  writeIndex(i);
  return token;
}

/** Turns the link off -- the old URL stops working at once. */
export function revokeGrowthShareToken(userId: string): boolean {
  const i = readIndex();
  let hit = false;
  for (const [t, v] of Object.entries(i)) if (v.userId === userId) { delete i[t]; hit = true; }
  if (hit) writeIndex(i);
  return hit;
}

export function growthShareOwner(token: string): string | null {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  return readIndex()[token]?.userId ?? null;
}

export function exportGrowthBundle(userId: string, now = Date.now()): GrowthBundle {
  const s = getStrategyState(userId);
  return {
    kind: "dave-growth",
    version: 1,
    exportedAt: now,
    neurons: listNeurons(userId).filter((n) => n.facts.length > 0).map((n) => ({ id: n.id, label: n.label, facts: n.facts })),
    rules: s.rules.map((r) => r.text),
    avoidSymbols: s.avoidSymbols.map((a) => a.symbol),
  };
}

export interface GrowthImportResult {
  newFacts: number;
  confirmedFacts: number;
  newRules: number;
  newAvoided: number;
}

/** Merges a friend's brain into this one. A fact this brain already knows is confirmed rather than
 *  duplicated; rules and avoided pairs already present are skipped. */
export function importGrowthBundle(userId: string, raw: unknown, now = Date.now()): GrowthImportResult {
  const b = raw as Partial<GrowthBundle> | null;
  if (!b || b.kind !== "dave-growth" || !Array.isArray(b.neurons)) throw new Error("That link does not hold a Dave Growth share.");
  const out: GrowthImportResult = { newFacts: 0, confirmedFacts: 0, newRules: 0, newAvoided: 0 };
  for (const n of b.neurons.slice(0, 60)) {
    if (!n || typeof n.id !== "string" || !Array.isArray(n.facts)) continue;
    for (const f of n.facts.slice(0, 30)) {
      if (!f || typeof f.text !== "string") continue;
      try {
        const r = learnFact(userId, n.label || n.id, f.text, { evidence: f.evidence ? `shared: ${f.evidence}` : "shared from another Dave", source: "trader", strength: f.strength }, now);
        if (r.isNew) out.newFacts++;
        else out.confirmedFacts++;
      } catch {
        /* a malformed fact is skipped */
      }
    }
  }
  const s = getStrategyState(userId);
  const v = currentVersion(s).v;
  for (const text of (Array.isArray(b.rules) ? b.rules : []).slice(0, 40)) {
    if (typeof text !== "string" || text.trim().length < 4) continue;
    if (s.rules.some((r) => r.text.trim().toLowerCase() === text.trim().toLowerCase())) continue;
    s.rules.push({ id: `shared-${randomBytes(3).toString("hex")}`, text: text.trim().slice(0, 400), addedInV: v });
    out.newRules++;
  }
  for (const sym of (Array.isArray(b.avoidSymbols) ? b.avoidSymbols : []).slice(0, 40)) {
    if (typeof sym !== "string" || !/^[A-Za-z0-9._#-]{2,24}$/.test(sym)) continue;
    if (s.avoidSymbols.some((a) => a.symbol.toUpperCase() === sym.toUpperCase())) continue;
    s.avoidSymbols.push({ symbol: sym.toUpperCase(), addedInV: v });
    out.newAvoided++;
  }
  saveStrategyState(userId, s);
  return out;
}

/** Only real share links are fetched (never an arbitrary address). */
export function parseGrowthShareUrl(raw: string): URL | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:" && !(u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1"))) return null;
    if (!/^\/api\/share\/growth\/[A-Za-z0-9_-]{20,64}$/.test(u.pathname)) return null;
    return u;
  } catch {
    return null;
  }
}
