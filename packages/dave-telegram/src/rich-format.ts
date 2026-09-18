/**
 * Step 8.2: full native rich formatting, HTML parse_mode (simpler and
 * less escaping-fragile than MarkdownV2 for programmatically-built
 * text). All tags below are real, current HTML-subset tags per the Bot
 * API docs.
 */

export function escapeHtml(text: string): string {
  // Real bug fixed: the original version didn't escape double quotes.
  // link()/mention() interpolate values inside href="...", so an
  // unescaped `"` in a url/text lets it break out of the attribute --
  // e.g. fmt.link("x", 'https://evil.com" onclick="...') would have
  // produced a second, injected attribute instead of a harmless string.
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export const fmt = {
  bold: (s: string) => `<b>${escapeHtml(s)}</b>`,
  italic: (s: string) => `<i>${escapeHtml(s)}</i>`,
  underline: (s: string) => `<u>${escapeHtml(s)}</u>`,
  strikethrough: (s: string) => `<s>${escapeHtml(s)}</s>`,
  spoiler: (s: string) => `<tg-spoiler>${escapeHtml(s)}</tg-spoiler>`,
  code: (s: string) => `<code>${escapeHtml(s)}</code>`,
  pre: (s: string, language?: string) =>
    language ? `<pre><code class="language-${language}">${escapeHtml(s)}</code></pre>` : `<pre>${escapeHtml(s)}</pre>`,
  blockquote: (s: string) => `<blockquote>${escapeHtml(s)}</blockquote>`,
  expandableBlockquote: (s: string) => `<blockquote expandable>${escapeHtml(s)}</blockquote>`,
  link: (text: string, url: string) => `<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`,
  mention: (text: string, userId: number) => `<a href="tg://user?id=${userId}">${escapeHtml(text)}</a>`,
  customEmoji: (fallback: string, customEmojiId: string) => `<tg-emoji emoji-id="${escapeHtml(customEmojiId)}">${escapeHtml(fallback)}</tg-emoji>`,
  /** No native <h1>/<h2> in Telegram HTML -- headings render as bold lines, the real workaround every Bot API client uses. */
  heading: (s: string) => `<b>${escapeHtml(s)}</b>`,
  list: (items: string[], ordered = false) =>
    items.map((item, i) => (ordered ? `${i + 1}. ${escapeHtml(item)}` : `• ${escapeHtml(item)}`)).join("\n"),
};

/**
 * Telegram has no native table rendering -- the real, common workaround
 * is a monospace <pre> block with padded columns. Used for trade
 * summaries per IDENTITY.md ("tables for trade summaries").
 */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  const text = [line(headers), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
  return fmt.pre(text);
}

/**
 * Item 4 real gap fixed: the first pass only actually converted bold/tables -- everything else
 * (italic, underline, strikethrough, spoiler, blockquote/expandable blockquote, links) was never
 * verified end to end, and underline/strikethrough/spoiler/blockquote/links had NO markdown
 * detection at all, so a model writing `~~old~~`, `||secret||`, `> note`, or `[text](url)` would
 * still have leaked raw markdown syntax straight to the user -- the exact class of bug already
 * fixed for bold/tables, just not yet closed for the rest of the real HTML-subset tags rich-
 * format.ts already supports for programmatic use (fmt.*). Real markdown conventions matched:
 * `**bold**`/`__bold__`, single `*italic*`/`_italic_`, `~~strikethrough~~` (GFM), `||spoiler||`
 * (the convention Telegram's own MarkdownV2 and Discord both use), `++underline++` (there is no
 * widely-used underline markdown convention; this one is unambiguous and doesn't collide with any
 * other real syntax here), `> quote` / `>> quote` (double for expandable -- Telegram's own
 * addition, no real markdown standard covers it), and `[text](url)` links.
 *
 * Extraction order matters: fenced code blocks and markdown tables are pulled out and rendered
 * FIRST (so nothing inside them gets escaped/reformatted as if it were prose), the remaining
 * text is HTML-escaped, links are stashed next (so URL underscores/asterisks are never misread as
 * formatting), then the remaining inline patterns (bold/strike/spoiler/underline/italic/inline-
 * code/lists/headings) are applied, then the pre-rendered code/table/link blocks are spliced back
 * in, and finally blockquote lines are collapsed -- last, so bold/italic already applied INSIDE a
 * quoted line survives intact.
 */
function convertBlockquoteLines(working: string): string {
  const lines = working.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const expandablePrefix = /^&gt;&gt;[ \t]?/;
    const regularPrefix = /^&gt;[ \t]?/;
    const isExpandable = expandablePrefix.test(lines[i]);
    const isRegular = !isExpandable && regularPrefix.test(lines[i]);
    if (isExpandable || isRegular) {
      const prefix = isExpandable ? expandablePrefix : regularPrefix;
      const group: string[] = [];
      while (i < lines.length && prefix.test(lines[i])) {
        group.push(lines[i].replace(prefix, ""));
        i++;
      }
      out.push(isExpandable ? `<blockquote expandable>${group.join("\n")}</blockquote>` : `<blockquote>${group.join("\n")}</blockquote>`);
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return out.join("\n");
}

/**
 * Real bug fixed (user, live: a message literally showed "<b>every single symbol</b>" as
 * visible text instead of rendering bold). Root cause confirmed: the model itself sometimes
 * writes genuine Telegram HTML tags directly in its response text (not markdown ** syntax) --
 * IDENTITY.md's own "use rich Telegram formatting" instruction doesn't specify markdown-only
 * syntax, and the model has broad knowledge of Telegram's real Bot API HTML mode. The old
 * pipeline only ever converted MARKDOWN syntax and blindly HTML-escaped everything else
 * (correct for safety against a stray "<" or ">", but it also escaped the model's own genuine,
 * already-valid "<b>"/"<i>"/etc into "&lt;b&gt;" -- which Telegram then displays as literal
 * visible text, exactly matching the report. Fixed by recognizing the real Telegram HTML-subset
 * tag allowlist (same one Token Harbor's bug was fixed against, see command-router.ts) BEFORE
 * escaping: a genuine supported tag the model already wrote is preserved verbatim; anything
 * that merely LOOKS like a tag but isn't on the allowlist still gets safely escaped, so this
 * doesn't reopen the class of bug that broke Token Harbor's detail view.
 */
const TELEGRAM_HTML_TAG_ALLOWLIST = "b|strong|i|em|u|ins|s|strike|del|span|tg-spoiler|a|code|pre|blockquote|tg-emoji";
const REAL_TELEGRAM_TAG_PATTERN = new RegExp(`</?(?:${TELEGRAM_HTML_TAG_ALLOWLIST})(?:\\s+[a-zA-Z-]+="[^"]*")*\\s*>`, "gi");

export function markdownToTelegramHtml(text: string): string {
  const placeholders: string[] = [];
  const stash = (html: string): string => {
    const token = " PLACEHOLDER" + placeholders.length + " ";
    placeholders.push(html);
    return token;
  };

  let working = text;

  // Fenced code blocks: ```lang\ncode\n``` or ```\ncode\n```
  working = working.replace(/```(\w+)?\n([\s\S]*?)```/g, (_m, lang: string | undefined, code: string) => stash(fmt.pre(code.replace(/\n$/, ""), lang)));

  // Markdown pipe tables: a header row, a |---|---| separator row, then 1+ data rows.
  working = working.replace(
    /^\|(.+)\|\s*\n\|[\s:|-]+\|\s*\n((?:\|.*\|\s*\n?)+)/gm,
    (_m, headerLine: string, bodyLines: string) => {
      const headers = headerLine.split("|").map((c) => c.trim()).filter((c) => c.length > 0);
      const rows = bodyLines
        .trim()
        .split("\n")
        .map((line) => line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
      return stash(table(headers, rows)) + "\n";
    }
  );

  // Inline code spans: `code` -- extracted before bold/italic so markdown chars inside a code
  // span (e.g. a literal "*" in an example) are never misread as formatting.
  working = working.replace(/`([^`\n]+?)`/g, (_m, code: string) => stash(fmt.code(code)));

  // A genuine, already-valid Telegram HTML tag the model wrote directly (not markdown) -- stash
  // it verbatim so it survives the escaping pass below intact, instead of being turned into
  // visible "&lt;b&gt;" entity text. Anything NOT on the real allowlist is left alone here and
  // gets safely escaped by escapeHtml() just below, same as any other stray "<". Runs AFTER code
  // block/span extraction so a literal "<b>" written as a CODE EXAMPLE (inside backticks/fences)
  // is correctly treated as literal text, not live-rendered.
  working = working.replace(REAL_TELEGRAM_TAG_PATTERN, (tag) => stash(tag));

  // Now safe to escape the remaining plain prose.
  working = escapeHtml(working);

  // Links: [text](url) -- stashed before bold/italic/underline so a "_"/"*"/"+" inside a real
  // URL is never misread as inline formatting.
  working = working.replace(/\[([^\]\n]+)\]\((\S+?)\)/g, (_m, linkText: string, url: string) => stash(`<a href="${url}">${linkText}</a>`));

  // Bold: **text** or __text__
  working = working.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/__(.+?)__/g, "<b>$1</b>");
  // Strikethrough: ~~text~~ (GFM convention).
  working = working.replace(/~~(.+?)~~/g, "<s>$1</s>");
  // Spoiler: ||text|| (the convention Telegram's own MarkdownV2/Discord use).
  working = working.replace(/\|\|(.+?)\|\|/g, "<tg-spoiler>$1</tg-spoiler>");
  // Underline: ++text++.
  working = working.replace(/\+\+(.+?)\+\+/g, "<u>$1</u>");
  // Italic: single *text* or _text_ (after bold's ** is already consumed above).
  //
  // Real bug fixed (the trader, live, asking to check italics -- and this was mangling nearly
  // every message the bot sent). The old `_` rule was `(?<!_)_([^_\n]+?)_(?!_)`, which happily
  // matched ACROSS two unrelated snake_case words. Proven against real log text:
  //
  //   "VOL_10 shows premium_discount bias"  ->  "VOL<i>10 shows premium</i>discount bias"
  //
  // The underscores were deleted and the text between them italicised. This bot is the worst
  // possible case for that rule: every symbol it trades is snake_case (VOL_80, CRASH_200,
  // BOOM_100, STORM_500) and so is its entire analysis vocabulary (premium_discount, tape_flow,
  // spread_pips, risk_metrics, mean_reversion), so any two on one line mangled everything between
  // them.
  //
  // Fixed the way CommonMark itself handles this: `_` does NOT create emphasis intra-word. The
  // delimiters must sit against a non-word boundary, which leaves snake_case identifiers alone
  // while `_italic_` as real prose still works. Both delimiters also now refuse an adjacent
  // space, so "a * b * c" and "_ spaced _" stop being misread as emphasis.
  working = working
    .replace(/(?<!\*)\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)/g, "<i>$1</i>")
    .replace(/(^|[^A-Za-z0-9_])_(?!\s)([^_\n]+?)(?<!\s)_(?![A-Za-z0-9_])/g, "$1<i>$2</i>");
  // Headings: leading #'s -> a bold line (Telegram HTML has no native heading tag).
  working = working.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  // Bullet lists: leading "- " or "* " at line start -> a real bullet.
  working = working.replace(/^[ \t]*[-*][ \t]+(?!\*)/gm, "• ");

  // Blockquotes: `>`/`>>` at line start is only real blockquote syntax once escapeHtml has turned
  // it into `&gt;`/`&gt;&gt;`, so this runs after escaping and after the inline formatting above
  // (so bold/italic already applied inside a quoted line survives intact).
  //
  // Real bug fixed (the trader, live, asking to check quote handling): this used to run AFTER the
  // placeholder splice below, which meant it also scanned the RESTORED content of fenced code
  // blocks. A code block whose line starts with ">" -- a shell prompt, a diff, quoted output, all
  // extremely common -- had that line wrapped in <blockquote> tags that crossed the <pre>
  // boundary, producing genuinely malformed, interleaved HTML:
  //
  //   <pre>&gt; npm install\n<blockquote>done</pre></blockquote>
  //
  // Telegram rejects that outright with a 400 "can't parse entities", so the WHOLE message was
  // silently lost -- the same real failure shape already seen live in this system's own logs.
  // Running before the splice keeps code-block contents hidden behind their placeholders, where
  // no line-start rule can reach inside them.
  working = convertBlockquoteLines(working);

  // Splice the pre-rendered code/table/link blocks back in (their HTML must not be re-escaped).
  working = working.replace(/ PLACEHOLDER(\d+) /g, (_m, idx: string) => placeholders[Number(idx)]);

  return working;
}
