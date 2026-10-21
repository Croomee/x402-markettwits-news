// One shared Chromium + context (cookies/tokens survive across requests and restarts via storageState).
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { startBridge } from "./bridge.mjs";
import { parseProxyUrl, maskSecrets, mapWbCard, mapLdJson, mapOzonWidgets, merge, classifyBlock } from "./extract.mjs";

const STATE_FILE = process.env.STATE_FILE || path.join(process.env.STATE_DIR || "/var/lib/x402-parser", "storage-state.json");
const HEADLESS = !/^(0|false|no)$/i.test(process.env.HEADLESS || "");
const BLOCK = new Set((process.env.BLOCK_RESOURCES ?? "image,media,font").split(",").map((s) => s.trim()).filter(Boolean));
const LOW_MEMORY = /^(1|true|yes)$/i.test(process.env.LOW_MEMORY || ""); // small VPS (~1 GB RAM): fewer renderers, smaller JS heap
const WB_DEST = process.env.WB_DEST || "-1257786"; // Moscow delivery region

export class ParseError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

let proxy = null, bridge = null, browser = null, context = null, starting = null, wbPage = null, lastSave = 0;
export const proxyInfo = () => (proxy ? { scheme: proxy.scheme, bridged: !!bridge } : null);
const log = (...a) => console.log(new Date().toISOString(), ...a.map((x) => maskSecrets(x, proxy)));

