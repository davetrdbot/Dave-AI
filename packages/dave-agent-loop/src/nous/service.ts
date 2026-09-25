import { randomBytes } from "node:crypto";
import type { DaveDatabase } from "@dave/db";
import type { Provider } from "@dave/brain";
import { coloredButton, keyboard, type RichBlock, type TelegramClient } from "@dave/telegram";
import { createEaAnalysisSource, getLastKnownAccountSnapshot, getLastKnownState } from "@dave/ea-bridge";
import { getRiskSettings, tradeExecuteWithMarginRetry, type TradeExecutor } from "@dave/trading";
import { knowledgeDelete, knowledgeDraft, knowledgeSave, knowledgeView } from "@dave/knowledge";
import { logTrade } from "@dave/feedback";
import { getPrimaryChatId } from "../primary-chat.js";
import { consultJournal } from "../journal-agent.js";
import { readPost } from "./parse.js";
import { buildImageContentBlock } from "@dave/vision";
import { planPlacement, rewardToRisk, type Placement } from "./plan.js";
import { advanceNousTrade } from "./manager.js";
import { checkTelegramReachable, startNousListener, type NousPost } from "./userbot.js";
import {
  getNousConfig,
  getNousLogin,
  getNousSignal,
  getNousUpdate,
  hasNousSignalFor,
  listNousSignals,
  saveNousUpdate,
  lagosTime,
  listNousTrades,
  saveNousSignal,
  saveNousTrades,
  type NousSignal,
  type NousTrade,
  type NousUpdate,
} from "./store.js";

/**
 * Nous, end to end: a post in a chosen channel -> is it a new signal (parse.ts) -> is it still
 * takeable at the live price and the clock (plan.ts) -> the trader approves it (or auto-approve is
 * on) -> placed through Dave's own executor with TP = TP1 -> its reason saved to Dave's knowledge
 * -> managed (manager.ts): breakeven + TP2 at TP1, and Dave asked whether the setup still holds
 * when it's losing. Every message to the trader is in Lagos time.
 */

export interface NousDeps {
  userId: string;
  db: DaveDatabase;
  client: TelegramClient;
  executor: TradeExecutor;
  /** The model Nous reads signals with and Dave reviews setups with. */
  provider: () => Provider;
  /** Overrides for tests; the live EA is used otherwise. */
  quote?: (symbol: string, side: "buy" | "sell") => Promise<number | undefined>;
  eaState?: () => ReturnType<typeof getLastKnownState>;
  account?: () => ReturnType<typeof getLastKnownAccountSnapshot>;
  /** Overrides the "still valid?" consult for tests. */
  consult?: (question: string, context: string[]) => Promise<string>;
}

/** A card left untapped this long is expired -- the market it described has moved on. */
export const APPROVAL_WINDOW_MS = 30 * 60_000;
const MANAGE_EVERY_MS = 10_000;
const QUOTE_TIMEOUT_MS = 20_000;

const running = new Map<string, NousDeps>();

/** The live Nous for this account (set by startNous at boot). */
export function nousDepsFor(userId: string): NousDeps | undefined {
  return running.get(userId);
}

export async function startNous(deps: NousDeps): Promise<void> {
  running.set(deps.userId, deps);
  const timer = setInterval(() => void manageNousTrades(deps).catch((err) => console.error(`[nous] ${deps.userId}: manage failed:`, err)), MANAGE_EVERY_MS);
  timer.unref?.();
  void checkTelegramReachable().then((r) => console.log(`[nous] Telegram login servers: ${r}`));
  await ensureNousListening(deps.userId).catch((err) => console.error(`[nous] ${deps.userId}: not listening: ${err instanceof Error ? err.message : String(err)}`));
}

/** (Re)starts reading channels -- after login, after the chat list changes, and at boot. */
export async function ensureNousListening(userId: string): Promise<boolean> {
  const deps = running.get(userId);
  if (!deps || !getNousLogin(userId)) return false;
  await startNousListener(userId, (post) => void onNousPost(deps, post).catch((err) => console.error(`[nous] ${userId}: post failed:`, err)));
  return true;
}

