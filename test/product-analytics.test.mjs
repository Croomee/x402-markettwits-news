import test from "node:test";
import assert from "node:assert/strict";
import { collectUrls, parseCompareInput, parseTargetPrice, compareProducts, monitorResult, buildHistory } from "../product-analytics.mjs";
import { parseProductUrl, parseWbPriceHistory, recordObservation, getObservations, clearObservations } from "../product.mjs";

const U = (id) => `https://www.wildberries.ru/catalog/${id}/detail.aspx`;
const V = (id, amount, extra = {}) => ({ source: "wildberries", product_id: String(id), url: U(id), title: `T${id}`, price: { amount, currency: "RUB", ...(extra.orig ? { original_amount: extra.orig } : {}) },
  rating: 4.8, reviews_count: 10, availability: extra.in_stock === false ? "out_of_stock" : "in_stock", in_stock: extra.in_stock ?? true,
  fetched_at: "2026-10-21T16:00:00Z", data_source: "browser: wb card api (browser)", via: "browser" });
const NOW = Date.parse("2026-10-21T16:00:00Z");

test("collectUrls: comma list, repeated url=, comma inside a URL kept", () => {
  assert.deepEqual(collectUrls({ urls: `${U(1)},${U(2)}` }), [U(1), U(2)]);
  assert.deepEqual(collectUrls({ url: [U(1), U(2)] }), [U(1), U(2)]);
  assert.deepEqual(collectUrls({ urls: `${U(1)}, ${U(2)}`, url: U(3) }), [U(1), U(2), U(3)]);
  assert.deepEqual(collectUrls({ urls: "https://www.wildberries.ru/catalog/5/detail.aspx?a=1,2" }), ["https://www.wildberries.ru/catalog/5/detail.aspx?a=1,2"]);
  assert.deepEqual(collectUrls({}), []);
});

