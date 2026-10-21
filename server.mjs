// x402-paid MarketTwits news API
// Free:  GET /health, GET /news/sample
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
import { parseProductUrl, fetchProduct, UpstreamError } from "./product.mjs";
import { parseTerms, matchesTerms, parseNumParam, isoSec, buildSummary, topTopics, recentSummary, alertsNew, trending } from "./news-logic.mjs";

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
  res.json({ ok: true, mode: MODE, network: NETWORK, facilitator: FACILITATOR_TYPE, price: PRICE, items: items.length, newest_id: items[0]?.id ?? null, ingest: INGEST_TOKEN ? "enabled" : "disabled" });
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
    cached: { type: "boolean", description: "true when served from the 10-minute cache" },
  } };
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
  { path: "/product/info", operationId: "getProductInfo", price: "$0.004", tags: ["product"],
    summary: "Wildberries / Ozon product card: title, price (RUB), rating, reviews, stock",
    description: "Live product data for a Wildberries (wildberries.ru, wb.ru) or Ozon (ozon.ru) product URL: title, current price in RUB " +
      "(original_amount = list price before discount when known), rating, reviews_count and availability. Cached 10 min per product. " +
      "If the marketplace blocks or fails, returns 502 upstream_unavailable and the payment is NOT settled.",
    params: { url: PRODUCT_URL_PARAM }, required: ["url"], badRequest: true,
    example: { url: "https://www.wildberries.ru/catalog/211695539/detail.aspx" },
    badRequestText: "url is not a valid http(s) URL, the host is not wildberries.ru/wb.ru/ozon.ru, or no product id could be extracted. Returned before payment.",
    outputSchema: PRODUCT_OUTPUT_SCHEMA, ok200: "Product data",
    outputExample: { source: "wildberries", url: "https://www.wildberries.ru/catalog/211695539/detail.aspx", product_id: "211695539",
      title: "PUSY / Гель для бровей", price: { amount: 623.31, currency: "RUB", original_amount: 1990 }, rating: 4.7, reviews_count: 243068,
      availability: "in_stock", in_stock: true, fetched_at: "2026-10-21T05:24:42Z", data_source: "card.wb.ru v4", cached: false },
    extraResponses: { 502: { description: "Marketplace blocked or failed (anti-bot, timeout ~10s, product not found). The x402 payment is not settled.",
      content: { "application/json": { schema: { type: "object", required: ["error"], properties: {
        error: { type: "string", enum: ["upstream_unavailable"] }, detail: { type: "string" } } } } } } } },
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
        "updated every few minutes. Ideal for trading bots and news agents.",
      "x-guidance": `Ten paid endpoints via x402 (USDC, scheme exact, network ${NETWORK}` +
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
        `Marketplace endpoint: GET /product/info?url=PRODUCT_URL ($0.004) - live Wildberries (wildberries.ru/wb.ru /catalog/<id>/) or ` +
        `Ozon (ozon.ru /product/<slug>-<id>/) product data {source, product_id, title, price:{amount, currency:'RUB', original_amount?}, ` +
        `rating, reviews_count, availability, in_stock}; a bad or foreign url returns 400 before payment, and if the marketplace ` +
        `blocks/fails it returns 502 upstream_unavailable without settling the payment. ` +
        `Free: GET /news/sample (one truncated item), GET /health.`,
      contact: { email: "whale2003@proton.me" },
    },
    servers: [{ url: server }],
    paths: {
      ...paidPaths,
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
// /product/info: invalid/foreign url -> 400 before payment; missing url without payment -> 402 (x402scan probes).
app.get("/product/info", (req, res, next) => {
  const present = req.query.url !== undefined;
  if (!present && !hasPayment(req)) return next();
  const p = parseProductUrl(req.query.url);
  if (p.error) return res.status(400).json({ error: p.error });
  next();
});
// Temporary diagnostic (free, INGEST_TOKEN bearer, not in OpenAPI): same fetch logic, cache bypassed.
app.get("/admin/product-probe", async (req, res) => {
  if (!INGEST_TOKEN) return res.status(404).json({ error: "disabled" });
  if (!tokenOk(req.get("authorization"))) return res.status(401).json({ error: "unauthorized" });
  const p = parseProductUrl(req.query.url);
  if (p.error) return res.status(400).json({ error: p.error });
  const t = Date.now();
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

app.listen(PORT, HOST, () => console.log(`x402-news listening on ${HOST}:${PORT} mode=${MODE} network=${NETWORK} facilitator=${FACILITATOR_TYPE} price=${PRICE} payTo=${PAY_TO || "-"} ingest=${INGEST_TOKEN ? "on" : "off"} file=${NEWS_FILE}`));
