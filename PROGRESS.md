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

## Status: Step 4 — Memory System (COMPLETE)

Completed: 2026-09-04

### Step 4 checklist
- [x] 4.1 Hermes-style frozen snapshot — already built in Step 3
      (`hermes-store.ts`); this step adds a real cache-hit proxy metric
      proving the static prefix stays byte-identical within a session
- [x] 4.2 `ADAPTABILITY.md` — already separate since Step 3
- [x] 4.3 TencentDB-style L0→L2 tiers wired alongside the Hermes pattern:
      `packages/dave-memory/src/tencent-tiers.ts` — L0 raw conversation
      turns, L1 extracted atomic facts, L2 scenario summaries. L3 Persona
      is intentionally NOT re-implemented — the existing frozen
      MEMORY.md/USER.md from Step 3 IS the L3 tier, per the research
      summary's integration note
- [x] 4.4 Session search — `session-search.ts`, real full-text substring
      search over the L0 conversation log
- [x] 4.5 Recall-before-acting — `recall-guard.ts`, enforced (not just
      documented): `executeTask()` throws `RecallRequiredError` unless
      `markRecalled()` was called first for that exact task
- [x] 4.6 Write-approval setting — `write-approval.ts`, off by default,
      `gatedWrite()` genuinely defers the write (proven: side effect did
      not run until `approveWrite()`)
