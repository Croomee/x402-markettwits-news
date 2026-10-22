// RU market data parsers on REAL upstream responses saved in test/fixtures (cbr.ru, iss.moex.com, rosstat.gov.ru trimmed xlsx).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  parseIsoDate, parseCodes, parseTicker, parseIndexCodes, decodeCbr, parseCbrDaily, fxResult, parseKeyRateSoap, parseKeyRateHtml,
  keyRateSummary, quoteFrom, indexFrom, liveMoverRows, historyMoverRows, computeMovers, readXlsx, parseRuDate, parseFuelSheets, fuelResult, addDays,
} from "../ru-data.mjs";
import { upstream, cached, clearDataCache, setUpstreamForTests, UpstreamError, NotFoundError } from "../upstream.mjs";

const fx = (n) => fs.readFileSync(new URL(`./fixtures/${n}`, import.meta.url));
const json = (n) => JSON.parse(fx(n).toString("utf8"));
const NOW = Date.parse("2026-10-22T04:00:00Z");

test("param parsers", () => {
  assert.equal(parseIsoDate("2026-10-01", { now: NOW }), "2026-10-01");
  assert.equal(parseIsoDate("2026-10-23", { now: NOW }), "2026-10-23", "tomorrow allowed (CBR sets next-day rates)");
  for (const bad of ["2026-10-25", "2026-13-01", "2026-02-30", "1992-06-30", "21.10.2026", "", undefined]) assert.equal(parseIsoDate(bad, { now: NOW }), null, String(bad));
  assert.deepEqual(parseCodes("usd, EUR,CNY,usd"), ["USD", "EUR", "CNY"]);
  for (const bad of ["US", "USD;EUR", "", "U5D"]) assert.equal(parseCodes(bad), null, bad);
  assert.equal(parseTicker("sber"), "SBER");
  assert.equal(parseTicker("T"), "T");
  for (const bad of ["", "SB ER", "TOOLONGTICKER1", "-X"]) assert.equal(parseTicker(bad), null, bad);
  assert.deepEqual(parseIndexCodes("imoex,RTSI"), ["IMOEX", "RTSI"]);
  assert.equal(parseIndexCodes("List"), "list");
  for (const bad of ["IM-OEX", "A,B,C,D,E,F", "X"]) assert.equal(parseIndexCodes(bad), null, bad);
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
});

test("CBR XML_daily (windows-1251): parse + day-over-day change", () => {
  const cur = parseCbrDaily(decodeCbr(fx("cbr-daily-2026-10-21.xml")));
  const prev = parseCbrDaily(decodeCbr(fx("cbr-daily-2026-10-20.xml")));
  assert.equal(cur.date, "2026-10-21");
  assert.ok(cur.rates.length > 40);
  const usd = cur.rates.find((r) => r.code === "USD");
  assert.equal(usd.name, "Доллар США");
  assert.equal(usd.nominal, 1);
  const dzd = cur.rates.find((r) => r.code === "DZD");
  assert.equal(dzd.nominal, 100);
  assert.ok(Math.abs(dzd.per_unit - dzd.value / 100) < 1e-6);
  const r = fxResult(cur, prev, ["USD", "EUR", "XXX"], null);
  assert.deepEqual(r.rates.map((x) => x.code), ["USD", "EUR"]);
  assert.deepEqual(r.missing, ["XXX"]);
  assert.equal(r.previous_date, prev.date);
  const u = r.rates[0];
  assert.ok(Math.abs(u.change - (u.per_unit - u.prev_per_unit)) < 1e-3);
  assert.equal(fxResult(cur, cur, null, null).previous_date, null, "same set is not a previous");
});

test("CBR key rate: SOAP + HTML fallback + change points", () => {
  const rows = parseKeyRateSoap(fx("cbr-keyrate-soap.xml").toString("utf8"));
  assert.ok(rows.length > 400);
  const s = keyRateSummary(rows, { months: 24, now: NOW });
  assert.equal(s.rate, 14);
  assert.equal(s.as_of, "2026-10-21");
  assert.equal(s.effective_since, "2026-07-27");
  assert.equal(s.previous_rate, 14.25);
  assert.equal(s.last_change_bp, -25);
  assert.ok(s.changes.length >= 5 && s.changes[0].date === "2026-07-27");
  assert.ok(s.changes.every((c, i) => i === 0 || c.date < s.changes[i - 1].date), "newest first");
  const html = parseKeyRateHtml(fx("cbr-keyrate-page.html").toString("utf8"));
  assert.ok(html.length > 50);
  assert.deepEqual(html[0], { date: "2026-10-21", rate: 14 });
  assert.equal(keyRateSummary(html, { now: NOW }).rate, 14);
  assert.equal(keyRateSummary([], { now: NOW }), null);
});

