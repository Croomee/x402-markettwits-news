import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTerms, matchesTerms, parseNumParam, headlineOf, buildSummary, topTopics, trendingTopics, recentSummary, alertsNew, trending } from "../news-logic.mjs";

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

const NOW = Date.parse("2026-10-20T15:00:00Z");
test("recentSummary windows by hours", () => {
  const r = recentSummary(ITEMS, "Ukraine", 2, NOW);
  assert.equal(r.count, 2); assert.equal(r.high_count, 1); assert.equal(r.since, "2026-10-20T13:00:00Z");
  assert.deepEqual(Object.keys(r.items[0]), ["id", "published_at", "importance", "source_url"]);
  const e = recentSummary(ITEMS, "Ukraine", 1, NOW + 2 * 3600e3);
  assert.equal(e.count, 0); assert.equal(e.summary, 'No news matched "Ukraine" in the last 1 hours.');
});
test("alertsNew only counts HIGH items", () => {
  const a = alertsNew(ITEMS, "#ukraine", 6, NOW);
  assert.equal(a.has_new, true); assert.equal(a.count, 1); assert.equal(a.latest.id, 3);
  const b = alertsNew(ITEMS, "Russia", 6, NOW); // only a medium item mentions Russia
  assert.equal(b.has_new, false); assert.equal(b.latest, null);
});
test("trending: change vs previous window, latest_id, fallback", () => {
  const t = trendingTopics([ITEMS[0]], [ITEMS[2]]);
  const u = t.find((x) => x.topic === "Ukraine");
  assert.deepEqual(u, { topic: "Ukraine", count: 1, prev_count: 0, change: 1, latest_id: 3, latest_source_url: "https://t.me/markettwits/3" });
  const w = trending(ITEMS, 2, NOW); // high items: id 3 (now window 13-15h), id 1 (prev window 11-13h)
  assert.equal(w.fallback, false); assert.equal(w.items_considered, 1);
  const f = trending(ITEMS, 1, Date.parse("2026-10-21T15:00:00Z"));
  assert.equal(f.fallback, true); assert.equal(f.items_considered, 2); assert.match(f.note, /last 2 high-importance/);
  assert.deepEqual(topTopics([ITEMS[0]]).map((x) => x.topic), t.map((x) => x.topic)); // same ranking as top-topics
});

import { parseProductUrl, parseWbCard, productFromJsonLd, wbBasketHost } from "../product.mjs";
test("product url validation", () => {
  assert.deepEqual(parseProductUrl("https://www.wildberries.ru/catalog/211695539/detail.aspx?size=1"),
    { source: "wildberries", product_id: "211695539", url: "https://www.wildberries.ru/catalog/211695539/detail.aspx" });
  assert.equal(parseProductUrl("https://wb.ru/catalog/123/").product_id, "123");
  assert.equal(parseProductUrl("https://global.wildberries.ru/catalog/55/detail.aspx").source, "wildberries");
  const oz = parseProductUrl("https://www.ozon.ru/product/apple-smartfon-iphone-16-siniy-1720312800/?at=x");
  assert.equal(oz.source, "ozon"); assert.equal(oz.product_id, "1720312800");
  assert.equal(parseProductUrl("https://ozon.ru/context/detail/id/1720312800/").product_id, "1720312800");
  for (const bad of ["https://amazon.com/x", "garbage", "", "ftp://www.ozon.ru/product/x-123/", "https://evilwildberries.ru/catalog/1/",
    "https://www.ozon.ru/t/abc", "https://www.wildberries.ru/brands/apple"]) assert.ok(parseProductUrl(bad).error, bad);
  assert.ok(parseProductUrl(undefined).error);
});
test("WB card + JSON-LD parsing", () => {
  const c = parseWbCard({ products: [{ brand: "B", name: "N", reviewRating: 4.8, feedbacks: 10, totalQuantity: 3,
    sizes: [{ price: { basic: 199000, product: 99000 } }] }] });
  assert.deepEqual(c, { title: "B / N", amount: 990, original: 1990, rating: 4.8, reviews_count: 10, in_stock: true });
  assert.equal(parseWbCard({ data: { products: [{ name: "x", salePriceU: 5000, priceU: 9000, sizes: [{ stocks: [] }] }] } }).in_stock, false);
  const ld = productFromJsonLd('<script type="application/ld+json">{"@type":"Product","name":"P","offers":{"price":"1234","priceCurrency":"RUB",' +
    '"availability":"https://schema.org/InStock"},"aggregateRating":{"ratingValue":"4.9","reviewCount":"77"}}</script>');
  assert.deepEqual(ld, { title: "P", price: 1234, currency: "RUB", rating: 4.9, reviews_count: 77, in_stock: true });
  assert.equal(wbBasketHost(169684889), "12"); assert.equal(wbBasketHost(211695539), "14");
});
