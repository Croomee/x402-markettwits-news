// Pure helpers for the alert / digest endpoints (/alerts/price, /alerts/news, /alerts/fx, /digest/daily).
// No I/O: the server fetches (product chain, news store, CBR, Rosstat) and passes the results in, so everything is unit-testable.
import { parseTerms, matchesTerms, isoSec, headlineOf, topTopics, parseCursorId } from "./news-logic.mjs";

const ts = (it) => Date.parse(it.published_at) || 0;
const r = (x, d = 4) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
const brief = ({ id, published_at, importance, source_url, text_en }) => ({ id, published_at, importance, headline: headlineOf(text_en), source_url });

// ---------- /alerts/price ----------
export const PRICE_ALERT_MARKETPLACES = {
  wildberries: "supported (live price via the headless-browser parser, weekly CDN price as fallback)",
  ozon: "accepted, but currently blocked by Ozon's anti-bot: the call returns 502 and the payment is not settled",
};
/** monitorResult() output (product-analytics.mjs) -> alert shape; null stays null (caller returns 502). */
export function priceAlert(mon, source) {
  if (!mon) return null;
  return { triggered: mon.below_target, current_price: mon.current_price, target_price: mon.target_price, currency: "RUB",
    diff_abs: mon.diff_abs, diff_percent: mon.diff_percent, in_stock: mon.in_stock, marketplace: source,
    url: mon.url, product_id: mon.product_id, title: mon.title, original_price: mon.original_price,
    ...(mon.note ? { note: mon.note } : {}), supported_marketplaces: PRICE_ALERT_MARKETPLACES, checked_at: mon.checked_at };
}

// ---------- /alerts/news ----------
/** "oil, gas OPEC" -> ["oil","gas","opec"] (comma or space separated, '#' optional, max 10, 1-100 chars total). null = invalid. */
export function parseKeywords(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.length > 100) return null;
  const list = [...new Set(s.split(/[\s,;]+/).flatMap((w) => parseTerms(w)).filter((w) => w.length >= 2))];
  return list.length && list.length <= 10 ? list : null;
}
export const parseMatch = (raw) => (raw === undefined ? "any" : ["any", "all"].includes(String(raw).toLowerCase()) ? String(raw).toLowerCase() : null);
const ISO_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
/**
 * since = a news item id (same cursor as /news/since: items with a larger id) or an ISO 8601 time (items published after it).
 * Absent -> the last 24 hours. Returns { mode: "id", id } | { mode: "time", ms, iso, default? } or null when invalid.
 */
export function parseSince(raw, nowMs = Date.now()) {
  if (raw === undefined) return { mode: "time", ms: nowMs - 24 * 3600e3, iso: isoSec(nowMs - 24 * 3600e3), default: true };
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  const id = parseCursorId(s);
  if (id !== null) return { mode: "id", id };
  if (!ISO_RE.test(s)) return null;
  const ms = Date.parse(s.length === 10 ? s + "T00:00:00Z" : s.replace(" ", "T"));
  if (!Number.isFinite(ms) || ms < Date.parse("2020-01-01T00:00:00Z") || ms > nowMs + 86400e3) return null;
  return { mode: "time", ms, iso: isoSec(ms) };
}
/** items: whole store (any order). Only importance=high items newer than `since` that match the keywords. Newest first. */
export function newsAlert(items, { keywords, match = "any", since, limit = 20 }) {
  const newer = since.mode === "id" ? (it) => Number(it.id) > since.id : (it) => ts(it) > since.ms;
  const hits = [];
  for (const it of items) {
    if (it.importance !== "high" || !newer(it)) continue;
    const t = it.text_en.toLowerCase();
    const matched = keywords.filter((k) => matchesTerms(t, [k]));
    if (match === "all" ? matched.length === keywords.length : matched.length > 0) hits.push({ ...brief(it), text_en: it.text_en, matched });
  }
  hits.sort((a, b) => ts(b) - ts(a) || b.id - a.id);
  const latestId = items.length ? Math.max(...items.map((it) => Number(it.id))) : null;
  return { triggered: hits.length > 0, query: keywords.join(","), keywords, match, importance: "high",
    since: since.mode === "id" ? { mode: "id", id: since.id } : { mode: "time", time: since.iso, ...(since.default ? { default: "last 24 hours" } : {}) },
    count: hits.length, items: hits.slice(0, limit), latest_id: latestId,
    next_since: latestId === null ? (since.mode === "id" ? String(since.id) : since.iso) : String(latestId) };
}

