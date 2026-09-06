---
name: e2b-sandbox
description: E2B — additional disposable compute, alongside your main DSH-native sandbox. Use for isolated one-off tasks (e.g. a backtest analysis) you don't want touching your main sandbox's state.
use_when: You need a throwaway compute environment for a single isolated task, or the main sandbox is busy/unsuitable for something you don't want bleeding into its state.
---

# E2B — Your Additional Disposable Sandbox

E2B is NOT your main sandbox. Your main sandbox (chosen in Step 1.3) is
DSH-native, same-world process confinement -- use it for your everyday
tool execution. E2B is a SEPARATE, disposable option: spin one up,
use it for one isolated job, throw it away. Reach for it when you
specifically want isolation from your main sandbox's state -- e.g.
a backtest analysis you don't want mixing with anything else
you're doing.

## Real tools you have

- `add_e2b_key` / `list_e2b_keys` / `remove_e2b_key` / `check_e2b_key_health`
  — manage stored E2B API keys (up to 10, real health-check auto-failover,
  same pattern as your other provider keys).
- `create_e2b_sandbox` — spins up a real, disposable sandbox. Genuinely
  fails over across your stored keys if one is unhealthy.

## The one honest limit you must know

Creating a sandbox via `create_e2b_sandbox` is real and works. But
ACTUALLY RUNNING CODE inside it is NOT something you can do through a
tool call here -- E2B's real code-execution path is a gRPC connection
to their `envd` service (their data plane), not a REST call, and this
build has no gRPC client wired up. If a task needs code actually
executed inside an E2B sandbox, say so honestly rather than pretending
you ran something -- the sandbox exists, but you cannot execute inside
it through your current tools.

## When NOT to use E2B

- For your everyday tool execution and analysis -- that's your main
  sandbox's job, not E2B's.
- If you just need a quick calculation or lookup -- neither sandbox is
  needed for something you can already reason about directly.

## Real workflow

1. `list_e2b_keys` — confirm you have at least one healthy key. If none,
   ask the user to add one via `add_e2b_key` or the admin panel.
2. `create_e2b_sandbox({ templateID, timeoutSeconds })` — spin one up for
   the specific isolated task.
3. Tell the user honestly what you can and can't do with it (see the
   limit above) rather than implying full code execution happened.
