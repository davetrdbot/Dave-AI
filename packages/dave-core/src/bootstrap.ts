import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendAdaptability, appendUserFact } from "@dave/memory";

export type BootstrapState =
  | "not-started"
  | "awaiting-name"
  | "awaiting-style"
  | "complete";

export interface BootstrapProgress {
  userId: string;
  state: BootstrapState;
  name?: string;
  styleNote?: string;
}

export interface Transport {
  send(userId: string, text: string): void | Promise<void>;
}

const OPENING_MESSAGE =
  "Hey, I just came online — I'm Dave \u{1F605}. Quick one before we get going:";
const Q1_NAME = "What should I call you?";
const Q2_STYLE =
  "Terse and to the point, or more detail? And should I check in often, or only when it matters?";

function progressPath(userId: string): string {
  return join(process.env.DAVE_DATA_ROOT ?? process.cwd(), "data", "bootstrap", `${userId}.json`);
}

function loadProgress(userId: string): BootstrapProgress {
  const path = progressPath(userId);
  if (!existsSync(path)) return { userId, state: "not-started" };
  return JSON.parse(readFileSync(path, "utf8"));
}

function saveProgress(progress: BootstrapProgress): void {
  const path = progressPath(progress.userId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(progress, null, 2), "utf8");
}

/**
 * Real bug fixed (the trader, live: reset the bot, then reported bootstrap "doesn't work again").
 * BootstrapFlow's own progress ("complete" once onboarding finished) lives in a separate file
 * that /reset's wipe never touched -- so even though USER.md/ADAPTABILITY.md (the actual name/
 * style memory bootstrap wrote) were genuinely wiped, the state machine itself stayed stuck on
 * "complete" forever, and `handleMessage` short-circuits immediately whenever state is
 * "not-started" OR "complete" -- so a real reset never got Dave to introduce itself again. This
 * is the missing piece: delete the progress file entirely (not just set it to "not-started",
 * since the caller then calls start() to actually re-open it, and a stale file with old
 * name/styleNote fields serves no purpose once erased).
 */
export function resetBootstrapProgress(userId: string): void {
  const path = progressPath(userId);
  if (existsSync(path)) rmSync(path);
}

/**
 * Very simple, replaceable heuristic for Step 3.7 ("real tasks during
 * onboarding still get handled"). This is intentionally not a full intent
 * classifier — in production (Step 8+) this hook should be backed by the
 * actual LLM call; here it's a pluggable function so the state machine's
 * branching is real and testable without needing a live model.
 */
export type RealTaskDetector = (message: string) => boolean;

export const defaultRealTaskDetector: RealTaskDetector = (message) => {
  const trivialAnswerLike = message.trim().split(/\s+/).length <= 6;
  return !trivialAnswerLike && /[?]|please|help|can you|show me|what('|)s/i.test(message);
};

/**
 * The name inside an answer to "What should I call you?". People answer in a sentence as often as
 * with a bare name -- "call me Sam", "I'm Sam", "my name is Sam" -- and the whole sentence used to
 * be saved as the name ("Got it, Call me Sam."). A bare answer is kept as typed.
 */
export function extractPreferredName(message: string): string {
  const text = message.trim().replace(/[.!]+$/, "");
  const m = text.match(/^(?:(?:you can |just )?call me|my name is|my name's|name's|i am|i'm|im|it's|its|this is)\s+(.+)$/i);
  const name = (m ? m[1] : text).trim().replace(/^["']|["']$/g, "");
  return name.length > 40 ? name.slice(0, 40).trim() : name;
}

/** What still stands between a fresh install and Dave trading, in plain words -- empty when
 *  nothing does. Supplied by the caller, which can see keys and the EA connection. */
export type SetupGaps = (userId: string) => string[];

export class BootstrapFlow {
  constructor(
    private readonly transport: Transport,
    private readonly isRealTask: RealTaskDetector = defaultRealTaskDetector,
    private readonly setupGaps?: SetupGaps
  ) {}

  /** Step 3.5/BOOTSTRAP trigger: called the moment pairing is confirmed. Dave speaks first. */
  async start(userId: string): Promise<void> {
    const progress: BootstrapProgress = { userId, state: "awaiting-name" };
    saveProgress(progress);
    await this.transport.send(userId, OPENING_MESSAGE);
    await this.transport.send(userId, Q1_NAME);
  }

  getProgress(userId: string): BootstrapProgress {
    return loadProgress(userId);
  }

  /**
   * Feeds one incoming message through the bootstrap state machine.
   * Returns true if the message was consumed as an onboarding answer,
   * false if it looked like a real task (per 3.7) and should be routed
   * to normal task handling instead — in which case bootstrap stays open
   * and the caller is responsible for handling the task and noting setup
   * isn't finished.
   */
  async handleMessage(userId: string, message: string): Promise<boolean> {
    const progress = loadProgress(userId);

    if (progress.state === "not-started" || progress.state === "complete") {
      return false;
    }

    if (this.isRealTask(message)) {
      await this.transport.send(
        userId,
        "I'll handle that now — heads up, we haven't finished getting to know each other yet. Want to pick that back up after?"
      );
      return false;
    }

    switch (progress.state) {
      case "awaiting-name": {
        const name = extractPreferredName(message);
        appendUserFact(userId, `Prefers to be called: ${name}`);
        progress.name = name;
        progress.state = "awaiting-style";
        saveProgress(progress);
        await this.transport.send(userId, Q2_STYLE);
        return true;
      }
      case "awaiting-style": {
        const style = message.trim();
        appendAdaptability(userId, `Communication style preference: ${style}`);
        progress.styleNote = style;
        progress.state = "complete";
        saveProgress(progress);
        const name = progress.name ?? "there";
        // Item 9 real gap fixed (user: "remove any 'please upload your goal.yaml' flow or
        // mention from onboarding entirely"): this used to make onboarding wait on the user
        // uploading a rules file before Dave would trade at all. Dave's real trading behavior
        // (prompts/trading.md) is now built in, not something the user has to hand over first.
        // It used to say "I'm already scanning the markets" unconditionally -- on a fresh install
        // with no AI key and no MT5 connected, which was simply untrue. It now says what is
        // actually left to do, and only claims to be working when nothing is.
        const gaps = this.setupGaps?.(userId) ?? [];
        await this.transport.send(
          userId,
          gaps.length === 0
            ? `Got it, ${name}. I'll keep "${style}" in mind. Send /start_trading whenever you want me hunting, or just ask me anything.`
            : `Got it, ${name}. I'll keep "${style}" in mind.\n\nBefore I can trade for you:\n${gaps.map((g) => `• ${g}`).join("\n")}`
        );
        return true;
      }
      default:
        return false;
    }
  }
}
