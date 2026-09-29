import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getLastKnownState } from "@dave/ea-bridge";
import { fullClose, type TradeExecutor } from "@dave/trading";

/**
 * Exit rules (the trader: "if a trade is in a loss, ranging up and down... the bot can call a tool
 * so if this trade reaches +6 it should automatically close"). A rule rides on one open ticket and
 * is checked by the trade monitor on every sweep (~30 s):
 *
 *   closeAtProfit -- close once P/L climbs back to at least this much (0 = breakeven)
 *   closeAtLoss   -- close once P/L falls to this loss (a hard money stop), optional
 *
 * Money is the account currency, as P/L shows it. The sweep reads the EA's snapshot, so a spike
 * that touches the level and reverses inside one sweep can be missed -- the rule then fires on the
 * next touch. A rule ends when it fires, when it's cancelled, or when the trade closes.
 */

export interface ExitRule {
  ticket: string;
  symbol: string;
  closeAtProfit?: number;
  closeAtLoss?: number;
  note?: string;
  armedAt: number;
  /** P/L when the rule was armed -- for the message when it fires. */
  armedPnl?: number;
  expiresAt?: number;
}

function path(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "trading", userId, "exit-rules.json");
}

export function listExitRules(userId: string): ExitRule[] {
  try {
    if (existsSync(path(userId))) return JSON.parse(readFileSync(path(userId), "utf8")) as ExitRule[];
  } catch {
    /* a broken file is no rules */
  }
  return [];
}

function save(userId: string, rules: ExitRule[]): void {
  mkdirSync(dirname(path(userId)), { recursive: true });
  writeFileSync(path(userId), JSON.stringify(rules, null, 2), "utf8");
}

export const exitRuleFor = (userId: string, ticket: string) => listExitRules(userId).find((r) => r.ticket === String(ticket));

const num = (v: unknown): number | undefined => (v === undefined || v === null || v === "" ? undefined : Number.isFinite(Number(v)) ? Number(v) : NaN);

export function setExitRule(
  userId: string,
  input: { ticket: string; closeAtProfit?: unknown; closeAtLoss?: unknown; note?: unknown; expiresMinutes?: unknown },
  now = Date.now()
): ExitRule {
  const ticket = String(input.ticket ?? "").trim();
  const pos = getLastKnownState(userId).positions.find((p) => String(p.ticket) === ticket);
  if (!pos) throw new Error(`#${ticket} isn't an open position right now.`);
  const profit = num(input.closeAtProfit);
  const loss = num(input.closeAtLoss);
  if (Number.isNaN(profit) || Number.isNaN(loss)) throw new Error("closeAtProfit / closeAtLoss must be numbers (money, as P/L shows it).");
  if (profit === undefined && loss === undefined) throw new Error("Give closeAtProfit (close when P/L is back to at least this) and/or closeAtLoss (close if it falls to this loss).");
  // A loss level is a loss: -8 and 8 both mean "close at -8".
  const lossLevel = loss === undefined ? undefined : -Math.abs(loss);
  const pnl = typeof pos.pnl === "number" ? pos.pnl : undefined;
  if (profit !== undefined && pnl !== undefined && pnl >= profit) throw new Error(`#${ticket} is already at ${pnl} -- at or past ${profit}. Close it now instead if that's the plan.`);
  if (lossLevel !== undefined && pnl !== undefined && pnl <= lossLevel) throw new Error(`#${ticket} is already at ${pnl} -- at or below ${lossLevel}.`);
  if (profit !== undefined && lossLevel !== undefined && lossLevel >= profit) throw new Error("The loss level must sit below the profit level.");
  const minutes = num(input.expiresMinutes);
  const rule: ExitRule = {
    ticket,
    symbol: pos.symbol,
    ...(profit !== undefined ? { closeAtProfit: profit } : {}),
    ...(lossLevel !== undefined ? { closeAtLoss: lossLevel } : {}),
    ...(typeof input.note === "string" && input.note.trim() ? { note: input.note.trim().slice(0, 200) } : {}),
    armedAt: now,
    ...(pnl !== undefined ? { armedPnl: pnl } : {}),
    ...(minutes && minutes > 0 ? { expiresAt: now + Math.min(minutes, 7 * 24 * 60) * 60_000 } : {}),
  };
  save(userId, [...listExitRules(userId).filter((r) => r.ticket !== ticket), rule]);
  return rule;
}

export function cancelExitRule(userId: string, ticket: string): boolean {
  const rules = listExitRules(userId);
  const left = rules.filter((r) => r.ticket !== String(ticket));
  if (left.length === rules.length) return false;
  save(userId, left);
  return true;
}

export function describeExitRule(r: ExitRule): string {
  const parts = [];
  if (r.closeAtProfit !== undefined) parts.push(r.closeAtProfit === 0 ? "closes at breakeven" : `closes at ${r.closeAtProfit > 0 ? "+" : ""}${r.closeAtProfit}`);
  if (r.closeAtLoss !== undefined) parts.push(`cuts at ${r.closeAtLoss}`);
  return parts.join(", ") || "no levels";
}

