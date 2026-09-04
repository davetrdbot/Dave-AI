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

## Status: Step 6 — Sandbox (COMPLETE, one finding to flag)

Completed: 2026-09-04

### Step 6 checklist
- [x] 6.1 Wired the real `@deepseek-ai/dsh-sandbox-local` package chosen
      in Step 1.3 — `packages/dave-sandbox/src/sandbox-client.ts` — one
      consistent layer for Dave and workers, not a second parallel
      implementation
- [x] 6.2 Real code execution, real file I/O, real browser automation —
      all proven working (see below)
- [x] 6.3 Graceful degradation — `degradation.ts`, `checkSandboxHealth()`
      + proof that chat/DAVEMA-shaped functions keep returning real
      output regardless of sandbox reachability

### Real proof (Step 6)
Ran `npx tsx packages/dave-sandbox/test/step6-sandbox.test.ts`:
- **Real attempt at DSH-native confinement**: instantiated the actual
  `LocalSandboxProvider` from `@deepseek-ai/dsh-sandbox-local` via a real
  Cordis `Context`, called its real `confine()` method. Result: it threw
  `SandboxUnavailableError` — this sandbox host has neither `bwrap` nor a
  Landlock-enforcing kernel available, so DSH's own fail-closed design
  correctly refused to pretend to confine anything.
- **Real code execution**: `node -e "console.log(2 + 2)"` executed for
  real (degraded/unconfined, honestly reported as such), stdout `"4"`,
  exit code 0.
- **Real file I/O**: wrote and read back a real file
  (`notes/analysis.md`) scoped to a real temp workspace directory; a
  path-escape attempt (`../../etc/should-not-write`) was correctly
  rejected before touching the filesystem.
- **Real browser automation**: launched real headless Chromium via
  Playwright (pinned to 1.56.1 to match this environment's pre-fetched
  browser build), navigated to a real data: URL, read back the real page
  title `"Dave Sandbox Browser Test"`.
- **Graceful degradation**: `checkSandboxHealth()` correctly reported
  `reachable=false` with the real reason; a stand-in for Dave's
  chat/DAVEMA path (unrelated to the sandbox) returned real, non-empty
  output regardless — proving the rest of the agent doesn't go down with
  the sandbox.
- `=== ALL ASSERTIONS PASSED ===`

### Finding to flag: DSH's native sandbox needs host kernel features that may not exist on Railway
This is worth being upfront about rather than quietly working around:
DSH's sandbox is **same-world process confinement** (bwrap or Landlock on
Linux) — it needs specific host kernel/container capabilities
(unprivileged user namespaces for bwrap, or a Landlock-enforcing kernel).
**This sandbox environment has neither, and it's a real, open question
whether a Railway container will either** — PaaS containers commonly
restrict the same namespace/capability features. If Railway doesn't
support it either, Dave's sandbox will run in the same degraded
(unconfined-but-reported) mode demonstrated above in production, not
just here.

This changes the Step 1.3 recommendation's confidence level: DSH's
native sandbox is still the right *default* to keep one consistent layer
(confirmed: it fails closed and reports honestly rather than silently
lying about confinement), but real OS-level isolation on Railway is not
guaranteed by choosing it. Real options, for your call once Dave is
actually deployed and this can be tested on the real Railway container:
1. Accept degraded/unconfined execution on Railway (same as this test) —
   simplest, but code execution then has no OS-level sandboxing at all.
2. Explicitly configure DSH's `danger-full-access` mode so this is a
   deliberate choice, not a silent fallback, with the isolation risk
   understood.
3. Reconsider Alibaba OpenSandbox (Step 1.3's alternative) specifically
   for its container/gVisor/Firecracker-based isolation, which doesn't
   depend on the host kernel's namespace/Landlock support the way DSH's
   same-world confinement does.
Not deciding this now — flagging it for when Dave is actually deployed
and Railway's real container capabilities can be tested directly, rather
than guessing.

### Not yet done (deferred, not silently skipped)
- DSH has no dedicated browser-automation package (confirmed by
  inspecting its full package list — only web-fetch/web-search exist,
  neither drives a real browser), so browser automation runs as a
  Playwright-based code-execution task rather than through a DSH-native
  browser provider. This keeps "one consistent execution/browsing layer"
  per Step 6.1's requirement without adding an unrelated second product.
- The Railway-vs-confinement question above needs real testing on an
  actual Railway container, which doesn't exist yet in this build

### Update — real OpenSandbox attempt (requested after Step 6)
Installed the real Alibaba OpenSandbox SDK (`@alibaba-group/opensandbox`
0.1.11 — confirmed this is the correct package; there's an unrelated npm
package literally named `opensandbox` from a different project
(diggerhq, E2B-compatible) that must not be confused with it).
`packages/dave-sandbox/src/opensandbox-client.ts` is a real client using
the real SDK (`Sandbox.create()`, `sandbox.commands.run()`,
`sandbox.files.*`). Real, bounded connection attempt:
`attemptOpenSandboxConnection()` against a local domain with no server
running → real result: `TypeError: fetch failed` (no OpenSandbox service
reachable), same honest-failure methodology as the AirLLM and DSH-
sandbox attempts. **OpenSandbox is a client/server product** — real
functional proof (create a sandbox, run a command, get a result) needs
either a self-hosted OpenSandbox instance (their Docker compose) or a
hosted instance with a real API key, neither of which exists yet. This
gives Dave two real, code-complete sandbox backends
(`sandbox-client.ts` for DSH-native, `opensandbox-client.ts` for
OpenSandbox) to choose between once real infrastructure exists for
either — a decision for when Dave is actually deployed, not resolved here.

## Steps overview (for reference)
1. Research  2. File tree plan  3. Identity & cold start  4. Memory system
5. AI brain  6. Sandbox  7. DAVEMA integration  8. Telegram bot core
9. Thinking indicator  10. Trading engine  11. EA + MCP trade placement
12. Workers  13. Worker comms  14. Admin panel  15. File I/O
16. Database + automation  17. Self-improvement  18. Feedback loop
19. Safety  20. Vision  21. Notifications  22. Final review

## Status: Step 7 — DAVEMA Integration (COMPLETE)

Completed: 2026-09-04

### Step 7 checklist
- [x] 7.1 Read the DAVEMA skill doc and full PDF documentation in full
      (both provided this session) — 46 endpoints, base URL, auth, status
      codes, response envelope, all confirmed consistent between the two
      documents
- [x] 7.2 Dave calls DAVEMA directly over HTTPS, no sandbox routing:
      `packages/dave-davema/src/client.ts` — plain `fetch()`, nothing else
- [x] 7.3 Correlation check before sizing: `correlation.ts`, pulls
      `/correlation` + `/strength` per the skill doc's own recipe
- [x] Extra (requested alongside Step 7): secure DAVEMA API key storage
      (`credentials.ts`) + a transport-agnostic "ask for the key" flow
      (`api-key-flow.ts`), same pattern as Step 3's `BootstrapFlow` —
      ready for Step 8's real Telegram transport

### Real proof (Step 7)
Ran `npx tsx packages/dave-davema/test/step7-davema.test.ts` — real
live HTTPS calls to the actual DAVEMA service (not mocked):
- **Real `/ping` call** (no auth needed) returned a real live response:
  `{"status":"ok","service":"davema","version":"3.1","time":"...",
  "features":["multi_timeframe_confirmation","endpoint_bundles",
  "relative_history_windows","all_endpoint","watchlist_stream"]}` —
  confirms the service is live and reachable, and surfaces real features
  not mentioned in the docs (multi-timeframe confirmation, endpoint
  bundles, relative history windows) worth exploring later
- **Real `/price` call with no key** → real `401`:
  `{"error":"Missing x-api-key header"}`
- **Real `/structure` call with a syntactically-valid but fake key** →
  real `401`: `{"error":"Invalid or inactive API key"}` — confirms the
  API genuinely validates keys server-side, not just checks presence
- Key format validator correctly distinguishes valid/invalid formats;
  masking never leaks the key body
- Secure credential storage: a key stored via `storeDavemaKey()` is
  retrievable in full only through `getDavemaKey()` (used solely to build
  the outgoing header); every other accessor is masked
- API key request flow: asked, rejected a malformed key with a plain
  explanation, accepted a valid-format key with a masked confirmation
  that never echoes the real value, and correctly ignored an unrelated
  chat message rather than misrouting it into the key handler
- Correlation check (7.3): real `/correlation` + `/strength` calls fired
  (confirmed via the real 401 they returned — no key available, but the
  code path genuinely executed against the live API)
- `=== ALL ASSERTIONS PASSED ===`

### Real proof — what's still missing, and why
**No real DAVEMA API key exists in this environment**, so the calls
above prove the integration (real endpoint, real auth enforcement, real
error shapes) but not real authenticated *data*. To close that gap
either paste a real `sk_live_...` key in chat now (it'll be stored via
the same secure path shown above, `data/credentials/`, gitignored, never
committed) so I can re-run against 3+ endpoints with real returned
fields, or hold off until Step 8 wires a real Telegram transport and use
the `DavemaApiKeyFlow` built above through the bot itself.

### Not yet done (deferred, not silently skipped)
- Full authenticated real-data proof across 3+ endpoints — blocked on a
  real key, per above
- The correlation check's "compare against currently open positions"
  half isn't wired yet — that needs Step 10's trading engine (position
  state) to exist first; today it checks one symbol's correlation in
  isolation, which is the correct scope for Step 7 alone
- The credential store is a real file-permission-restricted baseline, not
  a production KMS — same caveat as noted for the sandbox in Step 6,
  worth hardening before a real Railway deploy

## Status: Step 8 — Telegram Bot Core (COMPLETE, live-bot test deferred per your request)

Completed: 2026-09-04

### Step 8 checklist
- [x] 8.1 Exactly the 9 required commands (`/account /connection /providers
      /models /settings /reset /help /status /ea`), nothing else registered
      as a command — `commands.ts`
- [x] 8.2 Full rich formatting: bold/italic/underline/strikethrough/spoiler/
      code/pre/blockquote/expandable blockquote/links/mentions/custom emoji/
      headings/lists/tables — `rich-format.ts`; real reply-with-quote via
      `ReplyParameters.quote` on `client.ts`
- [x] 8.3 Colored inline buttons — see correction below
- [x] 8.4 Settings-screen pattern: two buttons per row, live state,
      checkmark, Back row — `buttons.ts::settingsScreen()`
- [x] 8.5 `/ea` button picker + personalized `.mq5` with webhook URL+token
      pre-filled, shown again in caption — `ea-file.ts`, reuses Step 4's
      real hidden webhook infra
- [x] 8.6 `setMyCommands` + confirmed real per-user menu customization via
      `BotCommandScopeChatMember` — `menu.ts`
- [x] 8.7 Bot display-info update — see correction below

### Corrections made before building (checked real docs first, per your
"we'll test that later" — I still verified the API surface itself, just
deferred the live-bot render test)
- **`<tg-thinking>` and `setMyProfilePhoto`/`removeMyProfilePhoto` do not
  exist in the real Bot API** — confirmed by fetching the actual docs.
  These were hallucinated in the Step 1 research pass, exactly the kind
  of thing flagged then for re-verification. There is genuinely no API
  method for a bot to change its own profile photo — only manually via
  `@BotFather`'s `/setuserpic`. `profile.ts::botProfilePhotoInstructions()`
  says this plainly instead of faking a call. The display-info half of
  8.7 (`setMyName`/`setMyDescription`/`setMyShortDescription`) IS real
  and implemented for real.
- **`InlineKeyboardButton` has no color field** — confirmed against the
  real docs. "Colored buttons" are implemented the way every real bot
  does it: an emoji prefix (🟢/🔴/🔵) carrying the semantic meaning,
  documented as a workaround in `buttons.ts`, not presented as a native
  color property.
- **`sendRichMessageDraft`** and **`ReplyParameters.quote`** ARE both
  real, confirmed in the docs — implemented as documented.

### Real proof (Step 8)
Ran `npx tsx packages/dave-telegram/test/step8-telegram.test.ts`:
- Command registry: exactly the 9 required names, `parseCommand()`
  correctly splits command from arguments
- All 14 formatting helpers produce correct real HTML tags; confirmed
  user content gets HTML-escaped (`<script>` → `&lt;script&gt;`) so
  formatted text can't break `parse_mode: HTML` parsing
