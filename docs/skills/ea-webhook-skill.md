---
name: ea-webhook
description: How the real Dave EA <-> webhook pattern actually works — pairing/personalization, what the EA sends, what you can send back. Use this to correctly reason about trade_execute/trade_modify/partial_close/full_close and why an order might not have gone through yet.
use_when: You're placing/modifying/closing a real trade, explaining to the user why an order hasn't executed yet, or troubleshooting the real MT5 connection.
---

# The Real Dave EA <-> Webhook Pattern

## Pairing/personalization (how the user gets set up)

1. `personalizeEaFile(userId, publicBaseUrl)` generates a REAL, unique
   webhook token for that user and returns the actual `DaveEA.mq5`
   template with `{{WEBHOOK_URL}}`/`{{TOKEN}}` placeholders replaced by
   the real values -- if either placeholder is somehow still present
   after replacement, generation fails loudly rather than shipping a
   broken file.
2. The user drops that personalized file into their own MT5 terminal.
   From then on, THEIR EA and YOUR webhook share one real, private
   token -- nobody else's EA can reach their webhook path.

## What the EA actually sends (its report)

Every heartbeat, the real EA POSTs its own current state: `account`,
`balance`, `equity`, `margin`, `freeMargin`, the full list of currently
open `positions` and `pendingOrders`, and (if any of your queued
commands finished) a `results` array with each command's outcome.

## What you can send back

The webhook's HTTP response to that POST is the ONLY channel you have
to reach the EA -- it is one-directional and request-driven: you queue
commands (open/modify/close/delete_pending), and the EA only sees them
on its NEXT heartbeat, then reports the result on the heartbeat AFTER
that. There is no way to push a command to the EA outside of it
polling you. This means:
- `trade_execute`/`trade_modify`/`partial_close`/`full_close` do NOT
  resolve instantly -- they genuinely wait for the EA's next two
  heartbeats to complete the round trip.
- If you need to tell the user "this hasn't gone through yet," that's
  often just the real, expected latency of this pattern, not a failure.

## Manual state changes ARE detected, not guessed

Because every heartbeat carries the EA's own real, current position/
order list, you can tell a manual close or a manual SL/TP edit apart
from something you did: compare the new heartbeat against what you
last knew/commanded. You don't need to ask the user whether they
touched something manually -- the EA's own state already tells you.
