// Tests for /news/since, /movers, /country, /data-surprises, /sentiment, /digest logic on REAL MarketTwits lines
// (test/fixtures/news-v3.jsonl = 19 items copied verbatim from the live store, 2026-10-20/21).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  parseFloatParam, parseCursorId, newsSince, normalizeCountryCode, countryNews, parseMovers, movers,
  parseSurprises, dataSurprises, scoreText, sentiment, sectionsOf, digest,
} from "../news-logic.mjs";

const ITEMS = fs.readFileSync(new URL("./fixtures/news-v3.jsonl", import.meta.url), "utf8").trim().split("\n")
  .map((l) => JSON.parse(l)).sort((a, b) => b.id - a.id);
const byId = (id) => ITEMS.find((i) => i.id === id).text_en;
const NOW = Date.parse("2026-10-21T17:00:00Z");

test("param parsers", () => {
  assert.equal(parseCursorId("389850"), 389850);
  assert.equal(parseCursorId("0"), 0);
  for (const bad of ["", "abc", "-1", "1.5", "1234567890123456", undefined]) assert.equal(parseCursorId(bad), null, String(bad));
  assert.equal(parseFloatParam(undefined, { def: 0, min: 0, max: 100 }), 0);
  assert.equal(parseFloatParam("2,5", { def: 0, min: 0, max: 100 }), 2.5);
  assert.equal(parseFloatParam("500", { def: 0, min: 0, max: 100 }), 100);
  assert.equal(parseFloatParam("x", { def: 0, min: 0, max: 100 }), null);
  assert.equal(normalizeCountryCode("us"), "US");
  assert.equal(normalizeCountryCode("UK"), "GB");
  for (const bad of ["USA", "1", "", undefined]) assert.equal(normalizeCountryCode(bad), null);
});

test("newsSince: oldest first, cursor and has_more", () => {
  const r = newsSince(ITEMS, 389720, 3);
  assert.deepEqual(r.items.map((i) => i.id), [389726, 389741, 389757]);
  assert.equal(r.has_more, true);
  assert.equal(r.next_id, 389757);
  assert.equal(r.latest_id, 389909);
  const tail = newsSince(ITEMS, 389909, 3);
  assert.equal(tail.count, 0);
  assert.equal(tail.has_more, false);
  assert.equal(tail.next_id, 389909);
  assert.equal(newsSince(ITEMS, 0, 100).count, ITEMS.length);
});

test("parseMovers: single, multi-line, signs from arrows, flags", () => {
  assert.deepEqual(parseMovers(byId(389653)).map((m) => [m.ticker, m.pct, m.country]), [["CRWV", -6, "US"]]);
  assert.deepEqual(parseMovers(byId(389814)).map((m) => [m.ticker, m.pct, m.country]), [["IMOEX", -0.6, "RU"]]);
  const multi = parseMovers(byId(389651));
  const chmf = multi.find((m) => m.ticker === "CHMF");
  assert.deepEqual([chmf.name, chmf.pct, chmf.country], ["Severstal", -1, "RU"]);
  assert.equal(multi.find((m) => m.ticker === "GLRX").pct, 3);
  assert.equal(multi.find((m) => m.ticker === "GM").name, "General Motors");
  assert.deepEqual(parseMovers(byId(389768)).map((m) => [m.ticker, m.pct]), [["SPCX", 8], ["NFLX", -6], ["UAL", -1]]);
  // macro data and schedules are not price moves
  for (const id of [389757, 389726, 389656, 389716, 389720]) assert.deepEqual(parseMovers(byId(id)), [], String(id));
});

test("movers: ranking, min_pct, window", () => {
  const r = movers(ITEMS, 72, 0, NOW);
  assert.equal(r.gainers[0].ticker, "KLVZ");
  assert.equal(r.gainers[0].pct, 16);
  assert.equal(r.losers[0].pct, -6);
  assert.ok(r.losers.every((m) => m.pct < 0) && r.gainers.every((m) => m.pct > 0));
  assert.ok(!r.gainers.concat(r.losers).some((m) => m.ticker === "LEAS"), "0% move excluded");
  const big = movers(ITEMS, 72, 5, NOW);
  assert.ok(big.gainers.concat(big.losers).every((m) => Math.abs(m.pct) >= 5));
  assert.equal(movers(ITEMS, 1, 0, NOW).tickers_found, 0);
});