// ---------- /alerts/fx ----------
export const parseCurrency = (raw) => (typeof raw === "string" && /^[A-Za-z]{3}$/.test(raw.trim()) ? raw.trim().toUpperCase() : null);
/** "81.5" / "81,5" -> 81.5; absent -> undefined; invalid / <= 0 / > 1e6 -> null */
export function parseBound(raw) {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") return null;
  const s = raw.trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return n > 0 && n <= 1e6 ? n : null;
}
/** Validation error text or null. */
export function fxAlertInputError(q) {
  const code = parseCurrency(q.code);
  if (code === null) return "code is required: a 3-letter ISO currency code quoted by the CBR, e.g. USD, EUR, CNY";
  if (code === "RUB") return "code must not be RUB (rates are RUB per unit of the currency)";
  const min = parseBound(q.min), max = parseBound(q.max);
  if (min === null) return "min must be a positive number (RUB per 1 unit), e.g. 80 or 79.5";
  if (max === null) return "max must be a positive number (RUB per 1 unit), e.g. 95 or 94.5";
  if (min === undefined && max === undefined) return "give min and/or max (RUB per 1 unit of the currency)";
  if (min !== undefined && max !== undefined && min > max) return "min must be less than or equal to max";
  return null;
}
/** fx = getFx() result; returns null when the code is not quoted (caller -> 404). */
export function fxAlert(fx, code, min, max) {
  const x = fx.rates.find((y) => y.code === code);
  if (!x) return null;
  const rate = x.per_unit;
  const breach = min !== undefined && rate < min ? "below_min" : max !== undefined && rate > max ? "above_max" : null;
  return { triggered: breach !== null, code, name: x.name ?? null, rate, min: min ?? null, max: max ?? null, breach,
    distance: breach === "below_min" ? r(rate - min) : breach === "above_max" ? r(rate - max) : null,
    unit: "RUB per 1 unit", nominal: x.nominal, value: x.value, prev_rate: x.prev_per_unit ?? null, change_pct: x.change_pct ?? null,
    date: fx.date, source: fx.source, ...(fx.stale ? { stale: true } : {}), fetched_at: fx.fetched_at };
}

// ---------- /digest/daily ----------
const DIGEST_FX = ["USD", "EUR", "CNY"];
export { DIGEST_FX };
/**
 * parts: { keyRate, fx, fuel } each { value } or { error }; items: news store (newest first).
 * Returns null when both the key rate and FX failed (caller -> 502, not settled); fuel / news failures degrade to null + note.
 */
export function dailyDigest({ keyRate, fx, fuel, items, limit = 7, nowMs = Date.now() }) {
  if (keyRate.error && fx.error) return null;
  const notes = [];
  const kr = keyRate.value ? { rate: keyRate.value.rate, as_of: keyRate.value.as_of, effective_since: keyRate.value.effective_since ?? null,
    previous_rate: keyRate.value.previous_rate ?? null, last_change_bp: keyRate.value.last_change_bp ?? null, unit: "% per annum",
    ...(keyRate.value.stale ? { stale: true } : {}) } : null;
  if (!kr) notes.push(`key_rate unavailable: ${keyRate.error}`);
  const fxOut = fx.value ? { date: fx.value.date, base: "RUB", ...(fx.value.stale ? { stale: true } : {}),
    rates: fx.value.rates.map((y) => ({ code: y.code, rate: y.per_unit, change: y.change ?? null, change_pct: y.change_pct ?? null })) } : null;
  if (!fxOut) notes.push(`fx unavailable: ${fx.error}`);
  const fuelOut = fuel.value ? { as_of: fuel.value.as_of, unit: "RUB per litre", ...(fuel.value.stale ? { stale: true } : {}),
    prices: fuel.value.prices.map((p) => ({ fuel: p.fuel, price: p.price, change: p.change ?? null, change_pct: p.change_pct ?? null })) } : null;
  if (!fuelOut) notes.push(`fuel unavailable (Rosstat slow or unreachable): ${fuel.error}; retry later or use /ru/fuel`);
  const dayAgo = nowMs - 24 * 3600e3;
  const high = items.filter((it) => it.importance === "high");
  let top = high.filter((it) => ts(it) >= dayAgo);
  const newsFallback = top.length === 0 && high.length > 0;
  if (newsFallback) top = high;
  top = [...top].sort((a, b) => ts(b) - ts(a));
  const news = { window_hours: 24, high_count_24h: high.filter((it) => ts(it) >= dayAgo).length, fallback: newsFallback,
    top: top.slice(0, limit).map(brief), top_topics: topTopics(top.slice(0, 50), 5) };
  if (newsFallback) notes.push("No high-importance news in the last 24h: news.top lists the latest high-importance items instead.");
  if (!items.length) notes.push("News store is empty (service just restarted); news.top is empty.");
  return { date: isoSec(nowMs).slice(0, 10), generated_at: isoSec(nowMs), partial: !kr || !fxOut || !fuelOut,
    key_rate: kr, fx: fxOut, fuel: fuelOut, news, ...(notes.length ? { notes } : {}),
    sources: { key_rate: "cbr.ru", fx: "cbr.ru XML_daily", fuel: "rosstat.gov.ru weekly", news: "MarketTwits (t.me/markettwits), translated" } };
}
/** Resolves to { value } or { error } within ms (the underlying fetch keeps running and still fills the cache). */
export function settleWithin(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).then((value) => ({ value }), (e) => ({ error: e?.detail || e?.message || String(e) })),
    new Promise((res) => { timer = setTimeout(() => res({ error: `${label} timed out after ${ms / 1000}s` }), ms); }),
  ]).finally(() => clearTimeout(timer));
}
