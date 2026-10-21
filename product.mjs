// Product lookup for GET /product/info (Wildberries, Ozon). Pure URL parsing + best-effort upstream fetch.
// Every failure throws UpstreamError -> the route answers 502, which the x402 v2 middleware never settles.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const TOTAL_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 10 * 60_000, NEG_TTL_MS = 60_000, CACHE_MAX = 500;
const WB_DEST = "-1257786"; // Moscow
const PRICE_HISTORY_MAX_AGE_MS = 60 * 86400e3; // static-CDN fallback: refuse prices older than 60 days

export class UpstreamError extends Error {
  constructor(detail, attempts = []) { super(detail); this.detail = detail; this.attempts = attempts; }
}

// ---------- URL validation ----------
const hostIs = (h, base) => h === base || h.endsWith("." + base);
export function parseProductUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) return { error: "url is required" };
  if (raw.length > 2000) return { error: "url too long (max 2000 chars)" };
  let u;
  try { u = new URL(raw.trim()); } catch { return { error: "url is not a valid http(s) URL" }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { error: "url is not a valid http(s) URL" };
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (hostIs(host, "wildberries.ru") || hostIs(host, "wb.ru")) {
    const m = /\/catalog\/(\d{1,12})(?:\/|$)/.exec(u.pathname);
    if (!m) return { error: "no Wildberries product id found (expected /catalog/<digits>/)" };
    const id = String(Number(m[1]));
    return { source: "wildberries", product_id: id, url: `https://www.wildberries.ru/catalog/${id}/detail.aspx` };
  }
  if (hostIs(host, "ozon.ru")) {
    const m = /\/product\/(?:[^/]*?-)?(\d{3,14})(?:\/|$)/.exec(u.pathname) || /\/(\d{3,14})\/?$/.exec(u.pathname);
    if (!m) return { error: "no Ozon product id found (expected /product/<slug>-<digits>/)" };
    const slugPath = /^\/product\/[^/]+/.exec(u.pathname)?.[0] || `/product/${m[1]}`;
    return { source: "ozon", product_id: m[1], url: `https://www.ozon.ru${slugPath}/`, path: `${slugPath}/` };
  }
  return { error: "unsupported host: only wildberries.ru / wb.ru and ozon.ru product URLs" };
}

// ---------- HTTP helper with a shared deadline ----------
async function get(url, deadline, { headers = {}, attempts, label, redirect = "follow" } = {}) {
  const left = deadline - Date.now();
  if (left < 300) { attempts.push(`${label}: skipped (deadline)`); return null; }
  try {
    const r = await fetch(url, { redirect, signal: AbortSignal.timeout(Math.min(left, 7000)),
      headers: { "User-Agent": UA, "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8", ...headers } });
    if (!r.ok && !(redirect === "manual" && r.status >= 300 && r.status < 400)) {
      attempts.push(`${label}: HTTP ${r.status}`); await r.body?.cancel().catch(() => {}); return null;
    }
    return r;
  } catch (e) { attempts.push(`${label}: ${e.name === "TimeoutError" ? "timeout" : e.message}`); return null; }
}
async function getJson(url, deadline, opts) {
  const r = await get(url, deadline, { ...opts, headers: { Accept: "application/json, text/plain, */*", ...opts.headers } });
  if (!r) return null;
  try { return await r.json(); } catch { opts.attempts.push(`${opts.label}: invalid JSON`); return null; }
}

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const rub = (kop) => (num(kop) === null ? null : Math.round(Number(kop)) / 100);
const availability = (inStock) => (inStock === true ? "in_stock" : inStock === false ? "out_of_stock" : "unknown");

// ---------- JSON-LD (Product) ----------
export function productFromJsonLd(html) {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (let m; (m = re.exec(html));) {
    let d; try { d = JSON.parse(m[1].trim()); } catch { continue; }
    const list = (Array.isArray(d) ? d : d["@graph"] || [d]).flat();
    const p = list.find((x) => x && /Product/i.test(String(x["@type"])));
    if (!p) continue;
    const off = Array.isArray(p.offers) ? p.offers[0] : p.offers || {};
    const price = num(off.price ?? off.lowPrice);
    const avail = String(off.availability || "");
    const inStock = /InStock|LimitedAvailability|PreOrder/i.test(avail) ? true : /OutOfStock|SoldOut|Discontinued/i.test(avail) ? false : null;
    return { title: p.name || null, price, currency: off.priceCurrency || "RUB",
      rating: num(p.aggregateRating?.ratingValue), reviews_count: num(p.aggregateRating?.reviewCount ?? p.aggregateRating?.ratingCount), in_stock: inStock };
  }
  return null;
}

