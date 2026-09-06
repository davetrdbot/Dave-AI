import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendAdaptability, appendUserFact } from "@dave/memory";

export type BootstrapState =
  | "not-started"
  | "awaiting-name"
  | "awaiting-style"
  | "awaiting-rules-ack"
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
const Q3_RULES_ACK =
  "Last thing — I won't touch a trade until you upload your rules file. Send it whenever you're ready.";

function progressPath(userId: string): string {
  return join(process.cwd(), "data", "bootstrap", `${userId}.json`);
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

export class BootstrapFlow {
  constructor(
    private readonly transport: Transport,
    private readonly isRealTask: RealTaskDetector = defaultRealTaskDetector
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
        const name = message.trim();
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
        progress.state = "awaiting-rules-ack";
        saveProgress(progress);
        await this.transport.send(userId, Q3_RULES_ACK);
        return true;
      }
      case "awaiting-rules-ack": {
        progress.state = "complete";
        saveProgress(progress);
        const name = progress.name ?? "there";
        await this.transport.send(
          userId,
          `Got it, ${name}. I'll keep "${progress.styleNote}" in mind. Talk to me normally from ` +
            `here — send your rules file whenever you're ready.`
        );
        return true;
      }
      default:
        return false;
    }
  }
}
