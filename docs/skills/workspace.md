---
name: workspace
description: How Dave is actually put together — the prompt tiers and how they relate, how a real EA cycle flows, the tool-category map, and the real settings surface the user controls. A structural map, not a duplicate of what IDENTITY.md/trading.md/full-tool-catalog.md already teach in depth.
use_when: You want to understand where a piece of behavior actually comes from, how a live decision cycle wires together end to end, or what a user could be looking at when they mention a setting you don't immediately recognize.
---

# Dave's real structure

This is the map, not the manual — IDENTITY.md, SOUL.md, trading.md, and `full-tool-catalog.md` are each already the authoritative depth on their own topic. This doc exists for the one thing none of them are: how the pieces actually fit together.

## The prompt tiers, and why there are five of them

Every real turn (interactive chat and the autonomous loop alike) boots from the same five files, concatenated in this order: `SOUL.md` → `IDENTITY.md` → `SECURITY.md` → `trading.md` → `BOOTSTRAP.md`. Each has one real job, and none of them duplicate another's:

- **SOUL.md** — who Dave is as a personality. Tone, how Dave talks, how it takes a loss, how it handles pressure. Never trading logic.
- **IDENTITY.md** — how Dave operates in general: the tool catalog (curated subset + how to find the rest), the tool-selection decision framework, communication rules, workers, the autonomous-loop start/stop mechanics, skills as a concept. The operating manual, not the trading strategy.
- **SECURITY.md** — the absolute rules. Circuit breaker, hard stop, self-modification sandboxing, protected-limit changes, credential handling. Nothing here is ever negotiable by Dave, and every rule here carries its own rationalization tripwire — if Dave finds itself arguing a rule doesn't apply this time, that argument is the signal to stop, not proceed.
- **trading.md** — the actual trading behavior: when to hunt, how to size, the precedence order when signals conflict, the full analysis-suite mandate, milestones. Built in, never something the user has to configure before Dave can trade.
- **BOOTSTRAP.md** — governs exactly one thing: the very first real conversation after pairing. Irrelevant to every turn after that.

This tiering is deliberate: SOUL/IDENTITY/SECURITY/trading.md are static, loaded once per process boot and prefix-cached for cost — none of them ever contain live, per-user state (a specific balance, a specific setting value). That data reaches Dave a different way (see "Live context," below), specifically so the static tiers stay cache-friendly and don't need reloading every time a user changes a setting.

Two more files exist but are NOT part of the always-loaded stack:
- **`docs/skills/full-tool-catalog.md`** and **`docs/skills/ea-analysis-skill.md`** — full reference material (every tool, every EA analysis endpoint), seeded as permanent skills via `packages/dave-skills/src/internal-tool-docs.ts` so `list_skills`/`recall_memory` can genuinely pull them on demand, without bloating every single system-prompt load with content that's only needed occasionally.
- **This file** — same mechanism, same reasoning.

## Live context: how a static prompt sees dynamic state

The five static tiers above never change per-request. What actually carries live, per-user state (current SL/TP mode, active pair group, confidence threshold, account balance, and — when one is set — the full content of an active trading-strategy skill) is `packages/dave-agent-loop/src/live-context.ts`, which builds a fresh `<current_settings>` / `<active_strategy_skill>` block and prepends it to the CURRENT user message on every real turn. This rides on the message itself (inherently new every turn anyway) rather than the cached system prompt, so a setting saved a moment ago is genuinely visible on the very next turn with zero cache-invalidation cost.

The autonomous trading loop (`packages/dave-agent-loop/src/autonomous-tick.ts`) builds its own `contextLines` the same way, independently — not by calling `live-context.ts` — because a tick's real inputs (the current symbol's full analysis suite, open positions, self-pause state) are different from a chat turn's. It does, however, inject the same `<active_strategy_skill>` content directly, so a skill's scope reaches autonomous decisions exactly like it reaches interactive ones.

## A real decision cycle, end to end

1. The MT5 EA (`ea/DaveEA.mq5`) pushes a heartbeat to the webhook bridge on its own timer (1s by default), and answers `analyze` commands with real computed endpoint data when asked.
2. `packages/dave-ea-bridge` is the Node-side webhook server + client — it turns EA pushes into real, awaitable results (`get_all_analysis` and friends), and turns `trade_execute`/`modify_sl_tp`/etc. into real commands the EA picks up on its next heartbeat.
3. For a chat turn: `packages/dave-agent-loop/src/telegram-bot-server.ts`'s `runAgentTurn` assembles the static prompt + live context + full tool registry, runs the model loop, and sends the result back through `packages/dave-telegram`. The `tg_thinking`/`tg_thinking_update`/`tg_finalize` tools are the only mechanism that can create or update a visible progress indicator — there's no separate automatic wrapper, specifically to avoid two things racing to own the same message.
4. For an autonomous tick: `runAutonomousTick` (`autonomous-tick.ts`) picks the next symbol in the active pair group (round-robin), pulls a full analysis suite, builds its own context, and asks the model for exactly one structured decision via a single tool call — not an open-ended agent loop. The result either executes, queues for approval, or is a genuine SKIP.
5. `packages/dave-agent-loop/src/full-registry.ts` is where every package's tools (`dave-trading`, `dave-telegram`, `dave-skills`, `dave-workers`, `dave-memory`, `dave-knowledge`, `dave-firecrawl`, and the rest) actually get assembled into the one registry both paths above pull from — this is the single place a new tool category gets wired in.

## Tool categories, at a glance

The exhaustive, always-accurate list (226 tools as of the last real count, pulled live from the registry) lives in `full-tool-catalog.md` and the `get_tool_catalog` runtime tool — don't duplicate it here. The rough shape: real-time analysis (46 EA endpoints), trading execution and management, trailing stops, account/connection, pair groups, memory (read + write), knowledge base, trading-strategy skills, Telegram/messaging (including the thinking-indicator tools), workers and subagents, background checks (the general-purpose "watch for X, report back with why" primitive), web/search, self-improvement sandbox, and settings/admin.

## What the user actually controls, and where

- **Telegram `/settings`** — the real, live surface: SL/TP/lot mode (off/on-fixed/auto) and values, protected limits (max open trades, max daily loss — proposal-and-approval only, never silently changed), self-pause toggle, two-step (Flo) trading toggle, sequential-thinking toggle (decision-time only, default off), active pair group, active trading-strategy skill.
- **`/models`** — provider and model selection, including fallback chain configuration.
- **The admin panel** (web) — the rarer, heavier settings: an optional `goal.yaml` additive constraint, provider API keys, Railway/deployment-level configuration. Not something Dave prompts the user toward; it exists for the cases `/settings` doesn't cover.
- **`/reset`** — clears settings back to defaults. Everything reading as off/empty right after a reset is the expected, correct state, not a compromise signal (trading.md's "Settings changing without you touching them is normal" covers the reasoning).

None of the above is a static fact Dave should memorize from this doc — always read live state via the real tools/context block when it matters for a decision. This section exists so a user mentioning "the admin panel" or "my settings" maps to something concrete, not so Dave can answer settings questions without checking.
