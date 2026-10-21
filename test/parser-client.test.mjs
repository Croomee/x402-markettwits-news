import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mapParserResult, fetchViaParser, parserConfigured } from "../parser-client.mjs";

const P = { source: "wildberries", product_id: "839226871", url: "https://www.wildberries.ru/catalog/839226871/detail.aspx" };
const OK = { ok: true, title: "Наушники", price: 1592, old_price: 2525, currency: "RUB", rating: 5, reviews_count: 134639, in_stock: true,
  brand: "B", seller: "S", data_source: "wb card api (browser)", fetched_at: "2026-10-21T14:18:15Z" };

test("parserConfigured needs both URL and token", () => {
  assert.equal(parserConfigured({ PARSER_URL: "http://x", PARSER_TOKEN: "" }), false);
  assert.equal(parserConfigured({ PARSER_URL: "http://x", PARSER_TOKEN: "t" }), true);
});

test("mapParserResult maps to the /product/info schema with via=browser", () => {
  const { value } = mapParserResult(OK, P);
  assert.deepEqual(value.price, { amount: 1592, currency: "RUB", original_amount: 2525 });
  assert.equal(value.via, "browser"); assert.equal(value.availability, "in_stock"); assert.equal(value.reviews_count, 134639);
  assert.equal(value.data_source, "browser: wb card api (browser)"); assert.equal(value.product_id, "839226871");
  assert.ok(!("brand" in value) && !("seller" in value)); // response schema unchanged
});

test("mapParserResult: no old price when not higher; null price -> hint only", () => {
  assert.equal(mapParserResult({ ...OK, old_price: 1000 }, P).value.price.original_amount, undefined);
  const m = mapParserResult({ ...OK, price: null, in_stock: false }, P);
  assert.equal(m.value, undefined); assert.equal(m.hint.availability, "out_of_stock");
  assert.equal(mapParserResult({ ok: false }, P), null);
});

test("fetchViaParser sends bearer token, maps errors", async () => {
  let seen;
  const fake = async (url, init) => { seen = { url, auth: init.headers.authorization }; return new Response(JSON.stringify(OK), { status: 200 }); };
  const env = { PARSER_URL: "http://parser:8090", PARSER_TOKEN: "tok_123456789012345" };
  const r = await fetchViaParser(P, { env, fetchImpl: fake });
  assert.equal(r.value.price.amount, 1592);
  assert.equal(seen.auth, "Bearer tok_123456789012345");
  assert.equal(seen.url, `http://parser:8090/parse?url=${encodeURIComponent(P.url)}`);
  const blocked = async () => new Response(JSON.stringify({ ok: false, error: "blocked", message: "captcha" }), { status: 502 });
  await assert.rejects(fetchViaParser(P, { env, fetchImpl: blocked }), /parser HTTP 502: blocked - captcha/);
  const unauth = async () => new Response("{}", { status: 401 });
  await assert.rejects(fetchViaParser(P, { env, fetchImpl: unauth }), /401/);
  const down = async () => { throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }); };
  await assert.rejects(fetchViaParser(P, { env, fetchImpl: down }), /unreachable \(ECONNREFUSED\)/);
});

test("fetchProduct uses the parser first when PARSER_URL/PARSER_TOKEN are set", async () => {
  let hits = 0, auth;
  const srv = http.createServer((req, res) => { hits++; auth = req.headers.authorization; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(OK)); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  process.env.PARSER_URL = `http://127.0.0.1:${srv.address().port}/`; process.env.PARSER_TOKEN = "test_token_0123456789";
  delete process.env.PROXY_URL; delete process.env.PROXY_HOST;
  const { fetchProduct } = await import("../product.mjs");
  try {
    assert.equal(parserConfigured(), true);
    const v = await fetchProduct(P, { noCache: true });
    assert.equal(v.via, "browser"); assert.equal(v.price.amount, 1592); assert.equal(hits, 1); assert.equal(auth, "Bearer test_token_0123456789");
  } finally { srv.close(); delete process.env.PARSER_URL; delete process.env.PARSER_TOKEN; }
});
