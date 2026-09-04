/**
 * Step 8.1: exactly these 9 slash commands. Everything else is
 * conversational (routed to the agent loop, not a command handler).
 */
export const DAVE_COMMANDS = [
  { command: "account", description: "View your connected MT5 account and balance" },
  { command: "connection", description: "Check EA/MT5 connection status" },
  { command: "providers", description: "Switch AI provider (AirLLM / DeepSeek / Claude)" },
  { command: "models", description: "Pick which model each provider uses" },
  { command: "settings", description: "Trading limits, notifications, and preferences" },
  { command: "reset", description: "Reset this conversation" },
  { command: "help", description: "What Dave can do" },
  { command: "status", description: "Circuit breaker, workers, and system status" },
  { command: "ea", description: "Get your personalized MT5 Expert Advisor file" },
] as const;

export type DaveCommand = (typeof DAVE_COMMANDS)[number]["command"];

const COMMAND_NAMES = new Set<string>(DAVE_COMMANDS.map((c) => c.command));

export function isDaveCommand(text: string): boolean {
  const match = text.trim().match(/^\/(\w+)/);
  return !!match && COMMAND_NAMES.has(match[1]);
}

export function parseCommand(text: string): { command: DaveCommand; args: string } | null {
  const match = text.trim().match(/^\/(\w+)(?:@\w+)?\s*(.*)$/s);
  if (!match || !COMMAND_NAMES.has(match[1])) return null;
  return { command: match[1] as DaveCommand, args: match[2] ?? "" };
}