async function start() {
  proxy = parseProxyUrl(process.env.PROXY_URL);
  let pw;
  if (proxy?.scheme.startsWith("socks")) {
    if (!bridge) bridge = await startBridge(proxy, { log });   // Chromium can't do SOCKS5 auth -> local CONNECT bridge
    pw = { server: bridge.url };
  } else if (proxy) {
    pw = { server: `${proxy.scheme}://${proxy.host}:${proxy.port}`, ...(proxy.username ? { username: proxy.username, password: proxy.password } : {}) };
  }
  const exe = String(process.env.CHROMIUM_EXECUTABLE || "").trim(); // distro chromium fallback (setup script) instead of Playwright's build
  browser = await chromium.launch({ headless: HEADLESS, ...(exe ? { executablePath: exe } : { channel: process.env.CHROMIUM_CHANNEL || "chromium" }), proxy: pw,
    args: ["--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage", "--no-first-run", "--lang=ru-RU",
      "--disable-gpu", "--disable-extensions", "--disable-background-networking", "--disable-component-update", "--mute-audio",
      ...(LOW_MEMORY ? ["--renderer-process-limit=2", "--js-flags=--max-old-space-size=320", "--disable-features=Translate,MediaRouter,OptimizationHints",
        "--disk-cache-size=33554432"] : [])] });
  const major = browser.version().split(".")[0];
  // UA must match the real engine + OS, otherwise the WB challenge loops (HeadlessChrome UA gets 498 forever).
  const userAgent = process.env.USER_AGENT || `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  context = await browser.newContext({ userAgent, locale: "ru-RU", timezoneId: "Europe/Moscow", viewport: { width: 1366, height: 768 },
    extraHTTPHeaders: { "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8" }, storageState: fs.existsSync(STATE_FILE) ? STATE_FILE : undefined });
  await context.addInitScript(() => { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); });
  if (BLOCK.size) await context.route("**/*", (r) => (BLOCK.has(r.request().resourceType()) && !/abt-challenge/.test(r.request().url()) ? r.abort() : r.continue()));
  browser.on("disconnected", () => { log("browser disconnected"); browser = context = wbPage = null; wbHeaders = null; });
  log(`browser up: chromium ${browser.version()} headless=${HEADLESS} proxy=${proxy ? proxy.scheme + (bridge ? " via local bridge" : "") : "none (direct)"}`);
}
export async function ensureBrowser() {
  if (context) return context;
  if (!starting) starting = start().finally(() => { starting = null; });
  await starting; return context;
}
export const browserUp = () => !!context;
async function saveState() {
  if (Date.now() - lastSave < 60_000) return; lastSave = Date.now();
  try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); await context.storageState({ path: STATE_FILE }); } catch (e) { log("state save failed", e.message); }
}
const left = (deadline) => Math.max(0, deadline - Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Wildberries ----------
// A warm tab on wildberries.ru keeps the wbaas token; each request is then one in-page fetch of the site's own card API.
// wbaas also checks the SPA's own request headers (deviceid / x-spa-version); copy them from the SPA's first XHR.
let wbHeaders = null;
function watchWbHeaders(page) {
  page.on("request", (q) => { const h = q.headers();
    if (h.deviceid && /wildberries\.ru\/__internal\//.test(q.url())) wbHeaders = { deviceid: h.deviceid, "x-requested-with": "XMLHttpRequest", ...(h["x-spa-version"] ? { "x-spa-version": h["x-spa-version"] } : {}) }; });
}
async function wbCardFetch(page, id) {
  if (!wbHeaders) return { status: 0, body: null };
  const out = await page.evaluate(async ({ id, dest, headers }) => {
    const r = await fetch(`/__internal/u-card/cards/v4/detail?appType=1&curr=rub&dest=${dest}&spp=30&lang=ru&ab_testing=false&nm=${id}`, { credentials: "include", headers });
    return { status: r.status, body: r.status === 200 ? await r.json().catch(() => null) : null };
  }, { id, dest: WB_DEST, headers: wbHeaders });
  return out;
}
async function parseWb(t, deadline) {
  const ctx = await ensureBrowser();
  if (wbPage && !wbPage.isClosed() && /wildberries\.ru/.test(wbPage.url())) {        // fast path: token still valid
    try {
      const r = await wbCardFetch(wbPage, t.product_id);
      if (r.status === 200 && r.body) { const d = mapWbCard(r.body, t.product_id); if (d && (d.price !== null || d.in_stock === false)) return { ...d, data_source: "wb card api (browser, warm)" };
        if (Array.isArray(r.body.products) && !r.body.products.length) throw new ParseError("not_found", "Wildberries returned no product for this id"); }
    } catch (e) { if (e instanceof ParseError) throw e; }
  }
  if (!wbPage || wbPage.isClosed()) { wbPage = await ctx.newPage(); watchWbHeaders(wbPage); }
  let captured = null, docStatus = null;
  const onResp = async (r) => {
    try {
      if (r.request().isNavigationRequest() && r.request().frame() === wbPage.mainFrame()) docStatus = r.status();
      if (/u-card\/cards\/v4\/detail/.test(r.url()) && new RegExp(`nm=${t.product_id}(&|$)`).test(r.url()) && r.status() === 200) captured = await r.json();
    } catch {}
  };
  wbPage.on("response", onResp);
  try {
    await wbPage.goto(t.url, { waitUntil: "domcontentloaded", timeout: left(deadline) }).catch((e) => { if (!/interrupted|ERR_ABORTED|frame was detached/i.test(e.message)) throw e; });
    let tried = 0;
    while (left(deadline) > 300) {
      if (captured) { const d = mapWbCard(captured, t.product_id); if (d && (d.price !== null || d.in_stock === false)) return { ...d, data_source: "wb card api (browser)" }; if (!captured.products?.length) throw new ParseError("not_found", "Wildberries returned no product for this id"); }
      if (docStatus === 200 && wbHeaders && Date.now() - tried > 2000) {            // challenge passed: ask the API ourselves instead of waiting for the SPA
        tried = Date.now();
        const r = await wbCardFetch(wbPage, t.product_id).catch(() => null);
        if (r?.status === 200 && r.body) { const d = mapWbCard(r.body, t.product_id); if (d && (d.price !== null || d.in_stock === false)) return { ...d, data_source: "wb card api (browser)" };
          if (Array.isArray(r.body.products) && !r.body.products.length) throw new ParseError("not_found", "Wildberries returned no product for this id"); }
      }
      await sleep(400);
    }
    const ld = docStatus === 200 ? mapLdJson(await wbPage.content().catch(() => "")) : null;
    if (ld?.price) return { ...ld, data_source: "wb page json-ld (browser)" };
    throw new ParseError(docStatus === 498 ? "blocked" : "timeout", docStatus === 498 ? "Wildberries anti-bot challenge (498) did not clear in time" : `no product data before timeout (page status ${docStatus ?? "none"})`);
  } finally { wbPage.off("response", onResp); }
}

// ---------- Ozon ----------
async function parseOzon(t, deadline) {
  const ctx = await ensureBrowser();
  const page = await ctx.newPage();
  let docStatus = null, api = null;
  page.on("response", async (r) => {
    try {
      if (r.request().isNavigationRequest() && r.request().frame() === page.mainFrame()) docStatus = r.status();
      if (/entrypoint-api\.bx\/page\/json|composer-api\.bx\/page\/json/.test(r.url()) && r.status() === 200) api = await r.json();
    } catch {}
  });
  try {
    await page.goto(t.url, { waitUntil: "domcontentloaded", timeout: left(deadline) }).catch((e) => { if (!/interrupted|ERR_ABORTED/i.test(e.message)) throw e; });
    let triedApi = false;
    while (left(deadline) > 300) {
      const title = await page.title().catch(() => "");
      const onProduct = docStatus === 200 && !/__rr=|abt/.test(page.url());
      if (onProduct) {
        const ld = mapLdJson(await page.content().catch(() => ""));
        if (!api && !triedApi) { triedApi = true;
          api = await page.evaluate(async (p) => { const r = await fetch(`/api/entrypoint-api.bx/page/json/v2?url=${encodeURIComponent(p)}`, { credentials: "include" }); return r.ok ? r.json() : null; }, `/product/${t.product_id}/`).catch(() => null); }
        const w = mapOzonWidgets(api);
        if (ld?.price || w?.price) return { ...merge(w, ld), data_source: w?.price ? "ozon entrypoint-api (browser)" : "ozon page json-ld (browser)" };
      }
      const block = classifyBlock("ozon", { status: docStatus, title, html: docStatus === 403 ? await page.content().catch(() => "") : "" });
      if (block === "ozon_captcha") throw new ParseError("blocked", "Ozon anti-bot served an interactive captcha (not solved automatically)");
      await sleep(500);
    }
    throw new ParseError(docStatus === 403 ? "blocked" : "timeout", docStatus === 403 ? "Ozon anti-bot challenge (403 ?__rr) did not clear in time" : `no product data before timeout (page status ${docStatus ?? "none"})`);
  } finally { await page.close().catch(() => {}); }
}

export async function parseProduct(t, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  try {
    const d = t.source === "wildberries" ? await parseWb(t, deadline) : await parseOzon(t, deadline);
    saveState();
    return d;
  } catch (e) {
    if (e instanceof ParseError) throw e;
    if (/Target (page|closed)|browser has been closed/i.test(e.message)) { browser = context = wbPage = null; }
    throw new ParseError("browser_error", maskSecrets(e.message.split("\n")[0], proxy));
  }
}
export async function shutdown() { try { await browser?.close(); } catch {} try { await bridge?.close(); } catch {} }