function chatOf(deps: NousDeps): number | undefined {
  return getPrimaryChatId(deps.db, deps.userId);
}

async function rawQuote(userId: string, symbol: string): Promise<{ bid?: number; ask?: number; close?: number } | undefined> {
  try {
    return await Promise.race([
      createEaAnalysisSource(userId).get<{ bid?: number; ask?: number; close?: number }>("price", symbol),
      new Promise<undefined>((r) => setTimeout(() => r(undefined), QUOTE_TIMEOUT_MS).unref()),
    ]);
  } catch {
    return undefined;
  }
}

async function livePrice(userId: string, symbol: string, side: "buy" | "sell"): Promise<number | undefined> {
  const quote = await rawQuote(userId, symbol);
  // A buy fills at the ask, a sell at the bid.
  return side === "buy" ? (quote?.ask ?? quote?.close ?? quote?.bid) : (quote?.bid ?? quote?.close ?? quote?.ask);
}

/** Nous's get_price tool: the live bid/ask for any symbol. */
function priceTool(deps: NousDeps): (symbol: string) => Promise<{ bid?: number; ask?: number } | undefined> {
  if (deps.quote) {
    const q = deps.quote;
    return async (symbol) => {
      const [bid, ask] = await Promise.all([q(symbol, "sell"), q(symbol, "buy")]);
      return bid === undefined && ask === undefined ? undefined : { bid, ask };
    };
  }
  return async (symbol) => {
    const q = await rawQuote(deps.userId, symbol);
    return q ? { bid: q.bid ?? q.close, ask: q.ask ?? q.close } : undefined;
  };
}

export function nousLots(userId: string): number {
  const configured = getNousConfig(userId).lots;
  if (configured && configured > 0) return configured;
  const risk = getRiskSettings(userId);
  return risk.lotMode === "on" && risk.lotValue ? risk.lotValue : 0.01;
}

/** A new post in one of the chosen channels/groups. */
export async function onNousPost(deps: NousDeps, post: NousPost, now = Date.now()): Promise<void> {
  const { userId } = deps;
  const config = getNousConfig(userId);
  if (hasNousSignalFor(userId, post.chatId, post.messageId)) return;
  if (now - post.postedAt > config.maxAgeMinutes * 60_000) return; // old news: a reconnect delivering the past
  const fromChannel = listNousTrades(userId).filter((t) => t.chatId === post.chatId || (!t.chatId && t.chatTitle === post.chatTitle));
  const repliedTo = post.replyToMessageId !== undefined ? fromChannel.find((t) => t.messageId === post.replyToMessageId) : undefined;
  let image;
  try {
    image = post.image ? buildImageContentBlock(post.image, "signal.jpg") : undefined;
  } catch {
    image = undefined; // not a readable picture -- go on with the text
  }
  const read = await readPost(deps.provider(), {
    text: post.text,
    image,
    openTrades: fromChannel.map(describeTrade),
    replyingTo: repliedTo ? describeTrade(repliedTo) : undefined,
    quote: priceTool(deps),
  });
  if (!read) return;
  if (read.kind === "update") {
    await onNousUpdate(deps, post, read.update, repliedTo ? [repliedTo] : fromChannel, now);
    return;
  }
  const parsed = read.signal;

  const signal: NousSignal = {
    id: randomBytes(5).toString("hex"),
    chatId: post.chatId,
    chatTitle: post.chatTitle,
    messageId: post.messageId,
    postedAt: post.postedAt,
    text: (post.text || "(signal posted as a picture)").slice(0, 3000),
    signal: parsed,
    status: "awaiting",
  };
  saveNousSignal(userId, signal);

  const price = await (deps.quote ?? ((sym, side) => livePrice(userId, sym, side)))(parsed.symbol, parsed.side);
  if (price === undefined) {
    signal.status = "skipped";
    signal.note = `no live price for ${parsed.symbol} from MT5 -- the EA is offline, or the broker names it differently`;
    saveNousSignal(userId, signal);
    await send(deps, [heading(`📡 ${parsed.symbol} ${parsed.side.toUpperCase()} -- skipped`), para(`From ${signal.chatTitle} · ${lagosTime(signal.postedAt)}`), para(`⏭️ ${signal.note}`)], true);
    return;
  }
  const plan = planPlacement(parsed, price, post.postedAt, now, config.maxAgeMinutes);
  if (!plan.ok) {
    signal.status = "skipped";
    signal.note = plan.reason;
    saveNousSignal(userId, signal);
    await send(deps, [...signalCard(signal, price, userId, plan), para(`⏭️ Skipped: ${plan.reason}`)], true);
    return;
  }
  if (config.autoApprove) {
    await placeNousSignal(deps, signal.id, now);
    return;
  }
  const blocks = [...signalCard(signal, price, userId, plan), para(`Place it? This card expires ${lagosTime(post.postedAt + APPROVAL_WINDOW_MS)}.`)];
  const sent = await send(deps, blocks, false, keyboard([[coloredButton("✅ Place trade", "green", `nous:y:${signal.id}`), coloredButton("❌ Skip", "red", `nous:n:${signal.id}`)]]));
  if (sent) {
    signal.cardMessageId = sent;
    saveNousSignal(userId, signal);
  }
}

