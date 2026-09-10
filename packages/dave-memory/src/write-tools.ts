import { appendUserFact, appendAdaptability, appendMemoryNote } from "./hermes-store.js";
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
      "Save a real, lasting fact about the user to USER.md (e.g. their trading style, account details, stated preferences). Applied immediately unless write-approval mode is on, in which case it's queued pending approval.",
    parameters: { type: "object", properties: { fact: { type: "string" } }, required: ["fact"] },
    execute: async (args, ctx) => gatedWrite(ctx.actorId, `remember_user_fact: ${args.fact as string}`, () => appendUserFact(ctx.actorId, args.fact as string)),
  },
  {
    name: "remember_note",
    description:
      "Save a real, lasting general observation to MEMORY.md (not specific to the user's identity -- a pattern noticed, a decision made, something worth recalling later). Applied immediately unless write-approval mode is on.",
    parameters: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
    execute: async (args, ctx) => gatedWrite(ctx.actorId, `remember_note: ${args.note as string}`, () => appendMemoryNote(ctx.actorId, args.note as string)),
  },
  {
    name: "remember_adaptability_note",
    description:
      "Save a real communication-style/tone preference to ADAPTABILITY.md (e.g. 'prefers short answers', 'don't ask before X'). Applied immediately unless write-approval mode is on.",
    parameters: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
    execute: async (args, ctx) => gatedWrite(ctx.actorId, `remember_adaptability_note: ${args.note as string}`, () => appendAdaptability(ctx.actorId, args.note as string)),
  },
];
