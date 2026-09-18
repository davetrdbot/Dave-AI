import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workDir = mkdtempSync(join(tmpdir(), "dave-prompts-"));
process.env.DAVE_DATA_ROOT = workDir;

const { buildLiveSettingsBlock, buildClockLine } = await import("../src/live-context.js");
const { CORE_TOOL_NAMES } = await import("../src/tool-selection.js");
const { knowledgeDraft, knowledgeSave } = await import("@dave/knowledge");
const { appendUserFact, appendAdaptability } = await import("@dave/memory");
const { MEMORY_WRITE_TOOLS } = await import("@dave/memory");
const { SKILL_TOOLS } = await import("@dave/skills");
const { KNOWLEDGE_TOOLS } = await import("@dave/knowledge");

/**
 * Real bugs fixed, all four reported by the trader off a live Telegram transcript:
 *
 *  "it doesn't obey it's rules... he said trading.md to me -- is it supposed to make mention
 *   about that to me" -> Dave leaked the name of one of its own internal prompt files. Not a
 *   one-off slip: the prompts cross-referenced each other BY FILENAME on nearly every page, the
 *   memory block injected "MEMORY.md:" as a literal label every single turn, and several
 *   model-visible tool descriptions cited "prompts/trading.md". The model was reading those names
 *   constantly and reasonably treated them as speakable.
 *
 *  "the lot size it too big. So the lot size in his prompt -- default should be 0.01 to 0.05, but
 *   for normal trade either 0.01 or 0.02 and 0.03 is Okk" -> the old sizing scale was written in
 *   PERCENT OF BALANCE ("High / A-grade: 10-25%", "Sniper: 25%+ full aggression", "no fixed
 *   risk-per-trade cap"), plus a "breakeven-plug exception" that said to "size as large as the
 *   account can actually handle". On a ~$100 account that is what produced a real margin
 *   rejection.
 *
 *  "the bot doesn't know time" -> no clock anywhere.
 *
 *  "teach it tool so it knows when to save to memory... and when to use and save knowledge" ->
 *   knowledge was mechanically unreachable: never injected into any prompt, and of six tools only
 *   knowledge_view (which needs an id) was ever sent per turn.
 */

const PROMPTS = ["SOUL.md", "IDENTITY.md", "SECURITY.md", "trading.md", "BOOTSTRAP.md"];
const INTERNAL_NAMES = [
  "SOUL.md",
  "IDENTITY.md",
  "SECURITY.md",
  "trading.md",
  "BOOTSTRAP.md",
  "MEMORY.md",
  "USER.md",
  "ADAPTABILITY.md",
];

console.log("=== Real proof: the rewritten prompts fix what the trader actually reported ===\n");

