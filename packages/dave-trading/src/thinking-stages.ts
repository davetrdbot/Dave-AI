import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The steps (tags) of Dave's sequential thinking, the trader's to edit (the trader: "the tags for
 * the sequential thinking -- memory, growth and others -- add a toggle to switch them off and on,
 * and delete, and add others"). Every enabled step is MANDATORY: the pass can't finish until each
 * one has its own thought ("sometimes it refuses to think about a point -- make it important").
 */

export interface ThinkingStageItem {
  id: string;
  label: string;
  /** What the step must answer -- shown to Dave in his checklist. */
  help: string;
  enabled: boolean;
  builtIn: boolean;
}

export const DEFAULT_THINKING_STAGES: ThinkingStageItem[] = [
  { id: "bias", label: "Bias", help: "higher-timeframe bias -- which way the bigger picture leans, and how strongly", enabled: true, builtIn: true },
  { id: "spike", label: "Spike", help: "the spike -- on Boom/Crash/Storm/synthetics: where the next spike is likely, which way it fires, and is this trade WITH it or exposed to it; on forex: a news/volatility spike that could hit the stop", enabled: true, builtIn: true },
  { id: "trigger", label: "Trigger", help: "the entry trigger on the lower timeframe -- a change of character or rejection that is actually there now, or a limit on the level", enabled: true, builtIn: true },
  { id: "sniper", label: "Sniper entry", help: "the sniper entry -- the exact level (order block, sweep, OCL, A/V level, range edge) where the entry risks least; is price there NOW, or is it a limit order", enabled: true, builtIn: true },
  { id: "scalp", label: "Scalp", help: "the scalp -- is there a quick, high-probability move to grab on M1/M5 right now, how big, and the tight exit", enabled: true, builtIn: true },
  { id: "invalidation", label: "Invalidation", help: "where the idea is wrong -- the stop from structure, not from a number", enabled: true, builtIn: true },
  { id: "target", label: "Target", help: "where price is genuinely likely to reach (liquidity, the opposite level), and whether the exact R:R target is realistic", enabled: true, builtIn: true },
  { id: "edge", label: "Advantage", help: "the advantage -- what edge this trade has over a coin flip (spike direction, confluence, liquidity, structure), and why it is enough to take", enabled: true, builtIn: true },
  { id: "counter", label: "Case against", help: "the strongest case AGAINST this trade -- then say plainly whether it actually kills the setup or is just fear", enabled: true, builtIn: true },
  { id: "memory", label: "Memory", help: "your own rules, strategy card, brain facts and past graded calls on this pair -- what do they say about this exact setup", enabled: true, builtIn: true },
  { id: "growth", label: "Growth", help: "your self-improvement record -- the current strategy version under test, pairs to avoid, and the lessons from your last graded calls: does this trade follow them", enabled: true, builtIn: true },
  { id: "scenario", label: "Alternative path", help: "the alternative path -- what price does if you're wrong, and what you'd see first", enabled: true, builtIn: true },
  { id: "verdict", label: "Verdict", help: "the call, with an honest confidence -- a clean setup is TAKEN; a skip must name one of the real skip reasons", enabled: true, builtIn: true },
];

function root(): string {
  return process.env.DAVE_DATA_ROOT ?? process.cwd();
}
function stagesPath(userId: string): string {
  return join(root(), "data", "trading", userId, "thinking-stages.json");
}
function alertThinkPath(userId: string): string {
  return join(root(), "data", "trading", userId, "think-on-alert-scans.json");
}

function save(userId: string, list: ThinkingStageItem[]): ThinkingStageItem[] {
  const p = stagesPath(userId);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(list, null, 2), "utf8");
  return list;
}

export function getThinkingStages(userId: string): ThinkingStageItem[] {
  const p = stagesPath(userId);
  if (!existsSync(p)) return DEFAULT_THINKING_STAGES.map((s) => ({ ...s }));
  try {
    const list = JSON.parse(readFileSync(p, "utf8")) as ThinkingStageItem[];
    return Array.isArray(list) ? list.filter((s) => s && typeof s.id === "string" && typeof s.help === "string") : DEFAULT_THINKING_STAGES.map((s) => ({ ...s }));
  } catch {
    return DEFAULT_THINKING_STAGES.map((s) => ({ ...s }));
  }
}

export function getEnabledThinkingStages(userId: string): ThinkingStageItem[] {
  return getThinkingStages(userId).filter((s) => s.enabled);
}

export class ThinkingStageError extends Error {}

export function setThinkingStageEnabled(userId: string, id: string, enabled: boolean): ThinkingStageItem[] {
  const list = getThinkingStages(userId);
  const s = list.find((x) => x.id === id);
  if (!s) throw new ThinkingStageError("That step doesn't exist.");
  s.enabled = enabled;
  if (!list.some((x) => x.enabled)) throw new ThinkingStageError("Keep at least one step on.");
  return save(userId, list);
}

export function deleteThinkingStage(userId: string, id: string): ThinkingStageItem[] {
  const list = getThinkingStages(userId);
  const next = list.filter((x) => x.id !== id);
  if (next.length === list.length) throw new ThinkingStageError("That step doesn't exist.");
  if (!next.some((x) => x.enabled)) throw new ThinkingStageError("Keep at least one step on.");
  return save(userId, next);
}

export function addThinkingStage(userId: string, label: string, help: string): ThinkingStageItem[] {
  const name = label.trim().slice(0, 40);
  const what = help.trim().slice(0, 400);
  if (!name) throw new ThinkingStageError("Give the step a name.");
  if (!what) throw new ThinkingStageError("Say what Dave must think about in this step.");
  const list = getThinkingStages(userId);
  let id = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "step";
  while (list.some((x) => x.id === id)) id += "_2";
  // A new step goes before the verdict, so the call still comes last.
  const at = list.findIndex((x) => x.id === "verdict");
  const item: ThinkingStageItem = { id, label: name, help: what, enabled: true, builtIn: false };
  if (at >= 0) list.splice(at, 0, item);
  else list.push(item);
  return save(userId, list);
}

/** Back to the built-in steps (custom ones removed). */
export function resetThinkingStages(userId: string): ThinkingStageItem[] {
  return save(userId, DEFAULT_THINKING_STAGES.map((s) => ({ ...s })));
}

/** Whether the scans started by an alert / reminder / marked level also run the thinking pass.
 *  Off by default (the trader: "a switch so it doesn't do that when self-aware and reminders hit")
 *  -- those scans act fast on the one thing that fired. */
export function getThinkOnAlertScans(userId: string): boolean {
  const p = alertThinkPath(userId);
  if (!existsSync(p)) return false;
  try {
    return JSON.parse(readFileSync(p, "utf8")) === true;
  } catch {
    return false;
  }
}

export function setThinkOnAlertScans(userId: string, on: boolean): void {
  const p = alertThinkPath(userId);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(on), "utf8");
}
