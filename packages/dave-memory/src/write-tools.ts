import { appendUserFact, appendAdaptability, appendMemoryNote, applyMemoryOperations, readMemoryEntries, FROZEN_PAIR_CHAR_BUDGET, type MemoryOperation } from "./hermes-store.js";
import { gatedWrite } from "./write-approval.js";

/**
 * Item 11 real gap fixed: `appendUserFact`/`appendAdaptability`/`appendMemoryNote` were real
 * writer functions, but the ONLY caller anywhere in the codebase was `dave-core/src/bootstrap.ts`'s
 * one-time onboarding flow -- there was no agent-callable tool letting Dave write new memory
 * content during normal conversation. `check_write_approval`/`toggle_write_approval`/
 * `approve_pending_write` (extra-tools.ts) only ever managed the write-approval SETTING and the
 * pending-writes QUEUE -- none of them perform an actual write. These three tools are the real
 * writers, routed through the existing `gatedWrite` primitive so the write-approval setting
 * (on/off) is honored exactly the same way it already is for onboarding writes.
 */
export interface MemoryWriteToolContext {
  actorId: string;
}

export interface MemoryWriteToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: MemoryWriteToolContext) => Promise<unknown>;
}

export const MEMORY_WRITE_TOOLS: MemoryWriteToolDefinition[] = [
  {
    name: "remember_user_fact",
    description:
      "Save a real, lasting fact about the user to memory (e.g. their trading style, account details, stated preferences, a standing instruction). Use this for things about the PERSON -- durable lessons about markets or your own trading belong in knowledge instead (knowledge_draft + knowledge_save), which is unbounded, whereas memory is deliberately small and budgeted. Applied immediately unless write-approval mode is on, in which case it's queued pending approval.",
    parameters: { type: "object", properties: { fact: { type: "string" } }, required: ["fact"] },
    execute: async (args, ctx) => gatedWrite(ctx.actorId, `remember_user_fact: ${args.fact as string}`, () => appendUserFact(ctx.actorId, args.fact as string)),
  },
  {
    name: "remember_note",
    description:
      "Save a real, lasting general observation to memory (not specific to the user's identity -- a decision made, something worth recalling later). Memory is small and budgeted, and is loaded into every turn automatically; a durable trading lesson you'd want to apply to future setups belongs in knowledge instead. Applied immediately unless write-approval mode is on.",
    parameters: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
    execute: async (args, ctx) => gatedWrite(ctx.actorId, `remember_note: ${args.note as string}`, () => appendMemoryNote(ctx.actorId, args.note as string)),
  },
  {
    name: "remember_adaptability_note",
    description:
      "Save a real communication-style/tone preference to memory (e.g. 'prefers short answers', 'don't ask before X', 'don't message before 8am'). Applied immediately unless write-approval mode is on.",
    parameters: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
    execute: async (args, ctx) => gatedWrite(ctx.actorId, `remember_adaptability_note: ${args.note as string}`, () => appendAdaptability(ctx.actorId, args.note as string)),
  },
  {
    name: "edit_memory",
    description:
      "Edit memory as ONE atomic batch -- add, replace and remove entries together. Use this the moment memory is full: the size limit is checked only on the FINAL result, so a single call can remove or shorten stale entries AND add the new one, even when the add alone would not fit. " +
      "The three remember_* tools are the shortcut for a single easy addition; this is what you reach for when something has to give. " +
      "There is no read action and you do not need one -- your memory is already in front of you every turn, and if a call is rejected the entries actually stored come back with the error so you can correct it immediately, in the same turn. " +
      "Order matters: removes and replaces listed before an add free up room for it. " +
      "Memory is for facts true in EVERY session (who the user is, standing instructions, stable account facts). A durable lesson about markets or your own trading belongs in knowledge (knowledge_draft + knowledge_save), which is unbounded.",
    parameters: {
      type: "object",
      required: ["operations"],
      properties: {
        operations: {
          type: "array",
          description: "Applied in order, all-or-nothing. Nothing is written unless every operation succeeds and the end result fits the budget.",
          items: {
            type: "object",
            required: ["action", "target"],
            properties: {
              action: { type: "string", enum: ["add", "replace", "remove"] },
              target: { type: "string", enum: ["memory", "user"], description: "'user' = who the trader is and what they want. 'memory' = your own notes and standing facts." },
              content: { type: "string", description: "Required for add and replace. For a replace this is the COMPLETE new entry -- the whole matched entry is overwritten, so include everything worth keeping." },
              oldText: { type: "string", description: "Required for replace and remove: a short unique substring that IDENTIFIES the entry. It locates the entry; it is not cut out of it." },
            },
          },
        },
      },
    },
    execute: async (args, ctx) => {
      const operations = args.operations as MemoryOperation[];
      return gatedWrite(ctx.actorId, `edit_memory: ${operations.length} operation(s)`, () => applyMemoryOperations(ctx.actorId, operations));
    },
  },
  {
    name: "inspect_memory",
    description:
      "See your stored memory entries verbatim, with exact usage against the budget. You normally do NOT need this -- memory is injected into every turn already -- but it is the reliable way to get the exact substring for an edit_memory replace or remove when the injected copy has been summarised or you are unsure of the precise wording.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => {
      const memory = readMemoryEntries(ctx.actorId, "memory");
      const user = readMemoryEntries(ctx.actorId, "user");
      const chars = memory.join("").length + user.join("").length;
      return { memory, user, chars, budget: FROZEN_PAIR_CHAR_BUDGET, usagePercent: Math.round((chars / FROZEN_PAIR_CHAR_BUDGET) * 100) };
    },
  },
];
