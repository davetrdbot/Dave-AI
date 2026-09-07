/**
 * Step 8.1: 9 real command handlers, plus /menu (real gap fixed: users
 * kept typing /menu expecting a real command -- confirmed via real
 * Telegram update logs showing repeated unanswered /menu attempts --
 * so it's now a genuine 10th registered command, not just a hope that
 * people find the native "/" button). Everything else is conversational
 * (routed to the agent loop, not a command handler).
 */
/**
 * Item 5 real gap fixed: this list previously registered in an arbitrary/alphabetical-ish order
 * -- setMyCommands genuinely renders in array order (registerDefaultCommandMenu passes this
 * straight through, no re-sorting), so whatever order this array is in is exactly what the user
 * sees in Telegram's own command menu. Reordered usefulness-first: the real entry point (/menu),
 * then what's happening right now (/status, /account), then how Dave is configured (/settings,
 * /providers, /models, /connection), then the occasional/destructive/reference ones last
 * (/ea, /reset, /help).
 *
 * Real gap fixed (user: "start_trading and stop_trading should be... the first two, and panic
 * too"): these three are the actual trading on/off/kill switches, so they lead -- ahead of even
 * /menu. Their real handling lives in telegram-bot-server.ts (handleTradingControlCommand),
 * checked before this list's own dispatch even gets a chance to run; they're registered here so
 * they show up for real in Telegram's native "/" command list and can be added to /menu's own
 * button UI (see MENU_BUTTONS in command-router.ts).
 */
export const DAVE_COMMANDS = [
  { command: "start_trading", description: "▶️ Turn on autonomous trading (I act on real setups on my own)" },
  { command: "stop_trading", description: "⏸️ Turn off autonomous trading" },
  { command: "panic", description: "🚨 Instant hard kill -- halts all trading and workers immediately" },
  { command: "menu", description: "📋 Show this menu of commands" },
  { command: "status", description: "📊 Circuit breaker, workers, and system status" },
  { command: "account", description: "💰 View your connected MT5 account and balance" },
  { command: "trades", description: "📈 View and close your real open trades, live" },
  { command: "settings", description: "⚙️ Trading limits, notifications, and preferences" },
  { command: "providers", description: "🤖 Switch AI provider (28+ providers, AirLLM default)" },
  { command: "models", description: "🧠 Pick which model each provider uses" },
  { command: "connection", description: "🔌 Check EA/MT5 connection status" },
  { command: "ea", description: "📄 Get your personalized MT5 Expert Advisor file" },
  { command: "reset", description: "🔄 Reset this conversation" },
  { command: "help", description: "❓ What Dave can do" },
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
