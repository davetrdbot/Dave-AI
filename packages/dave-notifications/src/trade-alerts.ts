import type { TelegramClient } from "@dave/telegram";

/**
 * Update 10: connection/opened/closed/TP-hit notifications, clearly labeled which system
 * triggered it. (Item 7: R_Feed/demo-account trading is retired -- "dave" is the only real
 * system now, kept as a real field rather than removed outright since every call site already
 * threads it through and every alert is still genuinely labeled.)
 */
export type TradeSystem = "dave";

function systemLabel(_system: TradeSystem): string {
  return "🟢 Dave (real account)";
}

/** "+$12.30" / "-$4.50" -- always signed, always 2 decimals. */
export function formatMoney(amount: number): string {
  const sign = amount >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(amount).toFixed(2)}`;
}

export function formatConnectionAlert(system: TradeSystem): string {
  return `${systemLabel(system)} connected.`;
}

export interface TradeOpenedAlertInput {
  system: TradeSystem;
  symbol: string;
  lots: number;
  reason: string;
}

/** ALL of: which system, symbol/pair, lot size, and the reason -- together, in one message. */
export function formatTradeOpenedAlert(input: TradeOpenedAlertInput): string {
  return `${systemLabel(input.system)} opened **${input.symbol}**, ${input.lots} lots.\nReason: ${input.reason}`;
}

export interface TradeClosedAlertInput {
  system: TradeSystem;
  symbol: string;
  pnl: number;
  reason: string;
}

/** ALL of: which system, symbol/pair, exact P&L, and the reason (Dave's own reason, or a TP/SL-hit note). */
export function formatTradeClosedAlert(input: TradeClosedAlertInput): string {
  return `${systemLabel(input.system)} closed **${input.symbol}**, ${formatMoney(input.pnl)}.\nReason: ${input.reason}`;
}

export interface TpHitAlertInput {
  system: TradeSystem;
  symbol: string;
  profit: number;
}

/** A DEDICATED notification for a TP hit specifically -- distinct from a generic close. */
export function formatTpHitAlert(input: TpHitAlertInput): string {
  return `🎯 ${systemLabel(input.system)}: **${input.symbol}** hit take-profit, ${formatMoney(input.profit)}.`;
}

export interface SlHitAlertInput {
  system: TradeSystem;
  symbol: string;
  loss: number;
}

export function formatSlHitAlert(input: SlHitAlertInput): string {
  return `🛑 ${systemLabel(input.system)}: **${input.symbol}** hit stop-loss, ${formatMoney(input.loss)}.`;
}

export interface ManualChangeAlertInput {
  system: TradeSystem;
  symbol: string;
  detail: string; // e.g. "moved your SL to 1.0820" or "closed your position manually"
}

export function formatManualChangeAlert(input: ManualChangeAlertInput): string {
  return `👋 Noticed you ${input.detail} on **${input.symbol}** manually (${systemLabel(input.system)}).`;
}

async function send(client: TelegramClient, chatId: number | string, text: string): Promise<{ message_id: number }> {
  return client.sendMessage({ chat_id: chatId, text });
}

export const sendConnectionAlert = (client: TelegramClient, chatId: number | string, system: TradeSystem) => send(client, chatId, formatConnectionAlert(system));
export const sendTradeOpenedAlert = (client: TelegramClient, chatId: number | string, input: TradeOpenedAlertInput) => send(client, chatId, formatTradeOpenedAlert(input));
export const sendTradeClosedAlert = (client: TelegramClient, chatId: number | string, input: TradeClosedAlertInput) => send(client, chatId, formatTradeClosedAlert(input));
export const sendTpHitAlert = (client: TelegramClient, chatId: number | string, input: TpHitAlertInput) => send(client, chatId, formatTpHitAlert(input));
export const sendSlHitAlert = (client: TelegramClient, chatId: number | string, input: SlHitAlertInput) => send(client, chatId, formatSlHitAlert(input));
export const sendManualChangeAlert = (client: TelegramClient, chatId: number | string, input: ManualChangeAlertInput) => send(client, chatId, formatManualChangeAlert(input));

/**
 * Update 10: routes a real EA-reported closed position (ticket/symbol/
 * pnl/reason from MT5's own DEAL_REASON, see the EA files' own
 * comment) to the right specific notification -- a TP/SL hit gets its
 * OWN dedicated alert, a Dave-initiated or manual close gets the
 * general closed-trade alert with the appropriate reason text.
 */
export interface ClosedPositionRouterInput {
  system: TradeSystem;
  symbol: string;
  pnl: number;
  reason: "tp" | "sl" | "dave" | "manual";
  daveCloseReason?: string; // Dave's own stated reason, when reason === "dave"
}

export async function routeClosedPositionAlert(client: TelegramClient, chatId: number | string, input: ClosedPositionRouterInput): Promise<{ message_id: number }> {
  if (input.reason === "tp") {
    return sendTpHitAlert(client, chatId, { system: input.system, symbol: input.symbol, profit: input.pnl });
  }
  if (input.reason === "sl") {
    return sendSlHitAlert(client, chatId, { system: input.system, symbol: input.symbol, loss: input.pnl });
  }
  const reasonText = input.reason === "dave" ? (input.daveCloseReason ?? "Dave decided to close it.") : "Closed manually in the terminal.";
  return sendTradeClosedAlert(client, chatId, { system: input.system, symbol: input.symbol, pnl: input.pnl, reason: reasonText });
}