- Table rendering via monospace `<pre>` (no native Telegram table)
- Colored buttons: real JSON shape with the emoji-prefix workaround
- Settings screen: 2 option rows + 1 Back row, exactly 2 buttons per
  option row, the active option correctly carries the ✅
- `/ea` file: real webhook URL (`https://dave.example.com/hooks/user/
  <48-hex token>`) and token substituted into the real `ea/DaveEA.mq5`
  template, zero leftover `{{...}}` placeholders, both real values
  actually present in the generated file content
- **Real network round-trip**: called the actual `api.telegram.org`
  with a syntactically-invalid token — got back Telegram's real,
  live `401: Unauthorized: invalid token specified`, proving the
  client genuinely talks to the real API rather than a stub
- `=== ALL ASSERTIONS PASSED ===`

### Deferred, by your instruction
Full live-message rendering (what formatting/buttons/reply-with-quote
actually look like in a real Telegram chat) needs a real bot token from
`@BotFather` — you said to test that later, so it's not blocking, but
it's the one piece of Step 8 that can't be proven without one.

## Status: Step 9 — Thinking Indicator with Live Action-Type Icons (COMPLETE)

Completed: 2026-09-04

### Step 9 checklist
- [x] 9.1 Automatic typing/uploading chat action, zero AI decision —
      `withThinkingIndicator()` wrapper always starts it; the agent loop
      never chooses to call or skip it. Best-effort: a failed chat-action
      call never blocks the actual task (swallowed, not thrown)
- [x] 9.2 A real tool the agent calls to update the visible thinking text
      live — `ThinkingIndicator.update(action, text)`, backed by the real
      `sendRichMessageDraft` confirmed in Step 8
- [x] 9.3 Icon-prefixed text by typed action — `ACTION_ICONS` as const
      object + `ActionType` union (`code`/`database`/`api`/`input`/
      `output`/`memory`/`trade`/`worker`), not free-form strings
- [x] 9.4 Finalizes cleanly into a real message — `finalize()` edits the
      draft into plain final text, no leftover action icon

### Real proof (Step 9)
Ran `npx tsx packages/dave-telegram/test/step9-thinking-indicator.test.ts`
in two parts, since a real-but-unauthenticated network call can prove
genuine HTTP integration but not internal state transitions (every call
fails identically with no valid token, so `messageId` never gets set —
that's the correct degraded behavior, not a bug, but it can't prove the
draft→edit→finalize path):
- **Part A** — real state-machine proof against a working transport
  (same fake-transport pattern already used and accepted in Steps 3/4/7):
  call order was `sendChatAction → sendRichMessageDraft → editMessageText
  → editMessageText → editMessageText`; all three edits after the first
  draft genuinely targeted the same `message_id`; each update's real sent
  text was correctly icon-prefixed (`🧠 Recalling...`, `📡 Calling
  DAVEMA...`, `💹 Scoring EURUSD...`); the finalized message was clean
  plain text with no leftover icon
- **Part B** — real network round-trip: with no valid token, real calls
  to `api.telegram.org` for `sendChatAction` and `sendRichMessageDraft`
  were confirmed to genuinely fire (captured via a fetch spy that still
  forwards to the real network) before failing with Telegram's real 401
  — proves this isn't a stub
- **Part C** — confirmed the typed enum has exactly the 8 required
  action types, each mapped to a real icon
- `=== ALL ASSERTIONS PASSED ===`

### Not yet done (deferred, not silently skipped)
- Full live rendering of the draft→edit sequence in a real Telegram chat
  needs a real bot token — same deferral as Step 8, by your instruction

## Follow-up: EA code review (requested after Step 9)

You asked me to actually check my own Step 8 `/ea` work rather than take
my word for it. Real review found real bugs — listed honestly below,
all fixed and re-tested, not glossed over:

### Bugs found in `ea/DaveEA.mq5`
1. **Trailing-NUL bug**: `StringToCharArray(body, post, 0, StringLen(body))`
   appends a terminating `\0` byte to the array, which `WebRequest` would
   have sent as a stray null byte after the JSON body — a classic real
   MQL5 gotcha that can break strict server-side JSON parsers. Fixed:
   the extra byte is now trimmed before the request goes out.
2. **`WebRequest`'s return status was completely ignored** — no error
   handling at all, so a misconfigured "Allow WebRequest for listed URL"
   setting (which the DAVEMA docs explicitly call out as required) would
   fail every single push silently, forever, with zero diagnostic. Fixed:
   now checks for `-1` (with the specific error 4014 case called out by
   name) and non-200 responses, and logs clearly.
3. **No guard against compiling the raw, un-personalized template** — if
   someone attached the template file directly (skipping `/ea`), it would
   silently try to push to the literal string `"{{WEBHOOK_URL}}"` forever.
   Fixed: `OnInit()` now checks for leftover `{{` placeholders and refuses
   to start (`INIT_PARAMETERS_INCORRECT`) with a clear message.
4. **A redundant `X-EA-Token` header implied a security check that didn't
   exist** — the real auth mechanism is the token embedded in the webhook
   URL path itself; the header was never checked by the server. Removed
   it rather than leave a misleading no-op.

### A bug in `packages/dave-telegram/src/ea-file.ts`
5. **`.replace()` instead of `.replaceAll()`** — only substitutes the
   first occurrence of each placeholder. Worked today because each
   placeholder appears exactly once in the template, but was fragile:
   silently under-substituting the moment either placeholder appeared a
   second time. Fixed, plus added a real guard that throws if either
   specific placeholder token survives substitution.

### An overstated claim in `packages/dave-memory/src/user-webhook.ts`
6. I'd written "genuinely functional now, not a placeholder" about the
   EA reusing Step 4's hidden webhook — but the webhook server's
   `WebhookPush.type` union never included anything EA-shaped
   (`heartbeat`/`snapshot`), and nothing had ever actually proven the
   EA's real JSON payload round-trips through it. TypeScript's union type
   isn't a runtime check, so it technically would have accepted any
   string — meaning an EA push and a bad/malformed push were
   indistinguishable at the time. Fixed: extended the type union, added a
   real runtime validation that rejects unknown push types with 400
   (proven: a bogus type is now genuinely rejected and NOT stored), and
   added a test that posts the EA's exact real payload shape and confirms
   it's accepted and lands correctly in the inbox.

### Real proof
`packages/dave-telegram/test/step8-ea-review.test.ts` — and while
writing it, its own first assertion caught a bug in the fix itself: a
blanket `content.includes("{{")` check false-positived against the new
`OnInit()` guard's own `"{{"` string literal. Corrected to check the two
specific placeholder tokens instead. Full output:
- No leftover `{{WEBHOOK_URL}}`/`{{TOKEN}}` tokens; real values present
- OnInit() placeholder guard, WebRequest status check, and the
  StringToCharArray fix are all present in the actually-generated file
  (not just the template on disk — the real personalized output)
- The EA's real heartbeat payload posts to the real webhook server →
  200, lands correctly in the inbox with `type: "heartbeat"`
- A bogus push type now gets a real 400 and is confirmed NOT stored
  (previously would have been silently accepted)
- Re-ran the full existing test suite (Steps 3–9) afterward — all still
  pass, no regressions from these fixes
- `=== ALL ASSERTIONS PASSED ===`

### Still honestly open
- The `.mq5` changes can't be compile-tested in this sandbox (no MT5
  terminal/MetaEditor available) — the fixes are correct MQL5 as far as
  static review can confirm, but "real proof" here means TS-side proof
  plus careful manual review, not an actual MetaEditor F7 compile. Flag
  this if you get a chance to compile it for real.
- The `/ea` picker's two buttons ("Dave's default account" / "My own
  account") still aren't wired to different behavior — correctly blocked
  on Step 10.8's separate-credentials storage, not silently faked.

## Follow-up: sendRichMessageDraft update mechanics — real bug found

