import test from "node:test";
import assert from "node:assert/strict";
import { parseTarget, parseProxyUrl, maskSecrets, mapWbCard, mapLdJson, mapOzonWidgets, merge, classifyBlock } from "../extract.mjs";

test("parseTarget validates WB / Ozon hosts and ids", () => {
  assert.deepEqual(parseTarget("https://www.wildberries.ru/catalog/839226871/detail.aspx?size=1"),
    { source: "wildberries", product_id: "839226871", url: "https://www.wildberries.ru/catalog/839226871/detail.aspx" });
  assert.equal(parseTarget("https://wb.ru/catalog/123456/detail.aspx").product_id, "123456");
  assert.equal(parseTarget("https://www.ozon.ru/product/apple-iphone-16-1720312800/?at=x").product_id, "1720312800");
  assert.equal(parseTarget("https://ozon.ru/product/1687844308/").url, "https://www.ozon.ru/product/1687844308/");
  assert.match(parseTarget("https://evil-wildberries.ru.example.com/catalog/123456/").error, /unsupported host/);
  assert.match(parseTarget("https://www.wildberries.ru/brands/x").error, /no Wildberries product id/);
  assert.match(parseTarget("ftp://ozon.ru/product/1/").error, /valid http/);
  assert.match(parseTarget("").error, /required/);
});

test("parseProxyUrl + maskSecrets", () => {
  const c = parseProxyUrl("socks5h://user-sid-1:p%40ss@proxy.example:5000");
  assert.deepEqual([c.scheme, c.host, c.port, c.username, c.password], ["socks5h", "proxy.example", "5000", "user-sid-1", "p@ss"]);
  assert.equal(parseProxyUrl(""), null);
  assert.throws(() => parseProxyUrl("ftp://x:1"), /unsupported/);
  const m = maskSecrets("connect socks5h://user-sid-1:p%40ss@proxy.example:5000 failed for user-sid-1 / p@ss", c);
  assert.ok(!m.includes("p@ss") && !m.includes("user-sid-1"), m);
});

const WB = { products: [{ id: 839226871, brand: "TehnoVolna", name: "Наушники беспроводные TWS Pro 2", supplier: "Me TradeMark", reviewRating: 5, feedbacks: 134639,
  totalQuantity: 44, sizes: [{ price: { basic: 252500, product: 159200 }, stocks: [{ qty: 44 }] }] }] };
test("mapWbCard: kopecks -> RUB, old price, stock, brand/seller", () => {
  assert.deepEqual(mapWbCard(WB, "839226871"), { title: "Наушники беспроводные TWS Pro 2", brand: "TehnoVolna", seller: "Me TradeMark",
    price: 1592, old_price: 2525, currency: "RUB", rating: 5, reviews_count: 134639, in_stock: true, stock_qty: 44 });
  const oos = mapWbCard({ products: [{ id: 1, name: "x", totalQuantity: 0, sizes: [{ stocks: [] }] }] }, 1);
  assert.equal(oos.price, null); assert.equal(oos.in_stock, false);
  assert.equal(mapWbCard({ products: [] }, 1), null);
  assert.equal(mapWbCard(WB, "999"), null);
});

test("mapLdJson reads schema.org Product", () => {
  const html = `<script type="application/ld+json">{"@type":"Product","name":"iPhone 16","brand":{"name":"Apple"},
    "offers":{"price":"79 990","priceCurrency":"RUB","availability":"https://schema.org/InStock","seller":{"name":"Ozon"}},
    "aggregateRating":{"ratingValue":"4.9","reviewCount":"1234"}}</script>`;
  assert.deepEqual(mapLdJson(html), { title: "iPhone 16", brand: "Apple", seller: "Ozon", price: 79990, old_price: null, currency: "RUB",
    rating: 4.9, reviews_count: 1234, in_stock: true });
  assert.equal(mapLdJson("<html></html>"), null);
});

test("mapOzonWidgets + merge", () => {
  const api = { widgetStates: { "webPrice-3121879-default-1": JSON.stringify({ price: "79 990 ₽".replace(" ₽", ""), originalPrice: "99 990", cardPrice: "76 990", isAvailable: true }),
    "webProductHeading-1-default-1": JSON.stringify({ title: "iPhone 16" }), "webReviewProductScore-1-default-1": JSON.stringify({ totalScore: 4.9, reviewsCount: 1234 }) } };
  const w = mapOzonWidgets(api);
  assert.deepEqual([w.title, w.price, w.old_price, w.rating, w.reviews_count, w.in_stock], ["iPhone 16", 76990, 99990, 4.9, 1234, true]);
  assert.deepEqual(merge({ a: null, b: 2 }, { a: 1, b: 3, c: 4 }), { a: 1, b: 2, c: 4 });
});

test("classifyBlock", () => {
  assert.equal(classifyBlock("ozon", { status: 403, title: "Antibot Captcha" }), "ozon_captcha");
  assert.equal(classifyBlock("ozon", { status: 403, title: "Похоже, нет соединения" }), "ozon_antibot");
  assert.equal(classifyBlock("wildberries", { status: 498 }), "wb_challenge_unsolved");
  assert.equal(classifyBlock("wildberries", { status: 200 }), null);
});
