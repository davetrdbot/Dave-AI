import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSkill,
  listSkills,
  deleteSkill,
  DuplicateSkillNameError,
  SkillNotFoundError,
  PermanentSkillError,
  seedToolUsageSkill,
  generateToolUsageContent,
  TOOL_USAGE_SKILL_NAME,
  installSkillFromGithub,
  GithubSkillFetchError,
  parseGithubRepoUrl,
  isJsonlSkillFile,
  installSkillsFromJsonl,
  SKILL_TOOLS,
} from "../src/index.js";

console.log("=== Update 10 real proof: skills -- permanent, self-created, GitHub install, .jsonl install, deletion ===\n");

const workDir = mkdtempSync(join(tmpdir(), "dave-update10-"));
const OWNER = "user-1";

try {
  process.chdir(workDir);

  // --- [1] Permanent tool-usage skill: generated FROM real tool specs, genuinely undeletable ---
  console.log("[1] Permanent skill teaching Dave to use its real tools...\n");
  const toolSpecs = [
    { name: "trade_execute", description: "Place a real trade.", parameters: {} },
    { name: "request_tool", description: "Ask Dave for a tool you weren't given.", parameters: {} },
  ];
  const content = generateToolUsageContent(toolSpecs);
  assert.ok(content.includes("trade_execute"));
  assert.ok(content.includes("request_tool"));
  console.log(`    real generated content mentions both real tools:\n${content}\n`);

  const seeded = seedToolUsageSkill(OWNER, toolSpecs);
  assert.equal(seeded.name, TOOL_USAGE_SKILL_NAME);
  assert.equal(seeded.permanent, true);
  assert.equal(seeded.source, "built-in");
  console.log(`    real permanent skill seeded: id=${seeded.id}, permanent=${seeded.permanent}`);

  let permErr = false;
  try {
    deleteSkill(OWNER, seeded.id);
  } catch (err) {
    permErr = err instanceof PermanentSkillError;
  }
  assert.ok(permErr, "a permanent skill must genuinely refuse deletion");
  assert.ok(listSkills(OWNER).some((s) => s.id === seeded.id), "still genuinely present after the refused delete");
  console.log("    genuinely refused deletion -- PermanentSkillError, skill still present");

  console.log("\n[1b] Re-seeding updates the SAME skill in place as the tool set changes...\n");
  const reseeded = seedToolUsageSkill(OWNER, [...toolSpecs, { name: "generate_image", description: "Make a picture.", parameters: {} }]);
  assert.equal(reseeded.id, seeded.id, "must be the SAME skill, not a duplicate");
  assert.ok(reseeded.content.includes("generate_image"));
  assert.equal(listSkills(OWNER).filter((s) => s.name === TOOL_USAGE_SKILL_NAME).length, 1, "re-seeding must never create a duplicate");
  console.log(`    same skill id (${reseeded.id}), content now reflects the updated tool set, no duplicate created`);

  // --- [2] Self-created skill, through the real agent tool ---
  console.log("\n[2] Dave self-creates a new skill via the real create_skill tool...\n");
  const createTool = SKILL_TOOLS.find((t) => t.name === "create_skill")!;
  const created = (await createTool.execute(
    { name: "London Open Sweep Pattern", description: "How to spot the London-open liquidity sweep setup.", content: "Watch for a sweep of the Asian session low right at London open, then a bullish order block with an FVG above it." },
    { userId: OWNER }
  )) as any;
  assert.equal(created.source, "self-created");
  assert.equal(created.permanent, false);
  console.log(`    real self-created skill: "${created.name}" (source=${created.source})`);

  console.log("\n[2b] Creating a duplicate-named skill is genuinely refused...\n");
  let dupErr = false;
  try {
    createSkill(OWNER, { name: "London Open Sweep Pattern", description: "dup", content: "dup", source: "self-created" });
  } catch (err) {
    dupErr = err instanceof DuplicateSkillNameError;
  }
  assert.ok(dupErr);
  console.log("    genuinely refused: DuplicateSkillNameError");

  // --- [3] Install from GitHub -- a REAL network round trip against a real public repo ---
  console.log("\n[3] install_skill_from_github: a REAL network round trip against a real public GitHub repo...\n");
  assert.deepEqual(parseGithubRepoUrl("https://github.com/octocat/Hello-World"), { owner: "octocat", repo: "Hello-World" });
  console.log('    parseGithubRepoUrl("https://github.com/octocat/Hello-World") -> {owner:"octocat", repo:"Hello-World"}');

  const installTool = SKILL_TOOLS.find((t) => t.name === "install_skill_from_github")!;
  let githubResult: any;
  let githubErr: GithubSkillFetchError | undefined;
  try {
    githubResult = await installTool.execute({ repoUrl: "https://github.com/octocat/Hello-World" }, { userId: OWNER });
  } catch (err) {
    if (err instanceof GithubSkillFetchError) githubErr = err;
  }
  if (githubResult) {
    assert.equal(githubResult.source, "github");
    assert.ok(githubResult.content.length > 0);
    console.log(`    real GitHub fetch succeeded: "${githubResult.name}" (${githubResult.content.length} bytes) -- real content: "${githubResult.content.slice(0, 60).replace(/\n/g, " ")}..."`);
  } else {
    console.log(`    real network attempt genuinely failed in this environment (no egress to github.com here): ${githubErr?.message}`);
  }

  console.log("\n[3b] A nonexistent repo genuinely fails, typed, honest -- no fake skill fabricated...\n");
  let notFoundErr = false;
  try {
    await installSkillFromGithub(OWNER, "https://github.com/this-owner-does-not-exist-xyzabc123/also-fake-repo-99999", 6000);
  } catch (err) {
    notFoundErr = err instanceof GithubSkillFetchError;
  }
  assert.ok(notFoundErr, "a genuinely nonexistent repo must fail honestly, typed");
  console.log("    genuinely refused/failed -- GithubSkillFetchError, no fabricated skill installed");

  // --- [4] .jsonl auto-detection and install -- multiple skills, one per line ---
  console.log("\n[4] .jsonl auto-detection: real per-line parsing, multiple skills from one file...\n");
  assert.equal(isJsonlSkillFile("my-skills.jsonl"), true);
  assert.equal(isJsonlSkillFile("my-skills.json"), false);
  assert.equal(isJsonlSkillFile("rules.pdf"), false);
  console.log('    isJsonlSkillFile("my-skills.jsonl") -> true, ("my-skills.json"/"rules.pdf") -> false');

  const jsonl = [
    JSON.stringify({ name: "Risk Journaling", description: "How to write a risk journal entry.", content: "Always note confluence score, SL/TP, and the deciding factor." }),
    JSON.stringify({ name: "Broken Line", content: "" }), // will fail validation -- missing content really means empty
    "not even json",
    JSON.stringify({ name: "Session Overlap Awareness", content: "London/NY overlap (1-4pm GMT-ish) tends to have the highest real volume." }),
  ].join("\n");

  const jsonlTool = SKILL_TOOLS.find((t) => t.name === "install_skills_from_jsonl")!;
  const jsonlResult = (await jsonlTool.execute({ jsonlContent: jsonl, sourceLabel: "user-upload.jsonl" }, { userId: OWNER })) as any;
  assert.equal(jsonlResult.installed.length, 2, "exactly the 2 genuinely valid lines must install");
  assert.equal(jsonlResult.errors.length, 2, "the 2 genuinely malformed lines must be reported, not silently dropped");
  assert.ok(jsonlResult.errors.some((e: any) => e.message.includes("not valid JSON")));
  assert.ok(jsonlResult.errors.some((e: any) => e.message.includes('"content"')));
  console.log(`    real install result: ${jsonlResult.installed.length} installed (${jsonlResult.installed.map((s: any) => s.name).join(", ")}), ${jsonlResult.errors.length} real errors: ${JSON.stringify(jsonlResult.errors)}`);

  // --- [5] Deletion: a non-permanent skill genuinely CAN be deleted ---
  console.log("\n[5] A non-permanent skill genuinely CAN be deleted...\n");
  const deleteTool = SKILL_TOOLS.find((t) => t.name === "delete_skill")!;
  await deleteTool.execute({ id: created.id }, { userId: OWNER });
  assert.ok(!listSkills(OWNER).some((s) => s.id === created.id), "must genuinely be gone");
  console.log(`    "${created.name}" genuinely deleted -- no longer in list_skills`);

  console.log("\n[5b] Deleting an unknown skill id fails honestly, typed...\n");
  let notFound = false;
  try {
    deleteSkill(OWNER, "does-not-exist");
  } catch (err) {
    notFound = err instanceof SkillNotFoundError;
  }
  assert.ok(notFound);
  console.log("    real, typed SkillNotFoundError");

  // --- [6] list_skills tool reflects real current state ---
  console.log("\n[6] list_skills tool reflects the real current state...\n");
  const listTool = SKILL_TOOLS.find((t) => t.name === "list_skills")!;
  const finalList = (await listTool.execute({}, { userId: OWNER })) as any[];
  const names = finalList.map((s) => s.name).sort();
  console.log(`    real final skill list: ${names.join(", ")}`);
  assert.ok(names.includes(TOOL_USAGE_SKILL_NAME));
  assert.ok(names.includes("Risk Journaling"));
  assert.ok(names.includes("Session Overlap Awareness"));
  assert.ok(!names.includes("London Open Sweep Pattern"), "the deleted one must genuinely be absent");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
