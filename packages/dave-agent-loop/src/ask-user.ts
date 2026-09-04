import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { AgentTool } from "./tool-registry.js";

/**
 * Update 9 (per the user's explicit "and also ask user tool"): a real
 * tool letting Dave ask the user a direct question mid-task. Calling it
 * genuinely PAUSES the agent loop -- there is no live answer to give it
 * synchronously, so faking a response here would be dishonest.
 * `AgentLoop.run()` recognizes this specific tool BY NAME (the one
 * name every agent loop reserves) and pauses immediately after
 * executing it rather than looping back to the model, returning the
 * real pending question to the caller; `AgentLoop.resume()` continues
 * once the user's real answer comes in.
 */
export const ASK_USER_TOOL_NAME = "ask_user";

export interface PendingQuestion {
  id: string;
  question: string;
  askedAt: number;
}

function pendingQuestionPath(ownerUserId: string): string {
  return join(process.cwd(), "data", "agent-loop", ownerUserId, "pending-question.json");
}

export function getPendingQuestion(ownerUserId: string): PendingQuestion | undefined {
  const path = pendingQuestionPath(ownerUserId);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8"));
}

function savePendingQuestion(ownerUserId: string, question: PendingQuestion | null): void {
  const path = pendingQuestionPath(ownerUserId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(question), "utf8");
}

export function clearPendingQuestion(ownerUserId: string): void {
  savePendingQuestion(ownerUserId, null);
}

export function createAskUserTool(ownerUserId: string): AgentTool {
  return {
    name: ASK_USER_TOOL_NAME,
    description: "Ask the user a direct question and genuinely wait for their real answer before continuing. Use this for anything you cannot safely decide yourself.",
    parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
    execute: async (args) => {
      const id = randomBytes(6).toString("hex");
      const question: PendingQuestion = { id, question: args.question as string, askedAt: Date.now() };
      savePendingQuestion(ownerUserId, question);
      return question;
    },
  };
}
