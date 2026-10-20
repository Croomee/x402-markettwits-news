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

if (MODE === "paid") {
  // CDP: @coinbase/x402 createFacilitatorConfig -> { url, createAuthHeaders } (per-request CDP JWTs)
  const facilitator = new HTTPFacilitatorClient(
    USE_CDP ? createFacilitatorConfig(CDP_API_KEY_ID, CDP_API_KEY_SECRET) : { url: FACILITATOR_URL });
  const resourceServer = new x402ResourceServer(facilitator).register(NETWORK, new ExactEvmScheme());
  app.use(paymentMiddleware({
    "GET /news/latest": {
      accepts: [{ scheme: "exact", price: PRICE, network: NETWORK, payTo: PAY_TO, maxTimeoutSeconds: 60 }],
      description: "Latest translated MarketTwits news (newest first), limit 1-50",
      mimeType: "application/json",
    },
  }, resourceServer));
} else {
  app.use((_req, res, next) => { res.set("X-Dev-Mode", "unpaid"); next(); });
}

app.get("/news/latest", (req, res) => {
  let limit = parseInt(req.query.limit ?? "20", 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 20;
  limit = Math.min(limit, 50);
  const items = readNews().slice(0, limit).map(publicItem);
  res.json({ count: items.length, items });
});

app.listen(PORT, HOST, () => console.log(`x402-news listening on ${HOST}:${PORT} mode=${MODE} network=${NETWORK} facilitator=${FACILITATOR_TYPE} price=${PRICE} payTo=${PAY_TO || "-"} ingest=${INGEST_TOKEN ? "on" : "off"} file=${NEWS_FILE}`));
