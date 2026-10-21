import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTerms, matchesTerms, parseNumParam, headlineOf, buildSummary, topTopics } from "../news-logic.mjs";

const it = (id, importance, text_en, published_at = "2026-10-20T12:00:00Z") =>
  ({ id, importance, text_en, published_at, source_url: `https://t.me/markettwits/${id}` });
const ITEMS = [
  it(3, "high", "❗️🇺🇦 #Ukraine #geopolitics\nZelensky: talks with Witkoff were constructive. More later.", "2026-10-20T14:00:00Z"),
  it(2, "medium", "🇺🇦 #Ukraine\nTrump:\n\nRussia would like to make a deal on Ukraine", "2026-10-20T13:00:00Z"),
  it(1, "high", "⬇️🇺🇸#CRWV = -6%\n\nCoreWeave shares are diving again", "2026-10-20T12:00:00Z"),
];

test("matching mirrors /news/search", () => {
  assert.deepEqual(parseTerms("#Oil  Fed"), ["oil", "fed"]);
  assert.ok(matchesTerms("Fed and #oil", parseTerms("oil fed")));
  assert.ok(!matchesTerms("oil only", parseTerms("oil fed")));
});
test("numeric params", () => {
  const o = { def: 24, min: 1, max: 168 };
  assert.equal(parseNumParam(undefined, o), 24);
  assert.equal(parseNumParam("500", o), 168);
  assert.equal(parseNumParam("0", o), 1);
  assert.equal(parseNumParam("abc", o), null);
  assert.equal(parseNumParam("", o), null);
});
test("headlines", () => {
  assert.equal(headlineOf(ITEMS[1].text_en), "Trump: Russia would like to make a deal on Ukraine");
  assert.equal(headlineOf(ITEMS[2].text_en), "CRWV = -6%: CoreWeave shares are diving again");
});
test("summary has 3-5 sentences, high first", () => {
  const s = buildSummary("Ukraine", ITEMS.slice(0, 2));
  assert.match(s, /^2 matching items for "Ukraine" since 2026-10-20 13:00 UTC; 1 high-importance\. Zelensky: talks/);
  const n = s.split(/(?<=[.!?])\s+(?=[A-Z0-9])/).length;
  assert.ok(n >= 3 && n <= 5, s);
  assert.equal(buildSummary("x", []), 'No recent news matched "x".');
});
test("top topics count once per item", () => {
  const t = topTopics(ITEMS);
  assert.deepEqual(t[0], { topic: "Ukraine", count: 2 });
  assert.ok(t.length <= 5);
});
