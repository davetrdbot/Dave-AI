import type { TelegramClient } from "./client.js";

/**
 * Step 9: thinking indicator with live action-type icons.
 *
 * Corrected after checking the real sendRichMessageDraft parameter
 * table (an earlier pass assumed it returns a message you then edit
 * with editMessageText -- wrong on both counts):
 *   - sendRichMessageDraft returns `true`, not a message/message_id.
 *   - Updating a draft means calling sendRichMessageDraft AGAIN with the
 *     SAME bot-chosen `draft_id` -- Telegram animates the change. There
 *     is no message to editMessageText; the draft is an ephemeral
 *     ~30-second preview, never a real persisted message.
 *   - Finalizing means calling sendMessage with parse_mode: "HTML" (not
 *     editMessageText) with the complete content -- that's the real,
 *     documented method that actually returns a real Message, persists
 *     it in the chat, AND (unlike sendRichMessage's HTML-document-style
 *     `rich_message.html` field) preserves literal "\n\n" as a real
 *     visible blank line between paragraphs instead of collapsing it.
 */

// 9.3: typed enum, not free-form -- an agent can only pick one of these.
export const ACTION_ICONS = {
  /** Anything that is literally code being run -- run_script above all (the trader: "</> anything
   *  related to scripts"). Kept as the angle-bracket marker rather than an emoji precisely because
   *  it reads as code at a glance. */
  code: "</> ",
  /** Reaching for the toolbox itself: search_tools / get_tool_catalog / a granted-tool request. */
  tools: "\u{1F9F0} ", // 🧰
  database: "\u{1F5C4}\u{FE0F} ", // 🗄️
  api: "\u{1F4E1} ", // 📡
  input: "\u{1F4E5} ", // 📥
  output: "\u{1F4E4} ", // 📤
  memory: "\u{1F9E0} ", // 🧠
  trade: "\u{1F4B9} ", // 💹
  worker: "\u{1F465} ", // 👥
  /** A background watch/check being armed or read -- work that outlives this turn. */
  watch: "\u{1F441}\u{FE0F} ", // 👁️
} as const;

export type ActionType = keyof typeof ACTION_ICONS;

export function iconize(action: ActionType, text: string): string {
  return `${ACTION_ICONS[action]}${text}`;
}

// Telegram's real, confirmed limit: 4096 UTF-16 code units per text/rich message. A safety
// margin (not the exact 4096) avoids off-by-one edge cases around multi-byte characters.
const TELEGRAM_MESSAGE_LIMIT = 4000;

/** Splits on paragraph/line boundaries where possible so an HTML tag is far less likely to be
 * cut in half than a naive char-count split would risk. Always returns at least one chunk
 * (an empty string still produces one empty chunk, matching a single sendMessage call). */
export function chunkForTelegram(text: string, limit = TELEGRAM_MESSAGE_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf("\n\n", limit);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt <= 0) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

/**
 * U+2060 WORD JOINER. The one character that makes the invisible-thinking technique work: it is
 * genuinely zero-width, yet Telegram's non-empty-text validation accepts it, so a draft can carry
 * "no visible text" without being rejected as empty.
 *
 * Live-tested by the trader, and the results are worth keeping written down because they are not
 * guessable: U+2060 and U+034F pass this check ALONE. U+200B, U+200C, U+200D and U+FEFF are
 * REJECTED alone -- they only work when combined with a U+2060. So U+2060 is the safe primitive
 * and the only one used here.
 */
export const WORD_JOINER = "⁠";

/** Three joiners, matching the payload shape that was live-confirmed working. */
export const INVISIBLE_PREFIX = WORD_JOINER.repeat(3);

/**
 * The real invisible-thinking draft payload (trader, live-tested end to end).
 *
 * Two ingredients, and it only works with both:
 *   1. The leading invisible prefix, so the draft renders with no visible body text -- without it
 *      you get a half-written message sitting in the chat instead of an indicator.
 *   2. The <tg-thinking> wrapper, which is what actually produces the collapsible
 *      "💭 Thinking" indicator. Its text may not be empty.
 *
 * This is the payload the OLD code got wrong: it sent `{ html: rendered }` -- visible text, no
 * thinking tag -- which is why the indicator "wasn't visibly happening" and a real-message
 * fallback got bolted on beside it. Sending the correct payload is the actual fix; see the
 * `fallbackMessage` note on ThinkingIndicator for why that fallback is now off by default.
 *
 * Markdown (not html) mode, matching what was confirmed live. `escapeThinkingText` keeps a stray
 * "<" in a tool name from closing the tag early.
 */
