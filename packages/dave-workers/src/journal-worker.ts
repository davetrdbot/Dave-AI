/**
 * Step 12.7: the journal role -- writes up WHY a trade was taken in a
 * readable narrative style, not a raw data dump. This module only
 * formats facts and reasoning that were already decided elsewhere (by
 * Dave's actual analysis) into prose -- it never invents the reasoning
 * itself, same boundary as everywhere else in this build: trading
 * judgment isn't authored here, only presented.
 */

export interface TradeJournalInput {
  symbol: string;
  direction: "buy" | "sell";
  entryPrice: number;
  sl?: number;
  tp?: number;
  reasoning: string[]; // the actual points Dave's analysis produced -- supplied, not generated here
  confluenceScore?: number;
  timestamp?: number;
}

/**
 * Turns structured trade facts + Dave's own reasoning points into a
 * readable narrative writeup -- real prose, not `JSON.stringify(input)`.
 */
export function writeTradeJournalEntry(input: TradeJournalInput): string {
  const when = new Date(input.timestamp ?? Date.now()).toISOString();
  const directionWord = input.direction === "buy" ? "long" : "short";
  const lines: string[] = [];

  lines.push(`**${input.symbol} — went ${directionWord} at ${input.entryPrice}** (${when})`);
  lines.push("");

  if (input.reasoning.length === 0) {
    lines.push("No reasoning was recorded for this trade -- that's a gap worth flagging, not filling in after the fact.");
  } else if (input.reasoning.length === 1) {
    lines.push(`The call came down to one thing: ${input.reasoning[0]}`);
  } else {
    const [first, ...rest] = input.reasoning;
    lines.push(`Here's the read: ${first}`);
    for (const point of rest.slice(0, -1)) {
      lines.push(`On top of that, ${lowerFirst(point)}`);
    }
    const last = rest[rest.length - 1];
    if (last) lines.push(`And the deciding factor: ${lowerFirst(last)}`);
  }

  if (input.confluenceScore !== undefined) {
    lines.push("");
    lines.push(`Confluence came in at ${input.confluenceScore}/100 -- ${confluenceQualifier(input.confluenceScore)}.`);
  }

  if (input.sl !== undefined || input.tp !== undefined) {
    lines.push("");
    const riskParts: string[] = [];
    if (input.sl !== undefined) riskParts.push(`stop at ${input.sl}`);
    if (input.tp !== undefined) riskParts.push(`target at ${input.tp}`);
    lines.push(`Risk: ${riskParts.join(", ")}.`);
  }

  return lines.join("\n");
}

function lowerFirst(s: string): string {
  return s.length ? s[0].toLowerCase() + s.slice(1) : s;
}

function confluenceQualifier(score: number): string {
  if (score >= 80) return "about as clean a setup as this gets";
  if (score >= 60) return "solid, not perfect";
  if (score >= 40) return "mixed signals, worth a second look next time";
  return "genuinely weak -- this one's on the thin side";
}
