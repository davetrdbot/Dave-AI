import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Real gap fixed: the default system prompt was a one-line placeholder
 * ("You are Dave, an autonomous trading assistant.") -- none of Dave's
 * actual real, checked-in behavioral rules (prompts/SOUL.md, IDENTITY.md,
 * SECURITY.md, BOOTSTRAP.md -- SOUL is personality, IDENTITY covers real
 * trade-decision rules like "check correlation before sizing", SECURITY
 * covers the absolute safety rules, BOOTSTRAP governs first contact)
 * were actually loaded into the real booted agent. SYSTEM_PROMPT can
 * still override this wholesale for a genuinely different deployment.
 *
 * Extracted from main.ts into its own module (not touching main.ts's
 * export) so autonomous-tick.ts can import it directly without a
 * main.ts -> telegram-bot-server.ts -> autonomous-tick.ts -> main.ts
 * import cycle. main.ts's own loadSystemPrompt is kept as a thin
 * re-export for backward compatibility.
 */
// Real gap fixed (an investigation subagent, live: the autonomous cycle calls
// buildSystemPrompt()/loadSystemPrompt() up to 3x per tick -- the initial decision plus a
// possible post-CONSULT_JOURNAL and post-REQUEST_CANDLES re-decision -- and this used to do 5
// synchronous readFileSync calls EVERY single time, none of them ever memoized. That's up to 15
// blocking disk reads per tick, on the one event loop that also serves the EA webhook, the
// Telegram webhook, and every LLM call, for content that cannot change without a redeploy
// (prompts/*.md and SYSTEM_PROMPT are both fixed at process start). Computed once per process
// and reused.
let cachedSystemPrompt: string | undefined;

export function loadSystemPrompt(): string {
  if (cachedSystemPrompt !== undefined) return cachedSystemPrompt;
  if (process.env.SYSTEM_PROMPT) return (cachedSystemPrompt = process.env.SYSTEM_PROMPT);
  const promptsDir = join(process.cwd(), "prompts");
  const files = ["SOUL.md", "IDENTITY.md", "SECURITY.md", "trading.md", "BOOTSTRAP.md"];
  const sections = files.flatMap((file) => {
    try {
      return [readFileSync(join(promptsDir, file), "utf8")];
    } catch {
      console.error(`[boot] could not read prompts/${file} -- continuing without it`);
      return [];
    }
  });
  return (cachedSystemPrompt = sections.length === 0 ? "You are Dave, an autonomous trading assistant." : sections.join("\n\n---\n\n"));
}
