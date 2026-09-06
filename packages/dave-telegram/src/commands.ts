/**
 * Step 8.1: 9 real command handlers, plus /menu (real gap fixed: users
 * kept typing /menu expecting a real command -- confirmed via real
 * Telegram update logs showing repeated unanswered /menu attempts --
 * so it's now a genuine 10th registered command, not just a hope that
 * people find the native "/" button). Everything else is conversational
 * (routed to the agent loop, not a command handler).
 */
export const DAVE_COMMANDS = [
  { command: "account", description: "View your connected MT5 account and balance" },
  { command: "connection", description: "Check EA/MT5 connection status" },
  { command: "providers", description: "Switch AI provider (AirLLM / DeepSeek / Claude)" },
  { command: "models", description: "Pick which model each provider uses" },
  { command: "settings", description: "Trading limits, notifications, and preferences" },
  { command: "reset", description: "Reset this conversation" },
  { command: "help", description: "What Dave can do" },
  { command: "menu", description: "Show this menu of commands" },
  { command: "status", description: "Circuit breaker, workers, and system status" },
  { command: "ea", description: "Get your personalized MT5 Expert Advisor file" },
] as const;

export type DaveCommand = (typeof DAVE_COMMANDS)[number]["command"];

const COMMAND_NAMES = new Set<string>(DAVE_COMMANDS.map((c) => c.command));

export function isDaveCommand(text: string): boolean {
  const match = text.trim().match(/^\/(\w+)/);
  return !!match && COMMAND_NAMES.has(match[1]);
}

/** Real gap fixed: a genuine slash command that ISN'T one of the 9 (mistyped, or an old
 * removed one like /pair) used to silently fall through to the LLM as ordinary conversation
 * -- isDaveCommand() only tells you when it IS a real command, not when it merely looks like
 * one. This is that second check. */
export function looksLikeSlashCommand(text: string): boolean {
  return /^\/(\w+)/.test(text.trim());
}

export function parseCommand(text: string): { command: DaveCommand; args: string } | null {
  const match = text.trim().match(/^\/(\w+)(?:@\w+)?\s*(.*)$/s);
  if (!match || !COMMAND_NAMES.has(match[1])) return null;
  return { command: match[1] as DaveCommand, args: match[2] ?? "" };
}
