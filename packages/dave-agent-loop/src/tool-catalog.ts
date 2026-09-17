import type { ToolRegistry } from "./tool-registry.js";

/**
 * Discretionary harness improvement (trader: "in your harness ... you have the power to add some
 * features that you like that will improve the bot ... it's up to you to choose"). Pairs with the
 * `full-tool-catalog` doc/skill (docs/skills/full-tool-catalog.md): that doc is the human/semantic
 * reference Dave reads via `list_skills`; this is the SAME categorization exposed as a real,
 * structured, model-callable tool -- `get_tool_catalog` -- so Dave can pull "everything I have,
 * grouped by category" programmatically in one call instead of relying only on `search_tools`'s
 * keyword match (which only ever surfaces tools whose name/description happens to contain the
 * queried word, and returns nothing when Dave doesn't already know roughly what to search for).
 *
 * Deliberately read-only and side-effect-free: it only reads `registry.list()` (already-registered
 * tool specs) and returns data -- it can never place a trade, change a setting, or touch anything
 * live, which is why this was judged safe for a live-money trading bot with no further gating.
 *
 * The category->toolName mapping below is static (kept in sync with full-registry.ts's real
 * registrations and full-tool-catalog.md by hand, same as that doc already is), but the function
 * itself never trusts the mapping to be exhaustive: any registered tool whose name isn't in ANY
 * category still comes back, filed under "Other" -- so a newly-added tool that's shipped before
 * this map is updated is still genuinely visible through this tool, never silently dropped.
 */
export const TOOL_CATALOG_CATEGORIES: Record<string, string[]> = {
  Analysis: [
    "get_all_analysis",
    "get_live_state",
    "get_account_balance",
    "get_trend",
    "get_momentum",
    "get_volatility",
    "get_price",
    "get_structure",
    "get_zones",
    "get_liquidity",
    "get_volume",
    "get_ichimoku",
    "get_fibonacci",
    "get_candles",
    "get_patterns",
    "get_ict",
    "get_wyckoff",
    "get_divergence",
    "get_session",
    "get_pivots",
    "get_levels",
    "get_orderflow",
    "get_confluence",
    "get_risk_metrics",
    "get_synthetic",
    "get_elliott",
    "get_correlation",
    "get_strength",
    "get_heatmap",
    "get_fractal",
    "get_harmonic",
    "get_mean_reversion",
    "get_tape",
    "get_tape_flow",
    "get_seasonality",
    "get_spread_analysis",
    "get_gann",
    "get_market_profile",
    "get_macro",
    "get_news",
    "get_sentiment",
    "get_regime",
    "get_backtest",
    "get_swing",
    "get_order_blocks",
    "get_inducement",
    "get_premium_discount",
  ],
  Trading: [
    "find_setup",
    "hunt_for_setup",
    "trade_execute",
    "trade_modify",
    "modify_sl_tp",
    "remove_sl_tp",
    "partial_close",
    "full_close",
    "delete_pending_order",
    "delete_all_pending_orders",
    "validate_order",
    "get_settings_log",
    "correlation_check",
  ],
  "Trailing stops": [
    "get_trailing_stop_config",
    "set_trailing_stop_config",
    "enable_position_trailing",
    "disable_position_trailing",
    "list_trailing_positions",
    "process_price_tick",
  ],
  "Account & connection": ["mt5_account", "run_selftest", "get_onboarding_status", "get_pairing_status", "get_goal_config"],
  "Pair groups & scope": [
    "list_pair_groups",
    "create_or_update_pair_group",
    "delete_pair_group",
    "get_active_pair_group",
    "set_active_pair_group",
    "set_active_pair",
    "clear_active_pair",
    "get_trading_session",
    "set_trading_session",
  ],
  Memory: [
    "recall_memory",
    "remember_user_fact",
    "remember_note",
    "remember_adaptability_note",
    "session_search",
    "tencent_memory",
    "check_write_approval",
    "toggle_write_approval",
    "approve_pending_write",
  ],
  Knowledge: ["knowledge_list", "knowledge_view", "knowledge_draft", "knowledge_save", "knowledge_delete", "list_knowledge_drafts"],
  Skills: [
    "list_skills",
    "create_skill",
    "install_skill_from_github",
    "install_skills_from_jsonl",
    "set_active_strategy_skill",
    "clear_active_strategy_skill",
    "get_active_strategy_skill",
    "delete_skill",
  ],
  "Telegram & messaging": [
    "send_telegram",
    "tg_rich_message",
    "tg_edit_message",
    "tg_send_file",
    "tg_send_photo",
    "tg_send_poll",
    "pin_message",
    "unpin_message",
    "tg_chat_action",
    "set_bot_profile",
    "edit_bot_menu",
    "telegram_health",
    "deliver_ea",
    "pair_user",
    "push_message_to_user",
    "read_image",
    "analyze_image",
    "process_video",
    "analyze_video",
    "transcribe_voice_note",
    "send_voice_message",
    "notification_settings",
    "set_tts_provider_key",
    "send_ea_connected_notification",
    "send_trade_opened_notification",
    "send_trade_closed_notification",
    "get_voice_settings",
    "set_voice_enabled",
    "set_active_voice_provider",
    "set_voice_id",
  ],
  "Workers & subagents": [
    "create_subagent",
    "list_subagents",
    "get_subagent",
    "retire_subagent",
    "request_tool",
    "check_my_tool_requests",
    "list_pending_tool_requests",
    "decide_tool_request",
    "journal_trade",
    "journal_close",
    "journal_daily",
    "journal_search",
  ],
  "Background checks": ["start_background_check", "list_background_checks", "get_background_check", "stop_background_check"],
  "Web & search": ["add_firecrawl_key", "list_firecrawl_keys", "remove_firecrawl_key", "web_search", "scrape_url"],
  "Sandbox & self-improvement": [
    "davesbx",
    "davesbx_health",
    "davesbx_write_file",
    "davesbx_read_file",
    "add_e2b_key",
    "list_e2b_keys",
    "remove_e2b_key",
    "check_e2b_key_health",
    "create_e2b_sandbox",
    "propose_patch",
    "preview_patch",
    "test_patch",
    "request_approval",
    "decide_approval",
    "get_approval",
    "get_auto_approve",
    "set_auto_approve",
    "apply_patch",
    "propose_new_tool",
    "request_tool_creation_approval",
    "get_version_history",
    "rollback_to_version",
  ],
  Safety: [
    "circuit_breaker",
    "check_safety_limits",
    "reset_circuit_breaker",
    "hard_stop",
    "pause_action",
    "resume_action",
    "get_interrupt_state",
    "detect_manual_close",
    "detect_manual_modify",
  ],
  "Settings & admin": [
    "set_risk_mode",
    "set_trading_mode",
    "propose_settings_change",
    "get_auto_approval",
    "set_auto_approval",
    "get_self_pause_enabled",
    "set_self_pause_enabled",
    "get_analysis_config",
    "set_analysis_scope_all",
    "set_analysis_timeframes",
    "set_analysis_endpoints",
    "get_confidence_settings",
    "set_confidence_threshold",
    "set_auto_approve_below_threshold",
    "get_lovable_mcp_settings",
    "set_lovable_mcp_settings",
    "generate_image",
    "lovable_ai_agent",
  ],
  "Providers (LLM keys)": [
    "list_providers",
    "add_provider_key",
    "edit_provider_key",
    "remove_provider_key",
    "list_provider_keys",
    "add_provider_keys_bulk",
    "set_primary_provider_key",
    "fetch_provider_models",
    "check_provider_key_health",
    "create_custom_provider",
    "edit_custom_provider",
    "delete_custom_provider",
  ],
  "MCP (external tool servers)": ["mcp_connect", "mcp_list", "mcp_call", "mcp_disconnect", "mcp_list_saved_servers", "mcp_connect_saved"],
  "Reflection & feedback": [
    "record_skip",
    "list_skips",
    "record_hypothesis",
    "record_observation",
    "list_hypotheses",
    "get_reflection_threshold",
    "set_reflection_threshold",
    "get_todays_journal",
    "get_win_rate",
    "get_trade_history",
    "add_trade_comment",
  ],
  "Database (your own tables)": [
    "db_create_table",
    "db_list_tables",
    "db_create_records",
    "db_read_records",
    "db_update_records",
    "db_delete_records",
    "db_aggregate",
  ],
  "Automation & workflows": ["create_automation", "list_automations", "pause_automation", "resume_automation", "delete_automation", "start_workflow", "get_workflow_run"],
  "Meta / self-discovery": ["search_tools", "get_tool_catalog", "ask_user"],
};

