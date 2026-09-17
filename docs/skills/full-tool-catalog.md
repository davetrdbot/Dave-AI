---
name: full-tool-catalog
description: The complete, categorized list of every real tool registered in your live registry (dave-agent-loop/src/full-registry.ts) — name and a real one-line description for each, pulled from the actual registered tool definitions, not invented. Only a curated subset (~63 tools, see IDENTITY.md's "Your real tools") is sent to the model by default; this doc is the full picture.
use_when: search_tools's keyword search doesn't turn up what you're looking for, you want to see everything available in one place instead of one match at a time, or you're not sure whether a capability exists at all.
---

# Your Full Tool Catalog

This is every real tool your registry can hold, organized by category. The
curated set in `IDENTITY.md` is always loaded; everything else here is real
and reachable via `search_tools` (keyword) or `get_tool_catalog` (the whole
structured list, programmatically, in one call). This doc is the
human/semantic reference — `get_tool_catalog` is the same data as a callable
tool.

Counts: 227 tools are registered for every user; +20 more (`push_message_to_user`
plus the rest of Telegram/notifications) register only once a live Telegram
client is wired in for that chat — 247 max. Only ~63 are sent to the model by
default per request (a real per-provider tool-count cap), which is exactly
why this doc and `search_tools`/`get_tool_catalog` exist.

## Analysis (EA-computed, on demand)

`get_all_analysis` — every one of the 44 endpoints below, in ONE response, for
a symbol/timeframe, plus whether you already have an open position/pending
order on it and full account-wide awareness (all positions, margin/equity/
leverage). Always loaded; call before any real trade decision.

The 44 individual endpoints (each `get_<name>`, on-demand, for any symbol in
Market Watch):

- `get_trend` — moving averages, EMA alignment, golden/death cross, bias score
- `get_momentum` — RSI/MACD/Stochastic/CCI/Williams %R, overall bull/bear signal
- `get_volatility` — ATR, Bollinger Bands, Keltner Channel, expansion/contraction, regime
- `get_price` — bid/ask/spread, day/week/month/52w high-low, swap, lot size limits
- `get_structure` — HH/HL/LH/LL trend, BOS, CHoCH, MSS, CISD, dealing range, premium/discount, OTE zone
- `get_zones` — supply/demand zones, fresh/tested, strength score, mitigation %, nearest/strongest zone
- `get_liquidity` — BSL/SSL, equal highs/lows, sweeps, liquidity voids
- `get_volume` — volume vs average, bull/bear volume delta, spikes/climax
- `get_ichimoku` — tenkan/kijun/senkou A+B/chikou, cloud position, TK cross, signal score
- `get_fibonacci` — retracement/extension levels, nearest level, OTE zone, golden-ratio bounce
- `get_candles` — 20 candles + present forming candle, body/wick ratios, size vs ATR, gap/imbalance detection
- `get_patterns` — candlestick pattern recognition, strongest pattern, bias, reliability
- `get_ict` — FVG/iFVG, order blocks, breaker blocks, killzones, silver bullet, Judas swing, AMD phase, OTE zone
- `get_wyckoff` — accumulation/distribution/markup phase, spring/UTAD events, effort-vs-result
- `get_divergence` — RSI/MACD/Stochastic divergence, regular and hidden, bull/bear, strongest/confirmed
- `get_session` — Tokyo/London/NY/Sydney status, overlaps, time to next session, Asian range
- `get_pivots` — classic/Fibonacci/Camarilla/weekly/monthly pivots, nearest pivot, price vs pivot
- `get_levels` — round-number/psychological levels, big/half figures, 52-week high/low distance
- `get_orderflow` — buy/sell volume delta, absorption, climax, stop runs, momentum ignition
- `get_confluence` — MA trend/RSI/MACD/ADX/price-action agreement, direction, strength
- `get_risk_metrics` — ATR-based SL/TP levels, R:R ratios, pip value, recommended lot size per % risk
- `get_synthetic` — Boom/Crash/Volatility spike detection, due/overdue, spike probability
- `get_elliott` — current wave count, impulse/correction, wave target/invalidation
- `get_correlation` — cross-market correlation vs EURUSD/DXY proxy, risk-on/off, safe-haven status
- `get_strength` — currency strength for the pair's base/quote, differential, bias, strongest/weakest
- `get_heatmap` — currency strength heatmap across all 8 majors
- `get_fractal` — Williams fractal up/down points
- `get_harmonic` — Gartley/Bat/Butterfly/Crab detection, XABCD ratios, PRZ, confidence
- `get_mean_reversion` — z-score vs 20-period mean, overextension, revert-long/short signal
- `get_tape` — up/down tick ratio, tape bias, fast-tape detection
- `get_tape_flow` — cumulative volume delta, aggressive buyer/seller flow
- `get_seasonality` — most volatile hour of day, hourly average range, month/day-of-week context
- `get_spread_analysis` — spread vs ATR, cost rating, tradeable flag, execution mode
- `get_gann` — fan ratios, nearest Gann level, Square of 9 projection
- `get_market_profile` — POC, value area high/low, price vs value area, profile shape
- `get_macro` — daily/weekly change, DXY/gold/USDJPY proxies, risk-on/off regime
- `get_news` — upcoming economic-calendar events for the pair's currencies, high-impact count, blackout window
- `get_sentiment` — RSI + MACD + bull-bar % blended fear/greed-style score
- `get_regime` — trending/ranging/transitional classification, volatility regime, suggested trading style
- `get_backtest` — quick MA20/50-cross backtest over loaded history (win rate, net pips, edge)
- `get_swing` — swing highs/lows with bar index and timestamp, last leg direction
- `get_order_blocks` — bullish/bearish order blocks, high/low, center, mitigated status, distance
- `get_inducement` — IDM levels, taken status, next liquidity target, valid-setup flag
- `get_premium_discount` — premium/discount zone position, OTE zone, bias

Also: `get_live_state` — current tick/positions/pending-orders right now, without
waiting for the periodic push. `get_account_balance` — balance/equity/margin/
freeMargin/leverage standalone.

## Trading

- `find_setup` — scan the active pair group for a setup right now, on your own initiative
- `hunt_for_setup` — aggressively hunt right now; auto-broadens past a single-pair focus if it's dry (`huntModeActivated`); supports `excludeSymbols`
- `trade_execute` — place a real order (market or pending); price optional on pending types, pulled from a live quote
- `trade_modify` — change SL/TP on an open position (null removes)
- `modify_sl_tp` — explicit alias of trade_modify for setting new SL/TP levels
- `remove_sl_tp` — remove SL only, TP only, or both
- `partial_close` — close part of an open position, leave the rest running
- `full_close` — close an entire open position
- `delete_pending_order` — delete one specific pending order
- `delete_all_pending_orders` — delete every pending order at once
- `validate_order` — check an order for errors before actually sending it
- `get_settings_log` — durable log of every settings change made outside this conversation (via /settings or the admin panel) — field, old/new value, when
- `correlation_check` — cross-market correlation check for a symbol before stacking risk

## Trailing stops

- `get_trailing_stop_config` / `set_trailing_stop_config` — default breakeven/trailing SL levels at TP1/TP2/TP3
- `enable_position_trailing` — opt a real ticket into running breakeven/trailing (requires TP1+TP2+TP3 set)
- `disable_position_trailing` — opt a ticket back out
- `list_trailing_positions` — every ticket currently registered for trailing, with stage flags
- `process_price_tick` — run one real price tick against a position's breakeven/trailing stage logic

## Account & connection

- `get_live_state`, `get_account_balance` — see Analysis above
- `mt5_account` — get/set which MT5 account is in use (masked login/server only, never the password)
- `run_selftest` — diagnostic pass: EA connection, memory files, sandbox health, pairing status
- `get_onboarding_status` — user's bootstrap/onboarding progress
- `get_pairing_status` — whether this user is genuinely paired yet
- `get_goal_config` — read the user's optional goal.yaml override

## Pair groups & scope

- `list_pair_groups`, `create_or_update_pair_group`, `delete_pair_group`, `get_active_pair_group`
- `set_active_pair_group` — set the active/fallback pair group
- `set_active_pair` — narrow scanning to exactly one symbol; `clear_active_pair` reverts
- `get_trading_session` / `set_trading_session` — restrict trading to sydney/asian/london/new_york/all

## Memory

- `recall_memory` — always loaded; frozen snapshot, session search, recent atoms, scenarios
- `remember_user_fact` — save a lasting fact about the user to USER.md
- `remember_note` — save a general observation to MEMORY.md
- `remember_adaptability_note` — save a communication-style/tone preference to ADAPTABILITY.md
- `session_search` — search past session content by keyword
- `tencent_memory` — read the tiered memory (L0 turns, L1 atoms, L2 scenarios)
- `check_write_approval` / `toggle_write_approval` / `approve_pending_write` — memory write-approval gating

## Knowledge

- `knowledge_list` / `knowledge_view` — list/view saved knowledge entries
- `knowledge_draft` — draft a new entry (title/use-when/content), not yet saved
- `knowledge_save` — approve and commit a pending draft
- `knowledge_delete` — delete a saved entry
- `list_knowledge_drafts` — pending drafts awaiting approval

## Skills

- `list_skills` — every skill you have (built-in, self-created, installed) — full content included
- `create_skill` — write and save a new skill for yourself
- `install_skill_from_github` — install from a GitHub repo's SKILL.md/README.md
- `install_skills_from_jsonl` — install one or more skills from uploaded .jsonl content
- `set_active_strategy_skill` / `clear_active_strategy_skill` / `get_active_strategy_skill` — the single active trading-strategy skill
- `delete_skill` — delete a skill by id (permanent ones refuse)

## Telegram / messaging

- `send_telegram` — send a plain message
- `tg_rich_message` — send a rich-formatted (HTML tables/blockquotes) message
- `tg_edit_message` — edit a previously-sent message
- `tg_send_file` — send a document/file
- `tg_send_poll` — send a poll
- `pin_message` / `unpin_message` — pin/unpin a message (unpin defaults to most recent)
- `tg_chat_action` — show a typing/uploading indicator
- `set_bot_profile` — update the bot's display name/description
- `edit_bot_menu` — register/refresh the default command menu
- `telegram_health` — confirm the bot token is valid and reachable
- `deliver_ea` — send the user their personalized Dave EA .mq5 file
- `pair_user` — get/create the Dave-to-user push webhook
- `push_message_to_user` — proactively message the user (trade alert, urgent heads-up) — only registered with a live Telegram client
- `read_image` / `analyze_image` — read a local image, or ask the vision model a real question about it
- `process_video` / `analyze_video` — scene-aware keyframe extraction, or full video understanding (keyframes + audio transcript)
- `transcribe_voice_note` — timestamped transcription of a local audio/video file
- `send_voice_message` — synthesize speech and send it as a real Telegram voice note
- `notification_settings` — get/set morning-brief notification mode
- `set_tts_provider_key` — store a Fish Audio/ElevenLabs key
- `send_ea_connected_notification`, `send_trade_opened_notification`, `send_trade_closed_notification` — routed real-event push notifications (no-op if the user has that channel off)
- `get_voice_settings` / `set_voice_enabled` / `set_active_voice_provider` / `set_voice_id` — TTS configuration

## Workers & subagents

- `create_subagent` — spin up a real named subagent for a task (fixed or temporary assignment)
- `list_subagents` / `get_subagent` / `retire_subagent`
- `request_tool` — ask Dave for a tool a worker realizes it needs mid-task
- `check_my_tool_requests` — check status of your own tool requests
- `list_pending_tool_requests` / `decide_tool_request` — Dave's side of granting/denying worker tool requests
- `journal_trade` — write a structured + narrative trade journal entry
- `journal_close` — append a close note and P&L
- `journal_daily` / `journal_search` — read back journal entries

## Background checks

- `start_background_check` — start a real, polled condition check with a reason and a re-evaluated whatToCheck
- `list_background_checks` — pending/active (or all, including finished)
- `get_background_check` — one check's state, poll count, outcome
- `stop_background_check` — cancel a check

## Web / search (Firecrawl)

- `add_firecrawl_key` / `list_firecrawl_keys` / `remove_firecrawl_key` — Firecrawl API key management
- `web_search` — real web search, auto-fails over across stored keys
- `scrape_url` — real scrape of one URL to markdown + metadata

## Sandbox & self-improvement

- `davesbx` — run a command inside the main sandbox (fails closed if unconfined)
- `davesbx_health` — check real sandbox confinement health
- `davesbx_write_file` / `davesbx_read_file` — read/write files in the sandbox workspace
- `add_e2b_key` / `list_e2b_keys` / `remove_e2b_key` / `check_e2b_key_health` — E2B disposable-sandbox key management
- `create_e2b_sandbox` — spin up a disposable E2B sandbox for isolated tasks
- `propose_patch` — propose a verified-consistent patch to one of your own files (never applies directly)
- `preview_patch` — human-readable +/- preview of a proposed patch
- `test_patch` — run a real sandbox test against a candidate patch
- `request_approval` / `decide_approval` / `get_approval` — approval workflow for risky self-changes
- `get_auto_approve` / `set_auto_approve` — auto-approval for your own self-improvement proposals
- `apply_patch` — apply a tested, approved patch (hard-gated)
- `propose_new_tool` — propose creating a brand-new tool, through the same patch gate
- `request_tool_creation_approval` — request approval specifically for creating a new tool
- `get_version_history` / `rollback_to_version` — version history for your own files

## Safety

- `circuit_breaker` — real report: tripped state, consecutive error count, recent errors
- `check_safety_limits` — whether the circuit breaker would currently refuse action
- `reset_circuit_breaker` — explicit reset of a tripped breaker
- `hard_stop` — halts the trading loop immediately (/panic)
- `pause_action` — halts the trading loop (/stop), framed as deliberate
- `resume_action` — resumes after a stop/panic
- `get_interrupt_state` — current thinking-loop/trading-loop interrupt state
- `detect_manual_close` / `detect_manual_modify` — detect manual position changes between two snapshots

## Settings & admin

- `set_risk_mode` — SL/TP/lot mode off/on/auto
- `set_trading_mode` — switch Auto vs Trading Skills mode
- `propose_settings_change` — propose a settings change on your own initiative (sends Approve/Decline unless auto-approval is on)
- `get_auto_approval` / `set_auto_approval` — auto-approval of Dave's own proposed settings changes
- `get_self_pause_enabled` / `set_self_pause_enabled` — whether the bot may self-pause on high exposure
- `get_analysis_config` / `set_analysis_scope_all` / `set_analysis_timeframes` / `set_analysis_endpoints` — narrow or reset what get_all_analysis fetches
- `get_confidence_settings` / `set_confidence_threshold` / `set_auto_approve_below_threshold` — trade confidence gating
- `get_lovable_mcp_settings` / `set_lovable_mcp_settings` — Lovable MCP URL/token
- `generate_image` — generate an image via the user's configured Lovable MCP server
- `lovable_ai_agent` — real, independent AI text call via that same Lovable MCP server, a second AI capability separate from your own configured LLM provider

## Providers (LLM keys)

- `list_providers` — every known LLM provider (built-in + custom)
- `add_provider_key` / `edit_provider_key` / `remove_provider_key` / `list_provider_keys` — provider key management
- `add_provider_keys_bulk` — paste multiple keys for one provider at once
- `set_primary_provider_key` — mark a key as primary for failover ordering
- `fetch_provider_models` — fetch available models for a stored key
- `check_provider_key_health` — real health check against a stored key
- `create_custom_provider` / `edit_custom_provider` / `delete_custom_provider` — custom (non-built-in) providers

## MCP (external tool servers)

- `mcp_connect` — connect to any MCP server by URL and discover its tools
- `mcp_list` — list connected servers and their tools
- `mcp_call` — call a tool on a connected server
- `mcp_disconnect` — disconnect from a server
- `mcp_list_saved_servers` — list saved MCP server configs (provisioned in /settings)
- `mcp_connect_saved` — connect to a saved server by id

## Reflection & feedback

- `record_skip` — log a real setup you looked at and chose not to trade, and why
- `list_skips` — every logged skip for this account
- `record_hypothesis` — record a hypothesis about market/strategy behavior to test over time
- `record_observation` — record whether a cycle supported or contradicted a hypothesis
- `list_hypotheses` — every hypothesis with its current verdict
- `get_reflection_threshold` / `set_reflection_threshold` — trades-count that triggers automatic reflection
- `get_todays_journal` — today's real win rate, wins/losses/breakeven, net P&L
- `get_win_rate` — win rate and P&L over N past days
- `get_trade_history` — every real trade placed in a window, with real lifecycle status (open/closed, TP/SL/manual, P/L) — the authoritative "did I place this" answer
- `add_trade_comment` — append a timestamped running note to a trade you're monitoring

## Database (your own tables)

- `db_create_table` — create a table you own
- `db_list_tables` — list every table you own
- `db_create_records` / `db_read_records` / `db_update_records` / `db_delete_records` — row CRUD, scoped to what you own
- `db_aggregate` — real SQL aggregate (SUM/COUNT/AVG/MIN/MAX) over one of your tables

## Automation & workflows

- `create_automation` — persisted automation: scheduled (cron), entity-triggered, or webhook, firing a real tool call
- `list_automations` / `pause_automation` / `resume_automation` / `delete_automation`
- `start_workflow` — persisted multi-step call/wait/branch sequence, surviving restarts
- `get_workflow_run` — a workflow run's status, step index, accumulated context

## Meta / self-discovery

- `search_tools` — keyword search over every registered tool's name/description
- `get_tool_catalog` — this entire categorized catalog, structured, in one call (see below)
- `ask_user` — ask the user a genuine clarifying question when something is truly ambiguous
