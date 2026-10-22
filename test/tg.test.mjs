// Telegram t.me/s parser on a REAL saved page (test/fixtures/tg-markettwits*.html, svg/script stripped).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { normalizeChannel, parseChannelList, parseViews, htmlToText, parseTgPage, channelLatest, channelSearch } from "../tg.mjs";
import { setUpstreamForTests, clearDataCache, NotFoundError, UpstreamError } from "../upstream.mjs";

const page = (n) => fs.readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");

test("channel names", () => {
  for (const [raw, want] of [["markettwits", "markettwits"], ["@MarketTwits", "markettwits"], ["https://t.me/s/markettwits", "markettwits"], ["t.me/rbc_news/", "rbc_news"]]) assert.equal(normalizeChannel(raw), want, raw);
  for (const bad of ["ab", "1abc", "bad-name", "a_b_", "x".repeat(33), "a__b5", "", undefined]) assert.equal(normalizeChannel(bad), null, String(bad));
  assert.deepEqual(parseChannelList("markettwits, @rbc_news,markettwits"), ["markettwits", "rbc_news"]);
  for (const bad of ["", "a,b", "aaaaa,bbbbb,ccccc,ddddd,eeeee,fffff", "markettwits,bad-name"]) assert.equal(parseChannelList(bad), null, bad);
});

test("views + html to text", () => {
  assert.equal(parseViews("39K"), 39000);
  assert.equal(parseViews("1.2M"), 1200000);
  assert.equal(parseViews("523"), 523);
  assert.equal(parseViews("n/a"), null);
  assert.equal(htmlToText('<i class="emoji"><b>⚠️</b></i><a href="?q=%23META">#META</a> A &amp; B<br/>C&nbsp;D &#8212; E'), "⚠️#META A & B\nC D — E");
});

test("parseTgPage on the real markettwits page", () => {
  const p = parseTgPage(page("tg-markettwits.html"), "markettwits");
  assert.equal(p.title, "MarketTwits");
  assert.equal(p.subscribers, 339000);
  assert.equal(p.messages.length, 20);
  assert.equal(p.before, 389926);
  const m = p.messages.find((x) => x.id === 389929);
  assert.equal(m.date, "2026-10-21T19:19:52+00:00");
  assert.equal(m.views, 39000);
  assert.equal(m.link, "https://t.me/markettwits/389929");
  assert.equal(m.edited, true);
  assert.match(m.text, /^⚠️🇺🇸#META #spo #ии\nMeta \(признана в РФ экстремистской и запрещена\)/);
  assert.ok(!/<|&amp;/.test(m.text));
  assert.ok(p.messages.some((x) => x.media.includes("photo")));
  assert.ok(p.messages.every((x, i) => i === 0 || x.id > p.messages[i - 1].id), "page is oldest -> newest");
  const q = parseTgPage(page("tg-markettwits-q.html"), "markettwits");
  assert.equal(q.messages.length, 20);
  assert.ok(q.messages.every((x) => /нефт/i.test(x.text)), "search page = matches for 'нефть'");
});

test("channelLatest / channelSearch with a stubbed t.me (404, pagination, partial failure)", async () => {
  clearDataCache();
  const html = page("tg-markettwits.html");
  const calls = [];
  setUpstreamForTests({ proxy: { configured: false }, fetchImpl: async (url, opts) => {
    calls.push(url);
    if (/nonexistent/.test(url)) return new Response(null, { status: 302, headers: { location: "https://t.me/nonexistent" } });
    if (/broken/.test(url)) return new Response("oops", { status: 503 });
    assert.equal(opts.redirect, "manual");
    return new Response(/before=/.test(url) ? "<html>tgme_channel_info</html>" : html, { status: 200 });
  } });
  const r = await channelLatest("markettwits", { limit: 25 });
  assert.equal(r.count, 20, "second page empty -> stop");
  assert.equal(r.items[0].id, Math.max(...r.items.map((x) => x.id)));
  assert.ok(calls.some((u) => /before=389926/.test(u)));
  await assert.rejects(channelLatest("nonexistent_chan"), NotFoundError);
  await assert.rejects(channelLatest("broken_chan"), UpstreamError);
  const s = await channelSearch("нефть", ["markettwits", "nonexistent_chan", "broken_chan"], { limit: 5 });
  assert.equal(s.count, 5);
  assert.deepEqual(s.per_channel.map((x) => x.error ?? "ok"), ["ok", "not_found", "upstream_unavailable"]);
  await assert.rejects(channelSearch("x", ["nonexistent_chan"]), NotFoundError);
  await assert.rejects(channelSearch("x", ["broken_chan", "nonexistent_chan"]), UpstreamError);
  clearDataCache();
});