export function buildThinkingDraft(text: string): { markdown: string } {
  const body = escapeThinkingText(text).trim();
  return { markdown: `${INVISIBLE_PREFIX}\n<tg-thinking>${body.length > 0 ? body : "Working"}</tg-thinking>` };
}

/** Minimal, deliberate: only the two characters that could break out of the tag. Emoji, slashes
 *  and the "</> " code marker all pass through untouched, which is the point -- they're content. */
export function escapeThinkingText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

/**
 * What finalize() sends. Both forms of the same answer:
 *   - `html`: already run through markdownToTelegramHtml, for sendMessage's parse_mode HTML.
 *   - `markdown`: the model's ORIGINAL text, untouched, for sendRichMessage's markdown field.
 *
 * Both are needed because the two transports want opposite things, and converting one into the
 * other at send time is not possible without losing information. A caller with only the converted
 * text can still pass a bare string and get the proven HTML path.
 */
export interface FinalMessage {
  html: string;
  markdown?: string;
}

/** Off-switch for the rich finalize path, should Telegram's markdown renderer ever regress. */
export const RICH_FINALIZE_DISABLED = process.env.DAVE_DISABLE_RICH_FINALIZE === "1";

/**
 * A literal Telegram HTML tag the MODEL wrote itself, rather than markdown. This is a real,
 * previously-observed behaviour (rich-format.ts exists partly to handle it: the model knows
 * Telegram's HTML mode and sometimes writes "<b>" directly). Such text is correct for the HTML
 * transport and WRONG for the markdown one, where the tag would render as visible literal text --
 * reintroducing the exact "raw <b> visible in the chat" bug that was already fixed once.
 */
const MODEL_WROTE_HTML_TAG = /<\/?(?:b|strong|i|em|u|ins|s|strike|del|span|tg-spoiler|a|code|pre|blockquote|tg-emoji)(?:\s[^>]*)?>/i;

/**
 * Whether this answer should go out as a rich markdown message rather than chunked HTML.
 *
 * Deliberately not "always": for a two-line reply the two paths render identically, so there is
 * nothing to gain and a proven path to lose. The rich path is taken when it genuinely buys
 * something -- the answer is too long for one ordinary message (otherwise it gets chopped into
 * several), or it contains structure that Telegram renders natively and sendMessage can only
 * imitate with a padded <pre> block.
 */
