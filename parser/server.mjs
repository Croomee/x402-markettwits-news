// Headless-browser product parser for Wildberries / Ozon. GET /parse?url=... (Bearer PARSER_TOKEN), GET /health.
import http from "node:http";
import crypto from "node:crypto";
import { parseTarget } from "./extract.mjs";
import { parseProduct, ensureBrowser, browserUp, proxyInfo, shutdown, ParseError } from "./browser.mjs";

const PORT = Number(process.env.PORT || 8090), HOST = process.env.HOST || "0.0.0.0";
const TOKEN = process.env.PARSER_TOKEN || "";
const TIMEOUT_MS = Number(process.env.PARSE_TIMEOUT_MS || 25000);
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 2));
const QUEUE_MAX = Number(process.env.QUEUE_MAX || 20);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_S || 600) * 1000, NEG_TTL_MS = 60_000;
if (!TOKEN || TOKEN.length < 16) { console.error("PARSER_TOKEN (>=16 chars) is required"); process.exit(1); }

const cache = new Map(), inflight = new Map();
let active = 0; const waiters = [];
const acquire = () => (active < CONCURRENCY ? (active++, Promise.resolve()) : new Promise((r) => waiters.push(r)));
const release = () => { const w = waiters.shift(); if (w) w(); else active--; };
const tokenOk = (h) => { const m = /^Bearer\s+(.+)$/i.exec(h || ""); if (!m) return false;
  const a = crypto.createHash("sha256").update(m[1].trim()).digest(), b = crypto.createHash("sha256").update(TOKEN).digest(); return crypto.timingSafeEqual(a, b); };
const send = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };
const STATUS = { invalid: 400, not_found: 404, blocked: 502, timeout: 504, browser_error: 502, busy: 503 };

async function handleParse(t) {
  const key = `${t.source}:${t.product_id}`, hit = cache.get(key);
  if (hit && Date.now() - hit.at < (hit.ok ? CACHE_TTL_MS : NEG_TTL_MS)) return { ...hit.value, cached: true };
  if (inflight.has(key)) return inflight.get(key);
  if (waiters.length >= QUEUE_MAX) throw new ParseError("busy", "parser queue is full, retry later");
  const p = (async () => {
    await acquire();
    const t0 = Date.now();
    try {
      const d = await parseProduct(t, TIMEOUT_MS);
      const value = { ok: true, source: t.source, product_id: t.product_id, url: t.url, title: d.title ?? null, price: d.price ?? null,
        old_price: d.old_price ?? null, currency: d.currency || "RUB", rating: d.rating ?? null, reviews_count: d.reviews_count ?? null,
        in_stock: d.in_stock ?? null, availability: d.in_stock === true ? "in_stock" : d.in_stock === false ? "out_of_stock" : "unknown",
        brand: d.brand ?? null, seller: d.seller ?? null, data_source: d.data_source, fetched_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"), ms: Date.now() - t0 };
      if (value.price === null && value.in_stock !== false) throw new ParseError("blocked", "page loaded but no price was found");
      cache.set(key, { at: Date.now(), ok: true, value });
      return { ...value, cached: false };
    } catch (e) {
      const err = e instanceof ParseError ? e : new ParseError("browser_error", String(e.message || e));
      err.ms = Date.now() - t0;
      if (err.code === "not_found") cache.set(key, { at: Date.now(), ok: false, value: null, err });
      throw err;
    } finally { release(); if (cache.size > 2000) cache.delete(cache.keys().next().value); }
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/health") return send(res, 200, { ok: true, browser: browserUp(), proxy: proxyInfo(), active, queued: waiters.length, cache: cache.size });
  if (u.pathname !== "/parse") return send(res, 404, { ok: false, error: "not_found" });
  if (!tokenOk(req.headers.authorization)) return send(res, 401, { ok: false, error: "unauthorized" });
  let url = u.searchParams.get("url");
  if (req.method === "POST") { let b = ""; for await (const c of req) { b += c; if (b.length > 8192) break; } try { url = JSON.parse(b).url ?? url; } catch {} }
  else if (req.method !== "GET") return send(res, 405, { ok: false, error: "method_not_allowed" });
  const t = parseTarget(url);
  if (t.error) return send(res, 400, { ok: false, error: "invalid", message: t.error });
  const hit = cache.get(`${t.source}:${t.product_id}`);
  if (hit && !hit.ok && Date.now() - hit.at < NEG_TTL_MS) return send(res, 404, { ok: false, error: hit.err.code, message: hit.err.message, cached: true });
  try { send(res, 200, await handleParse(t)); }
  catch (e) { send(res, STATUS[e.code] || 502, { ok: false, error: e.code || "error", message: e.message, source: t.source, product_id: t.product_id, ms: e.ms ?? null }); }
});
server.requestTimeout = TIMEOUT_MS * 3;
server.listen(PORT, HOST, () => console.log(`x402-parser listening on ${HOST}:${PORT} concurrency=${CONCURRENCY} timeout=${TIMEOUT_MS}ms cache=${CACHE_TTL_MS / 1000}s`));
ensureBrowser().catch((e) => console.error("browser start failed (will retry on first request):", e.message));
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, async () => { await shutdown(); process.exit(0); });
