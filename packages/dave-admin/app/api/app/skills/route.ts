import { NextResponse } from "next/server";
import { listSkills, createSkill, deleteSkill, installSkillFromGithub, PermanentSkillError, DuplicateSkillNameError, SkillNotFoundError } from "@dave/skills";
import { getActiveStrategySkillId, setActiveStrategySkill, clearActiveStrategySkill } from "@dave/trading";
import { withDevice } from "../../../../server/require-device.js";

/**
 * Skills from the app: browse, install from GitHub, activate, remove.
 *
 * Bodies are not returned by the list, for the same reason list_skills stopped returning them --
 * a handful of real strategy skills is tens of thousands of characters, and a list screen needs
 * names. `?id=` returns one in full when a detail screen actually opens it.
 *
 * Activation is exposed because the trader asked for the bot's full settings to be controllable
 * from the app. Note this is the one place where the app can do something Dave himself may not
 * do on his own initiative: the trading prompt forbids him from switching strategy by himself,
 * precisely because it is the trader's call -- and this IS the trader making it.
 */

export const GET = withDevice(async ({ userId, req }) => {
  const id = req.nextUrl.searchParams.get("id");
  const active = getActiveStrategySkillId(userId);
  const skills = listSkills(userId);

  if (id) {
    const skill = skills.find((s) => s.id === id);
    if (!skill) return NextResponse.json({ error: "No such skill." }, { status: 404 });
    return NextResponse.json({ ...skill, active: skill.id === active });
  }

  return NextResponse.json({
    activeSkillId: active ?? null,
    skills: skills.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      source: s.source,
      permanent: s.permanent,
      active: s.id === active,
      contentChars: s.content.length,
      createdAt: s.createdAt,
    })),
  });
});

export const POST = withDevice(async ({ userId, req }) => {
  let body: { action?: string; repoUrl?: string; name?: string; description?: string; content?: string; skillId?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  try {
    switch (body.action) {
      case "install-github": {
        if (!body.repoUrl) return NextResponse.json({ error: "repoUrl is required." }, { status: 400 });
        return NextResponse.json({ ok: true, skill: await installSkillFromGithub(userId, body.repoUrl) });
      }
      case "create": {
        if (!body.name || !body.content) return NextResponse.json({ error: "name and content are required." }, { status: 400 });
        const skill = createSkill(userId, { name: body.name, description: body.description ?? "", content: body.content, source: "self-created" });
        return NextResponse.json({ ok: true, skill });
      }
      case "activate": {
        if (!body.skillId) return NextResponse.json({ error: "skillId is required." }, { status: 400 });
        if (!listSkills(userId).some((s) => s.id === body.skillId)) return NextResponse.json({ error: "No such skill." }, { status: 404 });
        setActiveStrategySkill(userId, body.skillId);
        return NextResponse.json({ ok: true, activeSkillId: body.skillId });
      }
      case "deactivate": {
        clearActiveStrategySkill(userId);
        return NextResponse.json({ ok: true, activeSkillId: null });
      }
      default:
        return NextResponse.json({ error: "action must be one of: install-github, create, activate, deactivate." }, { status: 400 });
    }
  } catch (err) {
    // These three are expected outcomes of a valid request, not server faults -- a 4xx with the
    // real reason, so the app can show it instead of "something went wrong".
    if (err instanceof DuplicateSkillNameError) return NextResponse.json({ error: err.message }, { status: 409 });
    if (err instanceof SkillNotFoundError) return NextResponse.json({ error: err.message }, { status: 404 });
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
});

export const DELETE = withDevice(async ({ userId, req }) => {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required." }, { status: 400 });
  try {
    // Clearing first keeps the active pointer from dangling at a skill that no longer exists.
    if (getActiveStrategySkillId(userId) === id) clearActiveStrategySkill(userId);
    deleteSkill(userId, id);
    return NextResponse.json({ ok: true, deleted: id });
  } catch (err) {
    if (err instanceof PermanentSkillError) return NextResponse.json({ error: err.message }, { status: 403 });
    if (err instanceof SkillNotFoundError) return NextResponse.json({ error: err.message }, { status: 404 });
    throw err;
  }
});
