import assert from "node:assert/strict";
import { TELEGRAM_TOOLS } from "../src/tools.js";
import { markdownToTelegramHtml } from "../src/rich-format.js";

/**
 * Telegram rich messages, Bot API 10.2/10.3 (the trader: "implement the telegram rich too").
 * Media embedded in a rich message (10.2), the documented custom tags surviving the sanitizer
 * (10.3), and link-preview control as the extra.
 */

function fakeClient() {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const rec = (method: string) => (params: Record<string, unknown>) => {
    calls.push({ method, params });
    return Promise.resolve({ message_id: 1 } as unknown);
  };
  return { calls, client: { sendRichMessage: rec("sendRichMessage"), sendMessage: rec("sendMessage") } };
}
const CHAT = 999;
const tool = (n: string) => {
  const t = TELEGRAM_TOOLS.find((x) => x.name === n);
  assert.ok(t, `${n} exists`);
  return t!;
};

console.log("=== Telegram rich 10.2/10.3: media, custom tags, link preview ===\n");

(async () => {
  console.log("[1] tg_rich_message embeds media (10.2): tg://photo?id= link + a media list entry...\n");
  {
    const f = fakeClient();
    await tool("tg_rich_message").execute(
      {
        html: 'VOL_80 report:\n<a href="tg://photo?id=chart1">chart</a>\n<b>up 2.1R</b>',
        media: [{ id: "chart1", type: "photo", url: "https://example.com/chart.png", caption: "M5" }],
      },
      { client: f.client as never, chatId: CHAT }
    );
    const rm = f.calls[0].params.rich_message as { html: string; media: { id: string; media: { type: string; media: string } }[] };
    assert.match(rm.html, /tg:\/\/photo\?id=chart1/, "the html references the media by id");
    assert.equal(rm.media[0].id, "chart1", "the media list carries the same id");
    assert.equal(rm.media[0].media.type, "photo");
    assert.equal(rm.media[0].media.media, "https://example.com/chart.png", "the url is passed as the media source");
    console.log("    confirmed: inline photo by tg://photo?id=chart1 + matching media entry");
  }

  console.log("\n[2] The 10.3 custom tags survive the sanitizer (not escaped to literal text)...\n");
  const buttons = markdownToTelegramHtml('Pick one:\n<tg-button-row>A B</tg-button-row>');
  assert.match(buttons, /<tg-button-row>/, "tg-button-row must pass through");
  assert.ok(!buttons.includes("&lt;tg-button-row&gt;"), "it must NOT be escaped to literal text");
  const thinking = markdownToTelegramHtml('<tg-thinking>Reading the chart…</tg-thinking>');
  assert.match(thinking, /<tg-thinking>/, "tg-thinking must pass through");
  // sanity: an unknown/dangerous tag is still escaped
  const evil = markdownToTelegramHtml("<script>alert(1)</script>");
  assert.ok(evil.includes("&lt;script&gt;"), "an unknown tag is still escaped");
  console.log("    confirmed: tg-button-row + tg-thinking preserved; <script> still escaped");

  console.log("\n[3] send_telegram link-preview control maps to real LinkPreviewOptions...\n");
  const cases: [string, string][] = [
    ["off", "is_disabled"],
    ["large", "prefer_large_media"],
    ["small", "prefer_small_media"],
    ["above", "show_above_text"],
  ];
  for (const [choice, field] of cases) {
    const f = fakeClient();
    await tool("send_telegram").execute({ text: "see https://example.com", linkPreview: choice }, { client: f.client as never, chatId: CHAT });
    const lpo = f.calls[0].params.link_preview_options as Record<string, boolean>;
    assert.equal(lpo[field], true, `linkPreview="${choice}" must set ${field}`);
  }
  // no linkPreview -> no options object (default behaviour untouched)
  {
    const f = fakeClient();
    await tool("send_telegram").execute({ text: "hi" }, { client: f.client as never, chatId: CHAT });
    assert.equal(f.calls[0].params.link_preview_options, undefined, "omitting linkPreview leaves the default");
  }
  console.log("    confirmed: off/large/small/above map correctly; default preserved");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
  process.exit(0);
})();
