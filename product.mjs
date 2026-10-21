// Product lookup for GET /product/info (Wildberries, Ozon). Pure URL parsing + best-effort upstream fetch.
// Every failure throws UpstreamError -> the route answers 502, which the x402 v2 middleware never settles.
// Optional proxy (proxy-config.mjs) is used for these marketplace fetches only.
import { parseProxyEnv, proxyDispatcher, maskSecrets, undiciFetch } from "./proxy-config.mjs";
import { parserConfigured, fetchViaParser } from "./parser-client.mjs";
import net from "node:net";
import tls from "node:tls";
import { createHash } from "node:crypto";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const TOTAL_TIMEOUT_MS = 10_000;
const PROXY_PHASE_MS = 9_000, DIRECT_FALLBACK_MS = 6_000; // only when a proxy is configured

let PROXY = parseProxyEnv(process.env);
export const proxyConfig = () => PROXY;
export function setProxyConfig(cfg) { PROXY = cfg; } // tests
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
// ctx = { deadline, attempts, via: "direct"|"proxy", proxyDead }
function doFetch(url, init, ctx) {
  if (ctx.via !== "proxy") return fetch(url, init);
  return undiciFetch(url, { ...init, dispatcher: proxyDispatcher(PROXY) });
}
// Walk the cause chain: undici reports proxy tunnel failures as "fetch failed <- Request was cancelled <- Proxy response (407) ..."
export function errText(e) {
  if (e?.name === "TimeoutError") return "timeout";
  const parts = [];
  for (let x = e, i = 0; x && i < 5; x = x.cause, i++) {
    const m = [x.code, x.message].filter(Boolean).join(" ");
    if (m && !parts.includes(m)) parts.push(m);
  }
  const t = parts.join(": ");
  const pr = /Proxy response \((\d{3})\)/.exec(t);
  return pr ? `proxy CONNECT rejected with HTTP ${pr[1]}${pr[1] === "407" ? " (proxy auth failed)" : ""} [${t}]` : t;
}
async function get(url, ctx, { headers = {}, label, redirect = "follow" } = {}) {
  const left = ctx.deadline - Date.now();
  if (left < 300) { ctx.attempts.push(`${label}: skipped (deadline)`); return null; }
  if (ctx.proxyDead) { ctx.attempts.push(`${label}: skipped (proxy unreachable)`); return null; }
  try {
    const r = await doFetch(url, { redirect, signal: AbortSignal.timeout(Math.min(left, 7000)),
      headers: { "User-Agent": UA, "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8", ...headers } }, ctx);
    if (!r.ok && !(redirect === "manual" && r.status >= 300 && r.status < 400)) {
      if (ctx.via === "proxy" && r.status === 407) ctx.proxyDead = true;
      ctx.attempts.push(`${label}: HTTP ${r.status}${r.status === 407 ? " (proxy auth failed)" : ""}`); await r.body?.cancel().catch(() => {}); return null;
    }
    return r;
  } catch (e) {
    if (ctx.via === "proxy" && e.name !== "TimeoutError") ctx.proxyDead = true; // connect/tunnel/auth error: stop using the proxy
    ctx.attempts.push(`${label}: ${errText(e)}`); return null;
  }
}
async function getJson(url, ctx, opts) {
  const r = await get(url, ctx, { ...opts, headers: { Accept: "application/json, text/plain, */*", ...opts.headers } });
  if (!r) return null;
  try { return await r.json(); } catch { ctx.attempts.push(`${opts.label}: invalid JSON`); return null; }
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

async function fetchWildberries(id, ctx, { staticCdn = true } = {}) {
  const { attempts } = ctx;
  const wbHeaders = { Origin: "https://www.wildberries.ru", Referer: `https://www.wildberries.ru/catalog/${id}/detail.aspx` };
  // 1) public card API (full data: price, rating, feedbacks, stock)
  for (const [label, url] of [
    ["card.wb.ru v4", `https://card.wb.ru/cards/v4/detail?appType=1&curr=rub&dest=${WB_DEST}&spp=30&nm=${id}`],
    ["card.wb.ru v2", `https://card.wb.ru/cards/v2/detail?appType=1&curr=rub&dest=${WB_DEST}&spp=30&nm=${id}`],
    ["card.wb.ru v1", `https://card.wb.ru/cards/v1/detail?appType=1&curr=rub&dest=${WB_DEST}&spp=30&nm=${id}`],
  ]) {
    const j = await getJson(url, ctx, { label, headers: wbHeaders });
    if (!j) continue;
    const c = parseWbCard(j);
    if (!c) { attempts.push(`${label}: product not found`); continue; }
    if (c.amount === null) { attempts.push(`${label}: no price (sold out?)`); }
    return { ...c, data_source: label };
  }
  // 2) product page JSON-LD (usually an anti-bot challenge for non-browser clients)
  const page = await get(`https://www.wildberries.ru/catalog/${id}/detail.aspx`, ctx, { label: "wb page", headers: { Accept: "text/html" } });
  if (page) {
    const ld = productFromJsonLd(await page.text());
    if (ld?.price) return { title: ld.title, amount: ld.price, original: null, rating: ld.rating, reviews_count: ld.reviews_count, in_stock: ld.in_stock, data_source: "wb page json-ld" };
    attempts.push("wb page: no Product JSON-LD (anti-bot page?)");
  }
  if (!staticCdn) return null;
  // 3) static CDN: card.json (title) + feedbacks (rating) + price-history.json (last weekly price; stock unknown)
  const nm = Number(id);
  let base = basketBase(wbBasketHost(nm), nm);
  let card = await getJson(`${base}/ru/card.json`, ctx, { label: "wb basket card" });
  if (!card && !ctx.proxyDead) {
    const hosts = Array.from({ length: 45 }, (_, i) => String(i + 1).padStart(2, "0"));
    const probe = await Promise.any(hosts.map(async (b) => {
      const r = await doFetch(`${basketBase(b, nm)}/ru/card.json`, { signal: AbortSignal.timeout(Math.max(500, Math.min(4000, ctx.deadline - Date.now()))), headers: { "User-Agent": UA } }, ctx);
      if (!r.ok) throw new Error(String(r.status));
      return { b, json: await r.json() };
    })).catch(() => null);
    if (probe) { base = basketBase(probe.b, nm); card = probe.json; } else attempts.push("wb basket probe: product not found");
  }
  if (!card) return null;
  const [hist, fb] = await Promise.all([
    getJson(`${base}/price-history.json`, ctx, { label: "wb price-history" }),
    card.imt_id ? getJson(`https://feedbacks1.wb.ru/feedbacks/v1/${card.imt_id}`, ctx, { label: "wb feedbacks" }) : null,
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
async function ozonGet(url, ctx, label, accept) {
  const { attempts } = ctx;
  const jar = new Map();
  for (let hop = 0; hop < 4; hop++) {
    const r = await get(url, ctx, { label, redirect: "manual",
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
async function fetchOzon(p, ctx) {
  const { attempts } = ctx;
  const page = await ozonGet(`https://www.ozon.ru${p.path}`, ctx, "ozon page", "text/html,application/xhtml+xml");
  if (page) {
    const ld = productFromJsonLd(await page.text());
    if (ld?.price) return { ...ld, amount: ld.price, original: null, data_source: "ozon page json-ld" };
    attempts.push("ozon page: no Product JSON-LD (anti-bot page?)");
  }
  const api = await ozonGet(`https://www.ozon.ru/api/composer-api.bx/page/json/v2?url=${encodeURIComponent(p.path)}`, ctx, "ozon composer-api", "application/json");
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
  // 1) Headless-browser parser (passes WB/Ozon JS challenges), when PARSER_URL + PARSER_TOKEN are set.
  let browserAttempt = null, browserHint = null;
  if (parserConfigured()) {
    try {
      const b = await fetchViaParser(p);
      if (b.value) {
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
        cache.set(key, { at: Date.now(), ok: true, value: b.value });
        return { ...b.value, cached: false };
      }
      browserHint = b.hint; browserAttempt = `[browser] no price (${b.hint.availability})`;
    } catch (e) { browserAttempt = `[browser] ${e.message}`; }
  }
  // 2) Existing proxy/direct HTTP chain (unchanged).
  const run = async (via, budgetMs, staticCdn) => {
    const ctx = { deadline: Date.now() + budgetMs, attempts: [], via, proxyDead: false };
    let r = null;
    try { r = p.source === "wildberries" ? await fetchWildberries(p.product_id, ctx, { staticCdn }) : await fetchOzon(p, ctx); }
    catch (e) { ctx.attempts.push(`error: ${errText(e)}`); }
    return { r: r && r.amount !== null && r.amount !== undefined ? { ...r, via } : null, attempts: ctx.attempts };
  };
  const useProxy = PROXY.configured && PROXY.scope.has(p.source === "wildberries" ? "wb" : "ozon");
  let r, attempts;
  if (!useProxy) {
    ({ r, attempts } = await run("direct", TOTAL_TIMEOUT_MS, true)); // unchanged behaviour without a proxy
  } else {
    // Proxy first: live card API / Ozon page+composer (static CDN only if there is no direct fallback).
    const a = await run("proxy", PROXY_PHASE_MS, !PROXY.fallbackDirect);
    r = a.r; attempts = a.attempts.map((x) => `[proxy] ${x}`);
    if (!r && PROXY.fallbackDirect) {
      const b = await run("direct", DIRECT_FALLBACK_MS, true);
      r = b.r; attempts = [...attempts, ...b.attempts.map((x) => `[direct] ${x}`)];
    }
    attempts = attempts.map((x) => maskSecrets(x, PROXY));
  }
  if (browserAttempt) attempts = [browserAttempt, ...(attempts || [])];
  if (!r) {
    const err = new UpstreamError(`${p.source} did not return product data: ${attempts.join("; ") || "no data"}`, attempts);
    cache.set(key, { at: Date.now(), ok: false, error: err });
    throw err;
  }
  const value = {
    source: p.source, url: p.url, product_id: p.product_id, title: r.title ?? null,
    price: { amount: r.amount, currency: "RUB", ...(r.original ? { original_amount: r.original } : {}), ...(r.price_as_of ? { as_of: r.price_as_of } : {}) },
    rating: r.rating ?? null, reviews_count: r.reviews_count ?? null,
    availability: availability(r.in_stock), in_stock: r.in_stock ?? null,
    fetched_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"), data_source: r.data_source, via: r.via,
  };
  if (browserHint && browserHint.in_stock === false) { value.availability = "out_of_stock"; value.in_stock = false; } // live stock from the browser
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), ok: true, value });
  return { ...value, cached: false };
}

// Raw CONNECT to the proxy (plain TCP; https:// proxies via TLS) -> the proxy's own reply (status line, headers, body head).
async function rawConnect(target = "api.ipify.org:443") {
  const opts = { host: PROXY.host, port: Number(PROXY.port), servername: PROXY.host };
  const auth = PROXY.username ? `Proxy-Authorization: Basic ${Buffer.from(`${PROXY.username}:${PROXY.password}`).toString("base64")}\r\n` : "";
  return new Promise((resolve) => {
    let buf = "", done = false;
    const finish = (txt) => { if (done) return; done = true; try { sock.destroy(); } catch {} resolve(txt); };
    const sock = PROXY.scheme === "https" ? tls.connect(opts) : net.connect(opts);
    sock.setTimeout(8000, () => finish(`timeout; got: ${buf.slice(0, 300)}`));
    sock.on("error", (e) => finish(`socket error: ${e.code || e.message}`));
    sock.on(PROXY.scheme === "https" ? "secureConnect" : "connect", () =>
      sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}User-Agent: x402-news-diag\r\n\r\n`));
    sock.on("data", (d) => { buf += d.toString("latin1"); if (/\r\n\r\n/.test(buf) && (buf.length > 600 || !/^HTTP\/1\.[01] 4/.test(buf))) finish(buf.slice(0, 600)); setTimeout(() => finish(buf.slice(0, 600)), 1500); });
    sock.on("end", () => finish(buf.slice(0, 600)));
  });
}

// ---------- admin diagnostics (token-gated route, not in OpenAPI): proxy egress + raw marketplace answers ----------
export async function proxyDiagnostics() {
  const targets = [
    ["egress", "https://ipinfo.io/json"],
    ["wb card v4", `https://card.wb.ru/cards/v4/detail?appType=1&curr=rub&dest=${WB_DEST}&spp=30&nm=211695539`],
    ["wb page", "https://www.wildberries.ru/catalog/211695539/detail.aspx"],
    ["wb basket", "https://basket-14.wbbasket.ru/vol2116/part211695/211695539/info/ru/card.json"],
    ["ozon page", "https://www.ozon.ru/product/apple-smartfon-iphone-16-esim-sim-8-128-gb-nano-sim-siniy-1720312800/"],
  ];
  const keep = ["server", "content-type", "status-no-id", "x-wbaas-token", "x-guardium-token", "location", "x-squid-error", "via"];
  const u = PROXY.username || "";
  const out = { proxy_configured: PROXY.configured, scheme: PROXY.scheme || null, port: PROXY.port || null,
    proxy_host_domain: PROXY.host ? PROXY.host.split(".").slice(-2).join(".") : null, // registrable domain only
    username_hints: PROXY.configured ? { length: u.length, has_country_ru: /country[-_=]?ru/i.test(u), has_session: /sess|sid/i.test(u),
      separators: [...new Set(u.replace(/[A-Za-z0-9]/g, ""))].join("") } : null,
    username_sha256_8: PROXY.configured ? createHash("sha256").update(u).digest("hex").slice(0, 8) : null,
    password_hints: PROXY.password ? { length: PROXY.password.length, has_lower: /[a-z]/.test(PROXY.password), has_upper: /[A-Z]/.test(PROXY.password),
      has_digit: /\d/.test(PROXY.password), non_alnum_count: PROXY.password.replace(/[A-Za-z0-9]/g, "").length,
      has_whitespace: /\s/.test(PROXY.password) } : null,
    raw_connect: PROXY.configured && !PROXY.scheme.startsWith("socks") ? maskSecrets(await rawConnect(), PROXY) : null,
    results: [] };
  for (const via of PROXY.configured ? ["proxy", "direct"] : ["direct"]) {
    for (const [name, url] of targets) {
      const t = Date.now(), row = { via, name };
      try {
        const r = await doFetch(url, { redirect: "manual", signal: AbortSignal.timeout(8000),
          headers: { "User-Agent": UA, "Accept-Language": "ru-RU,ru;q=0.9", Accept: "*/*" } }, { via });
        row.status = r.status;
        row.headers = Object.fromEntries(keep.filter((h) => r.headers.has(h)).map((h) => [h, r.headers.get(h).slice(0, 120)]));
        const body = await r.text();
        if (name === "egress") {
          try { const j = JSON.parse(body); row.egress = { country: j.country, org: j.org, is_proxy_host: j.ip === PROXY.host }; } catch { row.body = body.slice(0, 120); }
        } else row.body_head = body.replace(/\s+/g, " ").slice(0, 160);
      } catch (e) { row.error = errText(e); }
      row.ms = Date.now() - t;
      out.results.push(JSON.parse(maskSecrets(JSON.stringify(row), PROXY)));
    }
  }
  return out;
}