export interface ToolCatalogEntry {
  name: string;
  description: string;
}

export interface ToolCatalogCategory {
  category: string;
  tools: ToolCatalogEntry[];
}

/**
 * Builds the categorized catalog from the REAL, currently-registered tools -- never from the
 * static list above in isolation, so a tool that isn't registered in this build (e.g. Telegram
 * tools when no live client was supplied) never shows up as available when it genuinely isn't.
 */
export function buildToolCatalog(registry: ToolRegistry): ToolCatalogCategory[] {
  const byName = new Map(registry.list().map((t) => [t.name, t.description]));
  const claimed = new Set<string>();
  const categories: ToolCatalogCategory[] = [];

  for (const [category, names] of Object.entries(TOOL_CATALOG_CATEGORIES)) {
    const tools: ToolCatalogEntry[] = [];
    for (const name of names) {
      const description = byName.get(name);
      if (description === undefined) continue; // not registered in this build (e.g. no telegram client) -- omit, don't fabricate
      tools.push({ name, description });
      claimed.add(name);
    }
    if (tools.length > 0) categories.push({ category, tools });
  }

  // Any registered tool the static map above doesn't yet know about (new tool shipped since this
  // map was last updated) still surfaces here -- never silently missing from the real catalog.
  const leftover: ToolCatalogEntry[] = registry
    .list()
    .filter((t) => !claimed.has(t.name))
    .map((t) => ({ name: t.name, description: t.description }));
  if (leftover.length > 0) categories.push({ category: "Other", tools: leftover });

  return categories;
}

export function createGetToolCatalogTool(registry: ToolRegistry) {
  return {
    name: "get_tool_catalog",
    description:
      "Get your ENTIRE tool catalog, structured and categorized (Analysis, Trading, Trailing Stops, Account & Connection, Memory, Skills, Telegram, Workers, Safety, Settings, ...) -- every tool's real name and description, not just the curated always-loaded subset or a single search_tools match. Read-only, no side effects. Use this when you want to see everything available at once, or search_tools's keyword search comes up empty.",
    parameters: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: "Optional -- return only this one category (exact match, e.g. \"Trading\"). Omit to get every category.",
        },
      },
    },
    execute: async (args: Record<string, unknown>) => {
      const all = buildToolCatalog(registry);
      const requested = args.category as string | undefined;
      const categories = requested ? all.filter((c) => c.category.toLowerCase() === requested.toLowerCase()) : all;
      return {
        totalTools: categories.reduce((sum, c) => sum + c.tools.length, 0),
        totalCategories: categories.length,
        categories,
      };
    },
  };
}