/** ✅ tapped (or auto-approve): re-checks against the price NOW, then places. */
export async function placeNousSignal(deps: NousDeps, signalId: string, now = Date.now()): Promise<string> {
  const { userId } = deps;
  const signal = getNousSignal(userId, signalId);
  if (!signal) return "That signal is gone.";
  if (signal.status !== "awaiting") return `Already ${signal.status}.`;
  await clearCardButtons(deps, signal);
  const parsed = signal.signal;
  if (now - signal.postedAt > APPROVAL_WINDOW_MS) {
    signal.status = "expired";
    saveNousSignal(userId, signal);
    return reply(deps, `⌛ ${parsed.symbol} ${parsed.side.toUpperCase()} from ${signal.chatTitle} expired -- posted ${lagosTime(signal.postedAt)}, too long ago to take now.`);
  }
  const price = await (deps.quote ?? ((sym, side) => livePrice(userId, sym, side)))(parsed.symbol, parsed.side);
  // At approval the age limit is the approval window: the trader's own tap is what's being honoured.
  const plan = price === undefined ? ({ ok: false, reason: "no live price from MT5 right now" } as Placement) : planPlacement(parsed, price, signal.postedAt, now, APPROVAL_WINDOW_MS / 60_000);
  if (!plan.ok) {
    signal.status = "skipped";
    signal.note = plan.reason;
    saveNousSignal(userId, signal);
    return reply(deps, `⏭️ Didn't place ${parsed.symbol} ${parsed.side.toUpperCase()}: ${plan.reason}.`);
  }

  const lots = nousLots(userId);
  let ticket: string;
  let placedLots = lots;
  try {
    const placed = await tradeExecuteWithMarginRetry(deps.executor, {
      symbol: parsed.symbol,
      type: plan.type,
      lots,
      price: plan.price,
      sl: parsed.sl,
      tp: parsed.tp1,
      comment: "Nous signal",
      pushMessage: `Nous: ${parsed.symbol} ${parsed.side.toUpperCase()} from ${signal.chatTitle}`,
    });
    ticket = placed.ticket;
    placedLots = placed.placedLots;
  } catch (err) {
    signal.status = "failed";
    signal.note = err instanceof Error ? err.message : String(err);
    saveNousSignal(userId, signal);
    return reply(deps, `⚠️ MT5 refused ${parsed.symbol} ${parsed.side.toUpperCase()}: ${signal.note}`);
  }

  signal.status = "placed";
  signal.ticket = ticket;
  saveNousSignal(userId, signal);

  const trade: NousTrade = {
    ticket,
    signalId: signal.id,
    symbol: parsed.symbol,
    side: parsed.side,
    lots: placedLots,
    entry: plan.entry,
    sl: parsed.sl,
    tp1: parsed.tp1,
    tp2: parsed.tp2,
    reason: parsed.reason,
    chatTitle: signal.chatTitle,
    chatId: signal.chatId,
    messageId: signal.messageId,
    placedAt: now,
    stage: "tp1",
  };
  trade.knowledgeId = saveSetupKnowledge(userId, signal, trade);
  saveNousTrades(userId, [...listNousTrades(userId), trade]);
  try {
    // The trade journal is what every self-aware alert quotes back as "the original idea".
    logTrade(deps.db, userId, {
      ticket,
      symbol: parsed.symbol,
      direction: parsed.side,
      entryPrice: plan.entry,
      sl: parsed.sl,
      tp: parsed.tp1,
      reasoning: [`Copied signal from ${signal.chatTitle}`, ...(parsed.reason ? [parsed.reason] : [])],
    });
  } catch {
    // Journaling never blocks a trade that is already placed.
  }

  const rows = [
    ["", ""],
    ["Ticket", `#${ticket}`],
    ["Order", plan.note],
    ["Lots", String(placedLots)],
    ["Stop loss", String(parsed.sl)],
    ["Take profit", `${parsed.tp1} (TP1)`],
  ];
  if (parsed.tp2 !== undefined) rows.push(["Then", `stop → entry, target → ${parsed.tp2} (TP2)`]);
  await send(deps, [heading(`✅ Placed ${parsed.symbol} ${parsed.side.toUpperCase()}`), { type: "table", cells: rows }, footer(`From ${signal.chatTitle} · ${lagosTime(now)} · reason saved to Dave's knowledge`)]);
  return `Placed #${ticket}`;
}