test("MOEX ISS: quote (pre-session -> previous close), index", () => {
  const q = quoteFrom(json("moex-sber.json"), "SBER");
  assert.equal(q.board, "TQBR");
  assert.equal(q.isin, "RU0009029540");
  assert.equal(q.currency, "RUB");
  assert.equal(q.price_source, "previous_close");
  assert.equal(q.price, q.prev_close);
  assert.equal(q.change_pct, null);
  assert.equal(q.delayed, true);
  assert.equal(quoteFrom({ securities: { columns: ["SECID"], data: [] }, marketdata: { columns: [], data: [] } }, "NOPE"), null);
  const live = structuredClone(json("moex-sber.json"));
  const cols = live.marketdata.columns, row = live.marketdata.data.find((r) => r[1] === "TQBR");
  row[cols.indexOf("LAST")] = 293.1; row[cols.indexOf("LASTTOPREVPRICE")] = 0.51;
  const ql = quoteFrom(live, "SBER");
  assert.equal(ql.price_source, "last_trade");
  assert.equal(ql.price, 293.1);
  assert.equal(ql.change_pct, 0.51);
  const idx = indexFrom(json("moex-index.json"));
  const imoex = idx.find((i) => i.code === "IMOEX");
  assert.equal(imoex.value, 2447.83);
  assert.equal(imoex.prev_close, 2469.75);
  assert.equal(imoex.change_pct, -0.89);
  assert.equal(idx.find((i) => i.code === "RTSI").currency, "USD");
});

test("MOEX movers: live rows, history fallback, liquidity filter", () => {
  const pre = liveMoverRows(json("moex-tqbr.json"));
  assert.ok(pre.length > 200);
  assert.equal(pre.filter((r) => r.price !== null).length, 0, "fixture taken before the session: no trades");
  const hist = historyMoverRows(json("moex-history-p0.json").history.data.map((r) =>
    Object.fromEntries(json("moex-history-p0.json").history.columns.map((c, i) => [c, r[i]]))));
  const m = computeMovers(hist, { limit: 3, minValue: 5e6 });
  assert.equal(m.gainers.length, 3);
  assert.ok(m.gainers.every((g, i) => g.pct > 0 && (i === 0 || g.pct <= m.gainers[i - 1].pct)));
  assert.ok(m.losers.every((g, i) => g.pct < 0 && (i === 0 || g.pct >= m.losers[i - 1].pct)));
  assert.ok([...m.gainers, ...m.losers].every((x) => x.value >= 5e6));
  assert.equal(m.advancers + m.decliners + m.unchanged, m.universe);
  const tiny = computeMovers([{ ticker: "A", price: 1, pct: 50, value: 10 }, { ticker: "B", price: 1, pct: -3, value: 1e7 }], { minValue: 5e6 });
  assert.deepEqual([tiny.gainers.length, tiny.losers[0].ticker], [0, "B"]);
});

test("Rosstat xlsx: zip/xml reader + fuel rows + Russian date headers", () => {
  assert.equal(parseRuDate("на 12 октября", 2026), "2026-10-12");
  assert.equal(parseRuDate("на 6 мая 2022 г."), "2022-05-06");
  assert.equal(parseRuDate("на 12.10.2026"), "2026-10-12");
  assert.equal(parseRuDate(46307), "2026-10-12");
  assert.equal(parseRuDate("Наименование", 2026), null);
  const sheets = readXlsx(fx("rosstat-nedel-sred-cen-trimmed.xlsx"));
  assert.deepEqual(sheets.map((s) => s.name), ["Содержание", "2025", "2026"]);
  const p = parseFuelSheets(sheets);
  assert.deepEqual(Object.keys(p.series).sort(), ["ai92", "ai95", "ai98", "diesel", "petrol_avg"]);
  assert.deepEqual(p.series.ai92.slice(0, 2), [{ date: "2026-10-12", price: 74.71 }, { date: "2026-10-05", price: 74.72 }]);
  assert.equal(p.series.ai92.at(-1).date, "2025-12-08", "2025 sheet merged");
  assert.equal(p.labels.diesel, "Дизельное топливо, л");
  const r = fuelResult(p, { weeks: 2 });
  assert.equal(r.as_of, "2026-10-12");
  const ai95 = r.prices.find((x) => x.fuel === "ai95");
  assert.deepEqual([ai95.price, ai95.prev_price, ai95.change, ai95.change_pct], [80.92, 81.03, -0.11, -0.14]);
  assert.equal(ai95.change_4w_pct, 0.17); // vs 14 Sep 80.78
  assert.equal(ai95.history.length, 3);
  assert.equal(r.prices.find((x) => x.fuel === "diesel").price, 86.67);
  assert.equal(fuelResult(p, { weeks: 0 }).prices[0].history, undefined);
  assert.throws(() => readXlsx(Buffer.from("not a zip")), /zip/);
});

test("upstream: 5xx -> UpstreamError (502), 404 -> NotFoundError, stale cache served on failure", async () => {
  clearDataCache();
  let status = 500;
  setUpstreamForTests({ proxy: { configured: false }, fetchImpl: async () => new Response("x", { status }) });
  await assert.rejects(upstream("https://example.test/a", { label: "t" }), (e) => e instanceof UpstreamError && /HTTP 500/.test(e.attempts[0]));
  status = 404;
  await assert.rejects(upstream("https://example.test/a", { label: "t", notFoundOn404: true }), NotFoundError);
  let fail = false;
  const fn = async () => { if (fail) throw new UpstreamError("down"); return 42; };
  assert.equal((await cached("k", 1, fn, { staleMs: 60e3 })).value, 42);
  await new Promise((r) => setTimeout(r, 5));
  fail = true;
  const st = await cached("k", 1, fn, { staleMs: 60e3 });
  assert.deepEqual([st.value, st.stale], [42, true]);
  await assert.rejects(cached("k2", 1, fn), UpstreamError);
  clearDataCache();
});