try {
  console.log("[1] No prompt tier names ANY internal file -- the root cause of the leak...\n");
  for (const file of PROMPTS) {
    const text = readFileSync(join(process.cwd(), "prompts", file), "utf8");
    for (const name of INTERNAL_NAMES) {
      assert.ok(
        !text.includes(name),
        `prompts/${file} still references the internal filename "${name}" -- that is exactly what got said out loud to the trader`
      );
    }
  }
  console.log(`    confirmed: all ${PROMPTS.length} tiers clean of all ${INTERNAL_NAMES.length} internal filenames`);

  console.log("\n[2] And each tier explicitly FORBIDS naming them, so it isn't just absence...\n");
  const security = readFileSync(join(process.cwd(), "prompts", "SECURITY.md"), "utf8");
  const identity = readFileSync(join(process.cwd(), "prompts", "IDENTITY.md"), "utf8");
  const soul = readFileSync(join(process.cwd(), "prompts", "SOUL.md"), "utf8");
  assert.match(security, /never expose your own internals/i, "the hard rules must carry an explicit no-internals rule");
  assert.match(identity, /Never name your own internals/i, "the operating tier must repeat it where formatting rules live");
  assert.match(soul, /ever something you name/i, "and it belongs in character, not just as a prohibition");
  console.log("    confirmed: stated as a hard rule, a communication rule, and a character trait");

  console.log("\n[3] Lot sizing is in LOTS with a real 0.05 ceiling -- not percent of balance...\n");
  const trading = readFileSync(join(process.cwd(), "prompts", "trading.md"), "utf8");
  assert.match(trading, /0\.05 is a hard ceiling/i, "the ceiling must be stated as a ceiling");
  for (const lots of ["0.01", "0.02", "0.03", "0.04"]) {
    assert.ok(trading.includes(lots), `the sizing scale must name ${lots} explicitly`);
  }
  assert.ok(
    !/\b(10.25|25%\+)/.test(trading) && !/full aggression/i.test(trading),
    "the old percent-of-balance conviction scale must be gone entirely"
  );
  assert.ok(
    !/size as large as the account can actually handle/i.test(trading),
    "the breakeven-plug 'size as large as the account can handle' exception must be gone -- that is the instruction that oversized the real trade"
  );
  assert.ok(
    !/There is no fixed risk-per-trade cap/i.test(trading),
    "'no fixed risk-per-trade cap' must be gone; there is now a hard cap"
  );
  console.log("    confirmed: 0.01-0.05 scale present, percent-of-balance scale and 'size as large as it can handle' both gone");

  console.log("\n[4] The ceiling is protected against the two things that actually broke it...\n");
  assert.match(security, /Lot size is capped/i, "the cap has to live in the hard rules, not only in the trading tier");
  assert.match(trading, /a target never raises the lot ceiling/i, "growth targets must be explicitly subordinated to the cap");
  assert.match(trading, /The lot ceiling/i, "and it must appear in the precedence order");
  console.log("    confirmed: enthusiasm and growth targets are both explicitly barred from raising it");

  console.log("\n[5] The spike entry model the trader asked for is the PRIMARY model...\n");
  assert.match(trading, /This is your primary entry model/i, "the spike model must be stated as primary, not an aside");
  assert.match(trading, /point of ignition/i, "it must say where to enter, not just what to look for");
  console.log("    confirmed: spike entry stated as the primary model, with the ignition-not-mid-move rule");

  console.log("\n[6] A real clock, and prompts that tell Dave to actually use it...\n");
  const clock = buildClockLine(new Date("2026-09-18T14:30:00Z"));
  assert.match(clock, /2026-09-18T14:30:00\.000Z/, "the clock must carry the real ISO timestamp");
  assert.match(clock, /Friday/, "and the real weekday");
  assert.match(identity, /You always know what time it is/i, "the prompt must tell Dave the clock is there");
  assert.match(identity, /never guess the time/i, "and that guessing is not allowed");
  console.log(`    real clock line: ${clock}`);

  console.log("\n[7] Memory is injected WITHOUT internal filenames as labels...\n");
  const USER = "user-prompt-1";
  appendUserFact(USER, "Trades synthetic indices only.");
  appendAdaptability(USER, "Prefers short answers.");
  const withMemory = buildLiveSettingsBlock(USER);
  assert.match(withMemory, /Trades synthetic indices only/, "the real remembered fact must reach the turn");
  assert.match(withMemory, /About the person you work for/, "labelled in plain language");
  for (const name of ["MEMORY.md", "USER.md", "ADAPTABILITY.md"]) {
    assert.ok(!withMemory.includes(name), `the injected memory block still shows "${name}" to the model`);
  }
  console.log("    confirmed: memory reaches the turn, labelled in plain language, no filenames");

  console.log("\n[8] Knowledge is now injected too -- it was completely unreachable before...\n");
  const draft = knowledgeDraft(USER, {
    title: "CRASH_200 · short into spike · loses",
    useWhen: "considering a CRASH_200 short right after a spike",
    content: "Shorts straight into the spike get stopped on the wick. Wait for the retrace, enter on the rejection.",
  });
  knowledgeSave(USER, draft.id);
  const withKnowledge = buildLiveSettingsBlock(USER);
  assert.match(withKnowledge, /<knowledge_index>/, "a knowledge index block must be present once something is saved");
  assert.match(withKnowledge, /CRASH_200 · short into spike/, "the entry's title must be in the index");
  assert.match(withKnowledge, /use when: considering a CRASH_200 short/, "and its use-when trigger, which is how it gets found");
  assert.ok(withKnowledge.includes(draft.id), "and its real id, so knowledge_view is actually callable");
  console.log("    real injected index line:");
  console.log(`      ${withKnowledge.split("\n").find((l) => l.includes(draft.id))}`);

  console.log("\n[9] Nothing is injected for a user with neither -- no empty scaffolding...\n");
  const empty = buildLiveSettingsBlock("user-prompt-empty");
  assert.ok(!empty.includes("<knowledge_index>"), "an empty knowledge store must add no block at all");
  assert.ok(!empty.includes("<remembered>"), "and neither must empty memory");
  console.log("    confirmed: clean turn for a fresh user");

  console.log("\n[10] Both knowledge WRITERS are core -- saving needs both calls or it no-ops...\n");
  for (const name of ["knowledge_list", "knowledge_view", "knowledge_draft", "knowledge_save"]) {
    assert.ok(CORE_TOOL_NAMES.includes(name), `${name} must be sent every turn -- it was not, which is why knowledge stayed empty`);
  }
  for (const name of ["remember_user_fact", "remember_note", "remember_adaptability_note", "recall_memory"]) {
    assert.ok(CORE_TOOL_NAMES.includes(name), `${name} must stay core`);
  }
  console.log("    confirmed: list + view + draft + save all core, alongside the memory tools");

  console.log("\n[11] The prompt teaches the memory/knowledge split, and the two-call save...\n");
  assert.match(identity, /if it's about them, it's memory\. If it's about the market or about your own trading, it's knowledge/i, "the split must be stated as a usable rule");
  assert.match(identity, /both are required/i, "the two-call save must be explicit -- a draft alone commits nothing");
  assert.match(identity, /Tag what you save/i, "tagging must be covered -- there is no keyword search over knowledge");
  console.log("    confirmed: split rule, mandatory draft+save pair, and tagging all stated");

  console.log("\n[12] Self-improvement now means writing knowledge, not editing code...\n");
  assert.match(identity, /You improve by learning, not by rewriting yourself/i, "the operating tier must redirect self-improvement");
  assert.match(trading, /Learning from a closed trade/i, "and the trading tier must say how, since the hard rules point at it");
  assert.ok(
    !/You can propose changes to your own code/i.test(identity),
    "the old 'propose changes to your own code' self-improvement instruction must be gone -- it contradicted the hard rules"
  );
  console.log("    confirmed: redirected to knowledge, old code-proposal instruction removed, no contradiction left");

  console.log("\n[13] Model-visible TOOL descriptions are clean too -- the other leak path...\n");
  const allTools = [...MEMORY_WRITE_TOOLS, ...SKILL_TOOLS, ...KNOWLEDGE_TOOLS];
  for (const tool of allTools) {
    for (const name of INTERNAL_NAMES) {
      assert.ok(
        !tool.description.includes(name),
        `tool "${tool.name}" still cites "${name}" in the description the model reads`
      );
    }
  }
  console.log(`    confirmed: ${allTools.length} memory/skill/knowledge tool descriptions clean`);

  console.log("\n[14] The batched-message and no-repeat rules the trader asked for...\n");
  assert.match(identity, /is one conversation, not several/i, "the batch rule must be present");
  assert.match(identity, /do not repeat yourself/i, "and the no-repeat rule it exists to serve");
  console.log("    confirmed: one reply per batch, no re-explaining on a short ack");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