// ---------- Wildberries ----------
export function parseWbCard(json) {
  const p = (json?.products || json?.data?.products || [])[0];
  if (!p) return null;
  const sizes = Array.isArray(p.sizes) ? p.sizes : [];
  const priced = sizes.map((s) => s.price).filter(Boolean);
  let amount = null, original = null;
  if (priced.length) { amount = Math.min(...priced.map((x) => rub(x.product ?? x.total)).filter((x) => x !== null)); original = Math.max(...priced.map((x) => rub(x.basic)).filter((x) => x !== null)); }
  if (!Number.isFinite(amount)) amount = rub(p.salePriceU ?? p.priceU); // v1/v2 legacy fields
  if (!Number.isFinite(original)) original = rub(p.priceU);
  let qty = num(p.totalQuantity);
  if (qty === null && sizes.some((s) => Array.isArray(s.stocks))) qty = sizes.reduce((a, s) => a + (s.stocks || []).reduce((b, x) => b + (num(x.qty) || 0), 0), 0);
  const inStock = qty === null ? null : qty > 0;
  return { title: [p.brand, p.name].filter(Boolean).join(" / ") || null, amount: Number.isFinite(amount) ? amount : null,
    original: Number.isFinite(original) && original > amount ? original : null,
    rating: num(p.reviewRating ?? p.rating), reviews_count: num(p.feedbacks ?? p.nmFeedbacks), in_stock: inStock };
}

// vol -> basket host ranges (WB static CDN); unknown/new ranges are probed.
const WB_BASKETS = [143, 287, 431, 719, 1007, 1061, 1115, 1169, 1313, 1601, 1655, 1919, 2045, 2189, 2405, 2621, 2837, 3053, 3269, 3485,
  3701, 3917, 4133, 4349, 4565, 4877, 5189, 5501, 5813, 6125, 6437, 6749, 7061, 7373, 7685, 7997, 8309, 8741, 9173, 9605];
export function wbBasketHost(nm) {
  const vol = Math.floor(nm / 1e5), i = WB_BASKETS.findIndex((max) => vol <= max);
  return String(i === -1 ? WB_BASKETS.length + 1 : i + 1).padStart(2, "0");
}
const basketBase = (b, nm) => `https://basket-${b}.wbbasket.ru/vol${Math.floor(nm / 1e5)}/part${Math.floor(nm / 1e3)}/${nm}/info`;

async function fetchWildberries(id, deadline, attempts) {
  const wbHeaders = { Origin: "https://www.wildberries.ru", Referer: `https://www.wildberries.ru/catalog/${id}/detail.aspx` };
  // 1) public card API (full data: price, rating, feedbacks, stock)
  for (const [label, url] of [
    ["card.wb.ru v4", `https://card.wb.ru/cards/v4/detail?appType=1&curr=rub&dest=${WB_DEST}&spp=30&nm=${id}`],
    ["card.wb.ru v2", `https://card.wb.ru/cards/v2/detail?appType=1&curr=rub&dest=${WB_DEST}&spp=30&nm=${id}`],
    ["card.wb.ru v1", `https://card.wb.ru/cards/v1/detail?appType=1&curr=rub&dest=${WB_DEST}&spp=30&nm=${id}`],
  ]) {
    const j = await getJson(url, deadline, { attempts, label, headers: wbHeaders });
    if (!j) continue;
    const c = parseWbCard(j);
    if (!c) { attempts.push(`${label}: product not found`); continue; }
    if (c.amount === null) { attempts.push(`${label}: no price (sold out?)`); }
    return { ...c, data_source: label };
  }
  // 2) product page JSON-LD (usually an anti-bot challenge for non-browser clients)
  const page = await get(`https://www.wildberries.ru/catalog/${id}/detail.aspx`, deadline, { attempts, label: "wb page", headers: { Accept: "text/html" } });
  if (page) {
    const ld = productFromJsonLd(await page.text());
    if (ld?.price) return { title: ld.title, amount: ld.price, original: null, rating: ld.rating, reviews_count: ld.reviews_count, in_stock: ld.in_stock, data_source: "wb page json-ld" };
    attempts.push("wb page: no Product JSON-LD (anti-bot page?)");
  }
  // 3) static CDN: card.json (title) + feedbacks (rating) + price-history.json (last weekly price; stock unknown)
  const nm = Number(id);
  let base = basketBase(wbBasketHost(nm), nm);
  let card = await getJson(`${base}/ru/card.json`, deadline, { attempts, label: "wb basket card" });
  if (!card) {
    const hosts = Array.from({ length: 45 }, (_, i) => String(i + 1).padStart(2, "0"));
    const probe = await Promise.any(hosts.map(async (b) => {
      const r = await fetch(`${basketBase(b, nm)}/ru/card.json`, { signal: AbortSignal.timeout(Math.max(500, Math.min(4000, deadline - Date.now()))), headers: { "User-Agent": UA } });
      if (!r.ok) throw new Error(String(r.status));
      return { b, json: await r.json() };
    })).catch(() => null);
    if (probe) { base = basketBase(probe.b, nm); card = probe.json; } else attempts.push("wb basket probe: product not found");
  }
  if (!card) return null;
  const [hist, fb] = await Promise.all([
    getJson(`${base}/price-history.json`, deadline, { attempts, label: "wb price-history" }),
    card.imt_id ? getJson(`https://feedbacks1.wb.ru/feedbacks/v1/${card.imt_id}`, deadline, { attempts, label: "wb feedbacks" }) : null,
  ]);
  const last = Array.isArray(hist) && hist.length ? hist[hist.length - 1] : null;
  if (!last?.price?.RUB) { attempts.push("wb basket: no price available"); return null; }
  if (Date.now() - last.dt * 1000 > PRICE_HISTORY_MAX_AGE_MS) { attempts.push(`wb price-history: last price is stale (${new Date(last.dt * 1000).toISOString().slice(0, 10)})`); return null; }
  return { title: [card.selling?.brand_name, card.imt_name].filter(Boolean).join(" / ") || null, amount: rub(last.price.RUB), original: null,
    price_as_of: new Date(last.dt * 1000).toISOString().slice(0, 10),
    rating: num(fb?.valuation), reviews_count: num(fb?.feedbackCount), in_stock: null, data_source: "wb static cdn (weekly price history)" };
}