You asked me to check whether the AI can actually update the thinking
draft via `sendRichMessageDraft` the way I'd built it. It couldn't —
Step 9's implementation had the wrong mental model, based on inferring
behavior from a one-line changelog blurb instead of the real parameter
table. Fetched the real, complete method definition this time (raw HTML,
not the summarized WebFetch pass, since the docs page is too large for
that tool's model to reach the actual Methods section) and found:

- **`sendRichMessageDraft` returns `true`, not a message with a
  `message_id`.** My code was doing
  `const result = await sendRichMessageDraft(...); this.messageId =
  result.message_id;` — `result.message_id` would have been `undefined`
  against the real API.
- **Updating a draft means calling `sendRichMessageDraft` again with the
  SAME bot-chosen `draft_id`** (a required non-zero integer) — Telegram
  animates the change. There is no message object to call
  `editMessageText` on; the draft is an ephemeral ~30-second preview,
  never a persisted message. My code's second-and-later `update()` calls
  were calling `editMessageText` against a `message_id` that was never
  real, which would have failed against the real API every time.
- **Finalizing uses a different real method, `sendRichMessage`** (not
  `editMessageText`) — that's the one that actually returns a real,
  persisted `Message`. My `finalize()` was calling `editMessageText`
  too, same problem.
- **The content parameter is `rich_message: InputRichMessage`
  (`{ html: "..." }`)**, not the plain `text`/`parse_mode` shape regular
  `sendMessage`/`editMessageText` use.

### Fixes
- `client.ts`: corrected `sendRichMessageDraft`'s real parameter table
  and return type (`draft_id`, `rich_message`, returns `true`); added
  the real `sendRichMessage` method; added the real `RichMessage`
  (`InputRichMessage`) type.
- `thinking-indicator.ts`: each `ThinkingIndicator` now generates its own
  stable `draft_id` (module-level counter, unique per instance so
  concurrent tasks never animate over each other's draft); `update()`
  calls `sendRichMessageDraft` with that same id every time;
  `finalize()` calls `sendRichMessage`, not `editMessageText`.
- Rewrote `step9-thinking-indicator.test.ts` end to end against the
  corrected mechanics.

### Real proof (corrected)
- Part A (fake working transport): call order is now
  `sendChatAction → sendRichMessageDraft → sendRichMessageDraft →
  sendRichMessageDraft → sendRichMessage`; all three draft updates
  genuinely reuse the same `draft_id`; a second, concurrently-run
  indicator gets a genuinely different `draft_id` (1 vs 2) — proven, not
  assumed, since silently colliding draft ids would have been a real bug
  a fake-only test could easily miss
- Part B (real network, no valid token): confirmed real calls to
  `api.telegram.org` for both `sendChatAction` and `sendRichMessageDraft`,
  and printed the exact real request body Telegram received:
  `{"chat_id":847213,"draft_id":3,"rich_message":{"html":"</> Patching
  provider-router.ts"}}` — matches the real parameter table exactly
- Full existing suite (Steps 3–9, including the EA review fixes) re-run
  afterward: no regressions
- `=== ALL ASSERTIONS PASSED ===`

### Lesson carried forward
The WebFetch tool's page-to-markdown-then-summarize pipeline silently
truncates on a page this large and can miss the actual section being
asked about while still returning a confident-sounding answer. For any
future Telegram Bot API method whose exact mechanics matter, pull the
raw HTML directly (`curl` + local string search) rather than trusting a
single WebFetch summary — this is exactly how this bug was caught.

## Follow-up: full audit pass across Steps 3-9

You asked me to keep auditing rather than move on immediately. Real
findings, most significant first:

### Major correction: InlineKeyboardButton DOES have a real color field
Step 8 claimed "Telegram has no color field on InlineKeyboardButton" and
built an emoji-prefix workaround. **That was wrong.** Re-checked by
pulling the raw docs HTML directly (not a WebFetch summary — the same
tool that missed `sendRichMessageDraft`'s real mechanics earlier missed
this too, on the same oversized page) and found a real `style` field:
`"danger"` (red), `"success"` (green), `"primary"` (blue) — a genuine
native Telegram feature, not something to fake. Fixed `buttons.ts` and
`client.ts` to use it; `coloredButton()` no longer prefixes an emoji.
Also added a real check for `callback_data`'s confirmed 1-64 byte limit
(previously unvalidated — a caller could have silently produced a
request Telegram would reject).

### AirLLM service: two bugs that directly contradicted the Step 5 finding
`ai-brain-service/main.py` defaulted `COMPRESSION` to `"4bit"` — but
Step 5's own real sandbox test found AirLLM 3.3.0's compression path
hardcodes `.cuda()` regardless of host, meaning **every single
`/generate` call would have failed on Railway's confirmed CPU-only
deployment.** Also: `input_ids.cuda() if hasattr(input_ids, "cuda")` is
always true for any PyTorch tensor regardless of whether a GPU exists —
the real check is `torch.cuda.is_available()`, confirmed to correctly
return `False` on a CPU host by actually running it. Fixed both: default
compression is now `"none"` (translated to Python `None`, not the
literal string — confirmed against AirLLM's real constructor signature),
device defaults to `"cpu"` explicitly, and `.cuda()` is only ever called
when CUDA is actually available.

### dave-core/pairing.ts
`generateCode()` had no collision check against other pending codes —
with enough simultaneously-pending users, two could get the same 6-digit
code, and `approvePairing(code)` would approve whichever record `.find()`
hit first. Fixed: regenerates on collision against currently-pending
codes. Proven with 25 real pairing requests, zero collisions.

### dave-memory
- `recall-guard.ts`: `hasRecalled()` had no expiry — a recall from
  arbitrarily long ago would silently satisfy a brand-new call with the
  same taskId string (and taskIds aren't guaranteed unique — my own
  Step 4 test used the plain reusable string `"check-account-balance"`).
  Added a 5-minute TTL.
- `write-approval.ts`: pending writes persist to disk, but their apply()
  closures only live in memory. After a restart, `listPendingWrites()`
  would keep showing old writes as approvable, and `approveWrite()`
  would then hard-fail. Added a `recoverable` flag so callers can tell
  the difference instead of hitting a dead end.
- `tencent-tiers.ts`: `readJsonl()` let one corrupted/truncated line
  (e.g. from a crash mid-append) throw and make the ENTIRE tier
  permanently unreadable. Fixed to skip and log just the bad line.

### dave-sandbox/sandbox-client.ts
`runCode()` had no execution timeout — a hung or infinite-loop process
(plausible from a bad self-patch proposal in Step 17) would block
forever with no recovery. Added a real timeout (default 30s) that kills
the process; proven by actually hanging a process and confirming it gets
killed in ~800ms against an 800ms timeout, not the process's own
999999ms delay.

### dave-davema
- No fetch timeout on `DavemaClient` at all — a hung DAVEMA call would
  block indefinitely, and DAVEMA is called before every trade decision.
  Added a real timeout, converted to the same `DavemaError` type callers
  already handle (proven against an actually-unreachable host).
- Key format regex was lowercase-hex-only (`[0-9a-f]`); the docs never
  actually show real casing. Fixed to accept both cases defensively.
- `DavemaApiKeyFlow` required the ENTIRE trimmed message to start with
  `sk_live_` — a user pasting "here's my key: sk_live_..." would have
  been silently ignored (no key saved, no error shown either). Added
  `extractDavemaKey()` to find a key anywhere in the message.
- No way to delete a stored key at all (only overwrite via re-submission,
  which does work for rotation). Added `deleteDavemaKey()` — SECURITY.md
  explicitly calls for handling exposed/leaked credentials.
- `checkCorrelationBeforeSizing("EURUSD")` would nonsense-warn that
  EURUSD is highly correlated with itself (vs_eurusd ≈ 1.0 trivially).
  Fixed to recognize the self-comparison case.

### rich-format.ts
`escapeHtml()` didn't escape double quotes, and `customEmoji()`'s
`emoji-id` attribute wasn't escaped at all — both are real attribute-
injection risks (a value containing `"` could break out of `href="..."`
or `emoji-id="..."` and inject adjacent attributes). Fixed both.

### Real proof
`packages/dave-core/test/audit-fixes.test.ts` proves items 1, and the
memory/sandbox/DAVEMA fixes above, end to end against real files, a real
hung process, and a real unreachable-host timeout. Full existing suite
(Steps 3-9) re-run twice during this pass — all green throughout, no
regressions introduced by any of these fixes.

### Lesson reinforced
Two of this session's real bugs (`sendRichMessageDraft`'s mechanics, and
now the `InlineKeyboardButton` color field) both trace back to the same
root cause: WebFetch's page-to-markdown-then-summarize pipeline silently
drops sections on a docs page this large, and returns a confident answer
regardless. Every claim in this build about exact Telegram Bot API
mechanics now comes from pulling the raw HTML directly and searching it
locally, not a single WebFetch pass.

## Status: Step 10 — Trading Engine (COMPLETE)

Completed: 2026-09-04

### Step 10 checklist
- [x] 10.1 SL/TP/lot each Off/On/Auto — `risk-settings.ts`, "On" is
      enforced (not just documented) to require a real user value via
      `OnModeRequiresValueError`. Max open trades/max daily loss are
      optional, off by default, and PROTECTED: `proposeProtectedLimitChange`
      never applies anything — only a separate `approveProtectedLimitChange`
      call does, matching SECURITY.md's "never bundled, never assumed to
      carry over" requirement
- [x] 10.2 All 6 real order types (`buy`/`sell`/`buy_limit`/`sell_limit`/
      `buy_stop`/`sell_stop`) — `order-types.ts`. `resolveEntryPrice()`
      never silently fails: explicit price, or a caller-supplied
      reference+offset (mechanical only — this module doesn't invent
      *which* offset to use, that's the user's rules file's job), or an
      explicit "needs prompt" result
- [x] 10.3 Partial close, remove SL/TP, delete one/all pending orders —
      `trade-execute.ts`, through a `TradeExecutor` seam (same pattern as
      `Provider`/`Transport` elsewhere) so this is real, tested logic
      ahead of Step 11's actual EA/MCP transport
- [x] 10.4 Trading mode: Auto vs Trading Skills — `trading-mode.ts`,
      "trading-skills" mode enforced to require a specific locked skill id
- [x] 10.5 Pair groups, generic system — `pair-groups.ts`. Exactly one
      active + one fallback structurally (a single `activeGroupId` field,
      not just a convention), no default pre-selected
- [x] 10.6 Extreme conditions → pause + auto-switch to fallback —
      `handleExtremeConditions()`; this module owns only the switching
      mechanism, the market-condition judgment itself is the caller's
      (real DAVEMA data), keeping trading-strategy content out of this code
- [x] 10.7 Machine-readable `.json` trading skills — `skills.ts`, system
      only, ships with an empty library, never authors skill content
- [x] 10.8 Dave's default MT5 account or the user's own — `mt5-accounts.ts`,
      same secure-credential pattern as DAVEMA's key storage (0600 file,
      masked accessor); cannot select "own-account" before credentials for
      it actually exist
- [x] 10.9 Breakeven/trailing stops — `breakeven-trailing.ts`, real state
      machine: TP1 → breakeven, TP2 → further lock-in, TP3 → more lock-in,
      each stage only applied once (idempotent) and never moves SL
      backward even if a bad config would ask it to
- [x] 10.10 "Find me a setup" — `find-setup.ts`, on-demand scan of the
      CURRENT active pair group via DAVEMA's real `/confluence` recipe

### Real proof (Step 10)
Ran `npx tsx packages/dave-trading/test/step10-trading.test.ts`:
- All 6 order types confirmed; `resolveEntryPrice` correctly resolved an
  explicit price, calculated one from a reference+offset
  (1.09 - 20 pips = 1.088, verified numerically), and correctly returned
  a "needs prompt" result for a bare pending order — `validateOrder`
  rejected a pending order missing a price
- `setRiskMode(..., "on")` with no value genuinely threw; providing one
  genuinely persisted
- A protected-limit proposal did NOT change `maxOpenTrades` until a
  separate, explicit approval call — verified both states
- Pair groups: set Majors active / Synthetics fallback, confirmed both;
  triggered `handleExtremeConditions(true)` and confirmed the active
  group genuinely switched to Synthetics, paused flag set
- Breakeven/trailing: ran a real BUY position through a simulated price
  sequence (1.086 → 1.101) — SL genuinely moved 1.08 → 1.085 (TP1/
  breakeven) → 1.09 (TP2) → 1.095 (TP3), each exactly once; a second
  test confirmed SL does NOT move backward when a stage's target would
  be worse than the current SL
- Partial close: 0.3 of 1.0 lots closed, 0.7 remaining, both real
  returned numbers checked; `tradeModify` with `sl:null, tp:null`
  genuinely called through with both nulled; `deleteAllPendingOrders`
  genuinely deleted both real pending tickets, not just the first
- Trading mode: defaulted to `auto`; `trading-skills` mode without a
  skill id genuinely threw; with one, genuinely persisted
- MT5 accounts: selecting "own-account" before storing credentials
  genuinely threw; after storing, selection succeeded and masked
  credentials correctly omitted the password while keeping login/server
- **"Find me a setup"**: real on-demand scan of the CURRENTLY active
  group (Synthetics, post extreme-condition switch — proving state
  actually flows between subsystems, not just within one test block),
  real live HTTP calls to DAVEMA for both symbols, both correctly
  returning real 401s (no key configured) — proving the real call path
  fires, not fabricated scan data
- `=== ALL ASSERTIONS PASSED ===`
- Full existing suite (Steps 3–9) re-run alongside — all green

### Not yet done (deferred, not silently skipped)
- `TradeExecutor` has no real backing transport yet — that's Step 11's
  EA webhook / MCP alternative. Everything above is real, tested logic
  built against that seam, same approach as `Provider`/`Transport`
  elsewhere in this build
- Full authenticated "find me a setup" data needs a real DAVEMA key
  (same gap noted since Step 7)
- The correlation-vs-open-positions half of sizing isn't wired into
  trade execution yet — needs `TradeExecutor.listOpenPositions()` to
  actually be called from a sizing flow, which is a Step 17-era
  self-improvement/execution-loop concern, not core order plumbing

## Follow-up: three fixes requested after Step 10

### 1. Breakeven/trailing stops are now opt-in, not automatic
Per explicit feedback: a normal trade should NOT get breakeven/trailing
behavior by default -- it's a capability Dave can choose to turn on for
a specific position "if it wishes," not something baked into every
trade. Fixed `breakeven-trailing.ts`:
- `Position.breakevenTrailingEnabled` defaults to `false`
  (`newPosition()` always creates one this way)
- `processPriceTick()` is a real no-op (no SL movement, at all, ever)
  on a position that hasn't opted in -- checked first, before any TP-stage
  logic runs
- `enableBreakevenTrailing(position)` / `disableBreakevenTrailing(position)`
  are the explicit, deliberate opt-in/out actions
Real proof: ran a normal (non-opted-in) position through the full price
sequence that previously triggered all three stages -- confirmed zero
SL movement throughout. A separately opted-in position still goes
through the real TP1→TP2→TP3 progression as before.

### 2. Trading actions exposed as real agentic tools, not just /commands
Per explicit feedback: Dave shouldn't need to be told to "find a setup"
-- it should be able to reach for that (and other trading actions) on
its own initiative, the way any tool-calling agent picks a tool because
the situation calls for it. Added `tools.ts`: a real tool manifest
(`TRADING_TOOLS`) with name/description/JSON-schema parameters/handler
for find_setup, trade_execute, trade_modify, partial_close, full_close,
delete_pending_order, delete_all_pending_orders, validate_order --
`find_setup`'s own description explicitly says "call this on your own
initiative." Real proof: called `find_setup` and `trade_execute` THROUGH
the manifest (not the raw functions) and got real results back.
**Honestly scoped**: this makes the tools genuinely callable by an
agent loop -- it does not itself wire them into a running, autonomous
agent loop, because that loop doesn't exist yet (Step 3's
`dave-core/agent-loop.ts` is still a stub, and DSH hasn't been booted as
Dave's actual runtime). What's real is that the tools are shaped
correctly and tested so that wiring is a connection, not a rewrite.

### 3. Railway deployability -- real, verified build pipeline
Set up TypeScript project references across all 8 packages (each gets
its own `tsconfig.json`, dependency-ordered `references`), added the
missing `@types/node` (tsx doesn't need it since it skips type-checking,
but a real `tsc` build does), and added root `build`/`start`/`test`
scripts plus `railway.json`.

**Real, from-scratch verification** (not just "should work"): wiped
`node_modules` and every package's `lib/`, then ran the actual sequence
Railway will run:
1. `pnpm install --frozen-lockfile` → succeeded, lockfile confirmed
   up to date
2. `pnpm run build` (`tsc -b tsconfig.json`) → exit 0, zero errors,
   across all 8 packages in dependency order
3. `pnpm run start` (`node server.mjs`) → real server started, real
   `curl` request got a real 200 response

`server.mjs` is an honest placeholder, not a fake success: Dave's
unified boot sequence (Telegram bot, agent loop, webhook servers) is
Step 22's job and doesn't exist as one running process yet -- every
subsystem built so far is real, tested library code, not yet wired
together. This placeholder is a plain Node script with zero dependency
on the TypeScript packages, so it starts reliably regardless of their
state, and says exactly what it is rather than pretending to be the
real app. Re-ran the full test suite (all 11 real test files) after the
fresh install too -- all green.

## Status: Step 11 — EA + MCP Trade Placement Alternative (COMPLETE)

Completed: 2026-09-04

### Step 11 checklist
- [x] 11.1 Dave EA (`.mq5`): lightweight bridge, no analysis. Sends real
      account/positions/pending-orders/heartbeat; receives open/modify/
      close/delete-pending instructions; detects manual closes; real
      pairing-style WebhookURL+token, per-user, already wired since Step 8
- [x] 11.2 MT5 push notification (`SendNotification`) and email
      (`SendMail`) on trade open/close/error, from within the EA — real
      MT5 API calls, not stubs
- [x] 11.3 MCP-based trade placement alternative for EA-less users —
      real `@modelcontextprotocol/sdk` client
- [x] 11.4 Push the personalized `.mq5` file on request — already built
      in Step 8 (`ea-file.ts`)

### The real architecture problem this step had to solve
MT5's `WebRequest` is one-directional outbound HTTP — an EA cannot run
a server or receive a push. So Dave→EA instructions can only travel back
inside the HTTP *response* to the EA's own heartbeat POST. Built the
real contract both sides implement:
- `dave-ea-bridge/ea-webhook.ts`: real HTTP server at
  `/hooks/ea/<token>` (a dedicated token namespace, replacing the Step 8
  stopgap that reused Step 4's generic webhook ahead of this step
  existing). A command queue (`enqueueCommand`/drained on the next
  report) is the only channel for Dave→EA instructions.
- `EaTradeExecutor` (implements Step 10's `TradeExecutor` seam for
  real): `openOrder()`/etc. enqueue a command and return a promise that
  resolves only once the EA reports a real result for that exact
  command id — with a timeout so an offline EA doesn't hang the caller
  forever. This is honest async modeling of what a polling bridge
  actually is, not a fake synchronous wrapper.
- `manual-close-detector.ts` + `EaBridge`: compares two consecutive real
  reports: any position that disappeared IS a manual close, UNLESS
  Dave's own `closePosition()` call just resolved for that exact ticket
  this cycle (traced through `EaTradeExecutor.resolveCommand()`'s
  return value, not a second duplicate tracking map) — a real bug caught
  and fixed during building, not left unhandled: without this check,
  every Dave-initiated close would have been misreported as manual.
- `ea/DaveEA.mq5` rewritten for real: builds a true `PositionsTotal()`/
  `OrdersTotal()` snapshot every report, executes commands via `CTrade`
  (`trade.Buy`/`Sell`/`PositionModify`/`PositionClose`/`OrderDelete`),
  reports real results back, and calls `SendNotification`/`SendMail` on
  real trade events. Includes a narrow, self-contained JSON parser for
  the one response shape this EA and the webhook both implement —
  deliberately not a general JSON parser (MQL5 has none built in, and
  claiming one would be exactly the kind of overclaim this whole build
  process exists to avoid).
- `mcp-trade-adapter.ts`: real `@modelcontextprotocol/sdk` `Client` +
  `StreamableHTTPClientTransport`, implementing the same `TradeExecutor`
  seam by calling real MCP tools by name.

### Real proof (Step 11)
Ran `packages/dave-ea-bridge/test/step11-ea-bridge.test.ts`:
- Real webhook token generated, distinct `/hooks/ea/` namespace confirmed
- A real heartbeat POST got back a real empty command list
- `executor.openOrder()` genuinely queued a command (verified via
  `peekQueue` BEFORE the "EA" ever touched it) — then a subsequent real
  heartbeat genuinely received that exact command back in its response,
  and the queue was confirmed drained (not left for double-delivery)
- A later real report carrying a matching result genuinely resolved the
  original `openOrder()` promise with the real ticket the "EA" reported
- **Manual close detection**: a position (T1) disappearing without any
  Dave-initiated close was genuinely flagged; a position (T2) Dave
  itself closed (traced through the executor's own command tracking)
  was genuinely NOT flagged despite also disappearing in the same way —
  proving the Dave-vs-manual distinction actually works, not just the
  simple disappearance case
- MCP: a real connection attempt against an unreachable server
  genuinely failed with a real, typed `McpConnectionError`; calling
  `openOrder()` on a never-connected executor genuinely refused rather
  than silently attempting a request
- `=== ALL ASSERTIONS PASSED ===`
- Full 12-file suite (Steps 3–11) re-run afterward, all green; real
  `tsc -b` build re-verified clean (zero errors, zero stray output in
  `src/`) with the new package included

### Not yet done (deferred, not silently skipped)
- The `.mq5` changes still can't be compile-tested in this sandbox (no
  MetaEditor) — same honest limitation noted in the Step 8 EA review
- No real MCP trading server exists to fully exercise `McpTradeExecutor`
  end to end (open a real order through it) — the real, bounded
  connection-attempt methodology used throughout this build (AirLLM,
  DSH sandbox, OpenSandbox) is what's available without one
- `EaBridge`/`EaTradeExecutor` aren't wired into a running process yet —
  same "real, tested logic ahead of the transport" status most of
  dave-trading is already in, consistent with Step 10's own notes

## Status: Step 12 — Workers (COMPLETE)

Completed: 2026-09-04

### Step 12 checklist
- [x] 12.1 Named like people, created on the fly — `worker-factory.ts`,
      a real name pool (20 first names) Dave draws from, not a fixed
      "Worker-1"/"Worker-2" roster; explicit names collision-checked
      against currently-active workers
- [x] 12.2 Fixed (ongoing) vs temporary (one-off) — `assignment` field,
      Dave's call at creation time; `retireWorker()` closes a worker out
- [x] 12.3 Auto-generated per-worker endpoint — real now, not a stub:
      implemented the actual `/hooks/worker/<workerId>/<token>` route in
      `dave-memory/user-webhook.ts`, replacing the Step 4 501 placeholder
      it explicitly deferred to this step. Separate token store from the
      per-user webhook, so a leaked worker token only resolves that one
      worker's identity
- [x] 12.4 Not personality-locked — a design/prompt-level property (SOUL.md/
      IDENTITY.md apply to workers same as Dave); nothing in this code
      layer restricts a worker's tone, by design
- [x] 12.5 Full feature parity except real trades unless designated a
      trading worker — `worker-permissions.ts::toolsForWorker()`, real
      filtering: a non-trading worker keeps analysis tools (`find_setup`,
      `validate_order`) and loses only the trade-placing ones
      (`trade_execute`, `partial_close`, etc.); a `role: "trading"`
      worker gets the full set
- [x] 12.6 `report_to_user` — `report-to-user.ts`, posts through the
      worker's own real endpoint, tagged with its name (`#priya`)
- [x] 12.7 Journal role — `journal-worker.ts::writeTradeJournalEntry()`,
      real prose generation from supplied facts + Dave's own reasoning
      points (never invents the reasoning itself — same trading-content
      boundary as everywhere else in this build)
- [x] 12.8 Settings tool, same permission as Dave — `settings-tool.ts`,
      calls the exact same `dave-trading` functions Dave's own commands
      use, not a separate weaker path, and deliberately NOT filtered by
      the trade-placing permission check (settings ≠ placing a trade)

### Real proof (Step 12)
Ran `packages/dave-workers/test/step12-workers.test.ts`:
- Created a temporary worker (auto-named "Mei" from the pool) and a
  fixed journal-role worker (explicitly named "Priya"); confirmed a
  second worker can't collide on an already-active name; confirmed
  retiring a worker removes it from the active list
- Permission filtering: journal-role worker's tool list included
  `find_setup`/`validate_order` but excluded `trade_execute` and
  `delete_all_pending_orders`; a `role: "trading"` worker's list
  included `trade_execute` — proven by inspecting the actual filtered
  arrays, not asserted in the abstract
- Worker model routing confirmed never `airllm`
- **Real per-worker webhook**: `reportToUser()` made a real HTTP POST
  through Priya's own real endpoint, got back `{"ok":true,"tag":"#priya"}`,
  and the stored report was genuinely tagged `#priya` with the real
  content; filtering reports by a different (nonexistent) workerId
  correctly returned zero, proving no cross-worker leakage
- **Real readable journal writeup** — not a JSON dump: given raw facts
  and Dave's own reasoning points, produced actual prose ("Here's the
  read: ... On top of that, ... And the deciding factor: ...",
  "Confluence came in at 82/100 -- about as clean a setup as this
  gets.", "Risk: stop at 2645, target at 2665."); missing reasoning was
  flagged honestly ("No reasoning was recorded...") rather than invented
- Settings tool: a worker called `set_risk_mode` through the tool
  interface, and the change genuinely took effect (verified by reading
  it back via `getRiskSettings`), proving it's real access, not a stub
- `=== ALL ASSERTIONS PASSED ===`
- Full 13-file suite (Steps 3–12) re-run afterward, all green; `tsc -b`
  build re-verified clean

### Not yet done (deferred, not silently skipped)
- Worker-to-worker and worker-to-Dave direct messaging + the persistent
  communication log are Step 13's job, not built here — `report_to_user`
  (12.6) is worker→user output only, a different channel
- No agent loop exists yet to actually decide when to spin up a worker
  or route a task to one — same "real, tested logic ahead of the
  runtime" status as dave-trading's tools

## Status: Step 13 — Worker-to-Worker + Worker-to-Dave Communication (COMPLETE)

Completed: 2026-09-04

### Step 13 checklist
- [x] 13.1 Workers message each other directly, not only report upward;
      workers message Dave directly, genuinely two-way — `comms.ts::sendMessage()`,
      a uniform channel for any participant pair (`DAVE_PARTICIPANT_ID`
      is a reserved convention, not a special-cased type)
- [x] 13.2 Persistent communication log — every message recorded with
      real timestamp/sender/recipient/content, `getCommsLog()` re-reads
      from disk every call (no cache to be silently stale)
- [x] 13.3 Powers the "Agent Teams" live activity feed — `onMessage()`
      subscription hook, fired synchronously on every `sendMessage()`
      call; this is what Step 14's admin panel will render once it
      exists, not built yet itself

### Real proof (Step 13)
Ran `packages/dave-workers/test/step13-comms.test.ts`:
- Two workers (Martins, Priya) exchanged direct messages — proven NOT
  routed through Dave (`getThread()` between them shows exactly their
  2 messages) and captured live via the subscription hook in real time
- A worker messaged Dave directly, and Dave genuinely replied back to
  that specific worker (not a broadcast) — `getConversation()` for
  Dave's participant id shows both, in the right sender/recipient
  direction
- Every one of 4 logged messages carries a real numeric timestamp,
  non-empty sender, non-empty recipient, and non-empty content —
  checked per-field, not just counted
- Log genuinely persists: a fresh `getCommsLog()` call re-read from disk
  matched the in-memory expectation exactly
- Unsubscribing stopped further live-feed delivery, but the message
  itself was still correctly persisted — proving the live feed and the
  persistent log are properly decoupled (one can stop without breaking
  the other)
- `=== ALL ASSERTIONS PASSED ===`
- Full 14-file suite (Steps 3–13) re-run afterward, all green; `tsc -b`
  build re-verified clean

### Not yet done (deferred, not silently skipped)
- The actual "Agent Teams" UI rendering this feed is Step 14's job —
  this step only had to power it (`onMessage`), not build it
- No agent loop exists yet to decide when Dave or a worker actually
  sends a message — same status as the rest of the workers/trading
  tooling: real, tested logic ahead of the runtime that will call it

## Status: Step 14 — Admin Panel (COMPLETE)

Completed: 2026-09-04

Built as a real Next.js 16 (App Router, Turbopack) application, per an
explicit correction mid-build ("Use next.js and also no emoji") — an
earlier vanilla Node/HTML version was fully deleted and replaced, not
patched.

### Step 14 checklist
- [x] 14.1 Live stats, pair-group designer, Agent Teams activity feed,
      AI model config, DAVEMA/sandbox status — all real Route Handlers
      (`app/api/*/route.ts`) calling straight into `@dave/trading`,
      `@dave/workers`, `@dave/brain`, `@dave/davema`, `@dave/sandbox` —
      no separate admin data layer, no mock data
- [x] Steps 16 (database automation) and 17 (self-improvement), which
      don't exist yet, get honest `{implemented: false, note: "..."}`
      responses from their panels/endpoints — not fabricated
- [x] Zero emoji anywhere in the UI or its source (checked, not assumed)
- [x] Whole repo — packages + this admin app — builds clean on a fresh
      `pnpm install --frozen-lockfile && pnpm run build`, matching
      Railway's actual build command

### Real bugs found and fixed while wiring this up
- **Turbopack couldn't resolve any `@dave/*` workspace import** ("The
  module has no exports at all"). Root cause: every package's compiled
  source uses NodeNext-style relative imports ending in `.js`
  (`from "./order-types.js"`) — correct for `tsc`, since that's the
  filename *after* compilation, but Turbopack was resolving straight
  against the raw `.ts` source tree (via `transpilePackages`), where no
  `.js` file exists. Fixed by pointing every workspace package's
  `main`/`types`/`exports` at its actual compiled `lib/` output instead
  of `src/`, and adding `lib/`-build as a prerequisite step (root
  `build` script now runs `tsc -b` before `next build`). This is also
  just the correct architecture regardless of Turbopack: Next.js
  consumes built JS, not another package's raw TypeScript.
- **DSH's local sandbox driver couldn't be bundled** — `@dave/sandbox`
  transitively pulls in `koffi` (native FFI bindings) and a
  `landlock-run` native launcher binary; Turbopack tried to bundle them
  as ordinary JS and failed ("non-ecmascript placeable asset" / can't
  resolve a `.node`-adjacent binary path). Fixed with
  `serverExternalPackages` in `next.config.mjs`, telling Next to leave
  those requires alone and resolve them at request time in real Node,
  the way any native addon has to be.
- **Stale `.tsbuildinfo` masking a real build gap**: found while
  verifying the fresh-checkout build path — with `lib/` deleted but old
  `.tsbuildinfo` files present, `tsc -b` considered the (missing) output
  up to date and skipped rebuilding, so `next build` failed even though
  the "fix" was already in place. Confirmed this cannot happen on
  Railway (`.tsbuildinfo` is gitignored, so every deploy is a true fresh
  build) by deleting all `.tsbuildinfo` files locally and re-running
  `pnpm run build` end-to-end clean.
- `.gitignore`'s `/data/` entry was root-anchored and would have missed
  `packages/dave-admin/data/` (created because `next start`'s cwd is the
  admin package, not the repo root) — widened to `data/` (unanchored).

### Real proof (Step 14)
Ran `packages/dave-admin/test/step14-admin.test.ts` against the actual
built server (`next start`, real HTTP, no mocks):
1. `POST /api/pair-groups` creates a group through the real HTTP API
2. The write lands on disk at the exact path Step 10's own storage
   functions use (`data/trading/<user>/pair-groups.json`)
3. A **direct import** of `@dave/trading`'s `listGroups()` — bypassing
   the API entirely — sees the identical data, proving there is no
   separate admin data layer
4. `POST /api/pair-groups/active` + `GET /api/pair-groups` round-trip
   correctly
5. `DELETE /api/pair-groups/[id]` removes it — confirmed both via the
   API response and a second direct `listGroups()` call
6. `/api/status/davema` made a real network call (real DAVEMA `ping()`
   response); `/api/status/sandbox` made a real `checkSandboxHealth()`
   call (correctly reported unusable in this sandboxed container — an
   honest failure, not swallowed)
7. `/api/self-improvement` and `/api/database-automation` both honestly
   report `implemented: false`
8. The `/` route returns real server-rendered HTML (6.2KB, not a stub)
9. Recursively scanned every `.tsx`/`.ts`/`.css` file under `app/` (15
   files) plus the rendered HTML for emoji via Unicode ranges — zero
   found
- `=== ALL ASSERTIONS PASSED ===`
- Full 15-file suite (Steps 3–14) re-run afterward, all green
- Root `tsc -b` build and the full `pnpm run build` (now `tsc -b && next
  build`) both re-verified clean from a state with all `lib/`,
  `.tsbuildinfo`, and `.next` artifacts removed — i.e. genuinely
  reproducing what Railway's fresh checkout will do
- Playwright screenshots taken of the live running server (Live Stats
  and Pair Groups tabs) confirming real rendered dark-glassmorphism UI,
  correct data binding, and no emoji anywhere on screen

### Not yet done (deferred, not silently skipped)
- No real Telegram bot token or DAVEMA key configured in this
  environment, so the panel's live values are honestly mostly zero/
  "not set" rather than populated — the wiring is real, the data just
  isn't there yet
- Karak plugin (a user-suggested admin-panel skill) was investigated and
  found to be an unrelated internal product plugin, not applicable here
  — user chose to skip it and have the panel built directly instead
- The admin panel is not yet wired into the main process's `start`
  command (`server.mjs` is still Step 22's placeholder) — it has its own
  working `next build`/`next start`, but nothing runs it in production
  yet; that integration is Step 22 territory

## Status: Step 15 — File I/O (COMPLETE)

Completed: 2026-09-04

Two research subagents ran in parallel to speed this step up: one pulled
the RAW HTML of the real Telegram Bot API docs (this project's
established practice, since WebFetch summaries have been wrong before —
invented `<tg-thinking>`, wrong `sendRichMessageDraft` return shape),
the other verified OpenAI's real transcription endpoint. Implementation
and all tests were then written directly against their verified findings.

### Step 15 checklist
- [x] 15.1 Input: any file type (documents, images, video) gets pulled
      into the sandbox workspace via a real two-step Telegram download
      (`getFile` → `file_path` → real byte fetch), written binary-safe
      — `packages/dave-io/src/inbound.ts`
- [x] 15.2 Input: voice messages received AND transcribed — real OpenAI
      `POST /v1/audio/transcriptions` call, `whisper-1` model (chosen
      over the newer `gpt-4o-*-transcribe` models specifically because
      OpenAI's own docs don't clearly confirm `.ogg`/OPUS support for
      those, while `whisper-1`'s broader format handling is well
      established for exactly this use case) — `packages/dave-io/src/voice.ts`,
      `transcription.ts`
- [x] 15.3 Output: Dave can push the FULL range out — document, photo,
      video, voice note, video note, animation — not just documents.
      `TelegramClient` gained real multipart/form-data upload support
      (`sendPhoto`, `sendVideo`, `sendVoice`, `sendVideoNote`,
      `sendAnimation`, and `sendDocument` extended) plus `getFile`/
      `downloadFile`. Link-based deliveries get a real expiry warning
      (Telegram's own docs: a `getFile` download link is only
      *guaranteed* valid for "at least 1 hour") — uploads of real bytes
      never need one, since Telegram re-hosts those permanently as a
      new `file_id` — `packages/dave-io/src/outbound.ts`

### Real findings from the two research subagents (both verified against raw docs, not summaries)
- **Telegram**: `getFile`'s `file_path` field is genuinely OPTIONAL on
  the response (not always present) — handled explicitly, not assumed.
  Upload limits are real and per-type: 50MB for document/video/voice/
  animation, 10MB for photos (plus a 20:1 max aspect ratio), video notes
  fall under the general 50MB cap with no separate documented number.
  Download cap for bots on the standard (non-self-hosted) API is exactly
  20MB. `sendVoice` genuinely requires `.ogg`/OPUS, `.mp3`, or `.m4a` —
  anything else silently becomes a plain Audio/Document instead of a
  voice bubble (not rejected, just not what was asked for). The
  `attach://` convention is for `InputMedia`-array methods only (e.g.
  `sendMediaGroup`) — NOT needed for the single-file methods used here,
  corrected from an initial assumption.
- **OpenAI**: response_format is genuinely restricted on the two newer
  `gpt-4o-*-transcribe` models — `json`/`text` only, no `verbose_json`/
  `srt`/`vtt` (those richer formats stay `whisper-1`-only). 25MB file
  size limit confirmed. The subagent flagged real inconsistency in
  OpenAI's own docs about whether `.ogg` is an officially accepted
  format — documented honestly in `transcription.ts`'s own comment
  rather than silently assumed either way.

### Real proof (Step 15)
Ran `packages/dave-io/test/step15-file-io.test.ts`:
1. A file with deliberately non-UTF-8 bytes (0xFF, 0xFE, 0x00) pulled
   into a real temp workspace and read back byte-for-byte identical —
   proves the binary-safe path, not the old text-mode one that would
   have silently corrupted it
2. Voice note transcription: real fake-download + a REAL network call
   to `api.openai.com` (no key available in this environment) — got a
   genuine HTTP 401 with OpenAI's real error body back, proving the
   request genuinely reached the real API with the right multipart
   shape; separately proved a download failure and a transcription
   failure surface as distinguishable errors, not one opaque catch-all
3. Real HTTP round-trip (same pattern as Step 9's) against the real
   `api.telegram.org` with an invalid token, for all 5 upload methods
   (`sendDocument`/`sendPhoto`/`sendVideo`/`sendVoice`/`sendVideoNote`)
   — confirmed every one genuinely reached Telegram's real host with a
   real multipart body, and genuinely failed (no token), not a silent
   no-op
4. Expiry-warning logic: a Telegram file link gets the real warning text
   appended to its caption; an uploaded local buffer does not (correct,
   since Telegram re-hosts uploaded bytes as a permanent `file_id`)
5. All 6 real output kinds (document/photo/video/voice/video_note/
   animation) dispatch to their correct distinct Bot API method
- `=== ALL ASSERTIONS PASSED ===`
- Full 16-file suite (Steps 3–15) re-run afterward, all green
- Full clean-state build re-verified (`lib/`, `.next`, all
  `.tsbuildinfo` removed, then `pnpm install --frozen-lockfile &&
  pnpm run build`) — genuinely reproduces Railway's fresh-checkout path

### Not yet done (deferred, not silently skipped)
- No real Telegram bot token or OpenAI API key configured in this
  environment, so both real network calls above genuinely fail on auth
  — the wiring and request shape are proven real, the actual successful
  transcription/upload needs live credentials to demonstrate end-to-end
- Reading file *content* once it's on disk (parsing a PDF, describing an
  image) is out of scope here — 15.1 only covers the real pull-in; Step
  20 (Vision) covers images/video specifically

## Status: Step 16 — Database + Automation (COMPLETE)

Completed: 2026-09-04

Three research subagents ran in parallel to speed this step up: Groq's
real transcription API (also fixing a Step 15 mistake, see below),
`better-sqlite3`'s real current API and Railway-deployability, and
real, current cron-scheduling libraries. Implementation was then
written directly against their verified findings.

### Correction carried over from Step 15
User caught: voice transcription must use **Groq**, not OpenAI.
`packages/dave-io/src/transcription.ts` now calls Groq's real
OpenAI-compatible endpoint (`api.groq.com/openai/v1/audio/transcriptions`)
with `whisper-large-v3-turbo` — confirmed via research to explicitly
support `.ogg` (Telegram's real voice-note format), which was genuinely
ambiguous in OpenAI's own docs. Re-verified with a real network
round-trip against the real Groq API (genuine `401 Invalid API Key`
with no key configured, proving the request itself is correctly
shaped). Committed as its own fix commit before starting Step 16.

### Step 16 checklist
- [x] 16.1 Full database capability — new `@dave/db` package,
      `DaveDatabase` class wrapping real SQLite (`better-sqlite3`
      v13, confirmed via research to ship prebuilt native binaries with
      NO install/postinstall script at all — verified this directly,
      it loads and runs with zero `pnpm approve-builds` needed despite
      pnpm's generic warning). Dave creates its own tables at runtime
      (`createTable`), every record auto-gets `id`/`created_at`/
      `updated_at` (never caller-supplied), real filter (`query`) and
      real SQL aggregates (`aggregate` — SUM/COUNT/AVG/MIN/MAX), real
      atomic transactions (`db.transaction()`). Row-level security is
      real enforcement in the query layer itself (every table gets an
      `owner_user_id` column, every read/write requires one and ANDs it
      into the WHERE clause) — not a documented convention that could
      be bypassed
- [x] 16.2(a) Scheduled/time-based triggers — `registerScheduledTrigger`
      via `node-cron` v4.6 (confirmed actively maintained, no
      persistence needs of its own — re-registering on boot is
      genuinely sufficient for restart survival), plus deterministic
      next-fire-time computation via `cron-parser` v5.10 for fast,
      non-wall-clock-dependent tests
- [x] 16.2(b) Entity triggers — `DaveDatabase.onEntityEvent()`, fires
      synchronously the instant a row is created/updated/deleted, real
      event data (table/op/id/owner/row), no polling
- [x] 16.2(c) Webhook/connector triggers — new `/hooks/automation/<token>`
      namespace (distinct from Step 4's `/hooks/user/<token>` and Step
      12's `/hooks/worker/<id>/<token>`), real HTTP server, fires a
      registered handler on a genuine external POST
- [x] 16.3 Multi-step workflows (call → wait → branch) — `WorkflowEngine`,
      persists every step transition to a real `workflow_runs` table
      (dogfooding 16.1). "Wait" schedules exactly one `setTimeout` for
      the remaining delay (never an interval/poll loop). Restart
      survival: `recoverPendingRuns()`, called once on boot, reloads
      every run still "waiting" and reschedules one timer per run from
      its persisted absolute resume timestamp (fires ~immediately if
      the process was down past that time)

### A real engine bug the test caught
Initial branch design let the `ifTrue` arm's steps fall through into
the `ifFalse` arm's steps, since both live in the same flat step array
and "call" steps defaulted to `stepIndex + 1` — a test asserting only
`notify_high` should fire caught `notify_high` AND `notify_low` both
firing on one run. Fixed by adding an explicit `next?: number | "end"`
field to call/wait steps instead of an implicit index+1 default,
documented in `workflow.ts` with the exact failure it prevents.

### Real proof (Step 16)
Ran `packages/dave-db/test/step16-database-automation.test.ts`:
1. Created a real table at runtime, inserted 5 rows, ran real SQL
   SUM/COUNT/AVG aggregates against them, confirmed all three correct
2. Row-level security: a second user's row is genuinely invisible to
   the first user's queries AND aggregates (not just row reads)
3. A real `db.transaction()` throw rolled back its insert — count
   verified unchanged afterward
4. Entity trigger fired synchronously with real event data on
   create/update/delete, in order
5. Scheduled trigger: a real `node-cron` job (every second) was
   registered and genuinely fired multiple times across 2.2s of real
   wall-clock waiting — not simulated; separately, deterministic
   next-fire computation verified for "every Sunday 09:00"
6. Webhook trigger: a real HTTP server was started on a real port, a
   real `fetch()` POST hit `/hooks/automation/<token>`, and the
   registered handler received the exact real payload
7. Workflow: started a call→wait→branch run, confirmed it genuinely
   paused (`status: "waiting"`) after the real 400ms wait step began;
   simulated an actual process restart by shutting down the first
   engine's timer and constructing a brand-new `WorkflowEngine` against
   the same on-disk SQLite file; `recoverPendingRuns()` found the
   waiting run and rescheduled it; the run completed correctly (right
   branch taken, wrong branch never called) purely from persisted state
- `=== ALL ASSERTIONS PASSED ===`
- Also fixed the admin panel's Step 16 tab, which was still honestly
  reporting "not built yet" — now calls the real `DaveDatabase`
  against a per-user `data/db/<userId>.db` file and shows real
  table/row-count data; verified live against a real running server
  (created a table via a separate script, confirmed the panel's API
  and screenshot reflected it) and marked `better-sqlite3` as a
  `serverExternalPackages` entry (same native-binding class of fix as
  Step 14's DSH sandbox natives)
- Full 17-file suite (Steps 3–16) re-run afterward, all green
- Full clean-state build re-verified (`lib/`, `.next`, all
  `.tsbuildinfo` removed, `pnpm install --frozen-lockfile && pnpm run
  build`) — genuinely reproduces Railway's fresh-checkout path

### Not yet done (deferred, not silently skipped)
- The SQLite `.db` file lives under `data/db/` — same as every other
  per-user JSON store in this repo, meaning it needs a persistent
  Railway volume mounted at deploy time to survive a redeploy (flagged
  by the research subagent as a real risk to confirm at deploy time,
  not something this step's code can control)
- No actual scheduled/entity/webhook triggers are registered yet for
  real Dave behavior (e.g. Step 18's dreaming cron, Step 19's security
  check) — this step built the real, tested mechanism; wiring specific
  triggers to specific behavior is those later steps' job

## Status: Step 17 — Self-Improvement (COMPLETE)

Completed: 2026-09-04

One research subagent ran in parallel (the real `diff`/jsdiff npm
package's API) while the DB-backed approval/versioning/backtest
architecture was designed and written directly, since this step is
almost entirely internal logic with no other external API surface to
verify.

### Step 17 checklist
- [x] 17.1 Dave views its own code, proposes patches — new
      `@dave/self-improve` package, `proposePatch()` generates a real
      unified diff (`diff` v9, confirmed zero-dependency, TypeScript-
      native) and self-verifies it: the diff library's own `applyPatch`
      must reproduce the proposed new content from the old content
      exactly, or the patch is refused as internally inconsistent
      (`InconsistentPatchError`) rather than stored broken
- [x] 17.2 Every patch tested in sandbox first — `testPatch()` writes
      ONLY the candidate content into a real sandbox workspace (the
      real file is never touched) and runs a real command via Step 6's
      `runCode` (e.g. `node --check`); status becomes `"tested"` only
      on a genuine exit code 0, `"test_failed"` otherwise. HARD GATE in
      code: `applyPatchToFile()` throws `PatchNotTestedError` unless
      status is genuinely `"tested"` — structurally impossible to reach
      a real file write otherwise
- [x] 17.3 Versioned releases with real lineage — every version
      references `evolvedFrom` (its real parent), a full changelog
      entry, `rollbackToVersion()` reverts the real file AND records
      the rollback as its own new lineaged version (doesn't erase
      history, honestly shows "we went back")
- [x] 17.4 Every risky change asks the master prompt's exact template —
      `"I need to do X. Reason: [why]. Yes or No?"` — verbatim, not
      paraphrased. Auto-approval is a real per-user DB-backed toggle,
      defaults off (verified: a fresh user's request genuinely comes
      back `"pending"`, not silently approved)
- [x] 17.5 Declined proposals remembered — re-requesting the identical
      description with the identical reason throws
      `DeclinedWithoutNewJustificationError` outright rather than
      re-asking; a genuinely new reason is allowed through
- [x] 17.6 Dynamic tool creation follows the SAME gate, provably — not
      asserted, `testNewTool === testPatch` and `applyNewTool ===
      applyPatchToFile` are checked as literal function identity in the
      test, since `tool-creation.ts` is a thin named wrapper, not a
      parallel implementation
- [x] 17.7 Strategy-change proposals require MULTIPLE backtests — new
      `backtest.ts`, `runMultipleBacktests()` throws
      `InsufficientBacktestsError` below 2 windows. Per the master
      prompt's own constraint (never author real trading rules), the
      strategy itself is an injected function this module has no
      knowledge of — only the harness (running it across multiple
      historical windows and presenting a real min/max/avg range, never
      a single number) is real code here

### Real proof (Step 17)
Ran `packages/dave-self-improve/test/step17-self-improvement.test.ts`:
1. Full cycle: proposed a real patch, confirmed applying before testing
   throws, ran a REAL sandbox `node --check`, confirmed applying before
   approval throws, requested approval (got the exact real prompt
   text), approved it, applied it — the REAL file on disk changed
   content, a version was created with `evolvedFrom: null` (lineage
   root)
2. Rollback: reverted the real file back to the original content,
   confirmed the rollback is its own new version referencing what it
   evolved from and what it rolled back to; full 3-entry changelog
   read back correctly
3. A patch with a genuine JS syntax error was tested, genuinely failed
   (`test_failed`, real non-empty stderr from real `node --check`), and
   confirmed unapplyable
4. Auto-approval toggled per-user in real time — before: `"pending"`,
   after: `"approved"`, both against real DB state
5. Declined-proposal memory: same description + same reason refused;
   same description + new reason allowed through, both real DB queries
6. Tool creation: proposed a new tool file, ran it through the real
   sandbox test, got a real tool-creation approval prompt, applied it —
   confirmed via literal function-identity assertions that it is not a
   separate gate
7. Backtest gate: a single window refused outright; 3 injected mock-
   strategy windows produced a real range (min/max/avg PnL and win
   rate), never a single number
- `=== ALL ASSERTIONS PASSED ===`
- Also fixed the admin panel's Self-Improvement tab (was still honestly
  reporting "not built yet") — now shows real version lineage from the
  same per-user `data/db/<userId>.db` Step 16 already uses; verified
  live against a real running server
- Full 18-file suite (Steps 3–17) re-run afterward, all green
- Full clean-state build re-verified (`lib/`, `.next`, all
  `.tsbuildinfo` removed, `pnpm install --frozen-lockfile && pnpm run
  build`) — genuinely reproduces Railway's fresh-checkout path

### Not yet done (deferred, not silently skipped)
- No real agent loop yet calls any of this during actual operation —
  same status as every other tool/skill package so far: real, tested
  logic ahead of the runtime that will eventually call it on Dave's own
  initiative
- The specific "risky change" categories that should route through this
  gate (which self-patches, which settings changes) aren't enumerated
  yet — this step built the real, generic gate; deciding exactly what
  triggers it in practice is part of wiring the agent loop later

## Status: Step 18 — Feedback Loop (COMPLETE)

Completed: 2026-09-04

One research subagent audited the exact real signatures of every
existing package this step needed to integrate with (workers, journal
formatting, scheduled triggers, the DB layer, Telegram's `sendPoll`)
before writing any code — and surfaced two real gaps that had to be
filled as part of this step, not assumed away.

### Real gaps the audit found
- `writeTradeJournalEntry()` (Step 12) only ever formatted a narrative
  string and returned it — **nothing in the repo persisted a trade
  journal anywhere**, so there was no real trade history to count
  against for 18.2. Filled by `trade-log.ts`, built on Step 16's real
  DB (dogfooding again) rather than inventing a new file format.
- **No inbound Telegram `poll_answer` handling exists anywhere** —
  `sendPoll` only sends. Rather than build a second bespoke webhook
  server, `feedback-poll.ts` reuses Step 16's real generic
  `/hooks/automation/<token>` mechanism — a poll answer arriving is
  exactly the external event that trigger type is for.

### Step 18 checklist
- [x] 18.1 Dreaming cron — `registerDreamingCron()`, real `node-cron`
      job (Step 16.2a), default `0 3 * * 0` (Sunday), a real
      customizable expression. "Run through a worker" is literal: a
      real `journal`-role worker (Step 12) is created for the run and
      retired immediately after — verified the worker is genuinely
      `active` mid-run and genuinely retired afterward, not a
      decorative object
- [x] 18.2 Trade-count-based reflection, separate from 18.1 —
      `subscribeTradeCountReflection()`, wired to Step 16's real entity
      trigger on the trade journal table. N is a real per-user DB-backed
      setting (`getReflectionThreshold`/`setReflectionThreshold`,
      default 10, changed to 3 and verified in the test)
- [x] 18.3 `hypotheses.jsonl` with real confirmed/failed verdicts —
      event-sourced JSONL (append-only, folds to current state), never
      settles a verdict before `MIN_CYCLES_BEFORE_VERDICT` (5) real
      observations — verified explicitly that 4/5 supporting cycles
      still reads `"pending"`, only the 5th settles it
- [x] 18.4 Skip log, separate from the trade journal — `skip-log.ts`,
      its own JSONL file; verified recording skips never moves the
      trade journal's count
- [x] 18.5 Feedback poll results actually referenced during
      reflection — `ReflectionInput.pollResults` is populated from the
      real webhook-received poll answer and asserted non-empty inside
      the fired reflection, not just collected and left unused
- [x] 18.6 Weekly dataset export, a real scheduled job —
      `registerWeeklyExportCron()`, default `0 4 * * 0`, writes a real
      JSON file to disk every time it fires; `runWeeklyExport()` also
      exposed standalone for on-demand use

### Real proof (Step 18)
Ran `packages/dave-feedback/test/step18-feedback-loop.test.ts`:
1. A real trade was logged and persisted (finally — Step 12's narrative
   formatter reused, not reimplemented) and counted via a real
   aggregate
2. Skip log confirmed genuinely separate — recording 2 skips left the
   trade count untouched
3. Hypothesis verdict gate: 4/5 supporting cycles still `"pending"`,
   the 5th settles it to `"confirmed"`; a second hypothesis with
   contradicting evidence settled to `"failed"` — both real, cycle-
   gated, not assumed
4. A real HTTP POST to a real webhook server delivered a poll answer
   that landed in the real DB with the correct selected option
5. Reflection genuinely didn't fire after 1 or 2 of 3 needed new
   trades, then fired exactly on the 3rd — with the poll result from
   step 4 present inside the fired reflection input, not empty
6. The dreaming cron genuinely fired (real node-cron, `* * * * * *` for
   a fast real-wall-clock test), a real worker was found `active` with
   role `"journal"` mid-run, and confirmed retired afterward
7. The weekly export cron genuinely fired and wrote a real JSON file to
   disk containing the real trades/skips/hypotheses accumulated so far;
   the standalone `runWeeklyExport()` call also verified independently
- `=== ALL ASSERTIONS PASSED ===`
- A real bug caught mid-build: an early test assumed a trade logged
  BEFORE subscribing to trade-count reflection would count toward the
  threshold — it doesn't (the entity-trigger counter only sees inserts
  after subscription), fixed by logging 3 genuinely new trades and
  updating the test's own expectations rather than changing the (correct)
  engine behavior
- Full 19-file suite (Steps 3–18) re-run afterward, all green
- Full clean-state build re-verified (`lib/`, `.next`, all
  `.tsbuildinfo` removed, `pnpm install --frozen-lockfile && pnpm run
  build`) — genuinely reproduces Railway's fresh-checkout path

### Not yet done (deferred, not silently skipped)
- No real agent loop yet calls `logTrade`/`recordSkip` during actual
  trading, and nothing yet wires a real Telegram update relay to
  forward `poll_answer` updates to the webhook this step built — same
  status as every other tool package so far: real, tested logic ahead
  of the runtime that will call it
- Admin panel not updated for this step (no "Feedback Loop" tab existed
  to begin with, unlike Steps 16/17 which had honest placeholder tabs
  already built in Step 14 to fix) — nothing dishonest to correct here

## Status: Step 19 — Safety (COMPLETE)

Completed: 2026-09-04

One research subagent audited every place in the repo that currently
writes a credential to disk (found two real plaintext gaps to fix); a
second subagent researching Node crypto best practices hit a session
rate limit mid-run and failed -- proceeded directly on well-established
Node.js `crypto` stdlib APIs (AES-256-GCM, scrypt, `createCipheriv`)
rather than blocking on a retry, since these are stable, long-standing
APIs I already had high confidence in.

### Real gaps the audit found and fixed
- `packages/dave-trading/src/mt5-accounts.ts` and
  `packages/dave-davema/src/credentials.ts` both wrote their secret
  (MT5 password / DAVEMA API key) as **plain JSON on disk**, protected
  only by 0600 file permissions — genuinely readable plaintext, not
  encrypted at rest. Both fixed to use real AES-256-GCM encryption.
- `packages/dave-ea-bridge/src/ea-webhook.ts`'s token store had **no
  file permission restriction at all** (worse than the two above) —
  tightened to 0600.
- A new leaf package, `@dave/crypto` (zero dependencies), holds the
  encryption primitives — NOT inside `@dave/safety` itself, because
  `dave-safety` depends on `@dave/workers`, which depends on
  `@dave/trading`; putting the crypto helpers in `dave-safety` would
  have created `dave-trading → dave-safety → dave-workers →
  dave-trading`, a real dependency cycle caught before it was written,
  not after.

### Step 19 checklist
- [x] 19.1 Circuit breaker — `packages/dave-safety/src/circuit-breaker.ts`,
      real DB-persisted state (Step 16), trips at exactly 3 consecutive
      errors (verified: 1/3 and 2/3 don't trip, 3/3 does), produces a
      real human-readable report, and — a real design detail — a
      success in the MIDDLE of a streak resets the consecutive counter
      (2 errors + 1 success + 1 more error does NOT trip, correctly:
      not 3 *consecutive*), while a success AFTER a trip does NOT
      silently clear it (only an explicit `resetCircuitBreaker()` does)
- [x] 19.2 `/stop`/`/panic`: instant hard interrupt, even mid-thought,
      genuinely distinct from an ordinary thinking-loop interrupt —
      `interrupts.ts`'s real state machine, verified: an ordinary
      message mid-thought interrupts thinking but leaves the trading
      loop completely untouched; `/panic` halts the trading loop AND
      interrupts the thinking loop in the same call (the one case both
      are hit)
- [x] 19.3 Security check cron — same real lifecycle as Step 18.1's
      dreaming cron (deliberately, not a second differently-shaped
      mechanism): default Sunday, runs through a real `generic`-role
      worker, retired after
- [x] 19.4 Heartbeat watchdog, genuinely separate process — real
      `child_process.fork()`, verified via a different real PID than
      the calling process; detects a simulated crash (heartbeats
      genuinely stop) and genuinely detects recovery (heartbeats
      resume) via real IPC messages, not a shared in-memory flag (which
      two real OS processes can't have)
- [x] 19.5 Credentials stored securely, never dumped in plain readable
      config — real AES-256-GCM at rest via the new `@dave/crypto`
      package, applied to both real plaintext gaps the audit found

### Real proof (Step 19)
Ran `packages/dave-safety/test/step19-safety.test.ts`:
1. Circuit breaker genuinely tripped on the 3rd consecutive error, not
   before; `assertNotTripped()` genuinely threw while tripped; a
   mid-streak success genuinely prevented a trip; an explicit reset
   genuinely cleared it
2. An ordinary message during a real "thinking" state interrupted
   thinking but left the trading loop's `running` state untouched;
   `/panic` during the same state halted the trading loop AND
   interrupted thinking in one call
3. The security check cron genuinely fired, a real worker was found
   `active` with role `"generic"` mid-check, confirmed retired after
4. **Real separate-process proof**: the watchdog's PID was asserted
   different from the test's own `process.pid`; with real heartbeats
   flowing, zero false alarms over 700ms; heartbeats were then
   genuinely stopped (simulated crash) and the watchdog reported `down`
   via a real IPC message within the timeout window; heartbeats resumed
   and the watchdog reported `recovered`
5. A real encrypt/decrypt round-trip confirmed the encrypted blob never
   contains the raw plaintext; decrypting with the wrong key genuinely
   failed (GCM auth tag, not silently-wrong output); encrypting with no
   master key failed closed; then, against the ACTUAL fixed call
   sites — `storeOwnMt5Credentials`/`storeDavemaKey` — the real files
   written to disk were read back and asserted to NOT contain the raw
   password/key anywhere in their bytes, with correct decryption on
   read-back
- `=== ALL ASSERTIONS PASSED ===`
- Also found and fixed a real staleness bug while re-running the full
  suite: Step 14's own admin-panel test still asserted
  `self-improvement`/`database-automation` returned
  `{implemented: false}` — true when Step 14 was built, no longer true
  since Steps 16/17 landed. Updated those assertions to match current
  real behavior rather than leaving a stale expectation in the suite.
- Full 20-file suite (Steps 3–19) re-run afterward, all green
- Full clean-state build re-verified (`lib/`, `.next`, all
  `.tsbuildinfo` removed, `pnpm install --frozen-lockfile && pnpm run
  build`) — genuinely reproduces Railway's fresh-checkout path

### Not yet done (deferred, not silently skipped)
- No real agent loop yet calls `recordError`/`recordSuccess` during
  actual trading, or `interruptThinking`/`stopOrPanic` from a real
  Telegram command handler — same status as every other safety/tool
  package so far: real, tested logic ahead of the runtime that will
  call it
- `DAVE_CREDENTIALS_KEY` needs to be set as a real Railway environment
  variable at deploy time — this repo never generates or stores that
  key itself, by design (it's exactly the kind of master secret that
  must not live in anything this repo writes to disk)

## Status: Step 20 — Vision (COMPLETE)

Completed: 2026-09-04

Two research subagents ran in parallel: one verified the real current
Claude Messages API image-content-block shape AND checked whether
DeepSeek's real chat API has any vision support (an assumption worth
verifying, not guessing); the other verified real ffmpeg scene-
detection syntax and confirmed ffmpeg needs to be explicitly added to
Railway's Nixpacks build (it's not included by default). ffmpeg was
also installed directly in this dev environment so the real proof test
could actually run it, not mock it.

### Step 20 checklist
- [x] 20.1 Images: the raw file goes straight into the model call — no
      OCR, no captioning pre-step. `packages/dave-vision/src/image.ts`
      base64-encodes the real downloaded bytes into a real Anthropic
      image content block (`{type: "image", source: {type: "base64",
      media_type, data}}`, exact field names confirmed against current
      docs), checked against the real 10MB base64 size limit. `@dave/brain`'s
      `CompletionMessage.content` was extended to `string | ContentBlock[]`
      to actually carry this through to a real provider call — a real
      gap, since it was string-only before this step
- [x] 20.2 Video: scene-aware keyframe extraction + timestamped
      transcript, inside the sandbox — `packages/dave-vision/src/video.ts`.
      Keyframes: real ffmpeg `select='gt(scene\,threshold)'` +
      `showinfo`, run through Step 6's real sandboxed `runCode` (never a
      bare unsandboxed child_process call), parsing real `pts_time`
      values out of ffmpeg's own stderr. Transcript: Step 15's real Groq
      `TranscriptionClient` extended with `transcribeWithTimestamps()`
      (`response_format: "verbose_json"`, real per-segment start/end
      times) — `.mp4` is directly on Groq's accepted-format list, so no
      separate audio-extraction step is needed

### Real findings from the two research subagents
- Claude's image content block shape was confirmed exactly as assumed,
  plus real details worth knowing: 10MB per image via the direct API
  (5MB on Bedrock/Vertex), max 8000x8000px, and a real `type: "url"`
  source alongside `base64` (not used here — a locally-downloaded file
  needs base64 across all backends).
- **DeepSeek's mainline `deepseek-chat`/`deepseek-reasoner` (what's
  actually configured in `DeepSeekProvider`) has NO vision support** —
  confirmed against DeepSeek's real current docs. There IS a vision
  model (`deepseek-v4-flash-vision-exp`) but it's explicitly
  experimental and not what this repo wires up, so `DeepSeekProvider`
  correctly refuses image content rather than silently misrepresenting
  a capability it doesn't have.
- ffmpeg is NOT bundled by Nixpacks by default — a real `nixpacks.toml`
  with `nixPkgs = ["...", "ffmpeg"]` was added at the repo root
  (confirmed exact syntax, including that `...` is required to merge
  with rather than replace the auto-detected Node toolchain).

### Real proof (Step 20)
Ran `packages/dave-vision/test/step20-vision.test.ts`:
1. A genuine 1x1 PNG (real magic bytes, not a stub buffer) became a
   content block whose base64 `data` is byte-for-byte identical to the
   raw file's own base64 — no processing step touched it
2. Unsupported extensions and an oversized (>10MB base64) image are
   both genuinely refused
3. `AirLLMProvider` and `DeepSeekProvider` both refuse image content
   BEFORE making any network call (verified via a fetch spy that would
   fail the test if invoked) — real proof they don't silently mishandle
   an image sent to a text-only endpoint
4. A real HTTP request to the real `api.anthropic.com` (no valid key in
   this environment, genuine failure) was captured and its body
   inspected — the exact real image content block, byte-identical
   `data`, was present in the actual outgoing request
5. A REAL video was generated with ffmpeg itself (red → blue → green,
   1s each, plus a real sine-wave audio track) — not a fixture file.
   Real scene detection found exactly the 2 real scene changes, with
   real chronologically-ordered timestamps parsed from ffmpeg's actual
   stderr output; a missing input file genuinely raised a real
   `FfmpegError`, not a silent empty result
6. The same real video, handed directly to Groq's transcription
   endpoint (no separate audio extraction) — genuinely failed without a
   key, proving the request reached the real API with the right shape
- `=== ALL ASSERTIONS PASSED ===`
- Full 21-file suite (Steps 3–20) re-run afterward, all green
- Full clean-state build re-verified (`lib/`, `.next`, all
  `.tsbuildinfo` removed, `pnpm install --frozen-lockfile && pnpm run
  build`) — genuinely reproduces Railway's fresh-checkout path (ffmpeg
  itself isn't part of this Node build step, but the new
  `nixpacks.toml` is real Railway-build configuration, not just
  documentation)

### Not yet done (deferred, not silently skipped)
- No real agent loop yet calls any of this during actual operation —
  same status as every other tool package so far
- `deepseek-v4-flash-vision-exp` was found by research to be real but
  explicitly experimental — deliberately NOT wired in as a fallback
  vision path; if DeepSeek's vision support graduates out of
  experimental, that's a real future decision, not assumed here

## Status: Step 21 — Notifications (COMPLETE)

Completed: 2026-09-04

Two research subagents ran in parallel to verify the real, current Fish
Audio and ElevenLabs TTS APIs before writing any code — both surfaced
real surprises that would have produced broken requests if guessed.

### Real findings from the two research subagents
- **Fish Audio**: voice/model selection (`s1`/`s2-pro`/`s2.1-pro`/
  `s2.1-pro-free`) is a real HTTP **header** (`model:`), NOT a JSON body
  field as initially assumed — caught before writing `tts.ts`, not
  after a failed real request.
- **ElevenLabs**: auth is the real non-standard `xi-api-key` header,
  confirmed NOT `Authorization: Bearer` (easy to get wrong by pattern-
  matching every other provider in this repo). Voice listing is the
  current `/v2/voices`, not the older `/v1/voices`.

### Step 21 checklist
- [x] 21.1 Morning brief: real Off/On/Custom toggle,
      `packages/dave-notifications/src/morning-brief.ts`, DB-persisted
      (Step 16) and driving a real Step 16.2a scheduled trigger the
      same way Steps 18/19's crons already do. "Custom" without a real
      interval is refused outright (`MissingCustomIntervalError`) —
      never silently falls back to the default
- [x] 21.2 Trade-opened notification includes the trade AND the
      reasoning together, in one message — `trade-notification.ts`
      reuses Step 12's real narrative formatter directly rather than
      building a second, differently-worded one for the same content
- [x] 21.3 Voice OUTPUT: real `FishAudioClient`/`ElevenLabsClient`
      (`tts.ts`) against their real current APIs. Switchable active
      provider, real per-user configurable voice ID per provider,
      whole feature togglable off (defaults off), real fallback order
      that follows whichever provider is currently active
      (`voice-settings.ts`). Fully button-driven — real Telegram
      inline keyboards for every setting, reusing Step 8's real button
      primitives, not a second button system (`voice-buttons.ts`).
      Voice INPUT (Step 15.2's Groq transcription) re-verified still
      genuinely wired end-to-end, per this step's own requirement to
      confirm it

### Real proof (Step 21)
Ran `packages/dave-notifications/test/step21-notifications.test.ts`:
1. Morning brief genuinely registers no trigger when off, the real
   default cron when on, and refuses "custom" with no interval given —
   then registers exactly the user's own real interval when one is given
2. A trade-opened notification's text contains both the trade AND the
   real reasoning in the SAME message body, sent as one real call
3. Real HTTP POSTs to both `api.fish.audio` and `api.elevenlabs.io` (no
   keys in this environment, genuine failures) were inspected: Fish
   Audio's real `model` header and `reference_id` body field, and
   ElevenLabs' `voice_id` as a real path parameter with the real
   `model_id` body field — both genuinely reached the real hosts
4. Voice output genuinely refuses to run while the feature is disabled
   (real toggle, defaults off); the active provider is genuinely
   switchable per user, and fallback order genuinely follows it
5. Real Telegram inline keyboards reflect real live state (ON/OFF label,
   a checkmark on the active provider/voice) and every button's
   `callback_data` round-trips correctly through the real parser
6. Voice input re-verified: a real (simulated) downloaded voice note
   genuinely reaches Groq's real transcription endpoint, still honestly
   failing without a key — the same real wiring Step 15 built, still
   working
- `=== ALL ASSERTIONS PASSED ===`
- Full 22-file suite (Steps 3–21) re-run afterward, all green
- Full clean-state build re-verified (`lib/`, `.next`, all
  `.tsbuildinfo` removed, `pnpm install --frozen-lockfile && pnpm run
  build`) — genuinely reproduces Railway's fresh-checkout path

### Not yet done (deferred, not silently skipped)
- No real Fish Audio, ElevenLabs, or Groq API key is configured in this
  environment, so "real proof of a real TTS call producing audio" and
  "a real voice note being transcribed correctly" (the master prompt's
  own Step 21 test wording) could only be proven as far as this
  environment allows: genuine, correctly-shaped requests reaching the
  real APIs and genuinely failing on auth, not fabricated success. The
  actual audio-producing / correctly-transcribing end-to-end proof
  needs live credentials this sandboxed dev environment doesn't have —
  flagged honestly rather than simulated
- No real agent loop yet calls any of this during actual operation —
  same status as every other notification/tool package so far

## Status: Step 22 — R_Feed (COMPLETE)

Completed: 2026-09-04

R_Feed was previously excluded from this build (per the master prompt's
own explicit "No... R_Feed" line) — this update reverses that and adds
it back as its own step, with a full explanation of what it's for: a
shared demo/practice MT5 account so Dave can backtest and paper-trade
with zero real financial risk before ever proposing a strategy for the
real account.

One research subagent verified the real MQL5 facts this step depends
on before any .mq5 code was written: `SYMBOL_CUSTOM` (confirmed real,
exact `ENUM_SYMBOL_INFO_INTEGER` member) for custom-symbol detection,
and `CopyRates()`'s three real overloads plus the `SERIES_SYNCHRONIZED`
gotcha (CopyRates can return fewer bars than requested if the terminal
hasn't finished syncing that range from the broker yet).

### A real bug found and fixed in the EXISTING Dave EA while building this
Reading `DaveEA.mq5` closely enough to mirror it for R_Feed surfaced a
real gap affecting real money: the `"open"` command handler only ever
called `trade.Buy()`/`trade.Sell()` (always market price) — the 4
pending order types (`buy_limit`/`sell_limit`/`buy_stop`/`sell_stop`)
were faithfully REPORTED on every heartbeat but could never actually be
PLACED via a Dave-issued command, silently falling through as an
unmatched type. Partial close had the same problem: `"lots"` was
accepted in the command shape and sent by `dave-trading`'s
`closePosition(ticket, lots?)`, but the handler always called
`PositionClose()` (full close only), ignoring it. Both fixed directly
in `ea/DaveEA.mq5` using `CTrade`'s real `BuyLimit`/`SellLimit`/
`BuyStop`/`SellStop`/`PositionClosePartial` methods — real money was
at stake, so this got fixed immediately rather than deferred.

### Step 22 checklist
- [x] Same trade-execution engine pattern as the real Dave EA — new
      `@dave/rfeed` package's `RFeedTradeExecutor` implements the
      IDENTICAL `TradeExecutor` interface (`@dave/trading`), so Step
      10's own `tradeExecute`/`tradeModify`/`partialClose`/`fullClose`/
      `deletePendingOrder`/`deleteAllPendingOrders` functions run
      UNCHANGED against R_Feed — proof by construction, not just a
      similarly-shaped rewrite
- [x] History download support — real MT5 `CopyRates()`-backed, a
      `request_history` command/report round-trip through R_Feed's own
      webhook, `HistoryRequestManager` awaiting the real result the
      same way trade commands are awaited
- [x] Own EA file (`ea/RFeedEA.mq5`), own webhook/token pair
      (`/hooks/rfeed/<token>`, completely separate token namespace and
      storage from `/hooks/ea/<token>`), own tool set (`RFEED_TOOLS`:
      `request_history`, `place_paper_trade`, `modify_paper_trade`,
      `partial_close_paper_trade`, `close_paper_trade`,
      `delete_paper_pending_order`, `delete_all_paper_pending_orders`)
- [x] Safety: real trades never happen through R_Feed — architectural,
      not just convention (`@dave/rfeed`'s own `package.json` has no
      dependency on `@dave/ea-bridge` at all, checked directly in the
      real proof test, not inferred)
- [x] Safety: custom/synthetic symbols refused for even a paper trade —
      real `SYMBOL_CUSTOM` flag reported by the EA on every position/
      pending order, a server-side registry built from those real
      reports, and `RFeedTradeExecutor.openOrder()` refuses BEFORE a
      command is ever enqueued; the EA itself ALSO refuses independently
      (`SymbolInfoInteger(symbol, SYMBOL_CUSTOM)` checked in
      `ExecuteOneCommand`) -- real defense in depth, not one single
      point of failure
- [x] Safety: MT5 comment field stays short (the user's own ID, real
      ~31-char MT5 limit) — the full strategy note goes in the real DB
      (Step 16), linked by the trade's real MT5 ticket once it comes
      back, via `recordTradeNote`/`getTradeNote`

### Real proof (Step 22)
Ran `packages/dave-rfeed/test/step22-rfeed.test.ts`:
1. R_Feed's webhook path is genuinely `/hooks/rfeed/<token>`, a real
   distinct namespace
2. A real history request was enqueued, its real generated command ID
   read back from the actual on-disk queue file, then a real HTTP POST
   to the real webhook server (not injected directly into the manager)
   delivered real candle data that the waiting promise genuinely
   resolved with
3. A real paper trade was placed through the exact same `TradeExecutor`
   seam as the real EA — the real enqueued command's comment field was
   asserted to be the short user ID, not a strategy name; a real ticket
   came back with the correct SL/TP; the full strategy note was stored
   in the real DB and read back linked by that real ticket
4. Architectural safety: `@dave/rfeed`'s real `package.json` was read
   and asserted to have no `@dave/ea-bridge` dependency at all — no
   code path to the real EA exists, not just "we don't call it"
5. A custom/synthetic symbol was marked from real reported flags, then
   a real `openOrder()` call for that symbol was refused BEFORE
   touching the command queue — verified by reading the actual queue
   file afterward and confirming the refused order never landed in it
6. All 7 real tools are registered, every description genuinely scoped
   to the demo account
7. The real personalized `RFeedEA.mq5` file was checked for the real
   `SYMBOL_CUSTOM` safety check and a real, distinct webhook URL, with
   no unreplaced template placeholders (the SAME "{{" -substring gotcha
   `ea-file.ts`'s own comment already warned about tripped up this
   test's first draft too -- fixed to check the two real placeholders
   specifically, not any "{{" occurrence)
- `=== ALL ASSERTIONS PASSED ===`

### A second real bug found while re-running the full suite
Step 14's own admin-panel test (`step14-admin.test.ts`) was leaving an
orphaned real `next-server` process running after every single run —
`npx next start` spawns `next`, which spawns Next.js's own server
worker, and a plain `proc.kill("SIGTERM")` only ever signalled the
immediate `npx` child, never that whole process tree. This silently
blocked the ENTIRE test suite from completing (the outer shell loop
never advances past a `tsx` process that never exits, since its child
keeps stdout open). Fixed by spawning with `detached: true` and killing
the whole process group via the negative PID
(`process.kill(-proc.pid, "SIGKILL")`) in the test's cleanup — verified
by confirming zero `next`/`tsx` processes remain in the process table
after a clean run, not just that the test's own assertions passed.

### Not yet done (deferred, not silently skipped)
- No real R_Feed EA is actually running anywhere (no demo MT5 account
  connected in this environment) -- the real webhook/executor/history
  round-trip is proven against real HTTP calls simulating what a real
  EA report looks like, same "real, tested logic ahead of the runtime"
  status as every trading-adjacent package so far
- The real end-to-end loop the user described (download history →
  backtest in sandbox → paper trade on R_Feed → propose for the real
  account with required approval) is not wired into an agent loop yet
  -- same status as every other tool manifest in this repo
