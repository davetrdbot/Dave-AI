/**
 * Step 8.2: full native rich formatting, HTML parse_mode (simpler and
 * less escaping-fragile than MarkdownV2 for programmatically-built
 * text). All tags below are real, current HTML-subset tags per the Bot
 * API docs.
 */

function escapeHtml(text: string): string {
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
