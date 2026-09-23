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
 * else (the ~40 specialized EA analysis tools, skills/knowledge management, provider/E2B/
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
  "get_tool_catalog",
  "recall_memory",
  "push_message_to_user",

  // Trading actions -- the real reason this bot exists, never gated behind discovery.
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
  "enable_position_trailing",
  "disable_position_trailing",

  // Live status/account -- what Dave checks before/after nearly every trade decision.
  // Item 10 real gap fixed (user: "remove this from his memory it shouldn't use any correlation
  // check or get price or get candles it should just do get all analysis"): get_price, get_candles
  // and correlation_check are deliberately NOT core anymore -- get_all_analysis alone returns every
  // one of the 44 real analysis endpoints (Ichimoku, structure, order blocks, momentum, volatility,
  // RSI/MACD/Stochastic, Fibonacci, correlation, session/news, price/candle data included) in ONE
  // call, so a real trade decision is driven by that single guaranteed call, not a dozen separate
  // indicator calls the model has to remember to make one at a time.
  "get_all_analysis",
  "get_account_balance",
  "mt5_account",
  "get_live_state",
  "ping_ea",

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
  // Real gap fixed (user, live: Dave repeatedly treated a settings value it didn't remember
  // setting as evidence of a compromised account and self-halted trading over it). Must be core,
  // not discovery-only -- checking this log before drawing that conclusion is the whole point.
  "get_settings_log",
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
  // Real gap fixed (user, live: minutes after placing a real trade itself, Dave asked the user
  // "did you put this in?"): must be core, not discovery-only -- the whole point is Dave checks
  // this BEFORE asking the user, and it can't reliably do that if it has to think to search for
  // the tool first.
  "get_trade_history",
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
  // The read half of list_skills. A lister that is core while its reader is discovery-gated is the
  // same dead end knowledge_list/knowledge_view had: the model sees a name every turn and has no
  // reachable way to find out what it says. (Dave had no reader at all until now.)
  "skill_view",

  // Real bug fixed (the trader: "feasibility to check for anything... I don't want to mark levels
  // again"). The general-purpose "check anything" background system (start/list/get/stop_background_
  // check -- a free-text whatToCheck re-evaluated by a real agent each poll tick, distinct from the
  // cheap mechanical mark_level) is genuinely built and wired (full-registry.ts starts the polling
  // engine and re-arms active checks at boot), but NONE of its four tools was core, so Dave could
  // only reach the check-anything primitive after a search_tools call he rarely made. Same fix as
  // knowledge: put them in front of him every turn so the capability is actually used.
  "start_background_check",
  "list_background_checks",
  "get_background_check",
  "stop_background_check",

  // The cheap mechanical background check (a price level, evaluated by a comparison, no model call)
  // -- the other half of "check for anything". The trading rules actively tell Dave to mark a level
  // and move on while hunting, so these must be in front of him every turn, not discovery-gated.
  // Same never-surfaced bug as the agent check above.
  "mark_level",
  "check_marked_levels",
  "cancel_marked_level",

  // Reminders to self (the trader: "give the bot reminders so the bot can remind itself"). Core,
  // not discovery-gated: a reminder is only useful if Dave thinks of it in the moment.
  "set_reminder",
  "list_reminders",
  "delete_reminder",

  // Self-awareness: record what you expect before a trade, and check your own past experience with
  // a similar setup before taking a new one. Outcomes accrue automatically as trades close.
  "record_trade_expectation",
  "find_similar_setups",
  "review_prediction_accuracy",
  "update_trade_thesis",
  "get_trade_thesis",

  // Trade-safety settings the trader adjusts by hand (both are real, per-user, and surfaced every
  // turn in <current_settings>): the risk:reward floor a trade must clear, and how far a position
  // may travel toward its stop before the self-aware monitor warns of deep loss (default 50%).
  // Core, not discovery-gated -- a "set my R:R to 2" / "warn me at 40%" must never depend on the
  // model happening to search_tools for the setting first.
  "get_min_risk_reward",
  "set_min_risk_reward",
  "get_deep_loss_alert",
  "set_deep_loss_alert",
  // Every self-aware alert (loss-duration, deep-loss, recovery, breakeven, stuck, hot-hand) has an
  // on/off switch. Core so "turn off the stuck-trade nag" works without a discovery step.
  "get_self_aware_alerts",
  "set_self_aware_alert",
  // use and save knowledge"). knowledge_view was the ONLY knowledge tool that was ever core -- and
  // it takes an id. Nothing in a turn ever told the model an id existed, and the lister and both
  // writers sat behind a search_tools discovery step the model had no reason to take. So the
  // knowledge store was, in practice, write-never/read-never: every instruction to "save what you
  // learned" silently no-opped. Saving genuinely requires BOTH knowledge_draft and knowledge_save
  // (the draft is not committed by itself), so promoting one without the other would have left the
  // same dead end one call further along.
  "knowledge_view",
  "knowledge_list",
  "knowledge_draft",
  "knowledge_save",

  // Item 7 real gap fixed (user: "a worker gets created with a name but never executes its
  // assigned task... no working delete-worker tool despite this being reported as done
  // previously"): re-verified end to end -- create_subagent/retire_subagent were ALWAYS real and
  // working (step72/step73/step32's own tests prove a real multi-turn run, real reporting, real
  // grant/revoke, real retire), but none of them were core -- the exact same Cause A pattern as
  // items 1/4/11. The model had no reliable reason to reach for retire_subagent specifically
  // (nothing prompts "delete a worker" the way trading tools are prompted), so a real user asking
  // Dave to delete a worker could easily hit a model that never discovered the tool existed.
  "create_subagent",
  "list_subagents",
  "retire_subagent",

  // Item 4/11 real gap fixed (user: "pin message, memory-write tools appear to have vanished"):
  // both are real, registered tools -- just not core, so a model would only ever reach them if it
  // happened to call search_tools first. Small, cheap, frequently relevant -- promoted to core so
  // they're never gated behind discovery.
  "pin_message",
  "unpin_message",
  "remember_user_fact",
  "remember_note",
  "remember_adaptability_note",

  // The full Telegram message-action surface (the trader: "the rich text editor... all of them").
  // The client could already react, delete, close polls, stream a rich draft, and show every
  // loading indicator, but none of those was a core tool, so Dave never reached for them. rich
  // formatting itself is already handled automatically on every send (rich-format.ts); these are
  // the message ACTIONS Dave chooses to take.
  "react_to_message",
  "delete_message",
  "stop_poll",
  "send_rich_draft",
  "tg_chat_action",
  "tg_rich_message",
  // The structured block form (tables, collapsible details, footers, pull quotes) and real reply
  // tagging. Both are only ever reached for in the moment they apply -- while composing a message
  // -- so a discovery round first means the plain-text version has already been sent.
  "tg_rich_blocks",
  "reply_to_message",

  // Real general-purpose compute (the trader: "you can connect the main agent to the e2b").
  // run_script was registered in the full registry but never core, so the main agent essentially
  // never reached for it -- the whole point of wiring E2B in was that Dave can check ANYTHING it
  // can express as code (pull a live feed, compute a correlation, backtest a rule, parse a file
  // the user sent, verify a number before quoting it) instead of guessing. That only works if the
  // tool is reachable on every turn without a discovery round first.
  "run_script",
  // Memory consolidation. remember_* can only APPEND, so once memory is full the only tool that
  // can still save a fact is this one -- and a tool the model has to discover first is a tool it
  // reaches for after it has already given up. (Same lesson as run_script and the background
  // checks: registered is not the same as reachable.)
  "edit_memory",
  // File I/O both directions -- useless if the model has to discover them first, since the trigger
  // is always a file the user just sent or a result it just produced.
  "list_user_files",
  "send_file_to_user",
];

/** Real bounds check -- CORE_TOOL_NAMES itself must always stay well under the hard cap, or the
 *  whole point of curating it is defeated. Enforced by step21's test, not just this comment. */
if (CORE_TOOL_NAMES.length >= MAX_TOOLS_PER_REQUEST) {
  throw new Error(`CORE_TOOL_NAMES has grown to ${CORE_TOOL_NAMES.length} -- must stay well under MAX_TOOLS_PER_REQUEST (${MAX_TOOLS_PER_REQUEST}).`);
}