export async function skipNousSignal(deps: NousDeps, signalId: string): Promise<void> {
  const signal = getNousSignal(deps.userId, signalId);
  if (!signal || signal.status !== "awaiting") return;
  signal.status = "skipped";
  signal.note = "skipped by you";
  saveNousSignal(deps.userId, signal);
  await clearCardButtons(deps, signal);
  await reply(deps, `❌ Skipped ${signal.signal.symbol} ${signal.signal.side.toUpperCase()} from ${signal.chatTitle}.`);
}

/** Every 10s: breakeven + TP2 at TP1, "still valid?" when losing, results when closed. */
export async function manageNousTrades(deps: NousDeps, now = Date.now()): Promise<void> {
  const { userId } = deps;
  const trades = listNousTrades(userId);
  if (!trades.length) return;
  const state = deps.eaState ? deps.eaState() : getLastKnownState(userId);
  const account = deps.account ? deps.account() : getLastKnownAccountSnapshot(userId);
  const keep: NousTrade[] = [];
  for (const trade of trades) {
    const pos = state.positions.find((p) => p.ticket === trade.ticket);
    const pending = state.pendingOrders.find((p) => p.ticket === trade.ticket);
    if (!pos) {
      if (pending || now - trade.placedAt < 60_000) keep.push(trade); // not filled yet / first report not in
      else await closeOut(deps, trade);
      continue;
    }
    trade.filled = true;
    trade.lastPnl = pos.pnl;
    for (const action of advanceNousTrade(trade, pos, account, now)) {
      if (action.kind === "moveToBreakeven") {
        try {
          await deps.executor.modifyOrder(trade.ticket, { sl: action.sl, tp: action.tp });
          await reply(deps, `🎯 ${trade.symbol} ${trade.side.toUpperCase()} #${trade.ticket} reached TP1 -- stop moved to entry (${action.sl}), now riding to TP2 (${action.tp}). Risk-free from here.`);
        } catch (err) {
          trade.stage = "tp1"; // try again on the next pass
          await reply(deps, `⚠️ ${trade.symbol} #${trade.ticket} is at TP1 but MT5 refused moving the stop: ${err instanceof Error ? err.message : String(err)}. Move it to ${action.sl} by hand if you can.`);
        }
      } else {
        void askDaveIfValid(deps, trade, pos.pnl, action.why);
      }
    }
    keep.push(trade);
  }
  saveNousTrades(userId, keep);
}