/** Which way a rule fires for a P/L, or null. */
export function exitRuleHit(r: ExitRule, pnl: number | undefined): "profit" | "loss" | null {
  if (pnl === undefined || !Number.isFinite(pnl)) return null;
  if (r.closeAtProfit !== undefined && pnl >= r.closeAtProfit) return "profit";
  if (r.closeAtLoss !== undefined && pnl <= r.closeAtLoss) return "loss";
  return null;
}

const ago = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m < 1 ? "under a minute" : m < 90 ? `${m} min` : `${Math.round(m / 60)}h`;
};

/**
 * One pass, from the trade monitor sweep: fires the rules whose level was reached, drops the ones
 * whose trade is gone or whose time ran out. Returns the messages to send.
 */
export async function runExitRules(userId: string, executor: TradeExecutor | undefined, now = Date.now()): Promise<string[]> {
  const rules = listExitRules(userId);
  if (!rules.length) return [];
  const positions = getLastKnownState(userId).positions;
  const out: string[] = [];
  const keep: ExitRule[] = [];
  for (const r of rules) {
    const pos = positions.find((p) => String(p.ticket) === r.ticket);
    if (!pos) continue; // closed some other way -- the rule ends with it
    if (r.expiresAt && now >= r.expiresAt) {
      out.push(`⌛ Exit rule on ${r.symbol} #${r.ticket} (${describeExitRule(r)}) expired after ${ago(now - r.armedAt)} without firing.`);
      continue;
    }
    const hit = exitRuleHit(r, pos.pnl);
    if (!hit) {
      keep.push(r);
      continue;
    }
    if (!executor) {
      keep.push(r);
      continue;
    }
    try {
      await fullClose(executor, r.ticket);
      out.push(
        hit === "profit"
          ? `✅ Closed ${r.symbol} #${r.ticket} at ${pos.pnl! > 0 ? "+" : ""}${pos.pnl} -- it recovered to your ${r.closeAtProfit === 0 ? "breakeven" : `+${r.closeAtProfit}`} exit (armed ${ago(now - r.armedAt)} ago${r.armedPnl !== undefined ? ` at ${r.armedPnl}` : ""}).${r.note ? `\n📌 ${r.note}` : ""}`
          : `🛑 Closed ${r.symbol} #${r.ticket} at ${pos.pnl} -- it hit the ${r.closeAtLoss} cut-loss on its exit rule.${r.note ? `\n📌 ${r.note}` : ""}`
      );
    } catch (err) {
      keep.push(r); // try again next sweep
      out.push(`⚠️ ${r.symbol} #${r.ticket} reached its exit level (${pos.pnl}) but the close failed -- ${err instanceof Error ? err.message : String(err)}. I'll try again in 30 s.`);
    }
  }
  save(userId, keep);
  return out;
}

/** For Dave's context: the rules riding on his open trades. */
export function exitRulesContextBlock(userId: string): string | null {
  const rules = listExitRules(userId);
  if (!rules.length) return null;
  return `EXIT RULES ARMED (set_exit_rule; checked every ~30 s):\n${rules.map((r) => `- ${r.symbol} #${r.ticket}: ${describeExitRule(r)}${r.note ? ` -- ${r.note}` : ""}`).join("\n")}`;
}

export function createExitRuleTools(userId: string) {
  return [
    {
      name: "set_exit_rule",
      description:
        "Arm an automatic exit on an open trade, checked every ~30 s. closeAtProfit: close once P/L is back to at least this much (money as P/L shows it; 0 = breakeven) -- " +
        "the tool for a trade stuck ranging in loss: 'if it recovers to +6, close it'. closeAtLoss: close if P/L falls to this loss (e.g. -15), a money stop. Either or both. " +
        "Setting a rule on a ticket replaces its old one. Optional expiresMinutes and a short note (why). Use it when the trader asks, or when a self-aware alert says a trade is chopping in loss and a scratch exit beats hoping -- say what you armed.",
      parameters: {
        type: "object",
        properties: {
          ticket: { type: "string" },
          closeAtProfit: { type: "number", description: "close when P/L >= this (money). 0 = breakeven" },
          closeAtLoss: { type: "number", description: "close when P/L <= this loss (money), e.g. -15" },
          expiresMinutes: { type: "number" },
          note: { type: "string" },
        },
        required: ["ticket"],
      },
      execute: async (args: Record<string, unknown>) => {
        const rule = setExitRule(userId, args as { ticket: string });
        return { armed: rule, summary: `${rule.symbol} #${rule.ticket} ${describeExitRule(rule)}` };
      },
    },
    {
      name: "list_exit_rules",
      description: "The exit rules armed on open trades (set_exit_rule).",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ rules: listExitRules(userId).map((r) => ({ ...r, summary: describeExitRule(r) })) }),
    },
    {
      name: "cancel_exit_rule",
      description: "Remove the exit rule on a ticket.",
      parameters: { type: "object", properties: { ticket: { type: "string" } }, required: ["ticket"] },
      execute: async (args: Record<string, unknown>) => ({ cancelled: cancelExitRule(userId, String(args.ticket ?? "")) }),
    },
  ];
}
