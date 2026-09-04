# Dave — Build Progress

This file tracks progress through the DAVE master build prompt, step by step.
Per the master prompt: work through numbered steps IN ORDER, verify each with
real proof before moving on, report back after each step individually.

## Status: Step 1 — Research Phase (COMPLETE, awaiting user confirmation before Step 2)

Started: 2026-09-04 · Research completed: 2026-09-04

### Step 1 checklist
- [x] 1.1 AirLLM (Qwen3-235B MoE loader bug status, VRAM/disk/RAM tradeoffs, integration steps) — no confirmed open bug found; disk I/O is the real bottleneck
- [x] 1.2 DeepSeek Harness (DSH) — Cordis plugin architecture — confirmed real, matches module names in prompt
- [x] 1.3 Sandbox decision: Alibaba OpenSandbox vs DSH native sandbox — recommend DSH native sandbox, revisit only if it lacks browser automation
- [x] 1.4 Hermes Agent memory architecture (frozen MEMORY.md/USER.md pattern) — confirmed real (NousResearch), pattern matches spec
- [x] 1.5 TencentDB Agent Memory (4-tier L0-L3 pipeline) — confirmed real (TencentCloud)
- [x] 1.6 Telegram Bot API — rich messages, streaming drafts, buttons, commands, profile picture — findings need live-bot re-verification before Step 8 (see research-summary.md)
- [x] 1.7 Prompt caching mechanics — confirmed static-first/dynamic-last across Anthropic/OpenAI/DeepSeek
- [x] 1.8 Voice: Fish Audio / ElevenLabs (TTS) + STT for voice note transcription — recommend OpenAI transcription API for STT
- [x] 1.9 Write research-summary.md, confirm understanding before Step 2 — done, see research-summary.md; PAUSED here for user sign-off per master prompt process

Real proof: see `research-summary.md` for full findings, each with sources.
Two web-research passes were run in parallel; a third finding (Telegram's
`sendRichMessageDraft`/`<tg-thinking>`/`setMyProfilePhoto`) is flagged for
mandatory live re-verification against a real bot before Step 8, since it's
surprisingly well-matched to the prompt's own phrasing and should not be
trusted on search results alone.

### Notes / open decisions
- WhatsApp voice calling (Green API + Gemini Live) — NOT reconfirmed as part of final
  architecture. Flagging as pending decision per master prompt §"OPEN QUESTION". Do not
  build until user explicitly confirms.
- Trading rules are NOT to be authored by Claude. goal.yaml stays an empty placeholder
  until the user uploads their own rules .md file.
- DAVEMA skill/reference document has not yet been provided — Step 7 blocked until it is.

## Status: Step 2 — File Tree Plan (APPROVED)

Proposed full file/folder tree written to `FILE_TREE.md`. User confirmed
`ai-brain-service` runs on Railway CPU (AirLLM's disk-offload design is
the point) — resolves the open hosting question from Step 1/2.

## Status: Step 3 — Identity & Cold Start (COMPLETE)

Completed: 2026-09-04

### Step 3 checklist
- [x] 3.1 Four prompt-tier files written verbatim: `prompts/SOUL.md`,
      `prompts/IDENTITY.md`, `prompts/SECURITY.md`, `prompts/BOOTSTRAP.md`
- [x] 3.2 Name fixed: Dave (baked into BOOTSTRAP flow's opening message)
- [x] 3.3 Personality tone shift is textual in SOUL.md — real tone
      enforcement in code happens at Step 8/17 (LLM call sites), not here
- [x] 3.4 Memory files ship completely empty: `memory/MEMORY.md`,
      `memory/USER.md`, `memory/ADAPTABILITY.md` committed as 0-byte
      templates; `memory/goal.yaml` committed as an empty placeholder
      with an explanatory comment only
- [x] 3.5 Pairing flow implemented: `packages/dave-core/src/pairing.ts` —
      unconfigured by default, first message issues a user ID + pairing
      code, owner approves via `approvePairing(code)`
- [x] 3.6 Cold-start conversation implemented exactly per BOOTSTRAP.md:
      `packages/dave-core/src/bootstrap.ts` — one question at a time,
      answers saved immediately (`appendUserFact`/`appendAdaptability` in
      `packages/dave-memory`), closing summary message
- [x] 3.7 Real-task-during-onboarding handling: bootstrap state machine
      detects a task-shaped message, hands it off (transport-level stub
      for now), notes onboarding isn't finished, and leaves the bootstrap
      state open rather than silently advancing

### Real proof (Step 3)
Ran `npx tsx packages/dave-core/test/full-flow.test.ts` — a real,
non-mocked execution against real files on disk (not a unit test with
stubs for the memory layer). Full transcript:
- Unpaired user's first contact → real pairing code issued → owner
  approves by code → `isPaired()` flips true
- Pairing confirmed → Dave sends the real opening message + Q1 unprompted
- All 3 bootstrap questions asked one at a time, answers consumed in order
- `USER.md` on disk after the flow: `- Prefers to be called: David`
- `ADAPTABILITY.md` on disk after the flow: `- Communication style
  preference: Terse, only check in when it matters`
- Frozen-snapshot check: a snapshot taken mid-test did NOT pick up a
  write made immediately after it (Hermes-pattern static-first behavior,
  Step 1.4/4.1, verified in code now not just documented)
- Second user: sent a task-shaped message before finishing onboarding →
  bootstrap correctly did NOT consume it as an answer, sent the
  "haven't finished getting to know you" note, and left bootstrap state
  at `awaiting-name` (still open) instead of silently advancing
- `=== ALL ASSERTIONS PASSED ===`

### Architecture note discovered during Step 3
Installed and inspected the real `@deepseek-ai/dsh`/`cordis` packages
(224 packages). `dsh-persona` is the real injection point for Dave's
persona text (prefix-stable for caching); **`dsh-goal` is DSH's own
internal task-tracking concept, unrelated to Dave's trading `goal.yaml`
— kept these fully separate to avoid a wrong architecture**. DSH has no
built-in Telegram transport (it's a coding-agent harness driven via
stdio JSON-RPC), so Step 3's pairing/bootstrap/memory code was built
against a small `Transport` interface — works today against an in-memory
test transport, will take a real Telegram transport in Step 8 without
changing the state machine. Full detail in `FILE_TREE.md`.

### Not yet done (deferred to later steps, not silently skipped)
- No real Telegram wiring yet — Step 8 owns that; Step 3's test proves
  the pairing/bootstrap/memory logic itself, transport-agnostically
- No DSH runtime boot yet — persona composition into `dsh-persona`
  happens when Dave is actually wired onto the DSH agent loop (Step 8)
- Tone-shift enforcement (relaxed vs. precise) is not yet code — it's a
  prompt instruction until an LLM call site exists to enforce it against

## Steps overview (for reference)
1. Research  2. File tree plan  3. Identity & cold start  4. Memory system
5. AI brain  6. Sandbox  7. DAVEMA integration  8. Telegram bot core
9. Thinking indicator  10. Trading engine  11. EA + MCP trade placement
12. Workers  13. Worker comms  14. Admin panel  15. File I/O
16. Database + automation  17. Self-improvement  18. Feedback loop
19. Safety  20. Vision  21. Notifications  22. Final review
