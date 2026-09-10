import type { ActionType } from "@dave/telegram";

/**
 * Real gap fixed (Step 9 -- thinking indicator): ThinkingIndicator's
 * typed icons (code/database/api/input/output/memory/trade/worker) were
 * real and tested in isolation, but nothing ever mapped a real tool
 * call to one of them in production -- the indicator was never driven
 * by the agent loop at all (see telegram-bot-server.ts). This is that
 * mapping: a plain keyword heuristic over the tool's own name, same
 * "honest heuristic, not a fake classifier" pattern already used
 * elsewhere in this codebase (e.g. the admin dashboard's
 * classifySymbol()).
 */
const RULES: [RegExp, ActionType][] = [
  [/^db_|automation/i, "database"],
  [/journal|photo|voice|image|video|document|transcri/i, "input"],
  [/push|send|notify|message_to_user|unpin|pin_message/i, "output"],
  [/memory|fact|recall|adaptability/i, "memory"],
  [/worker|subagent/i, "worker"],
  [/sandbox|e2b|code|skill/i, "code"],
  // Checked last, and deliberately specific (whole-word "close"/"order",
  // not a bare substring) so it can't shadow unrelated tools that merely
  // contain these letters (e.g. "journal_close" is real journal input,
  // not a trade close -- caught by the "journal" rule above first).
  [/trade|\border\b|position|\bclose\b|modify|correlation|trailing|pair_group|risk|^sl_|^tp_|lot/i, "trade"],
];

export function classifyToolAction(toolName: string): ActionType {
  for (const [pattern, action] of RULES) {
    if (pattern.test(toolName)) return action;
  }
  return "api";
}
