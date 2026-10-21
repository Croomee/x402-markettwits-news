// Pure helpers for /product/compare, /product/monitor, /product/history (no I/O; unit-tested).
const r2 = (x) => Math.round(x * 100) / 100;
const iso = (ms = Date.now()) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

// ---------- input parsing (shared by the pre-payment validators and the handlers) ----------
export const COMPARE_MIN = 2, COMPARE_MAX = 5;
// urls=<u1>,<u2> and/or repeated url= / urls= params. Splits on commas followed by http(s):// so a comma inside a URL survives.
export function collectUrls(query) {
  const raw = [];
  for (const k of ["urls", "url"]) {
    const v = query?.[k];
    for (const s of Array.isArray(v) ? v : v === undefined ? [] : [v]) {
      if (typeof s !== "string") continue;
      raw.push(...s.split(/,(?=\s*https?:\/\/)/i).map((x) => x.trim()).filter(Boolean));
    }
  }
  return raw;
}
// -> { products } or { error }. parse = parseProductUrl from product.mjs
export function parseCompareInput(query, parse) {
  const urls = collectUrls(query);
  if (urls.length < COMPARE_MIN) return { error: `urls must contain ${COMPARE_MIN}-${COMPARE_MAX} product URLs (comma-separated urls= or repeated url=)` };
  if (urls.length > COMPARE_MAX) return { error: `too many URLs: ${urls.length} (max ${COMPARE_MAX})` };
  const products = [], seen = new Set();
  for (const [i, u] of urls.entries()) {
    const p = parse(u);
    if (p.error) return { error: `url #${i + 1}: ${p.error}` };
    const key = `${p.source}:${p.product_id}`;
    if (seen.has(key)) return { error: `url #${i + 1}: duplicate product ${p.product_id}` };
    seen.add(key); products.push(p);
  }
  return { products };
}
export function parseTargetPrice(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const s = raw.trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return n > 0 && n <= 1e9 ? r2(n) : null;
}

// ---------- compare ----------
// results: [{ p, value } | { p, error, hint }] in request order
export function compareProducts(results, now = Date.now()) {
  const items = results.map(({ p, value, error, hint }) => value ? {
    product_id: value.product_id, source: value.source, url: value.url, title: value.title ?? null,
    price: value.price?.amount ?? null, original_price: value.price?.original_amount ?? null, in_stock: value.in_stock ?? null,
    rating: value.rating ?? null, reviews_count: value.reviews_count ?? null, data_source: value.data_source ?? null,
    ...(value.price?.as_of ? { price_as_of: value.price.as_of } : {}),
  } : {
    product_id: p.product_id, source: p.source, url: p.url, title: hint?.title ?? null, price: null, original_price: null,
    in_stock: hint?.in_stock ?? null, rating: hint?.rating ?? null, reviews_count: hint?.reviews_count ?? null,
    error: hint?.in_stock === false ? "out_of_stock_no_price" : "upstream_unavailable", detail: String(error ?? "").slice(0, 300),
  });
  const priced = items.filter((x) => typeof x.price === "number");
  const pick = (x) => x && { product_id: x.product_id, url: x.url, title: x.title, price: x.price };
  const cheapest = priced.reduce((a, b) => (a && a.price <= b.price ? a : b), null);
  const most = priced.reduce((a, b) => (a && a.price >= b.price ? a : b), null);
  const inStock = items.filter((x) => x.in_stock === true).length;
  return {
    count: items.length, succeeded: priced.length, items,
    cheapest: pick(cheapest), most_expensive: pick(most),
    price_diff: cheapest && most ? { abs: r2(most.price - cheapest.price), percent: cheapest.price > 0 ? r2(((most.price - cheapest.price) / cheapest.price) * 100) : null } : null,
    in_stock_count: inStock, all_in_stock: inStock === items.length, currency: "RUB", fetched_at: iso(now),
  };
}

