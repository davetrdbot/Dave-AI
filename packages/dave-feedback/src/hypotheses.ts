import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Step 18.3: `hypotheses.jsonl` with confirmed/failed verdicts after
 * enough cycles. Per the master prompt's own constraint (never author
 * real trading rules/strategy content), the hypothesis TEXT is always
 * supplied by the caller (Dave's own reasoning during a real reflection
 * cycle) -- this module owns only the SYSTEM: recording a hypothesis,
 * tracking whether subsequent evidence supports or contradicts it, and
 * flipping a verdict once there's enough evidence, honestly.
 *
 * Event-sourced JSONL, not a mutable snapshot file: every state change
 * (creation, each observation) appends a NEW line rather than rewriting
 * history in place, so the file is a genuine append-only audit log --
 * `readHypotheses` folds the log down to current state per hypothesis.
 */

export type Verdict = "pending" | "confirmed" | "failed";
export type Observation = "supports" | "contradicts";

interface HypothesisEvent {
  id: string;
  ts: number;
  kind: "created" | "observation";
  text?: string; // present on "created"
  observation?: Observation; // present on "observation"
}

export interface Hypothesis {
  id: string;
  text: string;
  createdAt: number;
  cyclesObserved: number;
  supports: number;
  contradicts: number;
  verdict: Verdict;
}

export const MIN_CYCLES_BEFORE_VERDICT = 5;
const CONFIRM_THRESHOLD = 0.7; // >=70% of observations agreeing settles the verdict

function logPath(userId: string): string {
  return join(process.cwd(), "data", "feedback", userId, "hypotheses.jsonl");
}

function appendEvent(userId: string, event: HypothesisEvent): void {
  const path = logPath(userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const line = JSON.stringify(event) + "\n";
  writeFileSync(path, existsSync(path) ? readFileSync(path, "utf8") + line : line, "utf8");
}

function readEvents(userId: string): HypothesisEvent[] {
  const path = logPath(userId);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** A real hypothesis Dave formed during reflection -- text is Dave's own words, never authored here. */
export function recordHypothesis(userId: string, text: string): string {
  const id = randomBytes(8).toString("hex");
  appendEvent(userId, { id, ts: Date.now(), kind: "created", text });
  return id;
}

/**
 * Each subsequent reflection cycle that touches this hypothesis records
 * whether what actually happened supported or contradicted it. Once
 * `MIN_CYCLES_BEFORE_VERDICT` observations exist, a verdict is settled
 * for real -- never earlier, and never just from one data point.
 */
export function recordObservation(userId: string, hypothesisId: string, observation: Observation): void {
  appendEvent(userId, { id: hypothesisId, ts: Date.now(), kind: "observation", observation });
}

function fold(events: HypothesisEvent[]): Map<string, Hypothesis> {
  const byId = new Map<string, Hypothesis>();
  for (const event of events) {
    if (event.kind === "created") {
      byId.set(event.id, { id: event.id, text: event.text!, createdAt: event.ts, cyclesObserved: 0, supports: 0, contradicts: 0, verdict: "pending" });
      continue;
    }
    const h = byId.get(event.id);
    if (!h) continue; // observation for an unknown hypothesis -- ignore rather than crash
    h.cyclesObserved++;
    if (event.observation === "supports") h.supports++;
    else h.contradicts++;
    if (h.cyclesObserved >= MIN_CYCLES_BEFORE_VERDICT && h.verdict === "pending") {
      const supportRatio = h.supports / h.cyclesObserved;
      const contradictRatio = h.contradicts / h.cyclesObserved;
      if (supportRatio >= CONFIRM_THRESHOLD) h.verdict = "confirmed";
      else if (contradictRatio >= CONFIRM_THRESHOLD) h.verdict = "failed";
      // otherwise stays "pending" -- mixed evidence genuinely doesn't settle it
    }
  }
  return byId;
}

export function readHypotheses(userId: string): Hypothesis[] {
  return [...fold(readEvents(userId)).values()].sort((a, b) => a.createdAt - b.createdAt);
}

export function getHypothesis(userId: string, hypothesisId: string): Hypothesis | undefined {
  return fold(readEvents(userId)).get(hypothesisId);
}