/** The trader: "when a trade is losing like 5 min or eating margin, it should ask Dave if this setup is still valid". */
async function askDaveIfValid(deps: NousDeps, trade: NousTrade, pnl: number | undefined, why: string): Promise<void> {
  let opinion: string;
  try {
    const question = `A copied signal trade is ${why}. Check the live chart with your analysis tools and answer plainly: is this setup still valid -- hold, or close? Two or three sentences, then one word on its own line: HOLD or CLOSE.`;
    const context = [
      `Trade: ${trade.symbol} ${trade.side.toUpperCase()} #${trade.ticket}, ${trade.lots} lots, entry ${trade.entry}, SL ${trade.sl}, TP1 ${trade.tp1}${trade.tp2 !== undefined ? `, TP2 ${trade.tp2}` : ""}, floating ${pnl ?? "?"}.`,
      `Signal from: ${trade.chatTitle}. Their reason: ${trade.reason || "(none given)"}`,
    ];
    opinion = deps.consult
      ? await deps.consult(question, context)
      : (await consultJournal({ userId: deps.userId, db: deps.db, provider: deps.provider() }, question, context)).opinion.trim();
  } catch (err) {
    opinion = `(Dave couldn't check the chart right now: ${err instanceof Error ? err.message : String(err)})`;
  }
  const chatId = chatOf(deps);
  if (chatId === undefined) return;
  const blocks: RichBlock[] = [
    heading(`🤔 ${trade.symbol} ${trade.side.toUpperCase()} #${trade.ticket} -- still valid?`),
    { type: "table", cells: [["", ""], ["Why I'm asking", why], ["Floating", pnl !== undefined ? pnl.toFixed(2) : "?"], ["Entry / SL", `${trade.entry} / ${trade.sl}`], ["Target", String(trade.stage === "tp2" ? trade.tp2 : trade.tp1)]] },
    para(`Dave: ${opinion}`),
  ];
  await send(deps, blocks, false, keyboard([[coloredButton("Close it", "red", `nous:c:${trade.ticket}`), coloredButton("Keep it", "green", `nous:k:${trade.ticket}`)]]));
}