// ---------- monitor ----------
// Choice: a known product that is out of stock with no price -> 200 {below_target:false, current_price:null, in_stock:false, note}
// (the answer "not below target, not buyable" is useful and billable); no product data at all -> null (route answers 502, not charged).
export function monitorResult({ value, hint, target, now = Date.now() }) {
  const base = { target_price: target, currency: "RUB", checked_at: iso(now) };
  if (value && typeof value.price?.amount === "number") {
    const cur = value.price.amount, oos = value.in_stock === false;
    const notes = [oos ? "Product is out of stock, so below_target is false regardless of the price." : null,
      value.price.as_of ? `Live price unavailable; current_price is the Wildberries weekly CDN price of ${value.price.as_of}.` : null].filter(Boolean);
    return { ...base, url: value.url, product_id: value.product_id, title: value.title ?? null,
      below_target: cur <= target && !oos, current_price: cur, original_price: value.price.original_amount ?? null,
      diff_abs: r2(cur - target), diff_percent: r2(((cur - target) / target) * 100), in_stock: value.in_stock ?? null,
      ...(notes.length ? { note: notes.join(" ") } : {}), product: value };
  }
  if (hint && hint.title && hint.in_stock === false) {
    return { ...base, url: hint.url, product_id: hint.product_id, title: hint.title, below_target: false, current_price: null,
      original_price: null, diff_abs: null, diff_percent: null, in_stock: false,
      note: "Product is out of stock and has no current price; below_target is false until it is back in stock.", product: hint };
  }
  return null;
}

// ---------- history ----------
// weekly: [{date:'YYYY-MM-DD', price}] (WB CDN); observed: [{at:ms, price}]; live: product value or null
export function buildHistory({ p, weekly = [], observed = [], live = null, now = Date.now() }) {
  const pts = [
    ...weekly.map((x) => ({ date: x.date, ts: Date.parse(x.date + "T00:00:00Z"), price: x.price, source: "weekly_cdn" })),
    ...observed.map((x) => ({ date: iso(x.at), ts: x.at, price: x.price, source: "observed" })),
  ];
  const liveOk = live && typeof live.price?.amount === "number" && !live.price.as_of;
  if (liveOk) pts.push({ date: live.fetched_at || iso(now), ts: Date.parse(live.fetched_at) || now, price: live.price.amount, source: "live" });
  pts.sort((a, b) => a.ts - b.ts);
  // drop an observed point identical to the live one (the live fetch itself was just recorded as an observation)
  const points = pts.filter((x, i) => !(x.source === "observed" && liveOk && x.price === live.price.amount && Math.abs(x.ts - (Date.parse(live.fetched_at) || now)) < 60_000));
  if (!points.length) return null;
  const current = liveOk ? { price: live.price.amount, original_price: live.price.original_amount ?? null, source: "live", date: live.fetched_at || iso(now) }
    : { price: points[points.length - 1].price, original_price: null, source: points[points.length - 1].source, date: points[points.length - 1].date };
  const prices = points.map((x) => x.price);
  const cutoff = now - 30 * 86400e3;
  const ref = [...points].reverse().find((x) => x.ts <= cutoff);
  const limited = weekly.length === 0 && points.length <= 1;
  const notes = [];
  if (limited) notes.push("Only the current price is available: no Wildberries weekly price history was found for this product, and observed prices are kept in memory only since the last server restart.");
  if (!liveOk) notes.push("Live price unavailable right now; current is the latest historical point.");
  const lastWeekly = weekly[weekly.length - 1];
  if (liveOk && lastWeekly && (live.price.amount / lastWeekly.price > 5 || lastWeekly.price / live.price.amount > 5))
    notes.push("The live price differs from the weekly CDN history by more than 5x; the weekly series may belong to an earlier listing or variant of this product id.");
  return {
    url: p.url, product_id: p.product_id, source: p.source, title: live?.title ?? null, currency: "RUB",
    current, points: points.map(({ date, price, source }) => ({ date, price, source })),
    stats: { min: Math.min(...prices), max: Math.max(...prices), avg: r2(prices.reduce((a, b) => a + b, 0) / prices.length), count: prices.length,
      from: points[0].date, to: points[points.length - 1].date },
    change_30d: ref ? { vs_date: ref.date, vs_price: ref.price, abs: r2(current.price - ref.price), percent: r2(((current.price - ref.price) / ref.price) * 100) } : null,
    history_limited: limited, ...(notes.length ? { note: notes.join(" ") } : {}),
    sources: { weekly_cdn: weekly.length, observed: points.filter((x) => x.source === "observed").length, live: liveOk ? 1 : 0 },
    checked_at: iso(now),
  };
}
