// Pure helpers (no browser): URL validation, proxy parsing, and mapping marketplace payloads to one flat shape.
export const num = (v) => { if (v === null || v === undefined || v === "") return null; const n = Number(String(v).replace(/[\s\u00a0\u2009]/g, "").replace(",", ".")); return Number.isFinite(n) ? n : null; };
const kop = (v) => { const n = num(v); return n === null ? null : Math.round(n) / 100; };

export function parseTarget(raw) {
  if (typeof raw !== "string" || !raw.trim()) return { error: "url is required" };
  if (raw.length > 2000) return { error: "url too long" };
  let u; try { u = new URL(raw.trim()); } catch { return { error: "url is not a valid http(s) URL" }; }
  if (!/^https?:$/.test(u.protocol)) return { error: "url is not a valid http(s) URL" };
  const h = u.hostname.toLowerCase().replace(/\.$/, "");
  if (/(^|\.)(wildberries\.ru|wb\.ru)$/.test(h)) {
    const m = /\/catalog\/(\d{4,12})(?:\/|$)/.exec(u.pathname);
    if (!m) return { error: "no Wildberries product id found (expected /catalog/<digits>/)" };
    return { source: "wildberries", product_id: m[1], url: `https://www.wildberries.ru/catalog/${m[1]}/detail.aspx` };
  }
  if (/(^|\.)ozon\.ru$/.test(h)) {
    const m = /\/product\/(?:[a-z0-9-]*?-)?(\d{4,12})\/?$/i.exec(u.pathname.replace(/\/+$/, "/").replace(/\/$/, ""));
    if (!m) return { error: "no Ozon product id found (expected /product/<slug>-<digits>/)" };
    return { source: "ozon", product_id: m[1], url: `https://www.ozon.ru/product/${m[1]}/` };
  }
  return { error: "unsupported host: only wildberries.ru / wb.ru and ozon.ru product URLs" };
}

// PROXY_URL: http(s)://user:pass@host:port or socks5(h)://user:pass@host:port
export function parseProxyUrl(raw) {
  if (!raw || !String(raw).trim()) return null;
  let u; try { u = new URL(String(raw).trim()); } catch { throw new Error("PROXY_URL is not a valid URL"); }
  const scheme = u.protocol.replace(":", "");
  if (!["http", "https", "socks5", "socks5h"].includes(scheme)) throw new Error(`unsupported proxy scheme ${scheme}`);
  return { scheme, host: u.hostname, port: u.port || (scheme.startsWith("socks") ? "1080" : scheme === "https" ? "443" : "3128"),
    username: decodeURIComponent(u.username || ""), password: decodeURIComponent(u.password || "") };
}
export function maskSecrets(text, cfg) {
  let s = String(text ?? "").replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, "$1***@");
  for (const x of [cfg?.password, cfg?.username, cfg?.password && encodeURIComponent(cfg.password)]) if (x && x.length >= 3) s = s.split(x).join("***");
  return s;
}

// WB card JSON (www.wildberries.ru/__internal/u-card/cards/v4/detail, same shape as card.wb.ru v4). Prices are in kopecks.
export function mapWbCard(json, id) {
  const list = json?.products || json?.data?.products || [];
  const p = list.find((x) => String(x?.id) === String(id)) || (id ? null : list[0]);
  if (!p) return null;
  const sizes = Array.isArray(p.sizes) ? p.sizes : [];
  const prices = sizes.map((s) => s?.price).filter(Boolean);
  const cur = prices.map((x) => kop(x.product ?? x.total)).filter((x) => x !== null);
  const base = prices.map((x) => kop(x.basic)).filter((x) => x !== null);
  const price = cur.length ? Math.min(...cur) : kop(p.salePriceU ?? p.priceU);
  const old = base.length ? Math.max(...base) : kop(p.priceU);
  let qty = num(p.totalQuantity);
  if (qty === null && sizes.some((s) => Array.isArray(s.stocks))) qty = sizes.reduce((a, s) => a + (s.stocks || []).reduce((b, x) => b + (num(x.qty) || 0), 0), 0);
  return {
    title: p.name || null, brand: p.brand || null, seller: p.supplier || null,
    price, old_price: old !== null && price !== null && old > price ? old : null, currency: "RUB",
    rating: num(p.reviewRating ?? p.nmReviewRating ?? p.rating), reviews_count: num(p.feedbacks ?? p.nmFeedbacks),
    in_stock: qty === null ? (prices.length ? true : null) : qty > 0, stock_qty: qty,
  };
}

// schema.org Product in <script type="application/ld+json"> (generic DOM fallback for both sites).
export function mapLdJson(html) {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (let m; (m = re.exec(String(html || "")));) {
    let d; try { d = JSON.parse(m[1].trim()); } catch { continue; }
    const p = (Array.isArray(d) ? d : d["@graph"] || [d]).flat().find((x) => x && /Product/i.test(String(x["@type"])));
    if (!p) continue;
    const off = (Array.isArray(p.offers) ? p.offers[0] : p.offers) || {};
    const avail = String(off.availability || "");
    return { title: p.name || null, brand: (typeof p.brand === "object" ? p.brand?.name : p.brand) || null,
      seller: (typeof off.seller === "object" ? off.seller?.name : off.seller) || null,
      price: num(off.price ?? off.lowPrice), old_price: null, currency: off.priceCurrency || "RUB",
      rating: num(p.aggregateRating?.ratingValue), reviews_count: num(p.aggregateRating?.reviewCount ?? p.aggregateRating?.ratingCount),
      in_stock: /InStock|LimitedAvailability|PreOrder/i.test(avail) ? true : /OutOfStock|SoldOut|Discontinued/i.test(avail) ? false : null };
  }
  return null;
}

// Ozon entrypoint-api page JSON: widgetStates is a map of "<widget>-<id>-<n>" -> JSON string.
export function mapOzonWidgets(json) {
  const ws = json?.widgetStates; if (!ws || typeof ws !== "object") return null;
  const get = (prefix) => { for (const [k, v] of Object.entries(ws)) if (k.startsWith(prefix)) { try { return JSON.parse(v); } catch { return null; } } return null; };
  const price = get("webPrice-"), head = get("webProductHeading-"), score = get("webReviewProductScore-"), out = get("webOutOfStock-");
  const r = { title: head?.title || null, price: num(price?.cardPrice ?? price?.price), old_price: num(price?.originalPrice), currency: "RUB",
    rating: num(score?.totalScore), reviews_count: num(score?.reviewsCount), in_stock: out ? false : price ? (price.isAvailable ?? true) : null,
    brand: null, seller: null };
  if (r.old_price !== null && r.price !== null && r.old_price <= r.price) r.old_price = null;
  return r.title || r.price !== null ? r : null;
}

// Merge partial results: first non-null wins per field.
export function merge(...parts) {
  const out = {};
  for (const p of parts) if (p) for (const [k, v] of Object.entries(p)) if (out[k] === undefined || out[k] === null) out[k] = v;
  return out;
}

export function classifyBlock(source, { status, title = "", html = "" }) {
  if (source === "ozon" && (/Antibot Captcha/i.test(title) || /abt-challenge\/captcha/i.test(html))) return "ozon_captcha";
  if (source === "ozon" && (/Похоже, нет соединения|Доступ ограничен/i.test(title) || /abt-challenge/i.test(html))) return "ozon_antibot";
  if (source === "wildberries" && status === 498) return "wb_challenge_unsolved";
  return null;
}
