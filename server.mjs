// x402-paid MarketTwits news API
// Free:  GET / (service index + price list), GET /health, GET /news/sample, GET /openapi.json
// Paid:  GET /news/latest?limit=N, /news/important, /news/search?q=   (x402 v2, exact scheme, PRICE each)
//        GET /news/alerts/check ($0.004), /news/summary ($0.008), /news/top-topics ($0.005)
//        GET /news/summary/recent ($0.007), /news/alerts/new ($0.005), /news/topics/trending ($0.004)
//        GET /product/info?url= ($0.004)  Wildberries / Ozon product card (502 on upstream failure -> never settled)
// Admin: POST /ingest  (Authorization: Bearer <INGEST_TOKEN>)
import express from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { createFacilitatorConfig } from "@coinbase/x402";
import { declareDiscoveryExtension, bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { parseProductUrl, fetchProduct, UpstreamError, proxyConfig, proxyDiagnostics, fetchWbPriceHistory, getObservations } from "./product.mjs";
import { parseCompareInput, parseTargetPrice, compareProducts, monitorResult, buildHistory, COMPARE_MAX } from "./product-analytics.mjs";
import { describeProxy } from "./proxy-config.mjs";
import { parserConfigured } from "./parser-client.mjs";
import { parseTerms, matchesTerms, parseNumParam, isoSec, buildSummary, topTopics, recentSummary, alertsNew, trending,
  parseFloatParam, parseCursorId, newsSince, normalizeCountryCode, countryNews, movers, dataSurprises, sentiment, digest } from "./news-logic.mjs";
import { parseIsoDate, parseCodes, parseTicker, parseIndexCodes, getFx, getKeyRate, getQuote, getIndex, getMovers, getFuel } from "./ru-data.mjs";
import { normalizeChannel, parseChannelList, channelLatest, channelSearch } from "./tg.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4021);
const HOST = process.env.HOST || "0.0.0.0";
const NEWS_FILE = path.resolve(HERE, process.env.NEWS_FILE || "data/news.jsonl");
const PAY_TO = (process.env.PAY_TO_ADDRESS || "").trim();
const DEV_MODE = process.env.DEV_MODE === "1";
const NETWORK = process.env.X402_NETWORK || "eip155:8453"; // Base mainnet (eip155:84532 = Base Sepolia)
const FACILITATOR_URL = process.env.FACILITATOR_URL || "https://x402.org/facilitator";
const CDP_API_KEY_ID = (process.env.CDP_API_KEY_ID || "").trim();
const CDP_API_KEY_SECRET = (process.env.CDP_API_KEY_SECRET || "").trim();
const USE_CDP = Boolean(CDP_API_KEY_ID && CDP_API_KEY_SECRET);
const FACILITATOR_TYPE = USE_CDP ? "cdp" : (FACILITATOR_URL.includes("x402.org") ? "x402.org" : "custom");
const TESTNETS = new Set(["eip155:84532"]);
const PRICE = process.env.PRICE || "$0.003";
const INGEST_TOKEN = (process.env.INGEST_TOKEN || "").trim();
const MAX_ITEMS = 500;

if (PAY_TO && !/^0x[0-9a-fA-F]{40}$/.test(PAY_TO)) {
  console.error(`PAY_TO_ADDRESS is not a valid EVM address: ${PAY_TO}`);
  process.exit(1);
}
if (!PAY_TO && !DEV_MODE) {
  console.error("PAY_TO_ADDRESS is not set. Refusing to start.\n" +
    "Set PAY_TO_ADDRESS=0x... for paid mode, or DEV_MODE=1 for an UNPAID local dev server.");
  process.exit(1);
}
if (PAY_TO && !USE_CDP && FACILITATOR_TYPE === "x402.org" && !TESTNETS.has(NETWORK)) {
  console.error(`Network ${NETWORK} needs a mainnet facilitator: set CDP_API_KEY_ID and CDP_API_KEY_SECRET ` +
    "(x402.org facilitator is testnet-only), or set X402_NETWORK=eip155:84532 for testnet.");
  process.exit(1);
}
const MODE = PAY_TO ? "paid" : "dev-unpaid";

// ---------- store: in-memory (newest MAX_ITEMS) + best-effort JSONL persistence ----------
const store = new Map(); // id -> item
let fileMtime = 0;
const ts = (it) => Date.parse(it.published_at) || 0;
const sorted = () => [...store.values()].sort((a, b) => ts(b) - ts(a) || b.id - a.id);

function trim() {
  if (store.size <= MAX_ITEMS) return;
  for (const it of sorted().slice(MAX_ITEMS)) store.delete(it.id);
}

function normalize(raw) {
  if (!raw || typeof raw !== "object") throw new Error("item must be an object");
  const id = Number(raw.id);
  if (!Number.isInteger(id) || id <= 0) throw new Error("id must be a positive integer");
  if (typeof raw.published_at !== "string" || Number.isNaN(Date.parse(raw.published_at))) throw new Error(`published_at invalid for ${id}`);
  const importance = String(raw.importance || "").toLowerCase();
  if (!["high", "medium", "low"].includes(importance)) throw new Error(`importance invalid for ${id}`);
  if (typeof raw.text_en !== "string" || !raw.text_en.trim()) throw new Error(`text_en missing for ${id}`);
  return {
    id,
    source_url: raw.source_url || `https://t.me/markettwits/${id}`,
    published_at: raw.published_at,
    importance,
    text_en: raw.text_en.trim(),
    posted_to_x: Boolean(raw.posted_to_x),
    buffer_post_id: raw.buffer_post_id || null,
    stored_at: raw.stored_at || new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  };
}

// (Re)load file if it changed (lets a local writer such as store_news.py feed the server too)
function syncFromFile() {
  let st;
  try { st = fs.statSync(NEWS_FILE); } catch { return; }
  if (st.mtimeMs === fileMtime) return;
  fileMtime = st.mtimeMs;
  for (const line of fs.readFileSync(NEWS_FILE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { const it = normalize(JSON.parse(line)); if (!store.has(it.id)) store.set(it.id, it); } catch { /* skip bad line */ }
  }
  trim();
}

function persist(items) {
  try {
    fs.mkdirSync(path.dirname(NEWS_FILE), { recursive: true });
    fs.appendFileSync(NEWS_FILE, items.map((i) => JSON.stringify(i)).join("\n") + "\n");
    fileMtime = fs.statSync(NEWS_FILE).mtimeMs;
  } catch (e) { console.error("persist failed (ignored):", e.message); }
}

function readNews() { syncFromFile(); return sorted(); }
const publicItem = ({ id, source_url, published_at, importance, text_en }) => ({ id, source_url, published_at, importance, text_en });

function tokenOk(header) {
  if (!INGEST_TOKEN) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header || "");
  if (!m) return false;
  const a = crypto.createHash("sha256").update(m[1].trim()).digest();
  const b = crypto.createHash("sha256").update(INGEST_TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

// ---------- app ----------
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true); // behind Render / tunnel: use X-Forwarded-Proto/Host for resource URLs

app.get("/health", (_req, res) => {
  const items = readNews();
  res.json({ ok: true, mode: MODE, network: NETWORK, facilitator: FACILITATOR_TYPE, price: PRICE, items: items.length, newest_id: items[0]?.id ?? null, ingest: INGEST_TOKEN ? "enabled" : "disabled",
    proxy_configured: proxyConfig().configured, parser_configured: parserConfigured() }); // never the proxy/parser host or credentials
});

app.get("/news/sample", (_req, res) => {
  const it = readNews()[0];
  res.json({
    description: `Translated MarketTwits (t.me/markettwits) market news in English. Full feed: GET /news/latest?limit=N (x402, ${PRICE} USDC on ${NETWORK}).`,
    item: it ? { ...publicItem(it), text_en: it.text_en.length > 80 ? it.text_en.slice(0, 80) + "…" : it.text_en } : null,
  });
});

// ---------- OpenAPI discovery (x402scan / @agentcash/discovery v1 structured x-payment-info) ----------
const PUBLIC_URL = (process.env.PUBLIC_URL || "").trim().replace(/\/+$/, "");
const DEFAULT_PUBLIC_URL = "https://x402-markettwits-news.onrender.com";
const PRICE_USD = String(PRICE).replace(/^\$/, "").trim();
const assetInfo = new Map(); // price -> { asset, amount } resolved once from @x402/evm (USDC address for NETWORK)
async function resolveAsset(price = PRICE) {
  if (assetInfo.has(price)) return assetInfo.get(price);
  let info;
  try {
    const r = await new ExactEvmScheme().parsePrice(price, NETWORK);
    info = { asset: r.asset, amount: r.amount, decimals: 6, name: r.extra?.name || "USDC" };
  } catch { info = { asset: null, amount: null }; }
  assetInfo.set(price, info);
  return info;
}
const NEWS_ITEM_SCHEMA = {
  type: "object",
  required: ["id", "source_url", "published_at", "importance", "text_en"],
  properties: {
    id: { type: "integer", description: "Telegram post id in t.me/markettwits", examples: [389638] },
    source_url: { type: "string", format: "uri", description: "Original Russian post" },
    published_at: { type: "string", format: "date-time", description: "Publication time of the original post (ISO 8601)" },
    importance: { type: "string", enum: ["high", "medium", "low"] },
    text_en: { type: "string", description: "English translation of the post" },
    posted_to_x: { type: "boolean", description: "Whether the item was also posted to X" },
    buffer_post_id: { type: ["string", "null"], description: "Buffer post id when posted to X, else null" },
  },
};

// Same schema without "format" keywords (the bazaar validator's Ajv has no format plugin and warns)
const NEWS_ITEM_SCHEMA_NOFMT = JSON.parse(JSON.stringify(NEWS_ITEM_SCHEMA, (k, v) => (k === "format" ? undefined : v)));

const FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#0052ff"/>' +
  '<text x="32" y="43" font-family="Arial,sans-serif" font-size="30" font-weight="700" fill="#fff" text-anchor="middle">MT</text></svg>';
app.get(["/favicon.svg", "/favicon.ico"], (_req, res) => res.type("image/svg+xml").set("Cache-Control", "public, max-age=86400").send(FAVICON_SVG));

// ---------- paid route definitions (shared by x402 middleware, Bazaar extension and OpenAPI) ----------
const LIMIT_PARAM = { type: "integer", minimum: 1, maximum: 50, default: 20, description: "Number of items (newest first)" };
const Q_PARAM = { type: "string", minLength: 1, maxLength: 100,
  description: "Keywords (case-insensitive). Several words = all must match. Hashtags match with or without '#', e.g. 'oil', '#Fed rates'." };
const EXAMPLE_ITEM = { id: 389638, source_url: "https://t.me/markettwits/389638", published_at: "2026-10-20T12:20:00Z",
  importance: "high", text_en: "French government bond yields near 24-year high ahead of protests (Reuters)" };
const HOURS_PARAM = (def, max) => ({ type: "integer", minimum: 1, maximum: max, default: def,
  description: `Look-back window in hours (default ${def}, clamped to 1-${max})` });
const SUMMARY_LIMIT_PARAM = { type: "integer", minimum: 1, maximum: 50, default: 10, description: "Number of latest matching items to summarize (default 10, max 50)" };
const NOFMT = (sch) => JSON.parse(JSON.stringify(sch, (k, v) => (k === "format" ? undefined : v)));
const SHORT_ITEM_SCHEMA = { type: "object", required: ["id", "published_at", "importance", "source_url"], properties: {
  id: NEWS_ITEM_SCHEMA.properties.id, published_at: NEWS_ITEM_SCHEMA.properties.published_at,
  importance: NEWS_ITEM_SCHEMA.properties.importance, source_url: NEWS_ITEM_SCHEMA.properties.source_url } };
const ALERT_ITEM_SCHEMA = { ...SHORT_ITEM_SCHEMA, required: [...SHORT_ITEM_SCHEMA.required, "text_en"],
  properties: { ...SHORT_ITEM_SCHEMA.properties, text_en: NEWS_ITEM_SCHEMA.properties.text_en } };
const ALERTS_OUTPUT_SCHEMA = { type: "object", required: ["query", "hours", "count", "since", "latest_id", "latest_published_at", "items"],
  properties: {
    query: { type: "string" }, hours: { type: "integer", description: "Window actually used (1-168)" },
    count: { type: "integer", description: "Matching items published within the window" },
    since: { type: "string", format: "date-time", description: "Window start (now - hours)" },
    latest_id: { type: ["integer", "null"] }, latest_published_at: { type: ["string", "null"], format: "date-time" },
    items: { type: "array", maxItems: 5, items: ALERT_ITEM_SCHEMA, description: "Up to 5 most recent matching items in the window" },
  } };
const SUMMARY_OUTPUT_SCHEMA = { type: "object", required: ["query", "count", "summary", "items"],
  properties: {
    query: { type: "string" }, count: { type: "integer", description: "Number of matching items summarized" },
    summary: { type: "string", description: "Extractive English summary, 3-5 sentences (lead + de-duplicated headlines)" },
    items: { type: "array", items: SHORT_ITEM_SCHEMA },
  } };
const TOPICS_OUTPUT_SCHEMA = { type: "object", required: ["hours", "items_considered", "topics", "fallback"],
  properties: {
    hours: { type: "integer", description: "Window actually used (1-72)" },
    items_considered: { type: "integer", description: "High-importance items analysed" },
    topics: { type: "array", maxItems: 5, items: { type: "object", required: ["topic", "count"],
      properties: { topic: { type: "string" }, count: { type: "integer", description: "Number of items mentioning the topic" } } } },
    fallback: { type: "boolean", description: "true when no high item fell in the window and the last 20 high items were used" },
    note: { type: "string", description: "Explanation when fallback is true" },
  } };
const RECENT_OUTPUT_SCHEMA = { type: "object", required: ["query", "hours", "since", "count", "high_count", "summary", "items"],
  properties: {
    query: { type: "string" }, hours: { type: "integer", description: "Window actually used (1-168)" },
    since: { type: "string", format: "date-time", description: "Window start (now - hours)" },
    count: { type: "integer", description: "Matching items in the window that were summarized (max 50)" },
    high_count: { type: "integer", description: "How many of them are importance=high" },
    summary: { type: "string", description: "Extractive English summary, 3-5 sentences; 'No news matched \"q\" in the last N hours.' when count is 0" },
    items: { type: "array", maxItems: 50, items: SHORT_ITEM_SCHEMA },
  } };
const ALERTS_NEW_OUTPUT_SCHEMA = { type: "object", required: ["query", "hours", "since", "has_new", "count", "latest"],
  properties: {
    query: { type: "string" }, hours: { type: "integer", description: "Window actually used (1-168)" },
    since: { type: "string", format: "date-time", description: "Window start (now - hours)" },
    has_new: { type: "boolean", description: "true when at least one HIGH-importance item matched q in the window" },
    count: { type: "integer", description: "Number of matching HIGH-importance items in the window" },
    latest: { oneOf: [{ type: "object", required: ["id", "published_at", "text_en", "source_url"], properties: {
      id: NEWS_ITEM_SCHEMA.properties.id, published_at: NEWS_ITEM_SCHEMA.properties.published_at,
      text_en: NEWS_ITEM_SCHEMA.properties.text_en, source_url: NEWS_ITEM_SCHEMA.properties.source_url } }, { type: "null" }],
      description: "Most recent matching HIGH item, or null" },
  } };
const TRENDING_OUTPUT_SCHEMA = { type: "object", required: ["hours", "items_considered", "fallback", "topics"],
  properties: {
    hours: { type: "integer", description: "Window actually used (1-72)" },
    items_considered: { type: "integer", description: "High-importance items analysed in the current window" },
    fallback: { type: "boolean", description: "true when no high item fell in the window: the last 20 high items were used and compared with the 20 before them" },
    note: { type: "string", description: "Explanation when fallback is true" },
    topics: { type: "array", maxItems: 5, items: { type: "object", required: ["topic", "count", "prev_count", "change", "latest_id"],
      properties: {
        topic: { type: "string" }, count: { type: "integer", description: "Items mentioning the topic in the last N hours" },
        prev_count: { type: "integer", description: "Items mentioning it in the previous window of equal length" },
        change: { type: "integer", description: "count - prev_count (positive = rising)" },
        latest_id: { type: "integer", description: "id of the newest item mentioning the topic" },
        latest_source_url: { type: "string", format: "uri", description: "Source URL of that item" },
      } } },
  } };
const PRODUCT_URL_PARAM = { type: "string", minLength: 10, maxLength: 2000,
  description: "Product page URL: https://www.wildberries.ru/catalog/<id>/detail.aspx (also wb.ru, *.wildberries.ru) or https://www.ozon.ru/product/<slug>-<id>/ (also *.ozon.ru)" };
const PRODUCT_OUTPUT_SCHEMA = { type: "object",
  required: ["source", "url", "product_id", "title", "price", "rating", "reviews_count", "availability", "in_stock", "fetched_at"],
  properties: {
    source: { type: "string", enum: ["wildberries", "ozon"] },
    url: { type: "string", format: "uri", description: "Canonical product URL" },
    product_id: { type: "string", description: "Marketplace product id (WB nm id / Ozon SKU)" },
    title: { type: ["string", "null"] },
    price: { type: "object", required: ["amount", "currency"], properties: {
      amount: { type: "number", description: "Current price in RUB" }, currency: { type: "string", enum: ["RUB"] },
      original_amount: { type: "number", description: "List price before discount, when known" },
      as_of: { type: "string", description: "Only for the Wildberries static-CDN fallback: date of the weekly price point (YYYY-MM-DD)" } } },
    rating: { type: ["number", "null"], description: "Average rating 0-5" },
    reviews_count: { type: ["integer", "null"] },
    availability: { type: "string", enum: ["in_stock", "out_of_stock", "unknown"] },
    in_stock: { type: ["boolean", "null"] },
    fetched_at: { type: "string", format: "date-time" },
    data_source: { type: "string", description: "Which upstream answered (e.g. card.wb.ru v4, ozon page json-ld)" },
    via: { type: "string", enum: ["browser", "proxy", "direct"], description: "How the marketplace was reached: headless-browser parser, the server's proxy, or directly" },
    cached: { type: "boolean", description: "true when served from the 10-minute cache" },
  } };
const UPSTREAM_502 = (what) => ({ 502: { description: `${what} The x402 payment is not settled.`,
  content: { "application/json": { schema: { type: "object", required: ["error"], properties: {
    error: { type: "string", enum: ["upstream_unavailable"] }, detail: { type: "string" } } } } } } });
const NUMN = { type: ["number", "null"] };
const COMPARE_ITEM_SCHEMA = { type: "object", required: ["product_id", "url", "title", "price", "in_stock"], properties: {
  product_id: { type: "string" }, source: { type: "string", enum: ["wildberries", "ozon"] }, url: { type: "string", format: "uri" },
  title: { type: ["string", "null"] }, price: { ...NUMN, description: "Current price, RUB (null when this item failed)" },
  original_price: { ...NUMN, description: "List price before discount, when known" }, in_stock: { type: ["boolean", "null"] },
  rating: NUMN, reviews_count: { type: ["integer", "null"] }, data_source: { type: ["string", "null"] },
  price_as_of: { type: "string", description: "Only when the price came from the weekly CDN fallback" },
  error: { type: "string", enum: ["upstream_unavailable", "out_of_stock_no_price"], description: "Present only on failed items" },
  detail: { type: "string" } } };
const PICK_SCHEMA = { type: ["object", "null"], properties: { product_id: { type: "string" }, url: { type: "string" }, title: { type: ["string", "null"] }, price: { type: "number" } } };
const COMPARE_OUTPUT_SCHEMA = { type: "object",
  required: ["count", "succeeded", "items", "cheapest", "most_expensive", "price_diff", "in_stock_count", "all_in_stock", "fetched_at"],
  properties: {
    count: { type: "integer" }, succeeded: { type: "integer", description: "Items that returned a price (>= 2, else 502)" },
    items: { type: "array", items: COMPARE_ITEM_SCHEMA, description: "In request order; failed items carry error/detail" },
    cheapest: PICK_SCHEMA, most_expensive: PICK_SCHEMA,
    price_diff: { type: ["object", "null"], properties: { abs: { type: "number", description: "most_expensive - cheapest, RUB" },
      percent: { ...NUMN, description: "abs / cheapest * 100" } } },
    in_stock_count: { type: "integer" }, all_in_stock: { type: "boolean", description: "true only if every requested item is in stock" },
    currency: { type: "string", enum: ["RUB"] }, fetched_at: { type: "string", format: "date-time" } } };
const MONITOR_OUTPUT_SCHEMA = { type: "object",
  required: ["below_target", "current_price", "target_price", "diff_abs", "diff_percent", "in_stock", "checked_at", "product_id", "url"],
  properties: {
    url: { type: "string", format: "uri" }, product_id: { type: "string" }, title: { type: ["string", "null"] },
    below_target: { type: "boolean", description: "current_price <= target_price and the product is not out of stock (false when there is no current price)" },
    current_price: { ...NUMN, description: "RUB; null only when the product is out of stock with no price" },
    original_price: NUMN, target_price: { type: "number" }, currency: { type: "string", enum: ["RUB"] },
    diff_abs: { ...NUMN, description: "current_price - target_price (negative = below target)" },
    diff_percent: { ...NUMN, description: "diff_abs / target_price * 100" },
    in_stock: { type: ["boolean", "null"] }, note: { type: "string" },
    product: { type: "object", description: "Full /product/info-style product object" },
    checked_at: { type: "string", format: "date-time" } } };
const HISTORY_OUTPUT_SCHEMA = { type: "object", required: ["product_id", "url", "current", "points", "stats", "change_30d", "history_limited", "checked_at"],
  properties: {
    url: { type: "string", format: "uri" }, product_id: { type: "string" }, source: { type: "string" }, title: { type: ["string", "null"] },
    currency: { type: "string", enum: ["RUB"] },
    current: { type: "object", properties: { price: { type: "number" }, original_price: NUMN,
      source: { type: "string", enum: ["live", "weekly_cdn", "observed"] }, date: { type: "string" } } },
    points: { type: "array", description: "Oldest first", items: { type: "object", required: ["date", "price", "source"], properties: {
      date: { type: "string", description: "YYYY-MM-DD for weekly_cdn points, ISO date-time for observed/live" },
      price: { type: "number" }, source: { type: "string", enum: ["weekly_cdn", "observed", "live"] } } } },
    stats: { type: "object", properties: { min: { type: "number" }, max: { type: "number" }, avg: { type: "number" }, count: { type: "integer" },
      from: { type: "string" }, to: { type: "string" } } },
    change_30d: { type: ["object", "null"], description: "current vs. the latest point at least 30 days old (null if none)", properties: {
      vs_date: { type: "string" }, vs_price: { type: "number" }, abs: { type: "number" }, percent: { type: "number" } } },
    history_limited: { type: "boolean", description: "true when only the current price is available" }, note: { type: "string" },
    sources: { type: "object", properties: { weekly_cdn: { type: "integer" }, observed: { type: "integer" }, live: { type: "integer" } } },
    checked_at: { type: "string", format: "date-time" } } };
const PRODUCT_URLS_PARAM = { type: "string", minLength: 20, maxLength: 10000,
  description: `2-${COMPARE_MAX} comma-separated product URLs (Wildberries; Ozon is accepted but currently blocked by its anti-bot). ` +
    "Alternatively repeat url= instead." };
const TARGET_PRICE_PARAM = { type: "string", pattern: "^[0-9]+([.,][0-9]+)?$", description: "Target price in RUB, a positive number (e.g. 1500 or 1499.90)" };
// ---------- news v3 (since / movers / country / data-surprises / sentiment / digest) ----------
const BRIEF_SCHEMA = { type: "object", required: ["id", "published_at", "importance", "headline", "source_url"], properties: {
  ...SHORT_ITEM_SCHEMA.properties, headline: { type: "string", description: "First meaningful line, emoji removed" } } };
const TOPIC_COUNT_SCHEMA = { type: "array", items: { type: "object", properties: { topic: { type: "string" }, count: { type: "integer" } } } };
const SINCE_ID_PARAM = { type: "string", pattern: "^[0-9]{1,15}$", description: "Last item id you already have (0 = from the oldest stored item). Items with a larger id are returned, oldest first." };
const SINCE_LIMIT_PARAM = { type: "integer", minimum: 1, maximum: 100, default: 50, description: "Max items per page (default 50, max 100)" };
const MIN_PCT_PARAM = { type: "string", pattern: "^[0-9]+([.,][0-9]+)?$", default: "0", description: "Minimum absolute move in percent (default 0, max 100), e.g. 3 or 2.5" };
const COUNTRY_PARAM = { type: "string", pattern: "^[A-Za-z]{2}$", description: "ISO 3166-1 alpha-2 country code (e.g. US, RU, CN, UA, IR, GB; UK = GB; EU accepted)" };
const IMPORTANCE_PARAM = { type: "string", enum: ["all", "high", "medium", "low"], default: "all", description: "Importance filter (default all)" };
const Q_OPT_PARAM = { ...Q_PARAM, description: "Optional keyword filter (same matching as /news/search)" };
const SINCE_OUTPUT_SCHEMA = { type: "object", required: ["since_id", "count", "has_more", "next_id", "items"], properties: {
  since_id: { type: "integer" }, count: { type: "integer" }, has_more: { type: "boolean", description: "More items after this page: call again with id=next_id" },
  next_id: { type: "integer", description: "Pass as id= on the next call (= since_id when nothing new)" },
  latest_id: { type: ["integer", "null"], description: "Newest id in the store" }, items: { type: "array", items: NEWS_ITEM_SCHEMA, description: "Oldest first" } } };
const MOVER_SCHEMA = { type: "object", required: ["ticker", "pct", "id", "published_at"], properties: {
  ticker: { type: "string" }, name: { type: ["string", "null"] }, pct: { type: "number", description: "Reported move in percent (signed)" },
  country: { type: ["string", "null"], description: "ISO code from the flag before the ticker" }, id: { type: "integer" },
  published_at: { type: "string", format: "date-time" }, importance: { type: "string" }, source_url: { type: "string", format: "uri" }, headline: { type: "string" } } };
const MOVERS_OUTPUT_SCHEMA = { type: "object", required: ["hours", "min_pct", "since", "tickers_found", "gainers", "losers"], properties: {
  hours: { type: "integer" }, min_pct: { type: "number" }, since: { type: "string", format: "date-time" },
  tickers_found: { type: "integer", description: "Distinct tickers with a '#TICKER = ±X%' mention in the window (newest mention per ticker)" },
  gainers: { type: "array", items: MOVER_SCHEMA, description: "Top 10, largest first" }, losers: { type: "array", items: MOVER_SCHEMA, description: "Top 10, most negative first" } } };
const COUNTRY_OUTPUT_SCHEMA = { type: "object", required: ["code", "hours", "count", "high_count", "latest", "top_topics"], properties: {
  code: { type: "string" }, flag: { type: ["string", "null"] }, hours: { type: "integer" }, importance: { type: "string" }, since: { type: "string", format: "date-time" },
  count: { type: "integer" }, high_count: { type: "integer" }, by_flag: { type: "integer", description: "Matches by flag emoji (the rest by country keywords)" },
  share_of_window: { type: "number", description: "Percent of all items in the window" }, top_topics: TOPIC_COUNT_SCHEMA,
  latest: { type: "array", items: BRIEF_SCHEMA, description: "Up to 10, newest first" } } };
const SURPRISE_SCHEMA = { type: "object", required: ["kind", "indicator", "actual", "expected", "surprise", "direction", "id"], properties: {
  kind: { type: "string", enum: ["macro", "earnings"] }, indicator: { type: "string" }, ticker: { type: "string" },
  actual: { type: "number" }, expected: { type: "number" }, previous: NUMN, unit: { type: ["string", "null"], description: "%, M, B, K, $, '% m/m' ..." },
  surprise: { type: "number", description: "actual - expected (same unit)" }, surprise_pct: { ...NUMN, description: "surprise / |expected| * 100" },
  direction: { type: "string", enum: ["above", "below", "inline"] }, id: { type: "integer" }, published_at: { type: "string", format: "date-time" },
  importance: { type: "string" }, source_url: { type: "string", format: "uri" } } };
const SURPRISES_OUTPUT_SCHEMA = { type: "object", required: ["hours", "count", "above", "below", "items"], properties: {
  hours: { type: "integer" }, query: { type: ["string", "null"] }, since: { type: "string", format: "date-time" }, count: { type: "integer" },
  above: { type: "integer" }, below: { type: "integer" }, items: { type: "array", items: SURPRISE_SCHEMA, description: "Newest first, max 50" } } };
const SCORED_SCHEMA = { ...BRIEF_SCHEMA, properties: { ...BRIEF_SCHEMA.properties, score: { type: "number" } } };
const SENTIMENT_OUTPUT_SCHEMA = { type: "object", required: ["query", "hours", "count", "bullish", "bearish", "neutral", "score", "label", "method"], properties: {
  query: { type: "string" }, hours: { type: "integer" }, since: { type: "string", format: "date-time" }, count: { type: "integer" },
  bullish: { type: "integer" }, bearish: { type: "integer" }, neutral: { type: "integer" },
  score: { type: "number", minimum: -1, maximum: 1, description: "(bullish - bearish) / count" },
  label: { type: "string", enum: ["bullish", "bearish", "neutral", "no_data"] }, method: { type: "string", enum: ["heuristic"] }, note: { type: "string" },
  examples: { type: "object", properties: { bullish: { type: "array", items: SCORED_SCHEMA }, bearish: { type: "array", items: SCORED_SCHEMA } } } } };
const DIGEST_SECTION_SCHEMA = { type: "object", properties: { count: { type: "integer" }, high_count: { type: "integer" }, items: { type: "array", items: BRIEF_SCHEMA } } };
const DIGEST_OUTPUT_SCHEMA = { type: "object", required: ["hours", "count", "sections", "top_topics"], properties: {
  hours: { type: "integer" }, since: { type: "string", format: "date-time" }, count: { type: "integer" }, high_count: { type: "integer" },
  sections: { type: "object", properties: Object.fromEntries(["central_banks", "macro", "energy", "equities", "crypto", "geopolitics"].map((k) => [k, DIGEST_SECTION_SCHEMA])) },
  unclassified_count: { type: "integer" }, top_topics: TOPIC_COUNT_SCHEMA, note: { type: "string" } } };
const EX_BRIEF = { id: 389795, published_at: "2026-10-21T10:02:00Z", importance: "high", headline: "SPCX = +9%: SpaceX posted a quarterly profit for the first time", source_url: "https://t.me/markettwits/389795" };
// ---------- RU market data + Telegram (cbr.ru, iss.moex.com, rosstat.gov.ru, t.me) ----------
const STR = { type: "string" }, STRN = { type: ["string", "null"] }, INT = { type: "integer" }, NUM = { type: "number" }, INTN = { type: ["integer", "null"] };
const META_PROPS = { source: STR, via: { type: "string", enum: ["direct", "proxy"] }, cached: { type: "boolean" },
  stale: { type: "boolean", description: "true when the upstream failed and a recent cached copy was served" }, fetched_at: { type: "string", format: "date-time" } };
const NOT_FOUND_404 = (what) => ({ 404: { description: `${what} The x402 payment is not settled.`,
  content: { "application/json": { schema: { type: "object", required: ["error"], properties: { error: { type: "string", enum: ["not_found"] }, detail: STR } } } } } });
const FX_RATE_SCHEMA = { type: "object", required: ["code", "nominal", "value", "per_unit"], properties: { code: STR, name: STRN, nominal: INT,
  value: { type: "number", description: "RUB per `nominal` units" }, per_unit: { type: "number", description: "RUB per 1 unit" },
  prev_per_unit: NUMN, change: NUMN, change_pct: NUMN } };
const FX_OUTPUT_SCHEMA = { type: "object", required: ["base", "date", "count", "rates"], properties: { ...META_PROPS, base: { type: "string", enum: ["RUB"] },
  date: { type: "string", format: "date", description: "Date the official rates are set for" }, requested_date: STRN, previous_date: STRN,
  count: INT, rates: { type: "array", items: FX_RATE_SCHEMA }, missing: { type: "array", items: STR, description: "Requested codes CBR does not quote" }, note: STR } };
const KEYRATE_OUTPUT_SCHEMA = { type: "object", required: ["rate", "as_of", "changes"], properties: { ...META_PROPS, unit: STR,
  rate: { type: "number", description: "Current key rate, % per annum" }, as_of: { type: "string", format: "date" }, effective_since: STRN,
  previous_rate: NUMN, last_change_bp: INTN, months: INT, max_in_window: NUM, min_in_window: NUM,
  changes: { type: "array", description: "Rate changes in the window, newest first", items: { type: "object", properties: {
    date: { type: "string", format: "date" }, rate: NUM, prev_rate: NUM, change_bp: INT } } } } };
const QUOTE_OUTPUT_SCHEMA = { type: "object", required: ["ticker", "board", "price", "price_source", "delayed"], properties: { ...META_PROPS,
  ticker: STR, board: STR, short_name: STRN, name: STRN, isin: STRN, currency: STRN, lot_size: INTN,
  price: { ...NUMN, description: "Last trade, or previous close before the first trade of the session" },
  price_source: { type: "string", enum: ["last_trade", "previous_close"] }, last: NUMN, prev_close: NUMN, prev_date: STRN,
  change: NUMN, change_pct: NUMN, open: NUMN, high: NUMN, low: NUMN, bid: NUMN, offer: NUMN, waprice: NUMN, volume: NUMN, value_rub: NUMN,
  num_trades: INTN, market_cap_rub: NUMN, trading_status: STRN, updated_at: STRN, trade_date: STRN, note: STR,
  delayed: { type: "boolean", enum: [true] }, delay_minutes: INT, note_delay: STR } };
const INDEX_ITEM_SCHEMA = { type: "object", required: ["code"], properties: { code: STR, name: STRN, value: NUMN, prev_close: NUMN, change: NUMN, change_pct: NUMN,
  open: NUMN, high: NUMN, low: NUMN, month_change_pct: NUMN, year_change_pct: NUMN, annual_high: NUMN, annual_low: NUMN,
  value_traded_rub: NUMN, currency: STRN, trade_date: STRN, updated_at: STRN } };
const INDEX_OUTPUT_SCHEMA = { type: "object", required: ["mode", "count", "items"], properties: { ...META_PROPS,
  mode: { type: "string", enum: ["quote", "list"], description: "list when code=list (items are {code, name})" }, count: INT,
  items: { type: "array", items: INDEX_ITEM_SCHEMA }, missing: { type: "array", items: STR }, delayed: { type: "boolean" }, delay_minutes: INT, note_delay: STR } };
const MOEX_MOVER_SCHEMA = { type: "object", required: ["ticker", "pct"], properties: { ticker: STR, name: STRN, price: NUMN,
  pct: { type: "number", description: "Change vs previous close, %" }, value: { ...NUMN, description: "Turnover, RUB" }, prev_close: NUMN, updated_at: STRN, trade_date: STRN } };
const MOEX_MOVERS_OUTPUT_SCHEMA = { type: "object", required: ["mode", "gainers", "losers"], properties: { ...META_PROPS, board: STR,
  mode: { type: "string", enum: ["live", "previous_session"], description: "previous_session before the first trades of the day" },
  as_of: STRN, limit: INT, min_value_rub: NUM, universe: INT, advancers: INT, decliners: INT, unchanged: INT,
  gainers: { type: "array", items: MOEX_MOVER_SCHEMA }, losers: { type: "array", items: MOEX_MOVER_SCHEMA }, note: STR,
  delayed: { type: "boolean" }, delay_minutes: INT, note_delay: STR } };
const FUEL_PRICE_SCHEMA = { type: "object", required: ["fuel", "price", "as_of"], properties: {
  fuel: { type: "string", enum: ["ai92", "ai95", "ai98", "diesel", "petrol_avg"] }, name: STR, label_ru: STRN, price: { type: "number", description: "RUB per litre" },
  as_of: { type: "string", format: "date" }, prev_price: NUMN, prev_date: STRN, change: NUMN, change_pct: NUMN, change_4w_pct: NUMN, change_ytd_pct: NUMN,
  history: { type: "array", items: { type: "object", properties: { date: { type: "string", format: "date" }, price: NUM } } } } };
const FUEL_OUTPUT_SCHEMA = { type: "object", required: ["as_of", "unit", "prices", "source_url"], properties: { ...META_PROPS, source_url: { type: "string", format: "uri" },
  as_of: STRN, unit: STR, region: STR, prices: { type: "array", items: FUEL_PRICE_SCHEMA }, note: STR, stale_reason: STR } };
const TG_MSG_SCHEMA = { type: "object", required: ["id", "channel", "date", "text", "link"], properties: { id: INT, channel: STR,
  date: { type: ["string", "null"], format: "date-time" }, text: STR, views: INTN, views_raw: STRN, link: { type: "string", format: "uri" },
  media: { type: "array", items: { type: "string", enum: ["photo", "video", "document", "poll"] } }, edited: { type: "boolean" }, forwarded_from: STR } };
const TG_LATEST_OUTPUT_SCHEMA = { type: "object", required: ["channel", "count", "items"], properties: { ...META_PROPS, channel: STR, title: STRN,
  subscribers: INTN, subscribers_raw: STRN, count: INT, pages: INT, items: { type: "array", items: TG_MSG_SCHEMA, description: "Newest first" } } };
const TG_SEARCH_OUTPUT_SCHEMA = { type: "object", required: ["query", "channels", "count", "items", "per_channel"], properties: { ...META_PROPS,
  query: STR, channels: { type: "array", items: STR }, count: INT, items: { type: "array", items: TG_MSG_SCHEMA, description: "Merged, newest first" },
  per_channel: { type: "array", items: { type: "object", properties: { channel: STR, title: STRN, count: INT, error: STR, detail: STR } } }, note: STR } };
const FX_DATE_PARAM = { type: "string", format: "date", description: "Rates date YYYY-MM-DD (default: latest set by CBR; 1992-07-01 .. tomorrow)" };
const FX_CODES_PARAM = { type: "string", pattern: "^[A-Za-z]{3}(,[A-Za-z]{3}){0,29}$", description: "Comma-separated ISO currency codes (default: all ~55 CBR currencies), e.g. USD,EUR,CNY" };
const MONTHS_PARAM = { type: "integer", minimum: 1, maximum: 120, default: 24, description: "History window in months for `changes` (default 24, max 120)" };
const TICKER_PARAM = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,11}$", description: "MOEX ticker (SECID) on the shares market, e.g. SBER, GAZP, LKOH, YDEX, T" };
const INDEX_CODE_PARAM = { type: "string", pattern: "^([A-Za-z0-9]{2,16}(,[A-Za-z0-9]{2,16}){0,4}|list)$", default: "IMOEX",
  description: "Index code(s), up to 5 comma-separated (default IMOEX; e.g. RTSI, MOEXBMI, MOEXOG), or `list` for the catalogue of stock indices" };
const MOVERS_LIMIT_PARAM = { type: "integer", minimum: 1, maximum: 50, default: 10, description: "Gainers and losers to return (each side, default 10, max 50)" };
const MIN_VALUE_PARAM = { type: "string", pattern: "^[0-9]+([.,][0-9]+)?$", default: "5000000", description: "Minimum turnover in RUB to count a stock (default 5000000; filters illiquid names)" };
const WEEKS_PARAM = { type: "integer", minimum: 0, maximum: 52, default: 4, description: "Weekly history points to include per fuel (0-52, default 4)" };
const CHANNEL_PARAM = { type: "string", pattern: "^@?[A-Za-z][A-Za-z0-9_]{3,31}$", description: "Public Telegram channel username (5-32 chars; '@name' or a t.me link also accepted), e.g. markettwits" };
const CHANNELS_PARAM = { type: "string", description: "1-5 comma-separated public channel usernames, e.g. markettwits,rbc_news" };
const TG_LIMIT_PARAM = { type: "integer", minimum: 1, maximum: 50, default: 20, description: "Messages to return (default 20, max 50)" };
const DATA_502 = (what) => UPSTREAM_502(`${what} unreachable or returned an unexpected response.`);
const EX_T = "2026-10-20T12:20:00Z";
const PAID_ROUTES = [
  { path: "/news/latest", operationId: "getLatestNews", summary: "Latest translated MarketTwits news (newest first)",
    description: "Latest translated MarketTwits news (newest first), limit 1-50",
    params: { limit: LIMIT_PARAM }, required: [], example: { limit: 20 } },
  { path: "/news/important", operationId: "getImportantNews", summary: "High-importance news only (newest first)",
    description: "Only importance=high MarketTwits news (newest first), limit 1-50",
    params: { limit: LIMIT_PARAM }, required: [], example: { limit: 20 } },
  { path: "/news/search", operationId: "searchNews", summary: "Keyword search in translated news (newest first)",
    description: "Case-insensitive keyword search in translated MarketTwits news (all words must match), limit 1-50",
    params: { q: Q_PARAM, limit: LIMIT_PARAM }, required: ["q"], example: { q: "oil", limit: 20 }, badRequest: true },
  { path: "/news/alerts/check", operationId: "checkNewsAlert", price: "$0.004",
    summary: "Keyword alert check: how many matching items in the last N hours",
    description: "Count of news matching q (same matching as /news/search) published in the last N hours (1-168, default 24), plus the 5 most recent",
    params: { q: Q_PARAM, hours: HOURS_PARAM(24, 168) }, required: ["q"], example: { q: "oil", hours: 24 }, badRequest: true,
    outputSchema: ALERTS_OUTPUT_SCHEMA, ok200: "Alert check result (count 0 and items [] when nothing matched)",
    outputExample: { query: "oil", hours: 24, count: 1, since: "2026-10-19T12:20:00Z", latest_id: 389638, latest_published_at: EX_T,
      items: [EXAMPLE_ITEM] } },
  { path: "/news/summary", operationId: "summarizeNews", price: "$0.008",
    summary: "Short extractive English summary of the latest news on a keyword",
    description: "3-5 sentence extractive summary of the latest news matching q (limit 1-50, default 10): lead sentence + de-duplicated headlines, high-importance first",
    params: { q: Q_PARAM, limit: SUMMARY_LIMIT_PARAM }, required: ["q"], example: { q: "oil", limit: 10 }, badRequest: true,
    outputSchema: SUMMARY_OUTPUT_SCHEMA, ok200: "Summary (count 0 and a 'No recent news matched' summary when nothing matched)",
    outputExample: { query: "oil", count: 1, summary: `1 matching item for "oil" since 2026-10-20 12:20 UTC; 1 high-importance. ` +
      "Oil — API inventories: CRUDE = -4.931M (expected -1.3M / previous -11.12M). Most recent matching item published 2026-10-20 12:20 UTC.",
      items: [{ id: 389638, published_at: EX_T, importance: "high", source_url: "https://t.me/markettwits/389638" }] } },
  { path: "/news/top-topics", operationId: "getTopTopics", price: "$0.005",
    summary: "Top 5 keywords/hashtags in high-importance news of the last N hours",
    description: "Top 5 topics (hashtags, names, keywords; counted once per item) across high-importance news of the last N hours (1-72, default 6)",
    params: { hours: HOURS_PARAM(6, 72) }, required: [], example: { hours: 6 }, badRequest: true,
    badRequestText: "hours is not a number. Returned before payment.",
    outputSchema: TOPICS_OUTPUT_SCHEMA, ok200: "Top topics",
    outputExample: { hours: 6, items_considered: 12, topics: [{ topic: "Ukraine", count: 7 }, { topic: "Iran", count: 4 }], fallback: false } },
  { path: "/news/summary/recent", operationId: "summarizeRecentNews", price: "$0.007",
    summary: "Extractive English summary of news on a keyword from the last N hours",
    description: "3-5 sentence extractive summary of news matching q published in the last N hours (1-168, default 12; up to 50 items), " +
      "with high_count. Use for 'what happened with X today'.",
    params: { q: Q_PARAM, hours: HOURS_PARAM(12, 168) }, required: ["q"], example: { q: "Iran", hours: 12 }, badRequest: true,
    outputSchema: RECENT_OUTPUT_SCHEMA, ok200: "Summary of the window (count 0 and 'No news matched \"q\" in the last N hours.' when nothing matched)",
    outputExample: { query: "Iran", hours: 12, since: "2026-10-20T00:20:00Z", count: 1, high_count: 1,
      summary: `1 matching item for "Iran" since 2026-10-20 12:20 UTC; 1 high-importance. TRUMP: I HAVE TO MAKE A FINAL DECISION ON IRAN. ` +
        "Most recent matching item published 2026-10-20 12:20 UTC.",
      items: [{ id: 389638, published_at: EX_T, importance: "high", source_url: "https://t.me/markettwits/389638" }] } },
  { path: "/news/alerts/new", operationId: "checkNewHighAlert", price: "$0.005",
    summary: "Is there new HIGH-importance news on a keyword in the last N hours?",
    description: "Checks only importance=high news matching q in the last N hours (1-168, default 6): has_new, count and the latest item. " +
      "Cheap poll for market-moving alerts on a topic/ticker.",
    params: { q: Q_PARAM, hours: HOURS_PARAM(6, 168) }, required: ["q"], example: { q: "oil", hours: 6 }, badRequest: true,
    outputSchema: ALERTS_NEW_OUTPUT_SCHEMA, ok200: "Alert result (has_new false, count 0, latest null when nothing matched)",
    outputExample: { query: "oil", hours: 6, since: "2026-10-20T06:20:00Z", has_new: true, count: 1,
      latest: { id: 389638, published_at: EX_T, text_en: EXAMPLE_ITEM.text_en, source_url: EXAMPLE_ITEM.source_url } } },
  { path: "/news/topics/trending", operationId: "getTrendingTopics", price: "$0.004",
    summary: "Trending topics in high-importance news with change vs. the previous window",
    description: "Top 5 topics (hashtags, names, keywords; counted once per item) in high-importance news of the last N hours (1-72, default 6), " +
      "each with prev_count in the previous equal-length window, change = count - prev_count, and latest_id/latest_source_url",
    params: { hours: HOURS_PARAM(6, 72) }, required: [], example: { hours: 6 }, badRequest: true,
    badRequestText: "hours is not a number. Returned before payment.",
    outputSchema: TRENDING_OUTPUT_SCHEMA, ok200: "Trending topics",
    outputExample: { hours: 6, items_considered: 12, fallback: false, topics: [{ topic: "Iran", count: 6, prev_count: 2, change: 4,
      latest_id: 389638, latest_source_url: "https://t.me/markettwits/389638" }] } },
  { path: "/news/since", operationId: "getNewsSince", price: "$0.002",
    summary: "Incremental feed: items newer than the id you already have (cursor polling)",
    description: "All stored items with id > id (oldest first, up to limit 1-100, default 50) plus next_id/has_more for the next call. " +
      "The cheapest way for a bot to poll without duplicates: keep next_id and pass it back.",
    params: { id: SINCE_ID_PARAM, limit: SINCE_LIMIT_PARAM }, required: ["id"], example: { id: "389850", limit: 50 }, badRequest: true,
    badRequestText: "id missing (with a payment attached) or not a non-negative integer, or limit not a number. Returned before payment.",
    outputSchema: SINCE_OUTPUT_SCHEMA, ok200: "Items newer than id (count 0 and next_id = id when nothing new)",
    outputExample: { since_id: 389850, count: 1, has_more: false, next_id: 389858, latest_id: 389858,
      items: [{ id: 389858, source_url: "https://t.me/markettwits/389858", published_at: "2026-10-21T15:40:00Z", importance: "high", text_en: "⬆️🇷🇺#KLVZ = +16% PUTIN AND WITKOFF HAD A SUBSTANTIVE CONVERSATION - PESKOV" }] } },
  { path: "/news/movers", operationId: "getNewsMovers", price: "$0.005",
    summary: "Top gainers/losers reported in the news ('#TICKER = ±X%')",
    description: "Parses '#TICKER [Name] = ±X%' price-move mentions (stocks, indices, crypto; RU/US/... from the flag) in news of the last N hours " +
      "(1-72, default 6), newest mention per ticker, |move| >= min_pct (default 0): top 10 gainers and top 10 losers with the source item.",
    params: { hours: HOURS_PARAM(6, 72), min_pct: MIN_PCT_PARAM }, required: [], example: { hours: 6, min_pct: "2" }, badRequest: true,
    badRequestText: "hours or min_pct is not a number. Returned before payment.",
    outputSchema: MOVERS_OUTPUT_SCHEMA, ok200: "Movers (empty arrays when no moves were reported)",
    outputExample: { hours: 6, min_pct: 2, since: "2026-10-21T10:00:00Z", tickers_found: 3,
      gainers: [{ ticker: "KLVZ", name: null, pct: 16, country: "RU", id: 389858, published_at: "2026-10-21T15:40:00Z", importance: "high", source_url: "https://t.me/markettwits/389858", headline: "KLVZ = +16%: PUTIN AND WITKOFF HAD A SUBSTANTIVE CONVERSATION - PESKOV" }],
      losers: [{ ticker: "NFLX", name: "Netflix", pct: -6, country: "US", id: 389768, published_at: "2026-10-21T06:10:00Z", importance: "medium", source_url: "https://t.me/markettwits/389768", headline: "After-hours moves following earnings: SPCX SpaceX = +8%" }] } },
  { path: "/news/country", operationId: "getCountryNews", price: "$0.004",
    summary: "News about one country (flag emoji + country keywords) with counts and top topics",
    description: "Items of the last N hours (1-168, default 24; importance all|high|medium|low) that carry the country's flag emoji or mention it " +
      "(e.g. RU: Russia/Kremlin/Bank of Russia/MOEX; US: USA/Fed/White House): count, high_count, share_of_window, top_topics and the 10 latest headlines.",
    params: { code: COUNTRY_PARAM, hours: HOURS_PARAM(24, 168), importance: IMPORTANCE_PARAM }, required: ["code"], example: { code: "RU", hours: 24 }, badRequest: true,
    badRequestText: "code is not a 2-letter country code, importance not all|high|medium|low, or hours not a number. Returned before payment.",
    outputSchema: COUNTRY_OUTPUT_SCHEMA, ok200: "Country news (count 0 when nothing matched)",
    outputExample: { code: "RU", flag: "🇷🇺", hours: 24, importance: "all", since: "2026-10-20T16:00:00Z", count: 112, high_count: 31, by_flag: 93,
      share_of_window: 49.1, top_topics: [{ topic: "Russia", count: 40 }], latest: [EX_BRIEF] } },
  { path: "/news/data-surprises", operationId: "getDataSurprises", price: "$0.006",
    summary: "Macro data and earnings vs. expectations: actual, expected, previous, surprise",
    description: "Parses releases like 'US Pending Home Sales (Sep) = -7.3% m/m (exp. -0.5% / prev. +0.3%)' and earnings lines like " +
      "'3Q REV. $14.58B, EST. $12.87B' from news of the last N hours (1-168, default 24; optional q filter): indicator, actual, expected, previous, unit, " +
      "surprise (actual - expected), surprise_pct and direction above/below/inline.",
    params: { hours: HOURS_PARAM(24, 168), q: Q_OPT_PARAM }, required: [], example: { hours: 24, q: "CPI" }, badRequest: true,
    badRequestText: "hours is not a number, or q is present but empty/longer than 100 chars. Returned before payment.",
    outputSchema: SURPRISES_OUTPUT_SCHEMA, ok200: "Parsed surprises (count 0 when none)",
    outputExample: { hours: 24, query: null, since: "2026-10-20T16:00:00Z", count: 1, above: 1, below: 0, items: [{ kind: "macro",
      indicator: "UK - CONSUMER PRICE INFLATION CPI (Sep) — y/y", actual: 3.5, expected: 3.4, previous: 3.1, unit: "%", surprise: 0.1, surprise_pct: 2.9,
      direction: "above", id: 389757, published_at: "2026-10-21T06:00:00Z", importance: "high", source_url: "https://t.me/markettwits/389757" }] } },
  { path: "/news/sentiment", operationId: "getNewsSentiment", price: "$0.005",
    summary: "Heuristic bullish/bearish tone of news on a keyword (lexicon, not a model)",
    description: "Scores each item matching q in the last N hours (1-168, default 24) with a keyword/emoji lexicon (rise/beat/upgrade vs. fall/miss/sanctions, " +
      "⬆️/⬇️) plus explicit '= ±X%' moves, and returns bullish/bearish/neutral counts, score = (bullish - bearish)/count in [-1, 1], a label and examples. " +
      "method is always 'heuristic'.",
    params: { q: Q_PARAM, hours: HOURS_PARAM(24, 168) }, required: ["q"], example: { q: "oil", hours: 24 }, badRequest: true,
    outputSchema: SENTIMENT_OUTPUT_SCHEMA, ok200: "Sentiment (label no_data when nothing matched)",
    outputExample: { query: "SpaceX", hours: 24, since: "2026-10-20T16:00:00Z", count: 6, bullish: 4, bearish: 1, neutral: 1, score: 0.5, label: "bullish",
      method: "heuristic", note: "Heuristic keyword/emoji lexicon plus explicit '= ±X%' moves; not a language model.", examples: { bullish: [{ ...EX_BRIEF, score: 1 }], bearish: [] } } },
  { path: "/news/digest", operationId: "getNewsDigest", price: "$0.01",
    summary: "Sectioned briefing: central banks, macro, energy, equities, crypto, geopolitics",
    description: "Groups news of the last N hours (1-48, default 24) into central_banks, macro, energy, equities, crypto and geopolitics by keyword rules " +
      "(an item may appear in several), each with count, high_count and up to 5 headlines (high first, then newest), plus top_topics of high items.",
    params: { hours: HOURS_PARAM(24, 48) }, required: [], example: { hours: 24 }, badRequest: true,
    badRequestText: "hours is not a number. Returned before payment.",
    outputSchema: DIGEST_OUTPUT_SCHEMA, ok200: "Digest",
    outputExample: { hours: 24, since: "2026-10-20T16:00:00Z", count: 228, high_count: 70, unclassified_count: 54,
      sections: { equities: { count: 28, high_count: 7, items: [EX_BRIEF] } }, top_topics: [{ topic: "Ukraine", count: 12 }] } },
  { path: "/ru/fx", operationId: "getCbrFxRates", price: "$0.0015", tags: ["ru-data"],
    summary: "Official Bank of Russia FX rates (RUB) with day-over-day change",
    description: "CBR official exchange rates from cbr.ru XML_daily.asp for a date (default: the latest set) and optional currency codes: " +
      "per currency nominal, value (RUB per nominal), per_unit (RUB per 1 unit), previous set's per_unit, change and change_pct. Cached 30 min (past dates 7 days).",
    params: { date: FX_DATE_PARAM, codes: FX_CODES_PARAM }, required: [], example: { codes: "USD,EUR,CNY" }, badRequest: true,
    badRequestText: "date is not YYYY-MM-DD in 1992-07-01..tomorrow, or codes is not a comma list of 3-letter codes (max 30). Returned before payment.",
    outputSchema: FX_OUTPUT_SCHEMA, ok200: "CBR rates",
    outputExample: { source: "Bank of Russia (cbr.ru/scripts/XML_daily.asp)", base: "RUB", date: "2026-10-22", requested_date: null, previous_date: "2026-10-21", count: 2,
      rates: [{ code: "USD", name: "Доллар США", nominal: 1, value: 81.9739, per_unit: 81.9739, prev_per_unit: 82.8879, change: -0.914, change_pct: -1.103 },
        { code: "CNY", name: "Юань", nominal: 1, value: 12.2806, per_unit: 12.2806, prev_per_unit: 12.3708, change: -0.0902, change_pct: -0.729 }],
      missing: [], note: "Official CBR rate", via: "direct", cached: false, fetched_at: "2026-10-22T03:51:31Z" },
    extraResponses: DATA_502("cbr.ru") },
  { path: "/ru/key-rate", operationId: "getCbrKeyRate", price: "$0.0015", tags: ["ru-data"],
    summary: "Bank of Russia key rate: current level, since when, and recent changes",
    description: "Current CBR key rate (% p.a.) from the cbr.ru DailyInfo web service (KeyRateXML; the hd_base/KeyRate page as fallback): rate, as_of, " +
      "effective_since, previous_rate, last_change_bp and every change in the last `months` (default 24) newest first, plus min/max in the window. Cached 3 h.",
    params: { months: MONTHS_PARAM }, required: [], example: { months: 24 }, badRequest: true, badRequestText: "months is not a number. Returned before payment.",
    outputSchema: KEYRATE_OUTPUT_SCHEMA, ok200: "Key rate",
    outputExample: { source: "Bank of Russia key rate (cbr.ru DailyInfoWebServ KeyRateXML)", unit: "% per annum", rate: 14, as_of: "2026-10-21", effective_since: "2026-07-27",
      previous_rate: 14.25, last_change_bp: -25, months: 24, changes: [{ date: "2026-07-27", rate: 14, prev_rate: 14.25, change_bp: -25 }],
      max_in_window: 21, min_in_window: 14, via: "direct", cached: false, fetched_at: "2026-10-22T03:51:31Z" },
    extraResponses: DATA_502("cbr.ru") },
  { path: "/moex/quote", operationId: "getMoexQuote", price: "$0.003", tags: ["ru-data"],
    summary: "Moscow Exchange stock quote (delayed ~15 min): price, change, volume, bid/offer",
    description: "One MOEX shares-market ticker from MOEX ISS (main board TQBR when listed): price (last trade, or previous close before the session's first trade), " +
      "change/change_pct vs previous close, open/high/low, bid/offer, volume, value_rub, market cap, trading status. Data is delayed ~15 minutes (delayed: true). Unknown ticker -> 404 (not settled).",
    params: { ticker: TICKER_PARAM }, required: ["ticker"], example: { ticker: "SBER" }, badRequest: true,
    badRequestText: "ticker missing (with a payment attached) or not 1-12 letters/digits. Returned before payment.",
    outputSchema: QUOTE_OUTPUT_SCHEMA, ok200: "Quote",
    outputExample: { ticker: "SBER", board: "TQBR", short_name: "Сбербанк", name: "Сбербанк России ПАО ао", isin: "RU0009029540", currency: "RUB", lot_size: 1,
      price: 292.4, price_source: "last_trade", last: 292.4, prev_close: 291.62, prev_date: "2026-10-21", change: 0.78, change_pct: 0.27, open: 291.9, high: 293.1, low: 291.2,
      volume: 4100000, value_rub: 1198000000, num_trades: 21000, trading_status: "T", updated_at: "2026-10-22T11:05:00+03:00", trade_date: "2026-10-22",
      delayed: true, delay_minutes: 15, source: "MOEX ISS (iss.moex.com)", cached: false, fetched_at: "2026-10-22T08:20:00Z" },
    extraResponses: { ...NOT_FOUND_404("Ticker not found on the MOEX shares market."), ...DATA_502("iss.moex.com") } },
  { path: "/moex/index", operationId: "getMoexIndex", price: "$0.003", tags: ["ru-data"],
    summary: "MOEX index values (IMOEX, RTSI, sector indices) or the index catalogue",
    description: "Index level, change/change_pct vs previous close, open/high/low, month/year change, annual high/low and traded value for up to 5 codes " +
      "(default IMOEX), or code=list for the catalogue of MOEX stock indices (SNDX board + RTS*). Delayed ~15 minutes. Unknown codes -> 404 (not settled).",
    params: { code: INDEX_CODE_PARAM }, required: [], example: { code: "IMOEX,RTSI" }, badRequest: true,
    badRequestText: "code is not up to 5 comma-separated index codes (2-16 letters/digits) or `list`. Returned before payment.",
    outputSchema: INDEX_OUTPUT_SCHEMA, ok200: "Index values or catalogue",
    outputExample: { mode: "quote", count: 1, items: [{ code: "IMOEX", name: "Индекс МосБиржи", value: 2447.83, prev_close: 2469.75, change: -21.92, change_pct: -0.89,
      open: 2476.11, high: 2480.56, low: 2428.15, month_change_pct: 7.99, year_change_pct: -11.52, annual_high: 2912.01, annual_low: 1898.51,
      value_traded_rub: 87708483202, currency: "RUB", trade_date: "2026-10-21", updated_at: "2026-10-21T23:50:03+03:00" }], missing: [],
      source: "MOEX ISS (iss.moex.com)", delayed: true, delay_minutes: 15, cached: false, fetched_at: "2026-10-22T03:51:31Z" },
    extraResponses: { ...NOT_FOUND_404("Index code not found."), ...DATA_502("iss.moex.com") } },
  { path: "/moex/movers", operationId: "getMoexMovers", price: "$0.004", tags: ["ru-data"],
    summary: "Top gainers and losers on the Moscow Exchange main board (TQBR), with market breadth",
    description: "Ranks TQBR shares by change vs previous close (turnover >= min_value RUB, default 5 mln): top `limit` gainers and losers (default 10, max 50), " +
      "advancers/decliners/unchanged. Before the session's first trades (mode previous_session) it ranks the last completed session from ISS history. Delayed ~15 minutes.",
    params: { limit: MOVERS_LIMIT_PARAM, min_value: MIN_VALUE_PARAM }, required: [], example: { limit: 10 }, badRequest: true,
    badRequestText: "limit or min_value is not a number. Returned before payment.",
    outputSchema: MOEX_MOVERS_OUTPUT_SCHEMA, ok200: "Movers",
    outputExample: { board: "TQBR", mode: "previous_session", as_of: "2026-10-21", limit: 2, min_value_rub: 5000000, universe: 188, advancers: 60, decliners: 124, unchanged: 4,
      gainers: [{ ticker: "URKZ", name: "УрКузница", price: 273.6, pct: 10.06, value: 36678042.2, trade_date: "2026-10-21" }],
      losers: [{ ticker: "AFKS", name: "Система ао", price: 7.828, pct: -2.13, value: 1062601090, trade_date: "2026-10-21" }],
      delayed: true, delay_minutes: 15, source: "MOEX ISS (iss.moex.com), board TQBR (main shares board)", cached: false, fetched_at: "2026-10-22T03:51:31Z" },
    extraResponses: DATA_502("iss.moex.com") },
  { path: "/ru/fuel", operationId: "getRuFuelPrices", price: "$0.003", tags: ["ru-data"],
    summary: "Russian retail fuel prices (AI-92/95/98, diesel) — Rosstat weekly averages",
    description: "Average retail pump prices across Russia from Rosstat's weekly release (rosstat.gov.ru nedel_sred_cen.xlsx): price (RUB/l), as_of, week-over-week change, " +
      "4-week and year-to-date change and `weeks` of history per fuel. Rosstat publishes weekly (usually Wednesday, prices as of Monday); cached 6 h, a stale copy (stale: true) " +
      "is served for up to 14 days if Rosstat is unreachable.",
    params: { weeks: WEEKS_PARAM }, required: [], example: { weeks: 4 }, badRequest: true, badRequestText: "weeks is not a number. Returned before payment.",
    outputSchema: FUEL_OUTPUT_SCHEMA, ok200: "Fuel prices",
    outputExample: { source: "Rosstat: weekly average consumer prices for selected goods, Russian Federation (nedel_sred_cen.xlsx)",
      source_url: "https://rosstat.gov.ru/storage/mediabank/nedel_sred_cen.xlsx", as_of: "2026-10-12", unit: "RUB per litre", region: "Russian Federation (average)",
      prices: [{ fuel: "ai92", name: "Petrol AI-92", label_ru: "Бензин автомобильный марки АИ-92, л", price: 74.71, as_of: "2026-10-12", prev_price: 74.72, prev_date: "2026-10-05",
        change: -0.01, change_pct: -0.01, change_4w_pct: 0.15, change_ytd_pct: 20.38, history: [{ date: "2026-10-12", price: 74.71 }, { date: "2026-10-05", price: 74.72 }] }],
      note: "Rosstat publishes weekly", via: "direct", cached: false, fetched_at: "2026-10-22T03:51:31Z" },
    extraResponses: DATA_502("rosstat.gov.ru") },
  { path: "/tg/channel/latest", operationId: "getTelegramChannelLatest", price: "$0.004", tags: ["telegram"],
    summary: "Latest posts of a public Telegram channel (text, date, views, link)",
    description: "Reads the public web preview t.me/s/<channel> (no login): newest `limit` posts (default 20, max 50) with id, date, text (HTML stripped, emoji kept), " +
      "views, link, media types and channel title/subscribers. Channels without a public preview or that do not exist -> 404 (not settled). Cached 2 min.",
    params: { channel: CHANNEL_PARAM, limit: TG_LIMIT_PARAM }, required: ["channel"], example: { channel: "markettwits", limit: 20 }, badRequest: true,
    badRequestText: "channel missing (with a payment attached) or not a valid username, or limit not a number. Returned before payment.",
    outputSchema: TG_LATEST_OUTPUT_SCHEMA, ok200: "Channel posts",
    outputExample: { channel: "markettwits", title: "MarketTwits", subscribers: 339000, subscribers_raw: "339K", count: 1, pages: 1,
      items: [{ id: 389929, channel: "markettwits", date: "2026-10-21T19:19:52+00:00", text: "⚠️🇺🇸#META #spo #ии\nMeta ... — Semafor", views: 39000, views_raw: "39K",
        link: "https://t.me/markettwits/389929", media: [], edited: true }], source: "https://t.me/s/markettwits (public web preview)", cached: false, fetched_at: "2026-10-22T03:51:36Z" },
    extraResponses: { ...NOT_FOUND_404("Channel not found or no public web preview."), ...DATA_502("t.me") } },
  { path: "/tg/search", operationId: "searchTelegramChannels", price: "$0.006", tags: ["telegram"],
    summary: "Search up to 5 public Telegram channels for a keyword",
    description: "Runs Telegram's own channel search (t.me/s/<channel>?q=) on 1-5 public channels, merges the matches newest first (up to `limit`, default 20) " +
      "with per-channel counts/errors. 404 when no channel exists, 502 when all fail; partial failures are reported in per_channel.",
    params: { q: Q_PARAM, channels: CHANNELS_PARAM, limit: TG_LIMIT_PARAM }, required: ["q", "channels"], example: { q: "нефть", channels: "markettwits,rbc_news" }, badRequest: true,
    badRequestText: "q missing/empty/longer than 100 chars, channels missing/invalid/more than 5, or limit not a number (missing params with a payment attached). Returned before payment.",
    outputSchema: TG_SEARCH_OUTPUT_SCHEMA, ok200: "Matches",
    outputExample: { query: "нефть", channels: ["markettwits", "rbc_news"], count: 1,
      items: [{ id: 389883, channel: "markettwits", date: "2026-10-21T14:30:11+00:00", text: "#нефть ...", views: 41000, views_raw: "41K", link: "https://t.me/markettwits/389883", media: [], edited: false }],
      per_channel: [{ channel: "markettwits", title: "MarketTwits", count: 20 }, { channel: "rbc_news", title: "РБК. Новости. Главное", count: 20 }],
      source: "https://t.me/s/<channel>?q= (public web preview)", fetched_at: "2026-10-22T03:51:36Z" },
    extraResponses: { ...NOT_FOUND_404("None of the channels exist / have a public preview."), ...DATA_502("t.me") } },
  { path: "/product/info", operationId: "getProductInfo", price: "$0.004", tags: ["product"],
    summary: "Wildberries / Ozon product card: title, price (RUB), rating, reviews, stock",
    description: "Live product data for a Wildberries (wildberries.ru, wb.ru) or Ozon (ozon.ru) product URL: title, current price in RUB " +
      "(original_amount = list price before discount when known), rating, reviews_count and availability. Cached 10 min per product. " +
      "If the marketplace blocks or fails, returns 502 upstream_unavailable and the payment is NOT settled. Can take up to ~40s when the live page has to be rendered.",
    params: { url: PRODUCT_URL_PARAM }, required: ["url"], badRequest: true,
    example: { url: "https://www.wildberries.ru/catalog/211695539/detail.aspx" },
    badRequestText: "url is not a valid http(s) URL, the host is not wildberries.ru/wb.ru/ozon.ru, or no product id could be extracted. Returned before payment.",
    outputSchema: PRODUCT_OUTPUT_SCHEMA, ok200: "Product data",
    outputExample: { source: "wildberries", url: "https://www.wildberries.ru/catalog/211695539/detail.aspx", product_id: "211695539",
      title: "PUSY / Гель для бровей", price: { amount: 623.31, currency: "RUB", original_amount: 1990 }, rating: 4.7, reviews_count: 243068,
      availability: "in_stock", in_stock: true, fetched_at: "2026-10-21T05:24:42Z", data_source: "card.wb.ru v4", via: "proxy", cached: false },
    extraResponses: { 502: { description: "Marketplace blocked or failed (anti-bot, timeout, product not found). The x402 payment is not settled.",
      content: { "application/json": { schema: { type: "object", required: ["error"], properties: {
        error: { type: "string", enum: ["upstream_unavailable"] }, detail: { type: "string" } } } } } } } },
  { path: "/product/compare", operationId: "compareProducts", price: "$0.006", tags: ["product"],
    summary: "Compare 2-5 Wildberries products: prices, cheapest, price spread, stock",
    description: `Fetches 2-${COMPARE_MAX} product URLs (urls=comma-separated, or repeated url=) with the same live chain as /product/info and returns ` +
      "per-item title/price/original_price/in_stock/rating/reviews_count, the cheapest and most expensive item, price_diff (abs RUB and percent of the cheapest), " +
      "in_stock_count and all_in_stock. Items that fail carry error/detail; returns 502 (payment not settled) only if fewer than 2 items returned a price.",
    params: { urls: PRODUCT_URLS_PARAM }, required: ["urls"], badRequest: true,
    example: { urls: "https://www.wildberries.ru/catalog/1256886607/detail.aspx,https://www.wildberries.ru/catalog/197349073/detail.aspx" },
    badRequestText: `Fewer than 2 or more than ${COMPARE_MAX} URLs, a duplicate product, or any URL that is invalid / not wildberries.ru, wb.ru or ozon.ru. Returned before payment.`,
    outputSchema: COMPARE_OUTPUT_SCHEMA, ok200: "Comparison (at least 2 items with a price; failed items have error)",
    outputExample: { count: 2, succeeded: 2, items: [
      { product_id: "1256886607", source: "wildberries", url: "https://www.wildberries.ru/catalog/1256886607/detail.aspx", title: "Наушники беспроводные A.Pods Pro 2",
        price: 680, original_price: 1999, in_stock: true, rating: 5, reviews_count: 15084, data_source: "browser: wb card api (browser)" },
      { product_id: "197349073", source: "wildberries", url: "https://www.wildberries.ru/catalog/197349073/detail.aspx", title: "Наушники беспроводные Pods Pro 2",
        price: 618, original_price: 1112, in_stock: true, rating: 5, reviews_count: 134625, data_source: "browser: wb card api (browser)" }],
      cheapest: { product_id: "197349073", url: "https://www.wildberries.ru/catalog/197349073/detail.aspx", title: "Наушники беспроводные Pods Pro 2", price: 618 },
      most_expensive: { product_id: "1256886607", url: "https://www.wildberries.ru/catalog/1256886607/detail.aspx", title: "Наушники беспроводные A.Pods Pro 2", price: 680 },
      price_diff: { abs: 62, percent: 10.03 }, in_stock_count: 2, all_in_stock: true, currency: "RUB", fetched_at: "2026-10-21T16:30:00Z" },
    extraResponses: UPSTREAM_502("Fewer than 2 products returned a price (anti-bot, timeout, not found).") },
  { path: "/product/monitor", operationId: "monitorProductPrice", price: "$0.005", tags: ["product"],
    summary: "Price-target check for one product: is the current price at or below target_price?",
    description: "Fetches one Wildberries/Ozon product (same live chain as /product/info) and compares it with target_price (RUB): below_target " +
      "(current <= target and not out of stock), current_price, diff_abs/diff_percent, in_stock, the full product object and checked_at. Use it as a paid poll for price alerts. " +
      "If the product is out of stock with no price it returns 200 with below_target false, current_price null, in_stock false and a note; " +
      "if no product data can be fetched at all it returns 502 and the payment is not settled.",
    params: { url: PRODUCT_URL_PARAM, target_price: TARGET_PRICE_PARAM }, required: ["url", "target_price"], badRequest: true,
    example: { url: "https://www.wildberries.ru/catalog/839226871/detail.aspx", target_price: "1500" },
    badRequestText: "url invalid/unsupported, or target_price missing, non-numeric, zero or negative. Returned before payment.",
    outputSchema: MONITOR_OUTPUT_SCHEMA, ok200: "Target check result",
    outputExample: { target_price: 1500, currency: "RUB", checked_at: "2026-10-21T16:30:00Z", url: "https://www.wildberries.ru/catalog/839226871/detail.aspx",
      product_id: "839226871", title: "Наушники беспроводные TWS Pro 2", below_target: false, current_price: 1592, original_price: 2525,
      diff_abs: 92, diff_percent: 6.13, in_stock: true,
      product: { source: "wildberries", product_id: "839226871", title: "Наушники беспроводные TWS Pro 2", price: { amount: 1592, currency: "RUB", original_amount: 2525 } } },
    extraResponses: UPSTREAM_502("No product data could be fetched (anti-bot, timeout, not found).") },
  { path: "/product/history", operationId: "getProductPriceHistory", price: "$0.004", tags: ["product"],
    summary: "Wildberries price history: weekly CDN points + observed + live price, min/max/avg, 30-day change",
    description: "Price history for a Wildberries product: weekly points from WB's public price-history CDN (weekly_cdn), prices this service observed " +
      "on earlier lookups (observed; in-memory, reset on restart), and the current live price (live). Returns points (oldest first), current, " +
      "stats min/max/avg, change_30d (vs. the latest point at least 30 days old) and history_limited:true with a note when only the current price exists. " +
      "Ozon has no public history (only live, currently blocked). 502 (not settled) only when no price at all is available.",
    params: { url: PRODUCT_URL_PARAM }, required: ["url"], badRequest: true,
    example: { url: "https://www.wildberries.ru/catalog/839226871/detail.aspx" },
    badRequestText: "url is not a valid http(s) URL, the host is not wildberries.ru/wb.ru/ozon.ru, or no product id could be extracted. Returned before payment.",
    outputSchema: HISTORY_OUTPUT_SCHEMA, ok200: "Price history",
    outputExample: { url: "https://www.wildberries.ru/catalog/839226871/detail.aspx", product_id: "839226871", source: "wildberries",
      title: "Наушники беспроводные TWS Pro 2", currency: "RUB", current: { price: 1592, original_price: 2525, source: "live", date: "2026-10-21T16:30:00Z" },
      points: [{ date: "2026-09-13", price: 1602.06, source: "weekly_cdn" }, { date: "2026-09-20", price: 1471.2, source: "weekly_cdn" },
        { date: "2026-10-21T16:30:00Z", price: 1592, source: "live" }],
      stats: { min: 1471.2, max: 1602.06, avg: 1555.09, count: 3, from: "2026-09-13", to: "2026-10-21T16:30:00Z" },
      change_30d: { vs_date: "2026-09-20", vs_price: 1471.2, abs: 120.8, percent: 8.21 }, history_limited: false,
      sources: { weekly_cdn: 2, observed: 0, live: 1 }, checked_at: "2026-10-21T16:30:00Z" },
    extraResponses: UPSTREAM_502("No price at all (no weekly history and the live fetch failed).") },
];
const routePrice = (r) => r.price || PRICE;
const LIST_OUTPUT_SCHEMA = (itemSchema) => ({
  type: "object", required: ["count", "items"],
  properties: { count: { type: "integer" }, items: { type: "array", items: itemSchema } },
});

app.get("/openapi.json", async (req, res) => {
  const a = await resolveAsset();
  const host = req.host; // honours X-Forwarded-Host (trust proxy)
  const server = PUBLIC_URL || (host ? `${req.protocol}://${host}` : DEFAULT_PUBLIC_URL);
  const paid = MODE === "paid";
  const paymentInfo = (price, info) => ({
    price: { mode: "fixed", currency: "USD", amount: String(price).replace(/^\$/, "").trim() },
    protocols: [{ x402: { network: NETWORK, scheme: "exact", payTo: PAY_TO, asset: info.asset, amount: info.amount } }],
  });
  const paidPaths = {};
  for (const r of PAID_ROUTES) {
    const info = await resolveAsset(routePrice(r));
    paidPaths[r.path] = { get: {
      operationId: r.operationId, summary: r.summary, description: r.description, tags: r.tags || ["news"], security: [],
      parameters: Object.entries(r.params).map(([name, schema]) => {
        const { description, ...sch } = schema;
        return { name, in: "query", required: r.required.includes(name), description, schema: sch };
      }),
      ...(paid ? { "x-payment-info": paymentInfo(routePrice(r), info) } : {}),
      responses: {
        200: r.outputSchema
          ? { description: r.ok200, content: { "application/json": { schema: r.outputSchema } } }
          : { description: "News items (newest first); empty items array when nothing matches",
            content: { "application/json": { schema: LIST_OUTPUT_SCHEMA({ $ref: "#/components/schemas/NewsItem" }) } } },
        ...(r.badRequest ? { 400: { description: r.badRequestText || ("Missing or invalid q (1-100 chars)" +
          (r.params.hours || r.path === "/news/summary" ? ` or non-numeric ${r.params.hours ? "hours" : "limit"}` : "") +
          ". Returned before payment when a payment is attached or a parameter is invalid."),
          content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } } } } : {}),
        402: {
          description: "Payment Required. x402 v2 challenge in the PAYMENT-REQUIRED response header (base64 JSON).",
          headers: { "PAYMENT-REQUIRED": { description: "Base64-encoded x402 PaymentRequired object", schema: { type: "string" } } },
        },
        ...(r.extraResponses || {}),
      },
    } };
  }
  const doc = {
    openapi: "3.1.0",
    info: {
      title: "MarketTwits News (English) — x402",
      version: "1.0.0",
      description: "Real-time English translations of MarketTwits (top Russian financial Telegram channel). Covers macro, " +
        "central banks, oil/commodities, geopolitics, equities and crypto. Items are tagged high/medium importance and " +
        "updated every few minutes. Ideal for trading bots and news agents. Also sells Russian market data (CBR FX and key rate, " +
        "MOEX quotes/indices/movers, Rosstat fuel prices), public Telegram channel reading/search and Wildberries/Ozon product data.",
      "x-guidance": `Twenty-seven paid endpoints via x402 (USDC, scheme exact, network ${NETWORK}` +
        `${paid ? `, payTo ${PAY_TO}` : ""}). Feed endpoints, ${PRICE} each: ` +
        `GET /news/latest?limit=N - full feed (high+medium), use for polling/monitoring all market news. ` +
        `GET /news/important?limit=N - only importance=high, use when you want market-moving headlines only. ` +
        `GET /news/search?q=WORDS&limit=N - case-insensitive keyword search (all words must match; '#oil' and 'oil' both work), ` +
        `use for a topic/ticker/country (e.g. q=oil, q=Fed rates, q=BTC). limit is 1-50 (default 20); results newest first. ` +
        `An unpaid call returns HTTP 402 with a PAYMENT-REQUIRED header (base64 x402 v2 challenge); pay with an x402 client ` +
        `(e.g. @x402/fetch) and retry. Invalid q (empty or >100 chars) returns 400 before any payment; no match returns 200 with items []. ` +
        `Response: {count, items:[{id, source_url, published_at, importance, text_en, posted_to_x, buffer_post_id}]}. ` +
        `Analytics endpoints (fixed prices): GET /news/alerts/check?q=WORDS&hours=24 ($0.004) - count of matching items in the last N hours ` +
        `(1-168) plus the 5 most recent, use for keyword alerts; GET /news/summary?q=WORDS&limit=10 ($0.008) - 3-5 sentence extractive ` +
        `English summary of the latest matching news (limit 1-50); GET /news/top-topics?hours=6 ($0.005) - top 5 hashtags/keywords in ` +
        `high-importance news of the last N hours (1-72; falls back to the last 20 high items, fallback=true). ` +
        `GET /news/summary/recent?q=WORDS&hours=12 ($0.007) - like /news/summary but only items from the last N hours (1-168, up to 50), ` +
        `returns {query, hours, since, count, high_count, summary, items}; GET /news/alerts/new?q=WORDS&hours=6 ($0.005) - only ` +
        `HIGH-importance matches in the last N hours (1-168), returns {has_new, count, latest}, use as a cheap alert poll; ` +
        `GET /news/topics/trending?hours=6 ($0.004) - top 5 topics in high news of the last N hours (1-72) with prev_count, ` +
        `change (vs. the previous equal window) and latest_id. Non-numeric hours/limit returns 400 before payment. ` +
        `More news endpoints: GET /news/since?id=LAST_ID&limit=50 ($0.002) - items with id > LAST_ID oldest first + next_id/has_more (cheap polling cursor); ` +
        `GET /news/movers?hours=6&min_pct=2 ($0.005) - top gainers/losers parsed from '#TICKER = ±X%' mentions; ` +
        `GET /news/country?code=RU&hours=24&importance=all ($0.004) - news about a country (flag emoji + keywords) with counts, top topics, 10 latest headlines; ` +
        `GET /news/data-surprises?hours=24&q=CPI ($0.006) - macro releases and earnings vs. expectations (actual, expected, previous, surprise, direction); ` +
        `GET /news/sentiment?q=WORDS&hours=24 ($0.005) - heuristic lexicon tone: bullish/bearish/neutral counts and score in [-1,1] (method: heuristic); ` +
        `GET /news/digest?hours=24 ($0.01) - sectioned briefing (central_banks, macro, energy, equities, crypto, geopolitics) with up to 5 headlines each. ` +
        `Russian market data: GET /ru/fx?codes=USD,EUR&date=YYYY-MM-DD ($0.0015) - official CBR rates (RUB per unit) with change vs the previous set; ` +
        `GET /ru/key-rate?months=24 ($0.0015) - CBR key rate, effective_since, previous rate and the list of changes; ` +
        `GET /moex/quote?ticker=SBER ($0.003) - Moscow Exchange quote (price, change_pct, OHLC, volume, bid/offer), delayed ~15 min; ` +
        `GET /moex/index?code=IMOEX ($0.003) - index level/change for up to 5 codes (IMOEX, RTSI, ...) or code=list; ` +
        `GET /moex/movers?limit=10 ($0.004) - top TQBR gainers/losers and breadth (previous session before the open); ` +
        `GET /ru/fuel?weeks=4 ($0.003) - Rosstat weekly average pump prices AI-92/95/98 and diesel (RUB/l, as_of, weekly/4-week/YTD change). ` +
        `Telegram: GET /tg/channel/latest?channel=NAME&limit=20 ($0.004) - newest posts of a public channel (id, date, text, views, link); ` +
        `GET /tg/search?q=WORDS&channels=a,b ($0.006) - keyword search across up to 5 public channels. Upstream failures return 502 and unknown ticker/index/channel 404, ` +
        `neither is settled; invalid parameters return 400 before payment. ` +
        `Marketplace endpoint: GET /product/info?url=PRODUCT_URL ($0.004) - live Wildberries (wildberries.ru/wb.ru /catalog/<id>/) or ` +
        `Ozon (ozon.ru /product/<slug>-<id>/) product data {source, product_id, title, price:{amount, currency:'RUB', original_amount?}, ` +
        `rating, reviews_count, availability, in_stock}; a bad or foreign url returns 400 before payment, and if the marketplace ` +
        `blocks/fails it returns 502 upstream_unavailable without settling the payment. ` +
        `GET /product/compare?urls=URL1,URL2[,...] ($0.006) - 2-${COMPARE_MAX} products (or repeat url=): items with price/original_price/in_stock/rating, ` +
        `cheapest, most_expensive, price_diff {abs, percent}, in_stock_count, all_in_stock; per-item errors allowed, 502 if fewer than 2 priced. ` +
        `GET /product/monitor?url=URL&target_price=RUB ($0.005) - below_target (current <= target and not out of stock), current_price, diff_abs/diff_percent, in_stock; ` +
        `out-of-stock without a price -> 200 below_target:false current_price:null. ` +
        `GET /product/history?url=URL ($0.004) - Wildberries weekly CDN price points + observed + live price, min/max/avg, change_30d, ` +
        `history_limited when only the current price exists. Wildberries works via a headless-browser parser; Ozon is currently blocked (502, not charged). ` +
        `Free: GET / (service index with the full price list), GET /news/sample (one truncated item), GET /health.`,
      contact: { email: "whale2003@proton.me" },
    },
    servers: [{ url: server }],
    paths: {
      ...paidPaths,
      "/": {
        get: {
          operationId: "getServiceIndex", summary: "Service index (free): description, payTo, links and the price list of all paid endpoints", tags: ["meta"], security: [],
          responses: { 200: { description: "Service index", content: { "application/json": { schema: {
            type: "object", properties: {
              service: { type: "string" }, description: { type: "string" }, payTo: { type: ["string", "null"] }, links: { type: "object" },
              paid_endpoints: { type: "integer" },
              prices: { type: "array", items: { type: "object", properties: {
                method: { type: "string" }, path: { type: "string" }, price_usd: { type: "string" }, description: { type: "string" } } } },
            },
          } } } } },
        },
      },
      "/news/sample": {
        get: {
          operationId: "getNewsSample", summary: "Free sample: newest item with truncated text", tags: ["news"], security: [],
          responses: { 200: { description: "Sample item", content: { "application/json": { schema: {
            type: "object", properties: { description: { type: "string" },
              item: { oneOf: [{ $ref: "#/components/schemas/NewsItem" }, { type: "null" }] } },
          } } } } },
        },
      },
      "/health": {
        get: {
          operationId: "getHealth", summary: "Service status (free)", tags: ["meta"], security: [],
          responses: { 200: { description: "Status", content: { "application/json": { schema: {
            type: "object", properties: {
              ok: { type: "boolean" }, mode: { type: "string" }, network: { type: "string" }, facilitator: { type: "string" },
              price: { type: "string" }, items: { type: "integer" }, newest_id: { type: ["integer", "null"] },
              proxy_configured: { type: "boolean", description: "Whether a marketplace proxy is configured (no details exposed)" },
            },
          } } } } },
        },
      },
    },
    components: { schemas: { NewsItem: NEWS_ITEM_SCHEMA } },
  };
  res.set("Access-Control-Allow-Origin", "*").set("Cache-Control", "public, max-age=300").json(doc);
});
app.options("/openapi.json", (_req, res) => {
  res.set({ "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "*" }).sendStatus(204);
});

// ---------- free service index: GET / (price list generated from PAID_ROUTES, never paid) ----------
const X402SCAN_URL = "https://www.x402scan.com/server/f96fbc84-8538-414c-a847-bcc948103f8d";
const REPO_URL = "https://github.com/Croomee/x402-markettwits-news";
const MCP_PACKAGE = "x402-markettwits-mcp";
const priceUsd = (p) => String(p).replace(/^\$/, "").trim();
function buildIndex() {
  return {
    service: "x402-markettwits-news",
    description: "Russian and global market news from the MarketTwits Telegram channel (translated to English), plus Bank of Russia (CBR), " +
      "Moscow Exchange (MOEX), Rosstat and public Telegram channel data. Paid per call via x402 in USDC on Base (eip155:8453).",
    mode: MODE,
    payment: { protocol: "x402", version: 2, scheme: "exact", asset: "USDC", network: NETWORK, payTo: PAY_TO || null },
    payTo: PAY_TO || null,
    links: {
      openapi: "/openapi.json",
      sample: "/news/sample",
      health: "/health",
      x402scan: X402SCAN_URL,
      mcp: { package: MCP_PACKAGE, npm: `https://www.npmjs.com/package/${MCP_PACKAGE}`, install: `npx -y ${MCP_PACKAGE}` },
      repo: REPO_URL,
    },
    paid_endpoints: PAID_ROUTES.length,
    prices: PAID_ROUTES.map((r) => ({ method: "GET", path: r.path, price_usd: priceUsd(routePrice(r)), description: r.summary })),
  };
}
app.get("/", (_req, res) => res.set("Access-Control-Allow-Origin", "*").json(buildIndex()));

app.post("/ingest", express.json({ limit: "2mb" }), (req, res) => {
  if (!INGEST_TOKEN) return res.status(404).json({ error: "ingest disabled" });
  if (!tokenOk(req.get("authorization"))) return res.status(401).json({ error: "unauthorized" });
  const list = Array.isArray(req.body) ? req.body : [req.body];
  if (list.length > 1000) return res.status(413).json({ error: "too many items (max 1000)" });
  readNews();
  const added = [], errors = [];
  let duplicates = 0;
  for (const raw of list) {
    try {
      const it = normalize(raw);
      if (store.has(it.id)) { duplicates++; continue; }
      store.set(it.id, it); added.push(it);
    } catch (e) { errors.push(e.message); }
  }
  if (added.length) { persist(added); trim(); }
  res.status(errors.length && !added.length && !duplicates ? 400 : 200)
    .json({ added: added.length, duplicates, errors, total: store.size });
});

// /news/search: reject invalid q BEFORE payment. Missing q without a payment attached still gets the 402
// challenge so discovery probes (x402scan) can read it; with a payment attached it is rejected (never charged).
function parseQ(raw) {
  if (typeof raw !== "string") return null;
  const q = raw.trim();
  return q.length >= 1 && q.length <= 100 && /[^#\s]/.test(q) ? q : null;
}
const hasPayment = (req) => Boolean(req.get("payment-signature") || req.get("x-payment"));
function preCheckQ(req, res, next) {
  const present = req.query.q !== undefined;
  if (parseQ(req.query.q) === null && (present || hasPayment(req))) {
    return res.status(400).json({ error: "q is required (1-100 characters)" });
  }
  next();
}
app.get("/news/search", preCheckQ);
// New analytics routes: same q pattern; non-numeric hours/limit -> 400 before payment.
const HOURS_ALERT = { def: 24, min: 1, max: 168 }, HOURS_TOPICS = { def: 6, min: 1, max: 72 }, LIMIT_SUMMARY = { def: 10, min: 1, max: 50 };
const numCheck = (name, opts) => (req, res, next) =>
  parseNumParam(req.query[name], opts) === null ? res.status(400).json({ error: `${name} must be a number` }) : next();
app.get("/news/alerts/check", numCheck("hours", HOURS_ALERT), preCheckQ);
app.get("/news/summary", numCheck("limit", LIMIT_SUMMARY), preCheckQ);
app.get("/news/top-topics", numCheck("hours", HOURS_TOPICS));
const HOURS_RECENT = { def: 12, min: 1, max: 168 }, HOURS_ALERT_NEW = { def: 6, min: 1, max: 168 };
app.get("/news/summary/recent", numCheck("hours", HOURS_RECENT), preCheckQ);
app.get("/news/alerts/new", numCheck("hours", HOURS_ALERT_NEW), preCheckQ);
app.get("/news/topics/trending", numCheck("hours", HOURS_TOPICS));
// News v3 validators (before payment).
const HOURS_MOVERS = { def: 6, min: 1, max: 72 }, HOURS_DAY = { def: 24, min: 1, max: 168 }, HOURS_DIGEST = { def: 24, min: 1, max: 48 };
const SINCE_LIMIT = { def: 50, min: 1, max: 100 }, MIN_PCT = { def: 0, min: 0, max: 100 };
const IMPORTANCES = new Set(["all", "high", "medium", "low"]);
const floatCheck = (name, opts) => (req, res, next) =>
  parseFloatParam(req.query[name], opts) === null ? res.status(400).json({ error: `${name} must be a non-negative number` }) : next();
const optQCheck = (req, res, next) => (req.query.q !== undefined && parseQ(req.query.q) === null ? res.status(400).json({ error: "q must be 1-100 characters" }) : next());
app.get("/news/since", numCheck("limit", SINCE_LIMIT), (req, res, next) => {
  if (req.query.id === undefined && !hasPayment(req)) return next();
  return parseCursorId(req.query.id) === null ? res.status(400).json({ error: "id is required: the last item id you have (non-negative integer, 0 = from the start)" }) : next();
});
app.get("/news/movers", numCheck("hours", HOURS_MOVERS), floatCheck("min_pct", MIN_PCT));
app.get("/news/country", numCheck("hours", HOURS_DAY), (req, res, next) => {
  if (req.query.importance !== undefined && !IMPORTANCES.has(String(req.query.importance).toLowerCase())) return res.status(400).json({ error: "importance must be all, high, medium or low" });
  if (req.query.code === undefined && !hasPayment(req)) return next();
  return normalizeCountryCode(req.query.code) === null ? res.status(400).json({ error: "code is required: a 2-letter country code (e.g. US, RU, CN, UA, GB, EU)" }) : next();
});
app.get("/news/data-surprises", numCheck("hours", HOURS_DAY), optQCheck);
app.get("/news/sentiment", numCheck("hours", HOURS_DAY), preCheckQ);
app.get("/news/digest", numCheck("hours", HOURS_DIGEST));
// ---------- RU data + Telegram: one table drives pre-payment validation, the paid handlers and the admin probe ----------
const MONTHS_OPT = { def: 24, min: 1, max: 120 }, MOVERS_LIMIT = { def: 10, min: 1, max: 50 }, MIN_VALUE = { def: 5e6, min: 0, max: 1e12 };
const WEEKS_OPT = { def: 4, min: 0, max: 52 }, TG_LIMIT = { def: 20, min: 1, max: 50 };
const isNum = (q, k, o) => parseNumParam(q[k], o) !== null;
const DATA_OPS = {
  "/ru/fx": { op: "ru-fx", required: [],
    validate: (q) => (q.date !== undefined && parseIsoDate(q.date) === null ? "date must be YYYY-MM-DD between 1992-07-01 and tomorrow"
      : q.codes !== undefined && parseCodes(q.codes) === null ? "codes must be a comma list of 3-letter currency codes (max 30), e.g. USD,EUR" : null),
    run: (q) => getFx({ date: q.date === undefined ? null : parseIsoDate(q.date), codes: q.codes === undefined ? null : parseCodes(q.codes) }) },
  "/ru/key-rate": { op: "ru-key-rate", required: [], validate: (q) => (isNum(q, "months", MONTHS_OPT) ? null : "months must be a number"),
    run: (q) => getKeyRate({ months: parseNumParam(q.months, MONTHS_OPT) }) },
  "/moex/quote": { op: "moex-quote", required: ["ticker"],
    validate: (q) => (parseTicker(q.ticker) === null ? "ticker is required: a MOEX ticker such as SBER (1-12 letters/digits)" : null),
    run: (q) => getQuote(parseTicker(q.ticker)) },
  "/moex/index": { op: "moex-index", required: [],
    validate: (q) => (q.code !== undefined && parseIndexCodes(q.code) === null ? "code must be up to 5 comma-separated index codes (e.g. IMOEX,RTSI) or list" : null),
    run: (q) => getIndex(q.code === undefined ? ["IMOEX"] : parseIndexCodes(q.code)) },
  "/moex/movers": { op: "moex-movers", required: [],
    validate: (q) => (!isNum(q, "limit", MOVERS_LIMIT) ? "limit must be a number" : parseFloatParam(q.min_value, MIN_VALUE) === null ? "min_value must be a non-negative number (RUB)" : null),
    run: (q) => getMovers({ limit: parseNumParam(q.limit, MOVERS_LIMIT), minValue: parseFloatParam(q.min_value, MIN_VALUE) }) },
  "/ru/fuel": { op: "ru-fuel", required: [], validate: (q) => (isNum(q, "weeks", WEEKS_OPT) ? null : "weeks must be a number (0-52)"),
    run: (q) => getFuel({ weeks: parseNumParam(q.weeks, WEEKS_OPT) }) },
  "/tg/channel/latest": { op: "tg-latest", required: ["channel"],
    validate: (q) => (normalizeChannel(q.channel) === null ? "channel is required: a public channel username (5-32 letters/digits/_), e.g. markettwits"
      : !isNum(q, "limit", TG_LIMIT) ? "limit must be a number" : null),
    run: (q) => channelLatest(normalizeChannel(q.channel), { limit: parseNumParam(q.limit, TG_LIMIT) }) },
  "/tg/search": { op: "tg-search", required: ["q", "channels"],
    validate: (q) => (parseQ(q.q) === null ? "q is required (1-100 characters)"
      : parseChannelList(q.channels) === null ? "channels is required: 1-5 comma-separated public channel usernames" : !isNum(q, "limit", TG_LIMIT) ? "limit must be a number" : null),
    run: (q) => channelSearch(parseQ(q.q), parseChannelList(q.channels), { limit: parseNumParam(q.limit, TG_LIMIT) }) },
};
// Validate only what is present; required params may be absent when no payment is attached (-> 402 challenge).
function dataValidate(spec, q, { allowMissing }) {
  const missing = spec.required.filter((k) => q[k] === undefined);
  if (missing.length && !allowMissing) return spec.validate(q);
  const filled = { ...q }; // stand-ins for absent required params so validate() checks the others
  for (const k of missing) filled[k] = { ticker: "SBER", channel: "markettwits", q: "x", channels: "markettwits" }[k];
  return spec.validate(filled);
}
async function runDataOp(spec, q) {
  const err = dataValidate(spec, q, { allowMissing: false });
  if (err) return [400, { error: err }];
  try { return [200, await spec.run(q)]; } catch (e) {
    if (e.status === 404) return [404, { error: "not_found", detail: e.detail || e.message }];
    console.error(`[data] ${spec.op} failed:`, e.detail || e.message, JSON.stringify(e.attempts || []));
    return [502, { error: "upstream_unavailable", detail: e.detail || e.message, ...(e.attempts?.length ? { attempts: e.attempts } : {}) }];
  }
}
for (const [path, spec] of Object.entries(DATA_OPS)) app.get(path, (req, res, next) => {
  const err = dataValidate(spec, req.query, { allowMissing: !hasPayment(req) });
  return err ? res.status(400).json({ error: err }) : next();
});
// /product/info: invalid/foreign url -> 400 before payment; missing url without payment -> 402 (x402scan probes).
app.get("/product/info", (req, res, next) => {
  const present = req.query.url !== undefined;
  if (!present && !hasPayment(req)) return next();
  const p = parseProductUrl(req.query.url);
  if (p.error) return res.status(400).json({ error: p.error });
  next();
});
// /product/compare|monitor|history: invalid input -> 400 before payment; nothing given and no payment -> 402 (x402scan probes).
const anyPresent = (req, keys) => keys.some((k) => req.query[k] !== undefined);
app.get("/product/compare", (req, res, next) => {
  if (!anyPresent(req, ["urls", "url"]) && !hasPayment(req)) return next();
  const c = parseCompareInput(req.query, parseProductUrl);
  return c.error ? res.status(400).json({ error: c.error }) : next();
});
app.get("/product/monitor", (req, res, next) => {
  if (!anyPresent(req, ["url", "target_price"]) && !hasPayment(req)) return next();
  const e = monitorInputError(req.query);
  return e ? res.status(400).json({ error: e }) : next();
});
app.get("/product/history", (req, res, next) => {
  if (!anyPresent(req, ["url"]) && !hasPayment(req)) return next();
  const p = parseProductUrl(req.query.url);
  return p.error ? res.status(400).json({ error: p.error }) : next();
});
app.get("/admin/proxy-check", async (req, res) => {
  if (!INGEST_TOKEN) return res.status(404).json({ error: "disabled" });
  if (!tokenOk(req.get("authorization"))) return res.status(401).json({ error: "unauthorized" });
  res.json(await proxyDiagnostics());
});
// Temporary diagnostic (free, INGEST_TOKEN bearer, not in OpenAPI): same fetch logic, cache bypassed.
app.get("/admin/product-probe", async (req, res) => {
  if (!INGEST_TOKEN) return res.status(404).json({ error: "disabled" });
  if (!tokenOk(req.get("authorization"))) return res.status(401).json({ error: "unauthorized" });
  const t = Date.now(), op = String(req.query.op || "info");
  const dataSpec = Object.values(DATA_OPS).find((d) => d.op === op);
  if (dataSpec) { const [status, body] = await runDataOp(dataSpec, req.query); return res.json({ ok: status === 200, op, status, ms: Date.now() - t, body }); }
  if (op.startsWith("news-") && NEWS_OPS[op.slice(5)]) { const [status, body] = NEWS_OPS[op.slice(5)](req.query); return res.json({ ok: status === 200, op, status, ms: Date.now() - t, body }); }
  if (PRODUCT_OPS[op]) { const [status, body] = await PRODUCT_OPS[op](req.query); return res.json({ ok: status === 200, op, status, ms: Date.now() - t, body }); }
  const p = parseProductUrl(req.query.url);
  if (p.error) return res.status(400).json({ error: p.error });
  try { const result = await fetchProduct(p, { noCache: true }); res.json({ ok: true, ms: Date.now() - t, result }); }
  catch (e) { res.json({ ok: false, ms: Date.now() - t, error: e.detail || e.message, attempts: e.attempts || [] }); }
});

if (MODE === "paid") {
  // CDP: @coinbase/x402 createFacilitatorConfig -> { url, createAuthHeaders } (per-request CDP JWTs)
  const facilitator = new HTTPFacilitatorClient(
    USE_CDP ? createFacilitatorConfig(CDP_API_KEY_ID, CDP_API_KEY_SECRET) : { url: FACILITATOR_URL });
  const resourceServer = new x402ResourceServer(facilitator).register(NETWORK, new ExactEvmScheme())
    .registerExtension(bazaarResourceServerExtension);
  const routes = {};
  for (const r of PAID_ROUTES) {
    routes[`GET ${r.path}`] = {
      accepts: [{ scheme: "exact", price: routePrice(r), network: NETWORK, payTo: PAY_TO, maxTimeoutSeconds: 60 }],
      description: r.description,
      mimeType: "application/json",
      // Bazaar discovery metadata in the 402 challenge (input/output schema for x402scan / facilitator catalogs)
      extensions: {
        ...declareDiscoveryExtension({
          input: r.example,
          inputSchema: { properties: r.params, required: r.required },
          output: r.outputSchema
            ? { example: r.outputExample, schema: NOFMT(r.outputSchema) }
            : { example: { count: 1, items: [EXAMPLE_ITEM] }, schema: LIST_OUTPUT_SCHEMA(NEWS_ITEM_SCHEMA_NOFMT) },
        }),
      },
    };
  }
  app.use(paymentMiddleware(routes, resourceServer));
} else {
  app.use((_req, res, next) => { res.set("X-Dev-Mode", "unpaid"); next(); });
}

function parseLimit(v) {
  let limit = parseInt(v ?? "20", 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 20;
  return Math.min(limit, 50);
}
const sendItems = (res, items) => res.json({ count: items.length, items: items.map(publicItem) });

app.get("/news/latest", (req, res) => sendItems(res, readNews().slice(0, parseLimit(req.query.limit))));

app.get("/news/important", (req, res) =>
  sendItems(res, readNews().filter((i) => i.importance === "high").slice(0, parseLimit(req.query.limit))));

app.get("/news/search", (req, res) => {
  const q = parseQ(req.query.q);
  if (q === null) return res.status(400).json({ error: "q is required (1-100 characters)" }); // no settlement on 4xx
  const terms = parseTerms(q);
  if (!terms.length) return res.status(400).json({ error: "q must contain at least one word" });
  const limit = parseLimit(req.query.limit);
  const out = [];
  for (const it of readNews()) {
    if (matchesTerms(it.text_en, terms)) { out.push(it); if (out.length >= limit) break; }
  }
  sendItems(res, out);
});

// Shared q handling for the analytics routes (400s here are never settled by the x402 middleware).
function qTerms(req, res) {
  const q = parseQ(req.query.q);
  if (q === null) { res.status(400).json({ error: "q is required (1-100 characters)" }); return null; }
  const terms = parseTerms(q);
  if (!terms.length) { res.status(400).json({ error: "q must contain at least one word" }); return null; }
  return { q, terms };
}
const shortItem = ({ id, published_at, importance, source_url }) => ({ id, published_at, importance, source_url });

app.get("/news/alerts/check", (req, res) => {
  const m = qTerms(req, res); if (!m) return;
  const hours = parseNumParam(req.query.hours, HOURS_ALERT);
  if (hours === null) return res.status(400).json({ error: "hours must be a number" });
  const sinceMs = Date.now() - hours * 3600e3;
  const hits = readNews().filter((it) => ts(it) >= sinceMs && matchesTerms(it.text_en, m.terms)); // newest first
  res.json({ query: m.q, hours, count: hits.length, since: isoSec(sinceMs),
    latest_id: hits[0]?.id ?? null, latest_published_at: hits[0]?.published_at ?? null,
    items: hits.slice(0, 5).map(({ id, published_at, importance, text_en, source_url }) => ({ id, published_at, importance, text_en, source_url })) });
});

app.get("/news/summary", (req, res) => {
  const m = qTerms(req, res); if (!m) return;
  const limit = parseNumParam(req.query.limit, LIMIT_SUMMARY);
  if (limit === null) return res.status(400).json({ error: "limit must be a number" });
  const hits = [];
  for (const it of readNews()) { if (matchesTerms(it.text_en, m.terms)) { hits.push(it); if (hits.length >= limit) break; } }
  res.json({ query: m.q, count: hits.length, summary: buildSummary(m.q, hits), items: hits.map(shortItem) });
});

app.get("/news/top-topics", (req, res) => {
  const hours = parseNumParam(req.query.hours, HOURS_TOPICS);
  if (hours === null) return res.status(400).json({ error: "hours must be a number" });
  const sinceMs = Date.now() - hours * 3600e3;
  const high = readNews().filter((it) => it.importance === "high");
  let items = high.filter((it) => ts(it) >= sinceMs);
  const fallback = items.length === 0;
  if (fallback) items = high.slice(0, 20);
  res.json({ hours, items_considered: items.length, topics: topTopics(items, 5), fallback,
    ...(fallback ? { note: `No high-importance items in the last ${hours}h; used the last ${items.length} high-importance items instead.` } : {}) });
});


app.get("/news/summary/recent", (req, res) => {
  const m = qTerms(req, res); if (!m) return;
  const hours = parseNumParam(req.query.hours, HOURS_RECENT);
  if (hours === null) return res.status(400).json({ error: "hours must be a number" });
  res.json(recentSummary(readNews(), m.q, hours));
});

app.get("/news/alerts/new", (req, res) => {
  const m = qTerms(req, res); if (!m) return;
  const hours = parseNumParam(req.query.hours, HOURS_ALERT_NEW);
  if (hours === null) return res.status(400).json({ error: "hours must be a number" });
  res.json(alertsNew(readNews(), m.q, hours));
});

app.get("/news/topics/trending", (req, res) => {
  const hours = parseNumParam(req.query.hours, HOURS_TOPICS);
  if (hours === null) return res.status(400).json({ error: "hours must be a number" });
  res.json(trending(readNews(), hours));
});


// ---------- news v3 handlers (400s here are never settled) ----------
const NEWS_OPS = {
  since(q) {
    const id = parseCursorId(q.id), limit = parseNumParam(q.limit, SINCE_LIMIT);
    if (id === null) return [400, { error: "id is required: the last item id you have (non-negative integer, 0 = from the start)" }];
    if (limit === null) return [400, { error: "limit must be a number" }];
    const r = newsSince(readNews(), id, limit);
    return [200, { ...r, items: r.items.map(publicItem) }];
  },
  movers(q) {
    const hours = parseNumParam(q.hours, HOURS_MOVERS), minPct = parseFloatParam(q.min_pct, MIN_PCT);
    if (hours === null) return [400, { error: "hours must be a number" }];
    if (minPct === null) return [400, { error: "min_pct must be a non-negative number" }];
    return [200, movers(readNews(), hours, minPct)];
  },
  country(q) {
    const code = normalizeCountryCode(q.code), hours = parseNumParam(q.hours, HOURS_DAY), imp = String(q.importance ?? "all").toLowerCase();
    if (code === null) return [400, { error: "code is required: a 2-letter country code (e.g. US, RU, CN, UA, GB, EU)" }];
    if (hours === null) return [400, { error: "hours must be a number" }];
    if (!IMPORTANCES.has(imp)) return [400, { error: "importance must be all, high, medium or low" }];
    return [200, countryNews(readNews(), code, hours, imp)];
  },
  "data-surprises"(q) {
    const hours = parseNumParam(q.hours, HOURS_DAY);
    if (hours === null) return [400, { error: "hours must be a number" }];
    let query = null;
    if (q.q !== undefined) { query = parseQ(q.q); if (query === null || !parseTerms(query).length) return [400, { error: "q must be 1-100 characters" }]; }
    return [200, dataSurprises(readNews(), hours, query)];
  },
  sentiment(q) {
    const query = parseQ(q.q), hours = parseNumParam(q.hours, HOURS_DAY);
    if (query === null || !parseTerms(query).length) return [400, { error: "q is required (1-100 characters)" }];
    if (hours === null) return [400, { error: "hours must be a number" }];
    return [200, sentiment(readNews(), query, hours)];
  },
  digest(q) {
    const hours = parseNumParam(q.hours, HOURS_DIGEST);
    if (hours === null) return [400, { error: "hours must be a number" }];
    return [200, digest(readNews(), hours)];
  },
};
for (const op of Object.keys(NEWS_OPS)) app.get(`/news/${op}`, (req, res) => { const [status, body] = NEWS_OPS[op](req.query); res.status(status).json(body); });

for (const [path, spec] of Object.entries(DATA_OPS)) app.get(path, async (req, res) => { const [status, body] = await runDataOp(spec, req.query); res.status(status).json(body); });

app.get("/product/info", async (req, res) => {
  const p = parseProductUrl(req.query.url);
  if (p.error) return res.status(400).json({ error: p.error });
  try {
    res.json(await fetchProduct(p));
  } catch (e) {
    // >= 400 -> the x402 middleware cancels settlement: the buyer is not charged.
    res.status(502).json({ error: "upstream_unavailable", detail: e instanceof UpstreamError ? e.detail : String(e.message || e) });
  }
});

// ---------- /product/compare, /product/monitor, /product/history (also reachable via /admin/product-probe?op=...) ----------
function monitorInputError(q) {
  const p = parseProductUrl(q.url);
  if (p.error) return p.error;
  if (parseTargetPrice(q.target_price) === null) return "target_price is required: a positive number in RUB (e.g. 1500)";
  return null;
}
async function fetchOne(p) {
  try { return { p, value: await fetchProduct(p) }; }
  catch (e) { return { p, error: e instanceof UpstreamError ? e.detail : String(e.message || e), hint: e.hint || null }; }
}
async function mapLimit(list, n, fn) { // the VPS parser renders one page at a time; 2 in flight keeps its queue short
  const out = new Array(list.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => { while (i < list.length) { const k = i++; out[k] = await fn(list[k]); } }));
  return out;
}
const PRODUCT_OPS = {
  async compare(q) {
    const c = parseCompareInput(q, parseProductUrl);
    if (c.error) return [400, { error: c.error }];
    const out = compareProducts(await mapLimit(c.products, 2, fetchOne));
    if (out.succeeded < 2) return [502, { error: "upstream_unavailable", detail: `only ${out.succeeded} of ${out.count} products returned a price (need 2)`, items: out.items }];
    return [200, out];
  },
  async monitor(q) {
    const e = monitorInputError(q);
    if (e) return [400, { error: e }];
    const p = parseProductUrl(q.url), r = await fetchOne(p);
    const out = monitorResult({ value: r.value, hint: r.hint, target: parseTargetPrice(q.target_price) });
    return out ? [200, out] : [502, { error: "upstream_unavailable", detail: r.error }];
  },
  async history(q) {
    const p = parseProductUrl(q.url);
    if (p.error) return [400, { error: p.error }];
    const [weekly, live] = await Promise.all([
      p.source === "wildberries" ? fetchWbPriceHistory(p.product_id).catch(() => null) : Promise.resolve(null), fetchOne(p)]);
    const h = buildHistory({ p, weekly: weekly || [], observed: getObservations(p.source, p.product_id), live: live.value || null });
    if (!h) return [502, { error: "upstream_unavailable", detail: live.error || "no price available" }];
    if (!h.title && live.hint?.title) h.title = live.hint.title;
    if (!live.value && live.hint?.in_stock === false) h.note = [h.note, "The product is currently out of stock."].filter(Boolean).join(" ");
    return [200, h];
  },
};
for (const op of ["compare", "monitor", "history"]) {
  app.get(`/product/${op}`, async (req, res) => { const [status, body] = await PRODUCT_OPS[op](req.query); res.status(status).json(body); }); // >=400 never settled
}

app.listen(PORT, HOST, () => console.log(`proxy=${describeProxy(proxyConfig())} x402-news listening on ${HOST}:${PORT} mode=${MODE} network=${NETWORK} facilitator=${FACILITATOR_TYPE} price=${PRICE} payTo=${PAY_TO || "-"} ingest=${INGEST_TOKEN ? "on" : "off"} parser=${parserConfigured() ? "on" : "off"} file=${NEWS_FILE}`));