test("parseCompareInput: 2-5 valid unique URLs", () => {
  assert.equal(parseCompareInput({ urls: `${U(11)},${U(22)}` }, parseProductUrl).products.length, 2);
  assert.match(parseCompareInput({ urls: U(11) }, parseProductUrl).error, /2-5/);
  assert.match(parseCompareInput({ urls: [1, 2, 3, 4, 5, 6].map(U).join(",") }, parseProductUrl).error, /max 5/);
  assert.match(parseCompareInput({ urls: `${U(11)},https://example.com/x` }, parseProductUrl).error, /url #2: unsupported host/);
  assert.match(parseCompareInput({ urls: `${U(11)},https://wb.ru/catalog/11/detail.aspx` }, parseProductUrl).error, /duplicate/);
  assert.equal(parseCompareInput({ url: [U(11), "https://www.ozon.ru/product/x-1720312800/"] }, parseProductUrl).products[1].source, "ozon");
});

test("parseTargetPrice", () => {
  assert.equal(parseTargetPrice("1500"), 1500); assert.equal(parseTargetPrice("1499,90"), 1499.9); assert.equal(parseTargetPrice(" 10.5 "), 10.5);
  for (const bad of [undefined, "", "0", "-5", "abc", "1e3", "12a", "1e10"]) assert.equal(parseTargetPrice(bad), null, String(bad));
});

test("compareProducts: cheapest, spread, stock, per-item errors", () => {
  const ps = [1, 2, 3].map((id) => parseProductUrl(U(id)));
  const out = compareProducts([{ p: ps[0], value: V(1, 680, { orig: 1999 }) }, { p: ps[1], value: V(2, 618, { in_stock: false }) },
    { p: ps[2], error: "wildberries did not return product data", hint: { title: "T3", in_stock: false } }], NOW);
  assert.equal(out.count, 3); assert.equal(out.succeeded, 2);
  assert.deepEqual(out.cheapest, { product_id: "2", url: U(2), title: "T2", price: 618 });
  assert.equal(out.most_expensive.product_id, "1");
  assert.deepEqual(out.price_diff, { abs: 62, percent: 10.03 });
  assert.equal(out.in_stock_count, 1); assert.equal(out.all_in_stock, false);
  assert.equal(out.items[0].original_price, 1999);
  assert.equal(out.items[2].error, "out_of_stock_no_price"); assert.equal(out.items[2].title, "T3"); assert.equal(out.items[2].price, null);
  assert.equal(out.fetched_at, "2026-10-21T16:00:00Z");
  const one = compareProducts([{ p: ps[0], value: V(1, 100) }, { p: ps[1], error: "x" }]);
  assert.equal(one.succeeded, 1); assert.equal(one.price_diff.abs, 0);
});

test("monitorResult: below/above target, out-of-stock choice, no data", () => {
  const above = monitorResult({ value: V(1, 1592, { orig: 2525 }), target: 1500, now: NOW });
  assert.equal(above.below_target, false); assert.equal(above.diff_abs, 92); assert.equal(above.diff_percent, 6.13); assert.equal(above.original_price, 2525);
  const below = monitorResult({ value: V(1, 1500), target: 1500, now: NOW });
  assert.equal(below.below_target, true); assert.equal(below.diff_abs, 0);
  const oos = monitorResult({ hint: { url: U(9), product_id: "9", title: "Gel", in_stock: false }, target: 100, now: NOW });
  assert.equal(oos.below_target, false); assert.equal(oos.current_price, null); assert.equal(oos.in_stock, false); assert.match(oos.note, /out of stock/);
  const oosCdn = monitorResult({ value: { ...V(9, 50, { in_stock: false }), price: { amount: 50, currency: "RUB", as_of: "2026-09-20" } }, target: 100, now: NOW });
  assert.equal(oosCdn.below_target, false); assert.equal(oosCdn.current_price, 50); assert.match(oosCdn.note, /out of stock.*weekly CDN price of 2026-09-20/);
  assert.equal(monitorResult({ hint: null, target: 100 }), null);
  assert.equal(monitorResult({ hint: { title: "x", in_stock: null }, target: 100 }), null);
});

test("buildHistory: weekly + observed + live, stats, 30d change", () => {
  const p = parseProductUrl(U(839226871));
  const weekly = [{ date: "2026-09-13", price: 1602.06 }, { date: "2026-09-20", price: 1471.2 }];
  const h = buildHistory({ p, weekly, observed: [{ at: NOW - 3600e3, price: 1580 }, { at: Date.parse("2026-10-21T16:00:00Z"), price: 1592 }],
    live: V(839226871, 1592, { orig: 2525 }), now: NOW });
  assert.deepEqual(h.points.map((x) => x.source), ["weekly_cdn", "weekly_cdn", "observed", "live"]); // duplicate observed==live dropped
  assert.deepEqual(h.current, { price: 1592, original_price: 2525, source: "live", date: "2026-10-21T16:00:00Z" });
  assert.deepEqual([h.stats.min, h.stats.max, h.stats.count], [1471.2, 1602.06, 4]);
  assert.equal(h.stats.avg, 1561.32);
  assert.deepEqual(h.change_30d, { vs_date: "2026-09-20", vs_price: 1471.2, abs: 120.8, percent: 8.21 });
  assert.equal(h.history_limited, false); assert.equal(h.note, undefined);
  assert.deepEqual(h.sources, { weekly_cdn: 2, observed: 1, live: 1 });
});

test("buildHistory: only live -> history_limited; no live -> latest weekly; nothing -> null; 5x mismatch note", () => {
  const p = parseProductUrl(U(1));
  const only = buildHistory({ p, live: V(1, 500), now: NOW });
  assert.equal(only.history_limited, true); assert.match(only.note, /Only the current price/); assert.equal(only.change_30d, null);
  const noLive = buildHistory({ p, weekly: [{ date: "2026-09-20", price: 700 }], now: NOW });
  assert.equal(noLive.current.source, "weekly_cdn"); assert.equal(noLive.current.price, 700); assert.match(noLive.note, /Live price unavailable/);
  assert.equal(buildHistory({ p, now: NOW }), null);
  const odd = buildHistory({ p, weekly: [{ date: "2026-09-20", price: 18 }], live: V(1, 618), now: NOW });
  assert.match(odd.note, /more than 5x/);
});

test("parseWbPriceHistory: kopecks -> RUB, sorted, invalid dropped", () => {
  assert.deepEqual(parseWbPriceHistory([{ dt: 1758326400, price: { RUB: 147120 } }, { dt: 1757721600, price: { RUB: 160206 } }, { dt: 1, price: {} }]),
    [{ date: "2025-09-13", price: 1602.06 }, { date: "2025-09-20", price: 1471.2 }]);
  assert.deepEqual(parseWbPriceHistory(null), []);
});

test("observation store: records fresh live prices only, dedupes within 10 min", () => {
  clearObservations();
  recordObservation(V(5, 100), NOW); recordObservation(V(5, 100), NOW + 60_000); recordObservation(V(5, 90), NOW + 120_000);
  recordObservation({ ...V(5, 80), price: { amount: 80, currency: "RUB", as_of: "2026-09-20" } }, NOW + 180_000); // weekly CDN fallback: skipped
  recordObservation(V(5, 90), NOW + 20 * 60_000);
  assert.deepEqual(getObservations("wildberries", "5").map((x) => x.price), [100, 90, 90]);
  assert.deepEqual(getObservations("wildberries", "6"), []);
});
