# Dave — Build Progress

This file tracks progress through the DAVE master build prompt, step by step.
Per the master prompt: work through numbered steps IN ORDER, verify each with
real proof before moving on, report back after each step individually.

## Status: Step 1 — Research Phase (IN PROGRESS)

Started: 2026-09-04

### Step 1 checklist
- [ ] 1.1 AirLLM (Qwen3-235B MoE loader bug status, VRAM/disk/RAM tradeoffs, integration steps)
- [ ] 1.2 DeepSeek Harness (DSH) — Cordis plugin architecture
- [ ] 1.3 Sandbox decision: Alibaba OpenSandbox vs DSH native sandbox
- [ ] 1.4 Hermes Agent memory architecture (frozen MEMORY.md/USER.md pattern)
- [ ] 1.5 TencentDB Agent Memory (4-tier L0-L3 pipeline)
- [ ] 1.6 Telegram Bot API — rich messages, streaming drafts, buttons, commands, profile picture
- [ ] 1.7 Prompt caching mechanics
- [ ] 1.8 Voice: Fish Audio / ElevenLabs (TTS) + STT for voice note transcription
- [ ] 1.9 Write research-summary.md, confirm understanding before Step 2

### Notes / open decisions
- WhatsApp voice calling (Green API + Gemini Live) — NOT reconfirmed as part of final
  architecture. Flagging as pending decision per master prompt §"OPEN QUESTION". Do not
  build until user explicitly confirms.
- Trading rules are NOT to be authored by Claude. goal.yaml stays an empty placeholder
  until the user uploads their own rules .md file.
- DAVEMA skill/reference document has not yet been provided — Step 7 blocked until it is.

## Steps overview (for reference)
1. Research  2. File tree plan  3. Identity & cold start  4. Memory system
5. AI brain  6. Sandbox  7. DAVEMA integration  8. Telegram bot core
9. Thinking indicator  10. Trading engine  11. EA + MCP trade placement
12. Workers  13. Worker comms  14. Admin panel  15. File I/O
16. Database + automation  17. Self-improvement  18. Feedback loop
19. Safety  20. Vision  21. Notifications  22. Final review
