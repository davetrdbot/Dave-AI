---
name: rfeed-tools
description: How R_Feed's tools (history download, paper trading) work as distinct from the real EA's tools. Use before calling request_history/place_paper_trade/etc so you don't confuse demo-account tools with real-account ones.
use_when: You're about to backtest an idea, paper-trade something before risking real money, or you're unsure whether a tool touches the real account or the shared demo account.
---

# R_Feed's Tools — Real Demo-Account Tools, Never the Real Account

R_Feed is a SHARED demo/practice MT5 account. Its tools look similar to
your real trading tools by name, but they are architecturally
guaranteed to never touch real money -- the R_Feed package doesn't even
depend on the real EA's package, so there is no code path from these
tools to a real trade.

## The two real jobs

1. **History download** (`request_history`): a real `CopyRates`-backed
   request to R_Feed's EA, returning real candle data for a
   symbol/timeframe/date range. Use this to backtest an idea BEFORE
   ever risking anything.
2. **Paper trading** (`place_paper_trade`, `modify_paper_trade`,
   `partial_close_paper_trade`, `close_paper_trade`,
   `delete_paper_pending_order`, `delete_all_paper_pending_orders`):
   real fills, real SL/TP, on the shared demo account. Same
   trade-execution engine pattern as your real EA tools (all 6 order
   types, partial close, SL/TP removal, pending-order deletion) --
   just pointed at R_Feed's executor instead of the real one.

## The real usage loop

download history -> backtest in the sandbox -> if promising, paper-trade
it live on R_Feed -> only after it proves itself BOTH ways do you
propose (with required user approval) using it on the real account.
Skipping straight to the real account without this loop defeats the
entire point of R_Feed existing.

## Real safety rules enforced, not just documented

- A custom/synthetic symbol is refused BEFORE it ever reaches R_Feed's
  command queue, let alone its EA -- if you try, you get a
  `CustomSymbolTradeRefusedError`, not a silent no-op.
- The MT5 comment field on any R_Feed trade is always just your short
  user ID (~31 chars, MT5's own limit) -- your FULL reasoning/strategy
  note goes in the real database via `recordTradeNote`, linked by the
  real ticket number, never crammed into the comment field.
- R_Feed's webhook path (`/hooks/rfeed/<token>`) and token are entirely
  separate from the real EA's (`/hooks/ea/<token>`) -- see the
  `ea-webhook` skill for that pattern generally.

## Do NOT

- Assume `place_paper_trade` and `trade_execute` are interchangeable --
  they are not the same tool, not the same account, and mixing them up
  means either testing on the wrong account or, worse, thinking you
  tested something you didn't.