export function shouldFinalizeAsRichMarkdown(message: FinalMessage): boolean {
  const md = message.markdown;
  if (RICH_FINALIZE_DISABLED || !md || md.trim().length === 0) return false;
  if (MODEL_WROTE_HTML_TAG.test(md)) return false;
  // Too long for one plain message -- one rich message beats three chunked ones.
  if (md.length > TELEGRAM_MESSAGE_LIMIT) return true;
  // A markdown table: "| a | b |" over a "|---|---|" separator row.
  if (/^\|.*\|\s*\n\|[\s:|-]+\|\s*$/m.test(md)) return true;
  // A real heading line.
  if (/^#{1,6}\s+\S/m.test(md)) return true;
  return false;
}

let draftIdCounter = 1;
/** draft_id must be a non-zero integer the bot chooses -- unique per indicator instance so concurrent tasks don't animate over each other's drafts. */
function nextDraftId(): number {
  return draftIdCounter++;
}

/**
 * 9.1: automatic typing/uploading chat action on every message -- zero
 * AI decision in whether to show it. Infrastructure the message handler
 * always runs, never something the agent loop chooses to call or skip.
 */
export class ThinkingIndicator {
  private readonly draftId = nextDraftId();
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private readonly updates: { action: ActionType; text: string }[] = [];
  // Real bug fixed (the trader, live: "the thinking message like the tool calling indicator
  // sending two times, but sometimes it later delete it's self tho like normal").
  //
  // Root cause, and it was self-inflicted. An earlier pass concluded the draft indicator "isn't
  // visibly happening" and added a belt-and-suspenders fallback beside it: a REAL, persisted
  // sendMessage, edited in place as updates arrived, deleted again at finalize(). So every turn
  // produced TWO visible things -- the ephemeral draft AND a real progress message -- which is
  // exactly the reported duplicate. The "sometimes it deletes itself" half is the same bug seen
  // from the other side: the real one is deleted by finalize(), the draft just fades after ~30s,
  // so which one appears to vanish depends on which the client rendered.
  //
  // The draft was never broken. It was being sent WRONG: `{ html: rendered }` -- visible text and
  // no <tg-thinking> tag -- so it rendered as a stray half-message rather than an indicator. With
  // buildThinkingDraft() sending the live-confirmed payload instead, the draft does its job and
  // the fallback is pure duplication.
  //
  // Kept, but OFF unless DAVE_THINKING_FALLBACK_MESSAGE=1. The code is real and proven (two
  // genuine races were fixed in it, documented below) and drafts are a new-ish API surface, so
  // this stays as a switch rather than being deleted. Graceful degradation with it off is honest:
  // start()'s sendChatAction heartbeat still shows "Dave is typing…" the whole time, which is the
  // decades-stable mechanism and needs no client support at all.
  private readonly fallbackMessage: boolean;
  private progressMessageId: number | undefined;
  private lastEditAt = 0;
  private static readonly EDIT_THROTTLE_MS = 1200;
  // Real race fixed (user, live: "Dave: 💹 get_trade_history 📡 get_live_state" appeared as two
  // separate messages instead of one message editing in place). Every real caller invokes
  // `update()` fire-and-forget (`void indicator.update(...)`, once per tool-call step) -- so when
  // two tool calls finish close together, a second `update()` could enter
  // `updateGuaranteedProgressMessage()` before the first call's `sendMessage` had resolved and set
  // `progressMessageId`. Both saw it as `undefined` (a non-atomic check-then-set), so both sent a
  // brand-new message. Fixed by synchronously claiming this slot with an in-flight promise BEFORE
  // the first `await` -- a concurrent call sees the slot already claimed and awaits the SAME
  // promise instead of racing the `undefined` check.
  private sendingFirstMessage: Promise<void> | undefined;
  // Real race fixed, narrower window than the one above: `sendingFirstMessage` only gets set
  // partway through `update()` (after its own `await sendRichMessageDraft(...)` has already
  // resolved). Since every real caller invokes `update()` fire-and-forget and never awaits it,
  // `finalize()` can genuinely run while an `update()` call hasn't even reached that point yet --
  // `sendingFirstMessage` would still read `undefined`, finalize() would see no progress message
  // to delete, and the still-in-flight update() would go on to create one moments later with
  // nothing left to ever clean it up. Every `update()` call registers its own whole-call promise
  // here synchronously (before any `await` inside it can run), and removes itself when done;
  // `finalize()` awaits every promise still in this set before deciding whether there's a real
  // progress message to delete, closing the window completely.
  private readonly pendingUpdates = new Set<Promise<void>>();

  constructor(
    private readonly client: TelegramClient,
    private readonly chatId: number,
    private readonly chatAction: "typing" | "upload_document" | "upload_photo" = "typing",
    options: { fallbackMessage?: boolean; replyToMessageId?: number } = {}
  ) {
    this.fallbackMessage = options.fallbackMessage ?? process.env.DAVE_THINKING_FALLBACK_MESSAGE === "1";
    this.replyToMessageId = options.replyToMessageId;
  }

  /**
   * The message this turn is answering (the trader: "add message tag so it can actually tag
   * messages... like you know, respond to that same message"). finalize() attaches it as a real
   * `reply_parameters` so the answer is visibly tied to the question it answers -- which matters
   * most in exactly the case that prompted it: several messages sent in a row, where an untethered
   * reply is genuinely ambiguous about which one it belongs to.
   */
  private readonly replyToMessageId: number | undefined;

  getUpdates(): readonly { action: ActionType; text: string }[] {
    return this.updates;
  }

  /**
   * Best-effort: a failed "typing..." indicator (e.g. a transient
   * Telegram error) must never block the actual task from running, so
   * failures here are swallowed rather than thrown.
   *
   * Real latency fix (the trader: "responses are slow"): this used to `await` the very first
   * sendChatAction, so EVERY turn -- including a plain "hey" -- paid a full Telegram API round
   * trip before runAgentTurn was allowed to start building the request, let alone call the model.
   * That await bought nothing: the call is already `.catch(() => {})`-swallowed (its result is
   * never read and it can never reject), the 4s heartbeat below re-sends the same action anyway,
   * and every other sendChatAction in this class is already fire-and-forget for exactly this
   * reason. Kicked off without blocking, so the typing bubble and the real work start together
   * instead of one after the other.
   */
  async start(): Promise<void> {
    void this.client.sendChatAction({ chat_id: this.chatId, action: this.chatAction }).catch(() => {});
    this.heartbeat = setInterval(() => {
      void this.client.sendChatAction({ chat_id: this.chatId, action: this.chatAction }).catch(() => {});
    }, 4000);
  }

  /**
   * 9.2/9.3: the tool the agent calls to update the visible thinking
   * text live, icon-prefixed by typed action. Every call reuses the same
   * draft_id so Telegram animates the change on the same ephemeral
   * draft, per the real sendRichMessageDraft contract.
   *
   * Item 13 real bug fixed (user: "the bot starts showing 'typing,' but then stalls or times
   * out right before actually sending"): every real caller invokes this as `void
   * indicator.update(...)` -- fire-and-forget, since a mid-task draft update must never block
   * the real work. But this method had NO error handling at all: a genuine transient failure
   * (a real Telegram rate limit, a draft that already expired, a network blip) threw INSIDE a
   * promise nobody was awaiting or catching -- a real unhandled promise rejection, which
   * Node's default behavior (unhandledRejection -> throw) turns into an uncaught exception that
   * CRASHES THE WHOLE PROCESS. That exactly matches the reported symptom: typing shows (from
   * start()), then the process dies mid-task on the next draft update, so finalize() never runs
   * and nothing further is ever sent -- not a hang, a real crash. Best-effort now, matching the
   * same swallow-and-continue pattern start() already uses: a failed draft update is cosmetic
   * and must never take down the real task.
   */
  update(action: ActionType, text: string): Promise<void> {
    const rendered = iconize(action, text);
    this.updates.push({ action, text });
    // Registered synchronously, before any `await` runs -- see the class-level comment on
    // `pendingUpdates` for why this has to happen here rather than inside the async body below.
    const task = this.doUpdate(rendered);
    this.pendingUpdates.add(task);
    void task.finally(() => this.pendingUpdates.delete(task));
    return task;
  }

  private async doUpdate(rendered: string): Promise<void> {
    // The same draft_id on every call is what makes this animate in place instead of stacking new
    // drafts -- that, plus buildThinkingDraft's invisible prefix and <tg-thinking> wrapper, is the
    // whole technique.
    await this.client
      .sendRichMessageDraft({
        chat_id: this.chatId,
        draft_id: this.draftId,
        rich_message: buildThinkingDraft(rendered),
      })
      .catch(() => {});
    if (this.fallbackMessage) await this.updateGuaranteedProgressMessage(rendered);
  }

  /** The guaranteed-visible fallback -- see the class-level comment. Best-effort: a failure here
   *  must never block the real task, same as the draft call above. */
  private async updateGuaranteedProgressMessage(rendered: string): Promise<void> {
    if (this.progressMessageId === undefined) {
      if (this.sendingFirstMessage === undefined) {
        // Synchronously claim the slot -- everything up to and including this assignment runs
        // with no `await` in between, so a concurrent call arriving on the same microtask sees
        // `sendingFirstMessage` already set and takes the branch below instead of racing in here.
        this.sendingFirstMessage = (async () => {
          try {
            const sent = await this.client.sendMessage({ chat_id: this.chatId, text: rendered });
            this.progressMessageId = sent.message_id;
            this.lastEditAt = Date.now();
          } catch {
            // best-effort -- the chat action + draft above are still live even if this fails
          }
        })();
      }
      // Either we just started the first send above, or another concurrent call already did --
      // either way, wait for that SAME in-flight send rather than starting a second one.
      await this.sendingFirstMessage;
      return;
    }
    const now = Date.now();
    if (now - this.lastEditAt < ThinkingIndicator.EDIT_THROTTLE_MS) return; // throttled -- avoid a real Telegram edit rate limit on rapid tool calls
    this.lastEditAt = now;
    await this.client.editMessageText({ chat_id: this.chatId, message_id: this.progressMessageId, text: rendered }).catch(() => {});
  }

  /**
   * 9.4: finalizes cleanly into a real, persisted message -- via
   * editMessageText was never right (the draft was never a real message
   * to edit).
   *
   * Real bug fixed (root cause of the live "Dave's messages are one jam-packed
   * wall of text" report): this used to finalize via sendRichMessage's
   * `rich_message.html` field. That field is genuine HTML *document* content --
   * a real HTML renderer collapses runs of whitespace, including "\n\n", into a
   * single space (that's ordinary HTML semantics: you need a literal `<br>` or a
   * block element for a visible break). So even though markdownToTelegramHtml()
   * upstream correctly preserved every blank line between paragraphs, and
   * IDENTITY.md correctly told the model to write them, this specific send path
   * threw every paragraph break away at the transport layer, on every single
   * ordinary reply (this is the finalize() call every runAgentTurn/tg_finalize
   * response goes through) -- a prompt-level fix could never have reached this.
   * Telegram's real, documented Bot API has no HTML-document rendering mode at
   * all; its ONLY real HTML support is sendMessage's `parse_mode: "HTML"`, whose
   * small allowlisted-tag parser treats the text as literal text outside of
   * those tags -- "\n" is passed straight through as a real line break, so
   * "\n\n" renders as an actual blank line, exactly like every other real send
   * path in this codebase (push-tools.ts, worker-loop.ts, the autonomous-cycle
   * sends and send_telegram in tools.ts) that already uses it successfully.
   * Switched to that same real, proven mechanism instead.
   *
   * Real bug fixed: Telegram's real, hard 4096-character-per-message limit
   * was never respected here -- a genuinely long final answer (a full trade
   * journal recap, a detailed reasoning explanation) would have made this
   * call fail outright with a real Telegram 400 ("message is too long"),
   * not just "arrive as one giant message." Chunked, sent as multiple real
   * sequential messages instead -- as close to "streams progressively" as
   * this architecture (which gets a complete, non-streamed answer back
   * from the provider) can honestly get without providers streaming
   * partial completions themselves.
   *
   * Reopened and resolved properly (the trader, after live-testing the real finalize step):
   * everything above is about `rich_message.HTML`, and stays true of that field. But the
   * conclusion drawn from it -- "finalize can never use sendRichMessage" -- was too broad.
   * `rich_message.MARKDOWN` is a different field with a different parser, one where a blank line
   * IS a paragraph break by definition rather than collapsible document whitespace. The trader's
   * own live-confirmed finalize payload uses exactly that field and renders headings and tables
   * correctly, which is only possible if markdown block semantics are genuinely being applied.
   *
   * So finalize now prefers sendRichMessage + markdown, which buys three real things the chunked
   * sendMessage path cannot:
   *   1. ~32k characters instead of 4096, so a long answer arrives as ONE message rather than
   *      being chopped into three -- the chunking was always a workaround, never desirable.
   *   2. Real tables, headings and spoilers rendered natively instead of the <pre> padded-column
   *      imitation rich-format.ts has to fake for sendMessage.
   *   3. It replaces the in-flight draft, per the live-tested flow -- so the thinking indicator
   *      is dismissed by the answer itself rather than left to expire on its own clock.
   *
   * Two real guards, because this is the single highest-traffic path in the product:
   *   - If the model wrote literal Telegram HTML tags (a real, previously-observed behaviour --
   *     see rich-format.ts's allowlist), markdown mode would show them as visible text. That
   *     content takes the proven HTML path instead.
   *   - Any failure from sendRichMessage falls back to the chunked sendMessage path, so a
   *     rejected rich payload can never cost the user their answer.
   */
  async finalize(final: string | FinalMessage): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    // Same race, different window: a fire-and-forget update() can still be mid-flight (its
    // sendMessage not yet resolved) when finalize() runs, since real callers never await
    // update() before returning. Without waiting here, finalize() would see progressMessageId
    // still undefined, skip the delete, and the in-flight send would set it moments later --
    // orphaning that message forever with nothing left to clean it up. Waiting on every
    // still-outstanding update() call (registered synchronously in `pendingUpdates`, so this
    // catches the call even if it hasn't reached `sendingFirstMessage` yet) closes that window.
    if (this.pendingUpdates.size > 0) await Promise.all(this.pendingUpdates);
    if (this.progressMessageId !== undefined) {
      await this.client.deleteMessage({ chat_id: this.chatId, message_id: this.progressMessageId }).catch(() => {});
      this.progressMessageId = undefined;
    }
    const message: FinalMessage = typeof final === "string" ? { html: final } : final;

    if (shouldFinalizeAsRichMarkdown(message)) {
      try {
        await this.client.sendRichMessage({
          chat_id: this.chatId,
          rich_message: { markdown: message.markdown as string },
          reply_parameters: this.replyToMessageId !== undefined ? { message_id: this.replyToMessageId, allow_sending_without_reply: true } : undefined,
        });
        return;
      } catch (err) {
        // Never let a rejected rich payload cost the user their answer -- fall through to the
        // chunked HTML path below, which has been the proven one for this bot's whole life.
        console.warn(`[thinking-indicator] rich finalize failed, falling back to chunked sendMessage: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await this.finalizeAsChunkedHtml(message.html);
  }

  /** The proven path: HTML parse_mode, chunked under Telegram's real 4096 limit. */
  private async finalizeAsChunkedHtml(html: string): Promise<void> {
    const chunks = chunkForTelegram(html);
    for (const [i, chunk] of chunks.entries()) {
      await this.client.sendMessage({
        chat_id: this.chatId,
        text: chunk,
        parse_mode: "HTML",
        // First chunk only. Tagging every chunk of a long answer would quote the same question
        // three times over, which reads as a glitch rather than as an answer to it.
        reply_parameters:
          i === 0 && this.replyToMessageId !== undefined
            ? { message_id: this.replyToMessageId, allow_sending_without_reply: true }
            : undefined,
      });
    }
  }

  /**
   * Real gap fixed: the counterpart to `finalize()` for the failure path -- see the
   * `withThinkingIndicator` catch block's comment for the real bug this closes (a permanently
   * orphaned progress message read by the trader as a live "still thinking" contradiction when it
   * was really just a stale leftover from before a hard provider failure). Deletes the same real
   * guaranteed-visible progress message `finalize()` would have deleted, after waiting on any
   * still-in-flight `update()` calls the same way `finalize()` does -- but sends no final text,
   * since the caller is about to send its own real error message instead.
   */
  async cleanupOnFailure(): Promise<void> {
    if (this.pendingUpdates.size > 0) await Promise.all([...this.pendingUpdates].map((p) => p.catch(() => {})));
    if (this.progressMessageId !== undefined) {
      await this.client.deleteMessage({ chat_id: this.chatId, message_id: this.progressMessageId }).catch(() => {});
      this.progressMessageId = undefined;
    }
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
  }
}

/**
 * The wrapper every message handler actually calls -- this is what
 * makes 9.1 "zero AI decision": the caller doesn't ask whether to show
 * the indicator, it's always shown for the duration of `task`.
 */
export async function withThinkingIndicator<T>(
  client: TelegramClient,
  chatId: number,
  // `finalText: null` means the turn already delivered its answer itself (a message tool was its
  // last act): the progress message is cleaned up and nothing further is sent.
  task: (indicator: ThinkingIndicator) => Promise<{ result: T; finalText: string | FinalMessage | null }>,
  options: { replyToMessageId?: number; fallbackMessage?: boolean } = {}
): Promise<T> {
  const indicator = new ThinkingIndicator(client, chatId, "typing", {
    replyToMessageId: options.replyToMessageId,
    fallbackMessage: options.fallbackMessage,
  });
  await indicator.start();
  try {
    const { result, finalText } = await task(indicator);
    if (finalText === null) await indicator.cleanupOnFailure();
    else await indicator.finalize(finalText);
    return result;
  } catch (err) {
    // Real bug fixed (trader, live: saw "⚠️ All configured providers failed: upstage (request
    // failed)" as a genuine new message while the bot STILL visibly showed its last "💹 checking
    // what's open"-style progress message, looking exactly like a live contradiction -- bot
    // "failed" and "still working" at once. It wasn't a race: when `task(indicator)` throws (a
    // hard provider failure deep in the agent loop, well after `indicator.update()` had already
    // sent/edited a real, persisted progress message), that exception skipped straight past
    // `indicator.finalize()` above -- the only place that ever deletes the progress message. The
    // `finally` below only ever stopped the heartbeat interval, never touched the progress
    // message, so it was silently orphaned in the chat forever: a real, permanently stale leftover
    // from BEFORE the failure, not a live "still thinking" state. The trader was reading a corpse.
    // Cleaned up here, on every hard failure, before the error message is sent by the caller.
    await indicator.cleanupOnFailure();
    throw err;
  } finally {
    indicator.stop();
  }
}