// ---------- Ozon ----------
function pickCookies(res, jar) {
  for (const c of res.headers.getSetCookie?.() || []) { const kv = c.split(";")[0]; const k = kv.split("=")[0]; jar.set(k, kv); }
}
async function ozonGet(url, deadline, attempts, label, accept) {
  const jar = new Map();
  for (let hop = 0; hop < 4; hop++) {
    const r = await get(url, deadline, { attempts, label, redirect: "manual",
      headers: { Accept: accept, Cookie: [...jar.values()].join("; "), "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none", "Upgrade-Insecure-Requests": "1" } });
    if (!r) return null;
    pickCookies(r, jar);
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) { url = new URL(r.headers.get("location"), url).href; continue; }
    return r;
  }
  attempts.push(`${label}: redirect loop (anti-bot cookie challenge)`); return null;
}
export function parseOzonComposer(j) {
  for (const s of j?.seo?.script || []) {
    const ld = productFromJsonLd(`<script type="application/ld+json">${s.innerHTML}</script>`);
    if (ld) return ld;
  }
  return null;
}
async function fetchOzon(p, deadline, attempts) {
  const page = await ozonGet(`https://www.ozon.ru${p.path}`, deadline, attempts, "ozon page", "text/html,application/xhtml+xml");
  if (page) {
    const ld = productFromJsonLd(await page.text());
    if (ld?.price) return { ...ld, amount: ld.price, original: null, data_source: "ozon page json-ld" };
    attempts.push("ozon page: no Product JSON-LD (anti-bot page?)");
  }
  const api = await ozonGet(`https://www.ozon.ru/api/composer-api.bx/page/json/v2?url=${encodeURIComponent(p.path)}`, deadline, attempts, "ozon composer-api", "application/json");
  if (api) {
    let j = null; try { j = await api.json(); } catch { attempts.push("ozon composer-api: invalid JSON"); }
    const ld = parseOzonComposer(j);
    if (ld?.price) return { ...ld, amount: ld.price, original: null, data_source: "ozon composer-api json-ld" };
    if (j) attempts.push("ozon composer-api: no product data");
  }
  return null;
}

// ---------- public entry point ----------
const cache = new Map(); // key -> { at, ok, value|error }
export async function fetchProduct(p, { noCache = false } = {}) {
  const key = `${p.source}:${p.product_id}`, hit = cache.get(key);
  if (!noCache && hit && Date.now() - hit.at < (hit.ok ? CACHE_TTL_MS : NEG_TTL_MS)) {
    if (hit.ok) return { ...hit.value, cached: true };
    throw hit.error;
  }
  const deadline = Date.now() + TOTAL_TIMEOUT_MS, attempts = [];
  let r = null;
  try { r = p.source === "wildberries" ? await fetchWildberries(p.product_id, deadline, attempts) : await fetchOzon(p, deadline, attempts); }
  catch (e) { attempts.push(`error: ${e.message}`); }
  if (!r || r.amount === null || r.amount === undefined) {
    const err = new UpstreamError(`${p.source} did not return product data: ${attempts.join("; ") || "no data"}`, attempts);
    cache.set(key, { at: Date.now(), ok: false, error: err });
    throw err;
  }
  const value = {
    source: p.source, url: p.url, product_id: p.product_id, title: r.title ?? null,
    price: { amount: r.amount, currency: "RUB", ...(r.original ? { original_amount: r.original } : {}), ...(r.price_as_of ? { as_of: r.price_as_of } : {}) },
    rating: r.rating ?? null, reviews_count: r.reviews_count ?? null,
    availability: availability(r.in_stock), in_stock: r.in_stock ?? null,
    fetched_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"), data_source: r.data_source,
  };
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), ok: true, value });
  return { ...value, cached: false };
}
