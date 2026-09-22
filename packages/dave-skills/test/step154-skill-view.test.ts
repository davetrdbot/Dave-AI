import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workDir = mkdtempSync(join(tmpdir(), "dave-skillview-"));
process.env.DAVE_DATA_ROOT = workDir;

const { createSkill } = await import("../src/skill-store.js");
const { SKILL_TOOLS } = await import("../src/tools.js");
const { setActiveStrategySkill, clearActiveStrategySkill } = await import("@dave/trading");

/**
 * Two real findings from reading Hermes's skill tooling against Dave's.
 *
 * 1. Dave had NO skill_view. He could list skills (name + description) and ACTIVATE one -- which
 *    injects its content every turn -- but nothing in between. So "what does my Sniper strategy
 *    say about stops?" was unanswerable unless that skill happened to be active, and deciding
 *    whether a skill fits had to be done from a one-line description.
 * 2. list_skills returned the raw Skill records, which carry `content`. One call to a CORE tool --
 *    the one the model reaches for to answer "what skills do I have" -- dumped every skill's whole
 *    body into the conversation.
 */

console.log("=== Step 154: skill_view, and list_skills as a real index ===\n");

const USER = "user-skillview-1";
const tool = (name: string) => {
  const t = SKILL_TOOLS.find((s) => s.name === name);
  assert.ok(t, `${name} must be registered`);
  return t!;
};

// Two realistic strategy skills, big enough that dumping them is genuinely expensive.
const sniperBody = "# Sniper\n\n" + "Wait for the M1 sweep, then enter on the reclaim.\n".repeat(400);
const swingBody = "# Swing\n\n" + "H4 structure only. Stop beyond the swing, target the next pool.\n".repeat(400);
const sniper = createSkill(USER, { name: "Sniper", description: "scalping a swept low on M1", content: sniperBody, source: "self-created" });
const swing = createSkill(USER, { name: "Swing", description: "H4 structure swings", content: swingBody, source: "self-created" });
console.log(`   two skills stored: ${sniperBody.length} and ${swingBody.length} chars of content\n`);

// ---------------------------------------------------------------------------
console.log("[1] list_skills is an INDEX -- no content, whatever it costs to read\n");

const listed = (await tool("list_skills").execute({}, { userId: USER })) as Record<string, unknown>[];
assert.equal(listed.length, 2);
const serialisedIndex = JSON.stringify(listed);
for (const row of listed) {
  assert.equal(row.content, undefined, "a skill's body must never ride along in the index");
  assert.ok(typeof row.id === "string" && (row.id as string).length > 0, "every row carries the id skill_view needs");
  assert.ok(typeof row.name === "string", "and its name");
  assert.ok(typeof row.contentChars === "number", "and an honest size, so the cost of reading it is visible up front");
}
// The actual bug: the index must not be the same order of magnitude as the content it indexes.
assert.ok(
  serialisedIndex.length < (sniperBody.length + swingBody.length) / 10,
  `the index must be far smaller than the bodies -- index ${serialisedIndex.length} vs content ${sniperBody.length + swingBody.length}`
);
assert.ok(!serialisedIndex.includes("Wait for the M1 sweep"), "no body text leaked into the index");
console.log(`   ✓ index is ${serialisedIndex.length} chars for ${sniperBody.length + swingBody.length} chars of skills`);
assert.equal(listed.find((r) => r.id === sniper.id)!.contentChars, sniperBody.length, "size reported honestly");
console.log("   ✓ each row reports its real content size\n");

// ---------------------------------------------------------------------------
console.log("[2] skill_view reads one skill in full\n");

const viewed = (await tool("skill_view").execute({ skill: sniper.id }, { userId: USER })) as Record<string, unknown>;
assert.equal(viewed.id, sniper.id);
assert.equal(viewed.name, "Sniper");
assert.equal(viewed.content, sniperBody, "the whole body, verbatim");
console.log("   ✓ by id");

// The model sees names in the index every turn, so a name has to work too.
const byName = (await tool("skill_view").execute({ skill: "Swing" }, { userId: USER })) as Record<string, unknown>;
assert.equal(byName.id, swing.id, "resolved by exact name");
const byNameCased = (await tool("skill_view").execute({ skill: "swing" }, { userId: USER })) as Record<string, unknown>;
assert.equal(byNameCased.id, swing.id, "and case-insensitively -- the model retypes names from the index");
console.log("   ✓ by name, case-insensitive\n");

// ---------------------------------------------------------------------------
console.log("[3] Reading is not activating -- this is the whole reason it's safe to reach for\n");

clearActiveStrategySkill(USER);
await tool("skill_view").execute({ skill: sniper.id }, { userId: USER });
const activeAfterView = (await tool("get_active_strategy_skill").execute({}, { userId: USER })) as { active: boolean };
assert.equal(activeAfterView.active, false, "viewing a skill must never activate it -- activation is the trader's call alone");
console.log("   ✓ nothing was activated by reading\n");

// ---------------------------------------------------------------------------
console.log("[4] The ACTIVE skill is already in front of him -- don't serve a second copy\n");

setActiveStrategySkill(USER, sniper.id);
const activeView = (await tool("skill_view").execute({ skill: sniper.id }, { userId: USER })) as Record<string, unknown>;
assert.equal(activeView.contentReturned, false, "the active skill's content is injected every turn already");
assert.equal(activeView.content, undefined, "so it must not be duplicated into the same request");
assert.ok(String(activeView.reason).includes("active_strategy_skill"), "and he's told exactly where to read it instead");
assert.equal(activeView.name, "Sniper", "still identifies which skill he asked for");
console.log("   ✓ active skill returns a pointer, not a duplicate");

// A DIFFERENT skill must still come back in full while one is active -- that is the main case
// this tool exists for (checking whether to offer switching).
const otherWhileActive = (await tool("skill_view").execute({ skill: swing.id }, { userId: USER })) as Record<string, unknown>;
assert.equal(otherWhileActive.content, swingBody, "a non-active skill reads in full even while another is active");
assert.equal(otherWhileActive.active, false);
console.log("   ✓ a different skill still reads in full\n");

clearActiveStrategySkill(USER);

// ---------------------------------------------------------------------------
console.log("[5] A bad id fails honestly, pointing at the real way to recover\n");

await assert.rejects(
  () => tool("skill_view").execute({ skill: "no-such-skill" }, { userId: USER }),
  (err: Error) => {
    assert.ok(err.message.includes("no-such-skill"), "names what was asked for");
    assert.ok(err.message.includes("list_skills"), "and how to get real ids");
    return true;
  }
);
console.log("   ✓ unknown skill throws a usable error\n");

// ---------------------------------------------------------------------------
console.log("[6] skill_view is reachable without a discovery round\n");

const { CORE_TOOL_NAMES } = await import("../../dave-agent-loop/src/tool-selection.js");
assert.ok(CORE_TOOL_NAMES.includes("list_skills"), "the index is core");
// A lister that is core while its reader is discovery-gated is a dead end: the model sees a name
// every turn with no reachable way to find out what it says.
assert.ok(CORE_TOOL_NAMES.includes("skill_view"), "and so is the reader");
console.log("   ✓ both halves are core\n");

console.log("=== All sections passed ===");
