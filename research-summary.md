# Dave — Step 1 Research Summary

Compiled 2026-09-04. All findings below came from two parallel research passes
(web search + direct source fetch/clone where possible). Each topic has a
**Verdict** and **Sources**. Where a finding is surprising or came only from
a single search pass without independent verification, I've flagged it —
these should get a second look (e.g. a real test against a live Telegram bot,
per the master prompt's own instruction) before Dave hard-depends on them.

---

## 1.1 — AirLLM + Qwen3-235B

**Verdict:** AirLLM v3.3.0 (current, ~Aug 2026) claims support for
Qwen3-235B-A22B via streaming one MoE expert at a time (~3GB VRAM claimed).
**No open GitHub issue matching the described "streaming loader fails on
Qwen3-235B's MoE expert tensor layout" bug was found** on `lyogavin/airllm`
issues — closest matches were an unrelated `ValueError` in layer parsing
(#335) and a different model's MoE submodule-parsing bug (#345, Gemma
4-26B-A4B). Treat the premised bug as **unconfirmed** rather than assume
it's fixed — just no evidence it exists as described.

- Install: `pip install airllm`, `pip install -U bitsandbytes` for compression.
- Usage:
  ```python
  from airllm import AutoModel
  model = AutoModel.from_pretrained("Qwen/Qwen3-235B-A22B", compression='4bit')
  input_tokens = model.tokenizer(input_text, return_tensors="pt",
                                  return_attention_mask=False, truncation=True,
                                  max_length=128, padding=False)
  out = model.generate(input_tokens['input_ids'].cuda(), max_new_tokens=20,
                        use_cache=True, return_dict_in_generate=True)
  ```
  Other kwargs: `profiling_mode`, `layer_shards_saving_path`, `hf_token`,
  `prefetching` (on by default), `delete_original` (frees disk after splitting).
- **Disk is the real constraint**, not VRAM. The model is decomposed and
  saved layer-by-layer before use — README explicitly warns disk space is
  the most common failure mode. Expect several hundred GB free disk for a
  235B-class model unless `delete_original=True` reclaims space post-split.
- **Confirmed: AirLLM re-reads weights from disk on every generation
  step** — README states the bottleneck is disk loading, which is the
  stated reason compression exists (shrink what's read per step). Expect
  slow throughput; RAM page-cache size will materially affect speed.
- 3GB VRAM figure is AirLLM's own claim, not independently benchmarked —
  treat as best case at low batch/short context.

**Sources:** [airllm GitHub](https://github.com/lyogavin/airllm), [airllm issues](https://github.com/lyogavin/airllm/issues), [PyPI](https://pypi.org/project/airllm/)

---

## 1.2 — DeepSeek Harness (DSH) / Cordis plugin architecture

**Verdict:** Real project, developer preview (~Aug 2026), MIT-licensed,
`deepseek-ai/deepseek-harness` on GitHub. Cordis (`cordiverse/cordis`) is
an independent plugin-runtime kernel (previously used by the Koishi
chatbot framework) that DSH is built on.

- Run via `npx @deepseek-ai/dsh web`.
- All the specific module names in the master prompt exist as real packages:
  - `packages/core/`: `agent`, `agent-loop`, `agent-default-model`, `session`, `system-prompt`, `tools`, `scope`
  - `packages/compaction/`: `compaction`, `compaction-basic`, `compaction-tool-result-pruner`, `command-compact`
  - `packages/subagent/`: `subagent`, `subagent-claude-code`, `subagent-codex`, `subagent-dsh-sdk`, `tool-subagent`
  - `packages/skill/`: `skill`, `skill-badge`, `skill-filesystem`, `tool-skill`
  - `packages/schedule/`: `schedule`
  - Also present: `packages/sandbox`, `packages/mcp`, `packages/webhook`, `packages/lsp`, `python/sdk`
- This is a large, active multi-package pnpm monorepo — plausible as Dave's
  runtime per the architecture section.

**Caveat:** This came back suspiciously well-matched to the prompt's exact
naming. I'm noting it as verified-by-clone per the research pass, but this
is exactly the kind of claim to sanity-check again with a real `npx
@deepseek-ai/dsh web` run at the start of Step 2/3, before committing the
whole runtime architecture to it.

**Sources:** [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness), [cordis](https://github.com/cordiverse/cordis), [DSH docs](https://deepseek-harness.github.io/deepseek-harness/)

---

## 1.3 — Sandbox: OpenSandbox vs. DSH native sandbox

**Verdict:** Alibaba OpenSandbox is real, active, Apache-2.0
(`alibaba/OpenSandbox`, org now `opensandbox-group/OpenSandbox`) — but it's
a Docker/Kubernetes-centric platform meant to be run as its own
service(s), not an embeddable library. For a single Railway-hosted
process, that's a second deployable surface with real ops overhead
(container-in-container, image pulls, network policy).

- SDKs: Python, Java/Kotlin, JS/TS, C#/.NET, Go; CLI (`osb`); MCP server integration.
- Built-in Command / Filesystem / Code Interpreter sandboxes; confirmed
  examples for browser automation (headless Chrome + Playwright) and
  desktop (VNC/VS Code).
- Isolation backends: gVisor, Kata Containers, Firecracker microVM (via
  Docker locally or Kubernetes for scale). Has a credential vault and
  network egress policy controls.
- DSH itself also ships a native `packages/sandbox` per 1.2 above — since
  Dave is being built on DSH/Cordis, **the native DSH sandbox package is
  the more consistent choice** (one runtime, no second infra surface to
  operate on Railway). Recommend defaulting to DSH's native sandbox and
  only reaching for OpenSandbox if DSH's sandbox proves insufficient
  (e.g. lacks browser automation) — confirm this gap exists for real in
  Step 6 before deciding.

**Sources:** [alibaba/OpenSandbox](https://github.com/alibaba/OpenSandbox), [Northflank overview](https://northflank.com/blog/alibaba-opensandbox-architecture-use-cases)

---

## 1.4 — Hermes Agent memory architecture

**Verdict:** Real (NousResearch, `hermes-agent`), and matches the
described frozen `MEMORY.md`/`USER.md` pattern closely.

- Small, agent-curated memory as two Markdown files, loaded as a **frozen
  snapshot into the system prompt once at session start** — not mutated
  mid-session, specifically to preserve prompt-cache prefix stability.
- Writes persist to disk immediately but don't appear in the live system
  prompt until the *next* session — rewriting mid-session would break the cache.
- Hard combined budget (~1,300 tokens) across both files, enforced as a
  tool error if exceeded, forcing consolidation.
- Long-term memory beyond this pair goes to external providers (Honcho,
  Mem0, Supermemory, etc.) rather than growing the frozen files.

**Applicability to Dave:** directly reusable — keep `MEMORY.md`/`USER.md`
frozen per session, hard char cap, loaded first in the prompt; anything
written mid-session takes effect starting next session, not live.

**Sources:** [Hermes Agent memory docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory/), [GitHub source](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/memory.md)

---

## 1.5 — TencentDB Agent Memory (L0→L3)

**Verdict:** Real (`TencentCloud/TencentDB-Agent-Memory`) — fully local,
zero-external-API long-term memory with a 4-tier progressive pipeline:

- **L0 — Conversation:** raw recent turns
- **L1 — Atom:** atomic extracted facts
- **L2 — Scenario:** grouped/contextualized episode blocks
- **L3 — Persona:** distilled, persistent user profile

Lower tiers live in a database (structured/full-text retrieval, preserves
raw evidence); upper tiers (persona/scenes) are stored as human-readable
Markdown for inspectability. A companion "Symbolic Short-Term Memory"
compresses tool-call logs via Mermaid-diagram syntax to cut token usage
(project claims ~61% token reduction, ~51% task-success improvement —
their own numbers, not independently verified, treat as marketing-adjacent).

**How it integrates alongside Hermes-style memory:** Hermes' frozen
`MEMORY.md`/`USER.md` is the small, always-in-context layer (roughly
Hermes' analog to L3 Persona); TencentDB's L0-L2 tiers give Dave the
deeper session-search / fact-extraction / episode layer underneath it —
the two aren't competing, they're different altitudes of the same stack.

**Sources:** [TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory), [overview](https://jimmysong.io/ai/tencentdb-agent-memory/)

---

## 1.6 — Telegram Bot API (Rich Messages)

**Verdict:** Current version Bot API 10.3 (changelog through Aug 24,
2026). Several features flagged as "possibly made up" in the research
brief turned out to be real per a direct fetch of `core.telegram.org/bots/api`
— **but given how recent and unusually well-matched these are to the
prompt's exact naming, this is the single highest-priority item to
re-verify against a real live bot before Step 8, per the master prompt's
own instruction ("test real format shapes against a real bot, not just docs").**

- **`sendRichMessageDraft`** — reported real: streams/edits a partial
  "rich message" incrementally, distinct from repeated `editMessageText` polling.
- **`<tg-thinking>`** — reported real: an HTML tag usable only inside
  `sendRichMessageDraft`, renders a "Thinking…" placeholder (recommended
  custom emoji from `t.me/addemoji/AIActions`), draft-only (can't appear
  in received messages).
- Confirmed standard formatting: MarkdownV2/HTML, `spoiler`,
  `expandable_blockquote`, custom emoji entities, inline keyboards, polls,
  `setMessageReaction`/`deleteMessageReaction`, pin/unpin,
  `ReplyParameters.quote` (real reply-with-quote, ≤1024 chars, must be an
  exact substring of the original message), `setMyCommands`/`getMyCommands`,
  `setChatMenuButton`.
- **Per-user command menu:** `BotCommandScopeChatMember` exists — genuinely
  per-user-per-chat scoping, confirms Step 8.6's requirement is buildable.
- **Bot's own profile photo:** `setMyProfilePhoto` / `removeMyProfilePhoto`
  reported as real Bot API methods (not just BotFather-only) — accepts
  `InputProfilePhotoStatic`/`InputProfilePhotoAnimated`. `setChatPhoto`
  remains group/channel-only, separate from these.

**Sources:** [Telegram Bot API docs](https://core.telegram.org/bots/api) (direct fetch)

---

## 1.7 — Prompt caching

**Verdict:** All three target providers (Anthropic, OpenAI, DeepSeek)
support prefix-based caching; the "static-first, dynamic-last" rule is
confirmed as the load-bearing mechanism behind all three, not just an
Anthropic convention.

- **Anthropic:** explicit `cache_control: {type: "ephemeral"}` breakpoints
  (≤4/request) on content blocks; render order `tools → system → messages`;
  any byte change in the cached prefix invalidates everything after it;
  min cacheable prefix ~512–4096 tokens (model-dependent); default TTL 5
  min (refreshed on hit), optional 1-hour TTL; cache reads ~90% cheaper
  than base input. Verify hits via `usage.cache_read_input_tokens`.
- **OpenAI:** fully automatic, no explicit breakpoints; prompts >1,024
  tokens eligible, caching in 128-token increments; ~90% discount on cache
  hits.
- **DeepSeek:** also automatic ("Context Caching on Disk"); reported
  ~90–97% discount on hits.
- **Rule for Dave:** static content (system prompt, tool defs, frozen
  `MEMORY.md`/`USER.md`) first and byte-identical across calls; dynamic
  content (live DAVEMA data, recent conversation, timestamps) after the
  cache breakpoint / at the end. This is exactly what the Hermes frozen-
  memory pattern in 1.4 is designed to exploit.

**Sources:** Anthropic prompt-caching docs, [OpenAI prompt caching](https://openai.com/index/api-prompt-caching/), [DeepSeek context caching](https://api-docs.deepseek.com/news/news0802/)

---

## 1.8 — Voice: TTS (Fish Audio / ElevenLabs) + STT (transcription)

**Fish Audio (TTS):** $15/M UTF-8 bytes (s2-pro); free tier ~8k
credits/mo (~7 min); voice cloning from ~15s reference audio, 30+ (up to
83 on S2.1 Pro) languages, same endpoint as catalog voices — no separate
integration path; S2.1 Pro free via API under Fair Use including cloning;
streaming supported.

**ElevenLabs (TTS):** $0.0484/1k chars (Flash/Turbo) to $0.0968/1k chars
(Multilingual v2) — roughly 2x+ Fish Audio's rate; Instant Voice Clone
from Starter tier ($6/mo+), Professional Voice Clone from Creator tier;
streaming supported, lower latency on higher tiers.

→ **Recommendation:** Fish Audio as primary (cheaper, free-tier cloning),
ElevenLabs as fallback (higher perceived quality) — matches the master
prompt's stated pairing.

**STT (voice-note transcription, new research beyond the original
scope — needed per master prompt 1.8's "ALSO research... input"):**

| Option | Cost | WER | Streaming | Ops |
|---|---|---|---|---|
| OpenAI Whisper API | $0.006/min | ~10.6% | batch only | none |
| OpenAI gpt-4o-mini-transcribe | $0.003/min | comparable/better | batch | none |
| Deepgram Nova-3 | ~$0.15–0.21/hr async, ~$0.45/hr realtime | ~5.3–6.8% | true realtime, <300ms | low |
| AssemblyAI | $0.15–0.21/hr | competitive | streaming supported | low |
| Self-hosted faster-whisper large-v3 | compute only | ~4.2% (best) | no native streaming | high |

→ **Recommendation:** OpenAI transcription API for Dave's short Telegram
voice notes — negligible cost per message, zero infra to run on Railway.
Self-hosting only pays off at high volume; Deepgram only worth it if a
future live/streaming voice feature is built (not currently in scope).

**Sources:** [Fish Audio pricing](https://fish.audio/plan/), [ElevenLabs pricing comparison](https://fish.audio/vs/pricing/elevenlabs/), OpenAI/Deepgram/AssemblyAI pricing pages (see agent transcript for full list)

---

## Summary of decisions this research supports

1. **AI brain:** proceed with AirLLM for Qwen3-235B as planned (Step 5) —
   no confirmed blocking bug, but disk space and throughput are real
   constraints to plan for, not the MoE tensor bug as originally feared.
2. **Runtime:** DSH/Cordis appears real and matches the architecture
   description closely — proceed, but re-verify with a real `dsh` run
   early in Step 2/3 given how neatly it matched.
3. **Sandbox:** default to DSH's own native `packages/sandbox` (Step
   1.3/6 decision) over standing up OpenSandbox as a second service —
   revisit only if DSH's sandbox can't do browser automation.
4. **Memory:** Hermes-style frozen `MEMORY.md`/`USER.md` for the always-
   in-context layer, TencentDB-style L0-L2 tiers underneath for
   session search / fact extraction (Step 4).
5. **Telegram:** `sendRichMessageDraft`/`<tg-thinking>`/`setMyProfilePhoto`
   need a real live-bot test before Step 8 relies on them — flagged as
   the top re-verification priority.
6. **Prompt structure:** static-first/dynamic-last, enforced everywhere
   (Step 4, Step 22.3 audit).
7. **Voice:** Fish Audio primary / ElevenLabs fallback for output (per
   spec); OpenAI transcription API for input (new recommendation).

## Confirming understanding before Step 2

This closes Step 1.9. Per the master prompt's process, I'm stopping here
to confirm understanding before writing the full file tree (Step 2) —
nothing above changes any of the architecture already fixed in the
master prompt; it fills in the "how" for pieces that were open questions
(STT provider, sandbox-vs-DSH-sandbox tradeoff) and flags one thing to
re-verify live (Telegram's newer rich-message methods).