export async function closeNousTrade(deps: NousDeps, ticket: string): Promise<void> {
  try {
    await deps.executor.closePosition(ticket);
    await reply(deps, `Closing #${ticket} now.`);
  } catch (err) {
    await reply(deps, `⚠️ Couldn't close #${ticket}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Position gone: note the result on its knowledge entry so the next similar setup is judged with it. */
async function closeOut(deps: NousDeps, trade: NousTrade): Promise<void> {
  if (!trade.filled) {
    await reply(deps, `🗑️ ${trade.symbol} ${trade.side.toUpperCase()} pending order #${trade.ticket} is gone without filling.`);
    return;
  }
  const pnl = trade.lastPnl;
  const outcome =
    trade.stage === "tp2"
      ? `reached TP1 and was moved to breakeven; closed around ${pnl?.toFixed(2) ?? "?"} (last seen)`
      : pnl !== undefined && pnl >= 0
        ? `closed in profit (about ${pnl.toFixed(2)}, last seen) -- TP1 hit`
        : `closed at a loss (about ${pnl?.toFixed(2) ?? "?"}, last seen) -- stop hit or closed`;
  if (trade.knowledgeId) {
    try {
      const entry = knowledgeView(deps.userId, trade.knowledgeId);
      knowledgeDelete(deps.userId, trade.knowledgeId);
      const draft = knowledgeDraft(deps.userId, { title: entry.title, useWhen: entry.useWhen, content: `${entry.content}\n\nResult: ${outcome}.` });
      knowledgeSave(deps.userId, draft.id);
    } catch {
      // The knowledge entry was edited or removed by hand -- nothing to append to.
    }
  }
  await reply(deps, `📘 ${trade.symbol} ${trade.side.toUpperCase()} #${trade.ticket} (from ${trade.chatTitle}) ${outcome}. Saved to Dave's knowledge.`);
}

function saveSetupKnowledge(userId: string, signal: NousSignal, trade: NousTrade): string | undefined {
  const p = signal.signal;
  try {
    const draft = knowledgeDraft(userId, {
      title: `Signal setup: ${p.symbol} ${p.side} (${signal.chatTitle}, ${lagosTime(trade.placedAt)})`,
      useWhen: `Seeing a similar ${p.side} setup on ${p.symbol} or another pair${p.reason ? `: ${p.reason.slice(0, 160)}` : ""}`,
      content: [
        `Copied from ${signal.chatTitle}, posted ${lagosTime(signal.postedAt)}.`,
        `${p.symbol} ${p.side.toUpperCase()} -- entry ${trade.entry}, SL ${p.sl}, TP1 ${p.tp1}${p.tp2 !== undefined ? `, TP2 ${p.tp2}` : ""} (R:R to TP1 about 1:${rewardToRisk(trade.entry, p.sl, p.tp1).toFixed(1)}).`,
        `The provider's reason: ${p.reason || "(none given)"}`,
      ].join("\n"),
    });
    return knowledgeSave(userId, draft.id).id;
  } catch {
    return undefined;
  }
}

// ---- Follow-ups from the provider ("close now", "SL to BE", "SL to 2345", "cancel the limit") ----

export function describeTrade(t: NousTrade): string {
  return `${t.symbol} ${t.side.toUpperCase()} #${t.ticket}, entry ${t.entry}, SL ${t.sl}, TP ${t.stage === "tp2" ? t.tp2 : t.tp1}${t.filled ? "" : " (pending, not filled yet)"}`;
}

function describeAction(u: NousUpdate["update"]): string {
  switch (u.action) {
    case "close":
      return "close it now";
    case "close_partial":
      return `close ${Math.round((u.fraction ?? 0.5) * 100)}% of it`;
    case "breakeven":
      return "move the stop loss to entry (breakeven)";
    case "move_sl":
      return `move the stop loss to ${u.price}`;
    case "move_tp":
      return `move the take profit to ${u.price}`;
    case "cancel":
      return "cancel the pending order";
  }
}

/** Which copied trades a follow-up is about: the one it replies to; else the named pair's; else the latest. */
export function pickUpdateTargets(update: NousUpdate["update"], candidates: NousTrade[]): NousTrade[] {
  let pool = update.symbol ? candidates.filter((t) => t.symbol === update.symbol) : candidates;
  if (update.action === "cancel") pool = pool.filter((t) => !t.filled);
  if (!pool.length) return [];
  if (update.all || candidates.length === 1) return pool;
  return [pool.reduce((a, b) => (b.placedAt > a.placedAt ? b : a))];
}

async function onNousUpdate(deps: NousDeps, post: NousPost, update: NousUpdate["update"], candidates: NousTrade[], now: number): Promise<void> {
  const targets = pickUpdateTargets(update, candidates);
  if (!targets.length) return; // about a trade Nous didn't copy -- nothing of ours to touch
  const record: NousUpdate = {
    id: randomBytes(5).toString("hex"),
    chatId: post.chatId,
    chatTitle: post.chatTitle,
    messageId: post.messageId,
    postedAt: post.postedAt,
    text: (post.text || "(picture)").slice(0, 1500),
    update,
    tickets: targets.map((t) => t.ticket),
    status: "awaiting",
  };
  saveNousUpdate(deps.userId, record);
  if (getNousConfig(deps.userId).autoApprove) {
    await applyNousUpdate(deps, record.id, now);
    return;
  }
  const blocks: RichBlock[] = [
    heading(`📣 ${post.chatTitle}: ${describeAction(update)}`),
    { type: "table", cells: [["Trade", "Now"], ...targets.map((t) => [`${t.symbol} ${t.side.toUpperCase()} #${t.ticket}`, `entry ${t.entry} · SL ${t.sl} · TP ${t.stage === "tp2" ? t.tp2 : t.tp1}`])] },
    { type: "details", text: "Their post", blocks: [{ type: "pre", text: record.text }] },
    para(`Do it? Posted ${lagosTime(post.postedAt)}.`),
  ];
  const sent = await send(deps, blocks, false, keyboard([[coloredButton("✅ Do it", "green", `nous:uy:${record.id}`), coloredButton("❌ Ignore", "red", `nous:un:${record.id}`)]]));
  if (sent) {
    record.cardMessageId = sent;
    saveNousUpdate(deps.userId, record);
  }
}

export async function applyNousUpdate(deps: NousDeps, updateId: string, now = Date.now()): Promise<string> {
  const { userId } = deps;
  const record = getNousUpdate(userId, updateId);
  if (!record) return "That update is gone.";
  if (record.status !== "awaiting") return `Already ${record.status}.`;
  await clearUpdateButtons(deps, record);
  if (now - record.postedAt > APPROVAL_WINDOW_MS) {
    record.status = "expired";
    saveNousUpdate(userId, record);
    return reply(deps, `⌛ "${describeAction(record.update)}" from ${record.chatTitle} expired -- posted ${lagosTime(record.postedAt)}.`);
  }
  const state = deps.eaState ? deps.eaState() : getLastKnownState(userId);
  const trades = listNousTrades(userId);
  const u = record.update;
  const lines: string[] = [];
  let failed = false;
  for (const ticket of record.tickets) {
    const trade = trades.find((t) => t.ticket === ticket);
    const pos = state.positions.find((p) => p.ticket === ticket);
    const pending = state.pendingOrders.find((p) => p.ticket === ticket);
    const label = `${trade?.symbol ?? ""} #${ticket}`.trim();
    try {
      if (!pos && !pending) {
        lines.push(`${label}: already closed`);
        continue;
      }
      if (u.action === "close" || u.action === "cancel") {
        if (pending) {
          await deps.executor.deletePendingOrder(ticket);
          lines.push(`${label}: pending order cancelled`);
        } else if (u.action === "cancel") {
          lines.push(`${label}: already filled -- not cancelled (it's a live trade now)`);
        } else {
          await deps.executor.closePosition(ticket);
          lines.push(`${label}: closed`);
        }
      } else if (!pos) {
        lines.push(`${label}: still a pending order -- nothing to ${u.action === "close_partial" ? "part-close" : "move"} yet`);
      } else if (u.action === "close_partial") {
        const lots = Math.max(0.01, Math.floor(pos.lots * (u.fraction ?? 0.5) * 100) / 100);
        if (lots >= pos.lots) await deps.executor.closePosition(ticket);
        else await deps.executor.closePosition(ticket, lots);
        lines.push(`${label}: closed ${lots >= pos.lots ? "all" : `${lots} of ${pos.lots}`} lots`);
      } else if (u.action === "breakeven") {
        await deps.executor.modifyOrder(ticket, { sl: pos.openPrice });
        if (trade) trade.sl = pos.openPrice;
        lines.push(`${label}: stop moved to entry ${pos.openPrice}`);
      } else if (u.action === "move_sl") {
        await deps.executor.modifyOrder(ticket, { sl: u.price! });
        if (trade) trade.sl = u.price!;
        lines.push(`${label}: stop moved to ${u.price}`);
      } else if (u.action === "move_tp") {
        await deps.executor.modifyOrder(ticket, { tp: u.price! });
        if (trade) {
          if (trade.stage === "tp2") trade.tp2 = u.price!;
          else trade.tp1 = u.price!;
        }
        lines.push(`${label}: take profit moved to ${u.price}`);
      }
    } catch (err) {
      failed = true;
      lines.push(`${label}: ⚠️ MT5 refused -- ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  saveNousTrades(userId, trades);
  record.status = failed ? "failed" : "done";
  record.note = lines.join("; ");
  saveNousUpdate(userId, record);
  return reply(deps, `📣 ${record.chatTitle} said "${describeAction(u)}":\n${lines.map((l) => `• ${l}`).join("\n")}`);
}

export async function skipNousUpdate(deps: NousDeps, updateId: string): Promise<void> {
  const record = getNousUpdate(deps.userId, updateId);
  if (!record || record.status !== "awaiting") return;
  record.status = "skipped";
  saveNousUpdate(deps.userId, record);
  await clearUpdateButtons(deps, record);
  await reply(deps, `Ignored: "${describeAction(record.update)}" from ${record.chatTitle}.`);
}

async function clearUpdateButtons(deps: NousDeps, record: NousUpdate): Promise<void> {
  const chatId = chatOf(deps);
  if (chatId === undefined || !record.cardMessageId) return;
  await deps.client.editMessageReplyMarkup({ chat_id: chatId, message_id: record.cardMessageId, reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
}

// ---- Message helpers ----

const heading = (text: string): RichBlock => ({ type: "heading", text, size: 2 });
const para = (text: string): RichBlock => ({ type: "paragraph", text });
const footer = (text: string): RichBlock => ({ type: "footer", text });

function signalCard(signal: NousSignal, price: number, userId: string, plan: Placement): RichBlock[] {
  const p = signal.signal;
  const entry = plan.ok ? plan.entry : (p.entry ?? price);
  const rows: string[][] = [
    ["", ""],
    ["Entry", p.entry !== undefined ? String(p.entry) : "now (market)"],
    ["Stop loss", String(p.sl)],
    ["TP1 (target)", String(p.tp1)],
    ["TP2 (after breakeven)", p.tp2 !== undefined ? String(p.tp2) : "--"],
    ["Price now", String(price)],
    ["R:R to TP1", `1:${rewardToRisk(entry, p.sl, p.tp1).toFixed(1)}`],
    ["Lots", String(nousLots(userId))],
  ];
  if (plan.ok) rows.push(["Order", plan.note]);
  const blocks: RichBlock[] = [
    heading(`📡 ${p.symbol} ${p.side.toUpperCase()}`),
    para(`From ${signal.chatTitle} · posted ${lagosTime(signal.postedAt)}`),
    { type: "table", cells: rows },
  ];
  if (p.reason) blocks.push({ type: "details", text: "Their reason", blocks: [para(p.reason)] });
  blocks.push({ type: "details", text: "The original post", blocks: [{ type: "pre", text: signal.text.slice(0, 1500) }] });
  return blocks;
}

/** Sends a rich message to the trader; falls back to plain text if rich messages are refused. */
async function send(deps: NousDeps, blocks: RichBlock[], silent = false, replyMarkup?: ReturnType<typeof keyboard>): Promise<number | undefined> {
  const chatId = chatOf(deps);
  if (chatId === undefined) return undefined;
  try {
    const sent = await deps.client.sendRichMessage({ chat_id: chatId, rich_message: { blocks }, reply_markup: replyMarkup, disable_notification: silent || undefined });
    return sent.message_id;
  } catch {
    const sent = await deps.client.sendMessage({ chat_id: chatId, text: blocksToText(blocks), reply_markup: replyMarkup, disable_notification: silent || undefined }).catch(() => undefined);
    return sent?.message_id;
  }
}

async function reply(deps: NousDeps, text: string): Promise<string> {
  const chatId = chatOf(deps);
  if (chatId !== undefined) await deps.client.sendMessage({ chat_id: chatId, text }).catch(() => undefined);
  return text;
}

async function clearCardButtons(deps: NousDeps, signal: NousSignal): Promise<void> {
  const chatId = chatOf(deps);
  if (chatId === undefined || !signal.cardMessageId) return;
  await deps.client.editMessageReplyMarkup({ chat_id: chatId, message_id: signal.cardMessageId, reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
}

export function blocksToText(blocks: RichBlock[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.type === "heading" || b.type === "paragraph" || b.type === "footer" || b.type === "pre" || b.type === "blockquote" || b.type === "pullquote") out.push(b.text);
    else if (b.type === "table") out.push(b.cells.filter((r) => r.some((c) => c)).map((r) => r.join(": ")).join("\n"));
    else if (b.type === "details") out.push(`${b.text}:\n${blocksToText(b.blocks)}`);
  }
  return out.join("\n\n").slice(0, 4000);
}
