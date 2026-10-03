/** Growth share link: export from one bot, import into another; revoke kills the link. */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.DAVE_DATA_ROOT = mkdtempSync(join(tmpdir(), "share-"));
const g = await import("../src/growth.js");
const s = await import("../src/growth-share.js");

g.learnFact("friend", "liquidity", "VOL_10 sweeps of the Asian low reverse within 3 M15 candles", { strength: 4 });
g.learnFact("friend", "Gold timing", "XAUUSD fakes the London open move before the real one");
const st = g.getStrategyState("friend");
st.rules.push({ id: "r1", text: "No entries in the last 5 minutes before NY open", addedInV: 1 });
st.avoidSymbols.push({ symbol: "VOL_80", addedInV: 1 });
g.saveStrategyState("friend", st);
g.learnFact("me", "liquidity", "VOL_10 sweeps of the Asian low reverse within 3 M15 candles");

assert.equal(s.getGrowthShareToken("friend"), null);
const token = s.createGrowthShareToken("friend");
assert.equal(s.createGrowthShareToken("friend"), token, "one link per bot");
assert.equal(s.growthShareOwner(token), "friend");
assert.equal(s.growthShareOwner("../../etc"), null);

const bundle = JSON.parse(JSON.stringify(s.exportGrowthBundle("friend")));
assert.equal(bundle.kind, "dave-growth");
const r = s.importGrowthBundle("me", bundle);
assert.deepEqual(r, { newFacts: 1, confirmedFacts: 1, newRules: 1, newAvoided: 1 });
const mine = g.listNeurons("me");
assert.ok(mine.some((n) => n.id === "gold_timing" && n.facts.length === 1), "a new neuron comes over");
assert.equal(mine.find((n) => n.id === "liquidity")!.facts.length, 1, "a known fact is confirmed, not duplicated");
const again = s.importGrowthBundle("me", bundle);
assert.equal(again.newFacts + again.newRules + again.newAvoided, 0, "importing twice adds nothing new");
assert.throws(() => s.importGrowthBundle("me", { hello: 1 }), /Growth share/);

assert.ok(s.parseGrowthShareUrl(`https://bot.up.railway.app/api/share/growth/${token}`));
assert.equal(s.parseGrowthShareUrl("https://evil.example/anything"), null);
assert.equal(s.parseGrowthShareUrl(`http://bot.example/api/share/growth/${token}`), null, "https only");

assert.ok(s.revokeGrowthShareToken("friend"));
assert.equal(s.growthShareOwner(token), null, "revoked link stops working");
console.log("=== ALL ASSERTIONS PASSED ===");
