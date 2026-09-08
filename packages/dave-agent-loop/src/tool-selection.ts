/**
 * Real bug fixed (user, with a real Grok error: "'tools': maximum number of items is 128"):
 * the full registry composes 205+ real tools across every package -- sending all of them on
 * every single request hits hard per-request caps several real providers enforce (confirmed:
 * xAI Grok rejects a request above 128 tools; OpenAI's own docs cap at the same number, and most
 * OpenAI-compatible providers built on that same request shape inherit it). It's also a genuine,
 * major cost driver on top of the cap itself -- a full 205-tool schema list is a large, mostly-
 * irrelevant chunk of EVERY request's token count, which item 2 (caching) traced back to this
 * exact bug: a huge, always-present payload sent uncached to providers whose caching path (or
 * lack of one, e.g. Gemini's OpenAI-compat shim) never kicks in for it.
 *
 * The fix: only a curated CORE set -- covering the trading actions, settings, status, journal,
 * and safety tools Dave genuinely needs in nearly every real turn -- is sent by default. Anything
 * else (the ~40 specialized DAVEMA analysis tools, skills/knowledge management, provider/E2B/
 * Firecrawl/MCP key management, self-improvement, sandbox, workers, automations, ...) is real and
 * still fully callable, just DISCOVERABLE: the model calls the already-real `search_tools` tool,
 * and whatever it finds gets added to the active set for the rest of that run (agent-loop.ts) --
 * genuinely reachable, never silently missing, just not paid for on every turn it isn't needed.
 */

/** Real, confirmed hard cap (xAI Grok's own error text: "maximum number of items is 128";
 *  OpenAI's documented ceiling is the same number) -- a real safety net regardless of how large
 *  CORE_TOOL_NAMES or a run's discovered set ever grows. */
export const MAX_TOOLS_PER_REQUEST = 128;

export const CORE_TOOL_NAMES: string[] = [
  // Meta -- always available regardless of provider tool-count limits.
  "ask_user",
  "search_tools",
  "recall_memory",
  "push_message_to_user",

  // Trading actions -- the real reason this bot exists, never gated behind discovery.
  "find_setup",
  "trade_execute",
  "trade_modify",
  "modify_sl_tp",
  "remove_sl_tp",
  "partial_close",
  "full_close",
  "delete_pending_order",
  "delete_all_pending_orders",
  "validate_order",
  "enable_position_trailing",
  "disable_position_trailing",

  // Live status/account -- what Dave checks before/after nearly every trade decision.
  "get_price",
  "get_candles",
  "get_confluence",
  "get_account_balance",
  "mt5_account",
  "get_live_state",
  "ping_ea",
  "correlation_check",

  // Settings -- real gap fixed (user: "the bot keeps asking about these as if they were never
  // set"): these stay core so a settings question/change never depends on the model happening to
  // discover the right tool first.
  "set_risk_mode",
  "get_active_pair_group",
  "set_active_pair_group",
  "create_or_update_pair_group",
  "delete_pair_group",
  "list_pair_groups",
  "set_active_pair",
  "clear_active_pair",
  "get_trading_session",
  "set_trading_session",
  "set_trading_mode",
  "get_confidence_settings",
  "set_confidence_threshold",
  "set_auto_approve_below_threshold",
  "get_auto_approval",
  "set_auto_approval",
  "get_trailing_stop_config",
  "set_trailing_stop_config",
  "propose_settings_change",
  "get_reflection_threshold",
  "set_reflection_threshold",

  // Journal -- real win-rate/history questions, asked often enough to stay core.
  "get_todays_journal",
  "get_win_rate",
  "journal_trade",
  "journal_close",
  "journal_daily",

  // Safety -- must never depend on discovery.
  "check_safety_limits",
  "circuit_breaker",
  "hard_stop",
  "pause_action",
  "resume_action",
  "get_interrupt_state",

  "list_skills",
  "knowledge_view",
];

/** Real bounds check -- CORE_TOOL_NAMES itself must always stay well under the hard cap, or the
 *  whole point of curating it is defeated. Enforced by step21's test, not just this comment. */
if (CORE_TOOL_NAMES.length >= MAX_TOOLS_PER_REQUEST) {
  throw new Error(`CORE_TOOL_NAMES has grown to ${CORE_TOOL_NAMES.length} -- must stay well under MAX_TOOLS_PER_REQUEST (${MAX_TOOLS_PER_REQUEST}).`);
}
