// x402-paid MarketTwits news API
// Free:  GET /health, GET /news/sample
// Paid:  GET /news/latest?limit=N   (x402 v2, exact scheme)
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
let assetInfo = null; // resolved once from @x402/evm (USDC address for NETWORK)
async function resolveAsset() {
  if (assetInfo) return assetInfo;
  try {
    const r = await new ExactEvmScheme().parsePrice(PRICE, NETWORK);
    assetInfo = { asset: r.asset, amount: r.amount, decimals: 6, name: r.extra?.name || "USDC" };
  } catch { assetInfo = { asset: null, amount: null }; }
  return assetInfo;
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
];
const LIST_OUTPUT_SCHEMA = (itemSchema) => ({
  type: "object", required: ["count", "items"],
  properties: { count: { type: "integer" }, items: { type: "array", items: itemSchema } },
});

app.get("/openapi.json", async (req, res) => {
  const a = await resolveAsset();
  const host = req.host; // honours X-Forwarded-Host (trust proxy)
  const server = PUBLIC_URL || (host ? `${req.protocol}://${host}` : DEFAULT_PUBLIC_URL);
  const paid = MODE === "paid";
  const paymentInfo = {
    price: { mode: "fixed", currency: "USD", amount: PRICE_USD },
    protocols: [{ x402: { network: NETWORK, scheme: "exact", payTo: PAY_TO, asset: a.asset, amount: a.amount } }],
  };
  const paidPaths = {};
  for (const r of PAID_ROUTES) {
    paidPaths[r.path] = { get: {
      operationId: r.operationId, summary: r.summary, description: r.description, tags: ["news"], security: [],
      parameters: Object.entries(r.params).map(([name, schema]) => {
        const { description, ...sch } = schema;
        return { name, in: "query", required: r.required.includes(name), description, schema: sch };
      }),
      ...(paid ? { "x-payment-info": paymentInfo } : {}),
      responses: {
        200: { description: "News items (newest first); empty items array when nothing matches",
          content: { "application/json": { schema: LIST_OUTPUT_SCHEMA({ $ref: "#/components/schemas/NewsItem" }) } } },
        ...(r.badRequest ? { 400: { description: "Missing or invalid q (1-100 chars). Returned before payment when a payment is attached or q is invalid.",
          content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } } } } : {}),
        402: {
          description: "Payment Required. x402 v2 challenge in the PAYMENT-REQUIRED response header (base64 JSON).",
          headers: { "PAYMENT-REQUIRED": { description: "Base64-encoded x402 PaymentRequired object", schema: { type: "string" } } },
        },
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
      "x-guidance": `Three paid endpoints, ${PRICE} USDC each per request via x402 (scheme exact, network ${NETWORK}` +
        `${paid ? `, payTo ${PAY_TO}` : ""}). ` +
        `GET /news/latest?limit=N - full feed (high+medium), use for polling/monitoring all market news. ` +
        `GET /news/important?limit=N - only importance=high, use when you want market-moving headlines only. ` +
        `GET /news/search?q=WORDS&limit=N - case-insensitive keyword search (all words must match; '#oil' and 'oil' both work), ` +
        `use for a topic/ticker/country (e.g. q=oil, q=Fed rates, q=BTC). limit is 1-50 (default 20); results newest first. ` +
        `An unpaid call returns HTTP 402 with a PAYMENT-REQUIRED header (base64 x402 v2 challenge); pay with an x402 client ` +
        `(e.g. @x402/fetch) and retry. Invalid q (empty or >100 chars) returns 400 before any payment; no match returns 200 with items []. ` +
        `Response: {count, items:[{id, source_url, published_at, importance, text_en, posted_to_x, buffer_post_id}]}. ` +
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
app.get("/news/search", (req, res, next) => {
  const hasPayment = Boolean(req.get("payment-signature") || req.get("x-payment"));
  const present = req.query.q !== undefined;
  if (parseQ(req.query.q) === null && (present || hasPayment)) {
    return res.status(400).json({ error: "q is required (1-100 characters)" });
  }
  next();
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
      accepts: [{ scheme: "exact", price: PRICE, network: NETWORK, payTo: PAY_TO, maxTimeoutSeconds: 60 }],
      description: r.description,
      mimeType: "application/json",
      // Bazaar discovery metadata in the 402 challenge (input/output schema for x402scan / facilitator catalogs)
      extensions: {
        ...declareDiscoveryExtension({
          input: r.example,
          inputSchema: { properties: r.params, required: r.required },
          output: { example: { count: 1, items: [EXAMPLE_ITEM] }, schema: LIST_OUTPUT_SCHEMA(NEWS_ITEM_SCHEMA_NOFMT) },
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
  const terms = q.toLowerCase().split(/\s+/).map((t) => t.replace(/^#+/, "")).filter(Boolean);
  if (!terms.length) return res.status(400).json({ error: "q must contain at least one word" });
  const limit = parseLimit(req.query.limit);
  const out = [];
  for (const it of readNews()) {
    const text = it.text_en.toLowerCase();
    if (terms.every((t) => text.includes(t))) { out.push(it); if (out.length >= limit) break; }
  }
  sendItems(res, out);
});

app.listen(PORT, HOST, () => console.log(`x402-news listening on ${HOST}:${PORT} mode=${MODE} network=${NETWORK} facilitator=${FACILITATOR_TYPE} price=${PRICE} payTo=${PAY_TO || "-"} ingest=${INGEST_TOKEN ? "on" : "off"} file=${NEWS_FILE}`));
