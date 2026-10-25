// /alerts/price, /alerts/news, /alerts/fx, /digest/daily logic on REAL data (news-v3.jsonl store lines, cbr.ru XML_daily,
// cbr.ru key rate SOAP, Rosstat xlsx fixtures) with mocked upstream results; no network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { priceAlert, parseKeywords, parseMatch, parseSince, newsAlert, parseCurrency, parseBound, fxAlertInputError, fxAlert,
  dailyDigest, settleWithin } from "../alerts-logic.mjs";
import { monitorResult } from "../product-analytics.mjs";
import { decodeCbr, parseCbrDaily, fxResult, parseKeyRateSoap, keyRateSummary, readXlsx, parseFuelSheets, fuelResult } from "../ru-data.mjs";

const fx = (n) => fs.readFileSync(new URL(`./fixtures/${n}`, import.meta.url));
const ITEMS = fx("news-v3.jsonl").toString("utf8").trim().split("\n").map((l) => JSON.parse(l)).sort((a, b) => b.id - a.id);
const NOW = Date.parse("2026-10-21T17:00:00Z");
const CUR = parseCbrDaily(decodeCbr(fx("cbr-daily-2026-10-21.xml"))), PREV = parseCbrDaily(decodeCbr(fx("cbr-daily-2026-10-20.xml")));

test("alerts/price: monitorResult -> triggered / not triggered / out of stock / no data", () => {
  const value = { source: "wildberries", url: "https://www.wildberries.ru/catalog/839226871/detail.aspx", product_id: "839226871", title: "TWS Pro 2",
    price: { amount: 1592, currency: "RUB", original_amount: 2525 }, in_stock: true };
  const above = priceAlert(monitorResult({ value, target: 1500, now: NOW }), "wildberries");
  assert.deepEqual([above.triggered, above.current_price, above.target_price, above.diff_abs, above.marketplace], [false, 1592, 1500, 92, "wildberries"]);
  assert.match(above.supported_marketplaces.ozon, /blocked/);
  const below = priceAlert(monitorResult({ value, target: 1600, now: NOW }), "wildberries");
  assert.deepEqual([below.triggered, below.diff_abs], [true, -8]);
  const oos = priceAlert(monitorResult({ value: { ...value, in_stock: false }, target: 1600, now: NOW }), "wildberries");
  assert.equal(oos.triggered, false, "out of stock never triggers");
  const hintOnly = priceAlert(monitorResult({ hint: { url: value.url, product_id: "1", title: "x", in_stock: false }, target: 10 }), "wildberries");
  assert.deepEqual([hintOnly.triggered, hintOnly.current_price], [false, null]);
  assert.equal(priceAlert(monitorResult({ target: 10 }), "ozon"), null, "no data -> null -> 502 (not settled)");
});

test("alerts/news: keyword and since parsing", () => {
  assert.deepEqual(parseKeywords("oil, #OPEC  gas"), ["oil", "opec", "gas"]);
  assert.deepEqual(parseKeywords("Oil,oil"), ["oil"]);
  for (const bad of ["", "  ", ",", "a", "x".repeat(101), "a1 b2 c3 d4 e5 f6 g7 h8 i9 j10 k11", undefined]) assert.equal(parseKeywords(bad), null, String(bad));
  assert.equal(parseMatch(undefined), "any");
  assert.equal(parseMatch("ALL"), "all");
  assert.equal(parseMatch("some"), null);
  assert.deepEqual(parseSince("389720", NOW), { mode: "id", id: 389720 }, "digits = news id cursor as in /news/since");
  assert.equal(parseSince("0", NOW).id, 0);
  const t = parseSince("2026-10-21T00:00:00Z", NOW);
  assert.deepEqual([t.mode, t.iso], ["time", "2026-10-21T00:00:00Z"]);
  assert.equal(parseSince("2026-10-21T03:00:00+03:00", NOW).iso, "2026-10-21T00:00:00Z");
  assert.equal(parseSince("2026-10-21", NOW).iso, "2026-10-21T00:00:00Z");
  const d = parseSince(undefined, NOW);
  assert.deepEqual([d.mode, d.iso, d.default], ["time", "2026-10-20T17:00:00Z", true]);
  for (const bad of ["abc", "-1", "1.5", "2026-13-45", "2031-01-01T00:00:00Z", "yesterday", ""]) assert.equal(parseSince(bad, NOW), null, bad);
});

test("alerts/news: only HIGH items newer than since; any/all; next_since cursor", () => {
  const byTime = newsAlert(ITEMS, { keywords: ["oil", "earnings"], since: parseSince("2026-10-20T12:00:00Z", NOW) });
  assert.equal(byTime.triggered, true);
  assert.deepEqual(byTime.items.map((i) => i.id), [389720, 389719, 389718, 389642], "high only (389726 oil is medium), newest first");
  assert.deepEqual(byTime.items.find((i) => i.id === 389642).matched, ["oil"]);
  assert.equal(byTime.count, 4);
  assert.equal(byTime.latest_id, 389909);
  assert.equal(byTime.next_since, "389909");
  const byId = newsAlert(ITEMS, { keywords: ["oil", "earnings"], since: parseSince("389718", NOW) });
  assert.deepEqual(byId.items.map((i) => i.id), [389720, 389719], "id > since, same semantics as /news/since");
  assert.deepEqual(byId.since, { mode: "id", id: 389718 });
  const all = newsAlert(ITEMS, { keywords: ["netflix", "earnings"], match: "all", since: parseSince("0", NOW) });
  assert.deepEqual(all.items.map((i) => i.id), [389719]);
  const none = newsAlert(ITEMS, { keywords: ["oil"], since: parseSince("389909", NOW) });
  assert.deepEqual([none.triggered, none.count, none.items.length, none.next_since], [false, 0, 0, "389909"]);
  const empty = newsAlert([], { keywords: ["oil"], since: parseSince(undefined, NOW) });
  assert.deepEqual([empty.triggered, empty.latest_id, empty.next_since], [false, null, "2026-10-20T17:00:00Z"]);
});