test("parseSurprises: macro (UK CPI, API crude, US pending home sales)", () => {
  const cpi = parseSurprises(byId(389757));
  const yy = cpi.find((s) => /y\/y$/.test(s.indicator));
  assert.deepEqual([yy.kind, yy.actual, yy.expected, yy.previous, yy.unit, yy.direction], ["macro", 3.5, 3.4, 3.1, "%", "above"]);
  assert.equal(cpi.find((s) => /core/.test(s.indicator)).direction, "inline");
  const crude = parseSurprises(byId(389726))[0];
  assert.deepEqual([crude.actual, crude.expected, crude.previous, crude.unit, crude.direction], [-4.931, -1.3, -11.12, "M", "below"]);
  const phs = parseSurprises(byId(389656))[0];
  assert.deepEqual([phs.actual, phs.expected, phs.previous, phs.direction], [-7.3, -0.5, 0.3, "below"]);
});

test("parseSurprises: earnings (UAL, NFLX, SPCX)", () => {
  const ual = parseSurprises(byId(389718));
  assert.deepEqual(ual.map((s) => [s.kind, s.indicator, s.actual, s.expected, s.unit, s.direction]),
    [["earnings", "3Q ADJ EPS", 2.54, 2.61, "$", "below"], ["earnings", "3Q OPER REV.", 17.9, 17.91, "B", "below"]]);
  assert.equal(parseSurprises(byId(389719)).length, 2);
  const spcx = parseSurprises(byId(389720));
  const rev = spcx.find((s) => s.indicator === "3Q REV.");
  assert.deepEqual([rev.actual, rev.expected, rev.direction], [14.58, 12.87, "above"]);
  assert.ok(Math.abs(rev.surprise - 1.71) < 1e-9);
  assert.deepEqual(parseSurprises(byId(389653)), []);
});

test("dataSurprises: window, q filter, ticker", () => {
  const r = dataSurprises(ITEMS, 72, null, NOW);
  assert.equal(r.count, 14);
  assert.equal(r.above + r.below + r.items.filter((s) => s.direction === "inline").length, r.count);
  assert.ok(r.items.filter((s) => s.kind === "earnings").every((s) => ["SPCX", "NFLX", "UAL"].includes(s.ticker)));
  assert.equal(dataSurprises(ITEMS, 72, "CPI", NOW).count, 3);
  assert.equal(dataSurprises(ITEMS, 72, "netflix", NOW).count, 2);
  assert.equal(dataSurprises(ITEMS, 1, null, NOW).count, 0);
});

test("countryNews: flags, keywords, importance filter", () => {
  const us = countryNews(ITEMS, "US", 72, "all", NOW);
  assert.equal(us.flag, "🇺🇸");
  assert.equal(us.count, 9);
  assert.equal(us.high_count, 4);
  assert.equal(countryNews(ITEMS, "US", 72, "high", NOW).count, 4);
  const ir = countryNews(ITEMS, "IR", 72, "all", NOW);
  assert.equal(ir.count, 2);
  assert.equal(ir.by_flag, 0, "Iran matched by keyword (no flag in these lines)");
  assert.equal(countryNews(ITEMS, "RU", 72, "all", NOW).count, 6);
  assert.ok(countryNews(ITEMS, "RU", 72, "all", NOW).latest.length <= 10);
  assert.equal(countryNews(ITEMS, "JP", 72, "all", NOW).count, 0);
});

test("scoreText + sentiment: heuristic labels", () => {
  assert.equal(scoreText(byId(389858)).label, "bullish");
  assert.equal(scoreText(byId(389653)).label, "bearish");
  const s = sentiment(ITEMS, "Iran", 72, NOW);
  assert.equal(s.method, "heuristic");
  assert.equal(s.count, 2);
  assert.ok(s.score >= -1 && s.score <= 1);
  assert.equal(s.bullish + s.bearish + s.neutral, s.count);
  assert.equal(sentiment(ITEMS, "zzzznothing", 72, NOW).label, "no_data");
});

test("digest: sections", () => {
  assert.ok(sectionsOf(byId(389741)).includes("central_banks"));
  assert.ok(sectionsOf(byId(389757)).includes("macro"));
  assert.ok(sectionsOf(byId(389726)).includes("energy"));
  assert.ok(sectionsOf(byId(389653)).includes("equities"));
  assert.ok(sectionsOf(byId(389645)).includes("crypto"));
  const d = digest(ITEMS, 72, NOW);
  assert.equal(d.count, ITEMS.length);
  for (const k of ["central_banks", "macro", "energy", "equities", "crypto", "geopolitics"]) {
    assert.ok(d.sections[k].count >= 1, k);
    assert.ok(d.sections[k].items.length <= 5, k);
  }
  assert.equal(d.sections.central_banks.count, 2);
  assert.equal(digest(ITEMS, 1, NOW).count, 1, "only 389909 (16:25) is within 1h of 17:00");
});