- [x] 4.7 Hidden per-user webhook — `user-webhook.ts`, real Node `http`
      server, route namespace `/hooks/user/<token>`, proven distinct from
      the reserved `/hooks/worker/<id>/<token>` namespace (full worker
      webhook behavior is Step 12's, this only proves the separation)

### Real proof (Step 4)
Ran `npx tsx packages/dave-memory/test/step4-memory.test.ts` — real
execution, no mocks:
- L0/L1/L2 tiers: a real turn ("Hi Dave, I'm David and I prefer terse
  updates.") produced real extracted atoms and a real scenario summary
  on disk
- Session search: `searchSessions(userId, "EURUSD")` found the one real
  turn containing it, zero false positives on a nonsense query
- Cache-hit proxy: assembled the real static prefix (SOUL+IDENTITY+
  SECURITY+frozen memory, static-first per Step 1.7) three times in one
  session — all three SHA-256 hashes identical (100% proxy cache-hit
  rate); a fresh assembly taken *after* a mid-session write correctly
  differs, proving writes aren't lost, just not retroactive (frozen
  semantics from Step 1.4, now actually verified in code)
- Recall guard: `executeTask()` genuinely threw before `markRecalled()`,
  genuinely succeeded after
- Write-approval: with the gate OFF (verified default), a write applied
  immediately; with it ON, the side effect provably did NOT run until
  `approveWrite()` was called
- Hidden webhook: a real HTTP server on an ephemeral port, a real `fetch`
  POST to `/hooks/user/<48-hex-char token>` returned 200 and landed in
  the per-user inbox file; an unknown token got a real 404; a POST to
  `/hooks/worker/...` got a real 501 from a genuinely separate route
  handler, not silently absorbed by the user route
- `=== ALL ASSERTIONS PASSED ===`

### Not yet done (deferred to later steps)
- The cache-hit metric above is a proxy (prefix-hash stability) — a real
  `usage.cache_read_input_tokens` metric against a live Anthropic/
  DeepSeek call happens once Step 5 wires an actual provider
- L1 atom extraction uses a heuristic regex extractor by default; the
  extractor is pluggable and should be swapped for an LLM-backed one once
  Step 5/8 gives us a real model call site
- The hidden webhook server isn't mounted into a real deployed process
  yet — that happens when Step 8 stands up the actual bot process

## Status: Step 5 — AI Brain (COMPLETE, one correction to flag)

Completed: 2026-09-04

### Step 5 checklist
- [x] 5.1 AirLLM wired for Qwen3-235B: `ai-brain-service/main.py` (FastAPI,
      lazy model load, `/generate` + `/health`) — real attempt made, exact
      real result documented below
- [x] 5.2 DeepSeek + Claude wired as configured/switchable fallback
      providers: `packages/dave-brain/src/providers.ts`
      (`DeepSeekProvider`, `ClaudeProvider`), config via
      `getModelConfig`/`setModelConfig` (button-picker UI wires to these
      in Step 8, only these three provider names are valid)
- [x] 5.3 Basic failover: `provider-router.ts` — real HTTP timeout on a
      dead primary provably falls to the configured fallback, in order,
      with every attempt logged
- [x] 5.4 Workers routed via `routeForWorker()` — never returns `airllm`
      as primary or fallback
- [x] 5.5 4-bit compression: `ai-brain-service` defaults to
      `compression='4bit'`; see the correction below on where this
      actually runs

### Real proof — the AirLLM attempt (5.1/5.5)
Installed `airllm==3.3.0` for real (matches Step 1.1 research) in a venv
under `ai-brain-service/.venv`, then made a real, bounded attempt to load
`Qwen/Qwen3-235B-A22B` in this sandbox (no GPU, ~16–30GB free disk).
Exact sequence of real results:

1. `AutoModel.from_pretrained('Qwen/Qwen3-235B-A22B', compression='4bit')`
   → correctly recognized the architecture as `Qwen3MoeForCausalLM`
   ("using generic AirLLM streaming model for architecture:
   Qwen3MoeForCausalLM") — **no sign of the originally-feared MoE
   tensor-layout streaming bug from Step 1.1**; it got past architecture
   detection and index/shard resolution cleanly.
2. First real failure: `ImportError: bitsandbytes not found` — installed
   `bitsandbytes==0.50.2` for real and retried.
3. Second attempt: began downloading real shards (confirmed **118 total
   shards**, ~3.8GB for shard 1 alone — matches Step 1.1's "several
   hundred GB" disk estimate), then failed with:
   `RuntimeError: Found no NVIDIA driver on your system.`
4. Traced the real cause in the installed package source
   (`airllm/utils.py`): AirLLM's 4-bit/8-bit compression path calls
   `bnb.functional.quantize_nf4(v.cuda(), ...)` /
   `dequantize_nf4(v.cuda(), ...)` — **`.cuda()` is hardcoded** in
   AirLLM 3.3.0's compression implementation, unconditionally, regardless
   of bitsandbytes' own CPU backend (bitsandbytes 0.50.2 does ship a CPU
   backend at `bitsandbytes/backends/cpu/`, but AirLLM's own compression
   code never reaches it).
5. Retried **without compression**, passing `device='cpu'` explicitly
   (`AutoModel.from_pretrained('Qwen/Qwen3-235B-A22B', device='cpu')`) —
   this got further: it began AirLLM's disk-decomposition step for real
   (`saved as: .../splitted_model/model.embed_tokens.safetensors`), with
   **no CUDA error** this time. Stopped it at 60s (disk-watchdog bound)
   before it could consume meaningfully more disk, and deleted the
   partial cache (`rm -rf ~/.cache/huggingface`) to keep this sandbox usable.

**Correction to flag plainly, since it contradicts what was said earlier
in this conversation:** AirLLM's disk-offload/streaming mechanism itself
— "the point of AirLLM" — genuinely does not require a GPU, confirmed
above (step 5, uncompressed, `device='cpu'`, no CUDA error). **But the
specific 4-bit compression Step 5.5 asks to enable is a separate feature
that AirLLM 3.3.0 hardcodes to require an NVIDIA GPU, confirmed by
reading the actual installed package source, not assumed.** On Railway
CPU-only:
- Running Qwen3-235B via AirLLM uncompressed is architecturally possible
  (no CUDA requirement), but needs enough disk/RAM to hold the
  full-precision weights it streams layer-by-layer — realistically
  several hundred GB of persistent disk, which is a real Railway plan/cost
  decision, not a code problem.
- Running it with 4-bit compression (smaller footprint, per Step 5.5) is
  **not possible on CPU with AirLLM 3.3.0 as currently implemented** —
  it would need a GPU-backed host, which contradicts "Railway CPU."

This is a real trade-off to decide, not something to quietly pick a side
on: (a) run uncompressed on a large-disk CPU Railway service and accept
the disk footprint, (b) drop AirLLM's compression flag and accept slower/
larger uncompressed inference, or (c) put `ai-brain-service` on a
GPU-backed host after all for the compression path. Flagging for your
call rather than guessing.

### Real proof — provider router & failover (5.2/5.3/5.4)
No live DeepSeek/Claude API keys exist in this environment, so
`packages/dave-brain/test/step5-failover.test.ts` stands up real local
HTTP servers shaped like each provider's real response format and points
the real, production `AirLLMProvider`/`DeepSeekProvider` classes at them
over real loopback HTTP with real timeouts — same code path that hits
`api.deepseek.com`/`api.anthropic.com` in production, only the endpoint
is substituted for lack of credentials. Ran it:
- Default model config: `{"primary":"airllm","fallback":["deepseek","claude"]}`
- A real dead HTTP server (never responds) stood in for a stuck AirLLM;
  the router genuinely waited out a real 1500ms timeout (elapsed:
  1523ms) before falling to the real DeepSeek-shaped provider, which
  returned `"DeepSeek fallback response (real HTTP round trip)"`
- Failover log recorded the real attempt: `{"failedProvider":"airllm",
  "reason":"[airllm] request failed/timed out after 1500ms",
  "fellBackTo":"deepseek"}`
- `routeForWorker()` never selects `airllm` as primary or fallback, for
  either worker preference
- All-providers-failed path genuinely throws `AllProvidersFailedError`
  with the real accumulated failure reasons
- `=== ALL ASSERTIONS PASSED ===`

### Not yet done (deferred, not silently skipped)
- Real DeepSeek/Claude API keys aren't configured — live external calls
  need those from you before this can be tested against the real APIs,
  not just realistically-shaped local stand-ins
- The compression-vs-GPU trade-off above needs your decision before
  `ai-brain-service` is deployed anywhere for real
- Model-picker **UI** (buttons) is Step 8's job — the underlying
  `getModelConfig`/`setModelConfig` it will call are real and tested now

## Steps overview (for reference)
1. Research  2. File tree plan  3. Identity & cold start  4. Memory system
5. AI brain  6. Sandbox  7. DAVEMA integration  8. Telegram bot core
9. Thinking indicator  10. Trading engine  11. EA + MCP trade placement
12. Workers  13. Worker comms  14. Admin panel  15. File I/O
16. Database + automation  17. Self-improvement  18. Feedback loop
19. Safety  20. Vision  21. Notifications  22. Final review