test("alerts/fx: validation, breach below/above/inside on real CBR XML", () => {
  assert.equal(parseCurrency("usd"), "USD");
  assert.equal(parseCurrency("US"), null);
  assert.equal(parseBound("81,5"), 81.5);
  assert.equal(parseBound(undefined), undefined);
  for (const bad of ["0", "-1", "abc", "1e3", ""]) assert.equal(parseBound(bad), null, bad);
  assert.equal(fxAlertInputError({ code: "USD", min: "75", max: "95" }), null);
  assert.equal(fxAlertInputError({ code: "USD", max: "95" }), null);
  assert.match(fxAlertInputError({}), /code is required/);
  assert.match(fxAlertInputError({ code: "RUB", min: "1" }), /RUB/);
  assert.match(fxAlertInputError({ code: "USD" }), /min and\/or max/);
  assert.match(fxAlertInputError({ code: "USD", min: "x" }), /min must be/);
  assert.match(fxAlertInputError({ code: "USD", max: "0" }), /max must be/);
  assert.match(fxAlertInputError({ code: "USD", min: "90", max: "80" }), /less than or equal/);
  const res = { ...fxResult(CUR, PREV, ["USD"], null), fetched_at: "2026-10-21T10:00:00Z" };
  const usd = res.rates[0].per_unit;
  const inside = fxAlert(res, "USD", usd - 1, usd + 1);
  assert.deepEqual([inside.triggered, inside.breach, inside.rate, inside.date, inside.distance], [false, null, usd, CUR.date, null]);
  const above = fxAlert(res, "USD", undefined, usd - 2);
  assert.deepEqual([above.triggered, above.breach, above.min, above.max], [true, "above_max", null, usd - 2]);
  assert.ok(Math.abs(above.distance - 2) < 1e-6);
  const below = fxAlert(res, "USD", usd + 3, undefined);
  assert.deepEqual([below.triggered, below.breach], [true, "below_min"]);
  assert.equal(fxAlert(res, "XXX", 1, 2), null, "unquoted code -> null -> 404 (not settled)");
});

test("digest/daily: full, fuel failure degrades to null + note, both CBR failures -> null (502)", () => {
  const keyRate = { value: { ...keyRateSummary(parseKeyRateSoap(fx("cbr-keyrate-soap.xml").toString("utf8")), { months: 12, now: NOW }) } };
  const fxv = { value: fxResult(CUR, PREV, ["USD", "EUR", "CNY"], null) };
  const fuel = { value: fuelResult(parseFuelSheets(readXlsx(fx("rosstat-nedel-sred-cen-trimmed.xlsx"))), { weeks: 0 }) };
  const full = dailyDigest({ keyRate, fx: fxv, fuel, items: ITEMS, limit: 3, nowMs: NOW });
  assert.equal(full.partial, false);
  assert.equal(full.key_rate.rate, 14);
  assert.deepEqual(full.fx.rates.map((r) => r.code), ["USD", "EUR", "CNY"]);
  assert.ok(full.fuel.prices.some((p) => p.fuel === "ai92" && p.price > 0));
  assert.equal(full.news.top.length, 3);
  assert.equal(full.news.top[0].id, 389757, "newest high item of the last 24h first");
  assert.ok(full.news.top.every((i) => i.importance === "high" && i.headline));
  assert.equal(full.notes, undefined);
  const noFuel = dailyDigest({ keyRate, fx: fxv, fuel: { error: "rosstat.gov.ru fuel timed out after 8s" }, items: ITEMS, nowMs: NOW });
  assert.deepEqual([noFuel.partial, noFuel.fuel], [true, null]);
  assert.match(noFuel.notes.join(" "), /fuel unavailable.*timed out/);
  const noKr = dailyDigest({ keyRate: { error: "down" }, fx: fxv, fuel, items: [], nowMs: NOW });
  assert.deepEqual([noKr.key_rate, noKr.partial, noKr.news.top.length], [null, true, 0]);
  assert.match(noKr.notes.join(" "), /News store is empty/);
  const old = dailyDigest({ keyRate, fx: fxv, fuel, items: ITEMS, nowMs: NOW + 5 * 86400e3 });
  assert.equal(old.news.fallback, true, "no high news in 24h -> latest high items");
  assert.ok(old.news.top.length > 0);
  assert.equal(dailyDigest({ keyRate: { error: "a" }, fx: { error: "b" }, fuel, items: ITEMS }), null);
});

test("settleWithin: value, error and timeout", async () => {
  assert.deepEqual(await settleWithin(Promise.resolve(1), 100, "x"), { value: 1 });
  assert.deepEqual(await settleWithin(Promise.reject(Object.assign(new Error("boom"), { detail: "d" })), 100, "x"), { error: "d" });
  assert.deepEqual(await settleWithin(new Promise(() => {}), 20, "slow"), { error: "slow timed out after 0.02s" });
});
