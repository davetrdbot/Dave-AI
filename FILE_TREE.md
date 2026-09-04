# Dave — Step 2: Proposed File Tree

Presented for approval before any implementation code is written, per the
master prompt. Rationale for structural choices follows the tree.

```
Dave-AI/
├── PROGRESS.md
├── research-summary.md
├── FILE_TREE.md
├── README.md
├── package.json                  # pnpm workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .env.example
├── .gitignore
│
├── prompts/                      # Step 3 — verbatim prompt-tier files
│   ├── SOUL.md
│   ├── IDENTITY.md
│   ├── SECURITY.md
│   └── BOOTSTRAP.md
│
├── memory/                       # runtime memory store — ships empty, gitignored
│   ├── MEMORY.md                 # frozen, empty at first boot
│   ├── USER.md                   # frozen, empty at first boot
│   ├── ADAPTABILITY.md           # empty at first boot
│   └── goal.yaml                 # empty placeholder — never authored by Claude
│
├── packages/                     # Cordis plugins on DSH runtime
│   ├── dave-core/                # Step 3 — agent loop, bootstrap, pairing, interrupts, task loops, circuit breaker
│   ├── dave-memory/              # Step 4 — Hermes frozen store, TencentDB tiers, session search, recall-before-acting, write-approval, per-user hidden webhook
│   ├── dave-brain/               # Step 5 — AirLLM/DeepSeek/Claude router + failover + model-picker
│   ├── dave-sandbox/             # Step 6 — DSH native sandbox wrapper + graceful degradation
│   ├── dave-davema/              # Step 7 — DAVEMA HTTPS client + correlation checks
│   ├── dave-telegram/            # Step 8-9 — bot core, commands, rich formatting, thinking indicator
│   ├── dave-trading/             # Step 10 — engine, order types, SL/TP/lot modes, pair groups, breakeven/trailing, find-setup
│   ├── dave-ea-bridge/           # Step 11 — EA webhook protocol, MCP trade-placement alternative, .mq5 generator
│   ├── dave-workers/             # Step 12-13 — worker factory, comms log, journal worker
│   ├── dave-db/                  # Step 16 — dynamic tables, aggregates, RLS, triggers, workflows
│   ├── dave-self-improve/        # Step 17 — patch proposer, sandbox test gate, versioning, approval flow
│   ├── dave-feedback/            # Step 18 — dreaming cron, trade-count reflection, hypotheses, skip log
│   ├── dave-safety/              # Step 19 — circuit breaker, stop/panic, security cron, watchdog
│   ├── dave-vision/              # Step 20 — image + video handling
│   ├── dave-notifications/       # Step 21 — briefs, trade notify, voice out/in
│   └── dave-fileio/              # Step 15 — file input/output
│   (each package: src/, package.json, tsconfig.json — no test scaffolding
│   until the step that needs it, per "never batch unrelated changes")
│
├── ea/
│   └── DaveEA.mq5                # Step 11 — MT5 Expert Advisor template (personalized copies generated per-user, not committed)
│
├── ai-brain-service/             # Step 5 — separate Python service for self-hosted AirLLM/Qwen3-235B
│   ├── main.py                   # HTTP endpoint Dave's provider-router calls
│   ├── requirements.txt
│   └── Dockerfile
│
├── admin-panel/                  # Step 14 — separate web app (dark glassmorphism, mobile responsive)
│   ├── src/
│   ├── package.json
│   └── ...
│
├── scripts/
│   ├── deploy-railway.sh
│   └── generate-mql5.ts
│
└── docs/
    └── (design notes as steps produce them)
```

## Rationale

- **pnpm workspace of Cordis plugins**, one package per numbered step's
  subsystem — matches DSH's own plugin architecture (confirmed real in
  Step 1.2) instead of fighting it with a monolith. Each package maps
  1:1 to a master-prompt step, so progress/testing stays scoped exactly
  the way the master prompt requires ("never batch multiple unrelated
  changes into one step").
- **`memory/` is a real runtime directory, not just a schema** — ships
  with the four files empty, matches Step 3.4/17.x expectations, and is
  gitignored after first commit so real user data never lands in git.
  `goal.yaml` stays an empty placeholder file until the user uploads
  their rules — nothing here defines trading logic.
- **`ai-brain-service/` is a separate Python service**, not part of the
  Node/DSH app. AirLLM is Python-only and disk/RAM-heavy in a way that's
  a poor fit to colocate with the bot process — Dave's `dave-brain`
  package calls it over HTTP, with DeepSeek/Claude as configured
  fallbacks per Step 5.3. This needs a real hosting decision (GPU/disk
  availability) that I'll flag explicitly when we get to Step 5 — Railway
  alone may not be the right host for this piece.
- **`admin-panel/` is a separate web app**, not bundled into the bot
  process — Step 14 is monitoring/config only, explicitly not where
  trading actions happen, so it doesn't need to share a runtime with the
  agent loop.
- **`ea/DaveEA.mq5`** is the template; personalized per-user copies (with
  webhook URL + token baked in) are generated on demand by
  `dave-ea-bridge`, not committed to the repo.
- No dedicated `tests/` tree yet — each package gets its own tests as its
  step is implemented, since the master prompt wants proof per-step, not
  a test suite built ahead of the code it covers.

## Open item carried over from Step 1

`dave-brain`'s AirLLM provider and `ai-brain-service`'s actual deployment
target are still unresolved pending a real hosting decision (Railway
doesn't offer GPUs) — this will come up concretely in Step 5 and needs
your input on where that service actually runs.

---

**Requesting approval on this tree before I start Step 3 (Identity & Cold
Start) implementation.** Anything you want restructured, renamed, split,
or merged before I start writing code against it?
