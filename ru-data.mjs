// Russian market data for the x402 endpoints: CBR (FX, key rate), MOEX ISS (quotes, indices, movers),
// Rosstat weekly fuel prices. Pure parsers are exported for tests; fetchers use upstream.mjs
// (direct -> PROXY_URL fallback) and the shared TTL cache.
import { inflateRawSync } from "node:zlib";
import { upstream, cached, NotFoundError, UpstreamError, isoNow } from "./upstream.mjs";
import { RU_TRUSTED_CA } from "./ru-ca.mjs";

const r2 = (x, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
const numRu = (s) => { if (s === null || s === undefined) return null; const t = String(s).replace(/[\s\u00a0]/g, "").replace(",", "."); return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null; };
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
export const addDays = (iso, n) => ymd(new Date(Date.parse(iso + "T00:00:00Z") + n * 86400e3));
export const mskToday = (now = Date.now()) => ymd(new Date(now + 3 * 3600e3));

// ---------- param parsers (null = invalid) ----------
export function parseIsoDate(raw, { min = "1992-07-01", maxDaysAhead = 1, now = Date.now() } = {}) {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) return null;
  const s = raw.trim(), t = Date.parse(s + "T00:00:00Z");
  if (!Number.isFinite(t) || ymd(new Date(t)) !== s) return null;
  if (s < min || s > addDays(mskToday(now), maxDaysAhead)) return null;
  return s;
}
export function parseCodes(raw, { max = 30 } = {}) {
  if (typeof raw !== "string") return null;
  const list = raw.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean);
  if (!list.length || list.length > max || !list.every((c) => /^[A-Z]{3}$/.test(c))) return null;
  return [...new Set(list)];
}
export const parseTicker = (raw) => (typeof raw === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,11}$/.test(raw.trim()) ? raw.trim().toUpperCase() : null);
export function parseIndexCodes(raw, { max = 5 } = {}) {
  if (typeof raw !== "string") return null;
  if (raw.trim().toLowerCase() === "list") return "list";
  const list = raw.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean);
  if (!list.length || list.length > max || !list.every((c) => /^[A-Z0-9]{2,16}$/.test(c))) return null;
  return [...new Set(list)];
}

// ================= CBR =================
const CBR = "https://www.cbr.ru";
const dec1251 = new TextDecoder("windows-1251");
export const decodeCbr = (buf) => (/encoding="windows-1251"/i.test(buf.subarray(0, 100).toString("latin1")) ? dec1251.decode(buf) : buf.toString("utf8"));
export function parseCbrDaily(xml) {
  const m = /<ValCurs[^>]*Date="(\d\d)\.(\d\d)\.(\d{4})"/.exec(xml);
  if (!m) return null;
  const rates = [];
  for (const v of xml.matchAll(/<Valute ID="([^"]+)">([\s\S]*?)<\/Valute>/g)) {
    const f = (t) => (new RegExp(`<${t}>([^<]*)</${t}>`).exec(v[2]) || [])[1];
    const nominal = Number(f("Nominal")), value = numRu(f("Value"));
    if (!f("CharCode") || value === null || !nominal) continue;
    const unit = numRu(f("VunitRate"));
    rates.push({ code: f("CharCode"), num_code: f("NumCode") ?? null, name: f("Name") ?? null, nominal, value, per_unit: r2(unit ?? value / nominal, 6) });
  }
  return { date: `${m[3]}-${m[2]}-${m[1]}`, rates };
}
async function cbrDaily(date /* YYYY-MM-DD | null */) {
  const isPast = date && date < mskToday();
  return cached(`cbr:daily:${date || "latest"}`, isPast ? 7 * 86400e3 : 30 * 60e3, async () => {
    const q = date ? `?date_req=${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}` : "";
    const r = await upstream(`${CBR}/scripts/XML_daily.asp${q}`, { label: "cbr.ru XML_daily", headers: { Accept: "application/xml,text/xml" } });
    const parsed = parseCbrDaily(decodeCbr(r.buf));
    if (!parsed || !parsed.rates.length) throw new UpstreamError("cbr.ru XML_daily: unexpected response (no ValCurs)", r.attempts);
    return { ...parsed, via: r.via };
  }, { staleMs: 2 * 86400e3 });
}
export function fxResult(cur, prev, codes, requestedDate) {
  const prevMap = new Map((prev && prev.date !== cur.date ? prev.rates : []).map((x) => [x.code, x]));
  const want = codes ? new Set(codes) : null;
  const rates = cur.rates.filter((x) => !want || want.has(x.code)).map((x) => {
    const p = prevMap.get(x.code);
    const prevUnit = p ? p.per_unit : null;
    return { code: x.code, name: x.name, nominal: x.nominal, value: x.value, per_unit: x.per_unit,
      prev_per_unit: prevUnit, change: prevUnit === null ? null : r2(x.per_unit - prevUnit, 4),
      change_pct: prevUnit ? r2(((x.per_unit - prevUnit) / prevUnit) * 100, 3) : null };
  });
  if (codes) rates.sort((a, b) => codes.indexOf(a.code) - codes.indexOf(b.code));
  const missing = codes ? codes.filter((c) => !rates.some((x) => x.code === c)) : [];
  return { source: "Bank of Russia (cbr.ru/scripts/XML_daily.asp)", base: "RUB", date: cur.date, requested_date: requestedDate || null,
    previous_date: prev && prev.date !== cur.date ? prev.date : null, count: rates.length, rates, missing,
    note: "Official CBR rate: RUB per `nominal` units (per_unit = RUB per 1 unit). Rates set in the afternoon apply from the next business day; date is the date the rates are set for." };
}
export async function getFx({ date = null, codes = null } = {}) {
  const cur = await cbrDaily(date);
  let prev = null;
  try { prev = (await cbrDaily(addDays(cur.value.date, -1))).value; } catch { prev = null; }
  return { ...fxResult(cur.value, prev, codes, date), via: cur.value.via, cached: cur.cached, ...(cur.stale ? { stale: true } : {}), fetched_at: isoNow() };
}

export function parseKeyRateSoap(xml) {
  const rows = [];
  for (const m of xml.matchAll(/<KR>\s*<DT>(\d{4}-\d{2}-\d{2})T[^<]*<\/DT>\s*<Rate>([\d.,]+)<\/Rate>\s*<\/KR>/g)) rows.push({ date: m[1], rate: numRu(m[2]) });
  return rows;
}
export function parseKeyRateHtml(html) {
  const i = html.indexOf('<table class="data"');
  if (i < 0) return [];
  const t = html.slice(i, html.indexOf("</table>", i));
  const rows = [];
  for (const m of t.matchAll(/<td>\s*(\d\d)\.(\d\d)\.(\d{4})\s*<\/td>\s*<td>\s*([\d.,]+)\s*<\/td>/g)) rows.push({ date: `${m[3]}-${m[2]}-${m[1]}`, rate: numRu(m[4]) });
  return rows;
}
export function keyRateSummary(rows, { months = 24, now = Date.now() } = {}) {
  const asc = [...new Map(rows.filter((r) => r.rate !== null).map((r) => [r.date, r])).values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!asc.length) return null;
  const changes = [];
  for (let i = 1; i < asc.length; i++) if (asc[i].rate !== asc[i - 1].rate) {
    changes.push({ date: asc[i].date, rate: asc[i].rate, prev_rate: asc[i - 1].rate, change_bp: Math.round((asc[i].rate - asc[i - 1].rate) * 100) });
  }
  const cur = asc[asc.length - 1], last = changes[changes.length - 1];
  const from = addDays(mskToday(now), -Math.round(months * 30.44));
  return { rate: cur.rate, as_of: cur.date, effective_since: last ? last.date : null, effective_since_note: last ? undefined : `unchanged since at least ${asc[0].date}`,
    previous_rate: last ? last.prev_rate : null, last_change_bp: last ? last.change_bp : null,
    months, changes: changes.filter((c) => c.date >= from).reverse(),
    max_in_window: Math.max(...asc.filter((r) => r.date >= from).map((r) => r.rate)), min_in_window: Math.min(...asc.filter((r) => r.date >= from).map((r) => r.rate)) };
}
async function keyRateRows() {
  return cached("cbr:keyrate", 3 * 3600e3, async () => {
    const to = mskToday(), from = addDays(to, -Math.round(12 * 30.44 * 10)); // ~10 years of daily rows
    const env = '<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>' +
      `<KeyRateXML xmlns="http://web.cbr.ru/"><fromDate>${from}</fromDate><ToDate>${to}</ToDate></KeyRateXML></soap:Body></soap:Envelope>`;
    const errs = [];
    try {
      const r = await upstream(`${CBR}/DailyInfoWebServ/DailyInfo.asmx`, { method: "POST", body: env, label: "cbr.ru KeyRate SOAP",
        headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: '"http://web.cbr.ru/KeyRateXML"' }, timeoutMs: 10000 });
      const rows = parseKeyRateSoap(r.buf.toString("utf8"));
      if (rows.length) return { rows, method: "soap", via: r.via };
      errs.push("cbr.ru KeyRate SOAP: no rows");
    } catch (e) { errs.push(...(e.attempts?.length ? e.attempts : [e.detail || e.message])); }
    const f = (d) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
    try {
      const r = await upstream(`${CBR}/hd_base/KeyRate/?UniDbQuery.Posted=True&UniDbQuery.From=${f(from)}&UniDbQuery.To=${f(to)}`, { label: "cbr.ru KeyRate page", timeoutMs: 10000 });
      const rows = parseKeyRateHtml(r.buf.toString("utf8"));
      if (rows.length) return { rows, method: "html", via: r.via };
      errs.push("cbr.ru KeyRate page: no table rows");
    } catch (e) { errs.push(...(e.attempts?.length ? e.attempts : [e.detail || e.message])); }
    throw new UpstreamError("cbr.ru key rate unavailable", errs);
  }, { staleMs: 3 * 86400e3 });
}
export async function getKeyRate({ months = 24 } = {}) {
  const c = await keyRateRows();
  const s = keyRateSummary(c.value.rows, { months });
  if (!s) throw new UpstreamError("cbr.ru key rate: empty series");
  return { source: `Bank of Russia key rate (cbr.ru ${c.value.method === "soap" ? "DailyInfoWebServ KeyRateXML" : "hd_base/KeyRate page"})`, unit: "% per annum",
    ...s, via: c.value.via, cached: c.cached, ...(c.stale ? { stale: true } : {}), fetched_at: isoNow() };
}

// ================= MOEX ISS =================
const ISS = "https://iss.moex.com/iss";
const MOEX_NOTE = "MOEX ISS public data, delayed about 15 minutes; not for trading decisions that need real-time prices.";
export function issTable(j, name) {
  const t = j?.[name];
  if (!t || !Array.isArray(t.columns) || !Array.isArray(t.data)) return [];
  return t.data.map((row) => Object.fromEntries(t.columns.map((c, i) => [c, row[i]])));
}
const mskIso = (s) => (typeof s === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? s.replace(" ", "T") + "+03:00" : null);
async function iss(path, label, ttlMs) {
  return cached(`iss:${path}`, ttlMs, async () => {
    const r = await upstream(`${ISS}${path}`, { label, headers: { Accept: "application/json" } });
    try { return { json: JSON.parse(r.buf.toString("utf8")), via: r.via }; } catch { throw new UpstreamError(`${label}: invalid JSON`, r.attempts); }
  }, { staleMs: 15 * 60e3 });
}
export function quoteFrom(json, ticker) {
  const secs = issTable(json, "securities"), md = issTable(json, "marketdata");
  if (!secs.length) return null;
  const dv = issTable(json, "dataversion")[0];
  const pick = secs.find((s) => s.BOARDID === "TQBR") || secs.find((s) => md.find((m) => m.BOARDID === s.BOARDID && m.LAST !== null)) || secs[0];
  const m = md.find((x) => x.BOARDID === pick.BOARDID) || {};
  const live = m.LAST !== null && m.LAST !== undefined;
  return { ticker, board: pick.BOARDID, short_name: pick.SHORTNAME ?? null, name: pick.SECNAME ?? null, isin: pick.ISIN ?? null,
    currency: pick.CURRENCYID === "SUR" ? "RUB" : pick.CURRENCYID ?? null, lot_size: pick.LOTSIZE ?? null,
    price: live ? m.LAST : pick.PREVPRICE ?? null, price_source: live ? "last_trade" : "previous_close",
    last: m.LAST ?? null, prev_close: pick.PREVPRICE ?? null, prev_date: pick.PREVDATE ?? null,
    change: live ? r2(m.LAST - (pick.PREVPRICE ?? m.LAST), 6) : null, change_pct: live ? m.LASTTOPREVPRICE ?? null : null,
    open: m.OPEN ?? null, high: m.HIGH ?? null, low: m.LOW ?? null, bid: m.BID ?? null, offer: m.OFFER ?? null, waprice: m.WAPRICE ?? null,
    volume: m.VOLTODAY ?? null, value_rub: m.VALTODAY ?? null, num_trades: m.NUMTRADES ?? null, market_cap_rub: m.ISSUECAPITALIZATION ?? null,
    trading_status: m.TRADINGSTATUS ?? null, updated_at: mskIso(m.SYSTIME), trade_date: dv?.trade_date ?? null,
    ...(live ? {} : { note: "No trades yet in the current session: price is the previous close." }),
    delayed: true, delay_minutes: 15 };
}
export async function getQuote(ticker) {
  const c = await iss(`/engines/stock/markets/shares/securities/${encodeURIComponent(ticker)}.json?iss.meta=off&iss.only=securities,marketdata,dataversion`, "iss.moex.com quote", 30e3);
  const q = quoteFrom(c.value.json, ticker);
  if (!q) throw new NotFoundError(`ticker ${ticker} not found on the MOEX shares market (try e.g. SBER, GAZP, LKOH, YDEX)`);
  return { ...q, source: "MOEX ISS (iss.moex.com)", note_delay: MOEX_NOTE, cached: c.cached, ...(c.value.via === "proxy" ? { via: "proxy" } : {}), fetched_at: isoNow() };
}
export function indexFrom(json) {
  const secs = issTable(json, "securities"), md = issTable(json, "marketdata");
  return secs.map((s) => {
    const m = md.find((x) => x.SECID === s.SECID) || {};
    const value = m.CURRENTVALUE ?? m.LASTVALUE ?? null;
    return { code: s.SECID, name: s.NAME ?? s.SHORTNAME ?? null, value, prev_close: m.CURRENTVALUE !== null && m.CURRENTVALUE !== undefined ? m.LASTVALUE ?? null : null,
      change: m.LASTCHANGE ?? null, change_pct: m.LASTCHANGEPRC ?? null, open: m.OPENVALUE ?? null, high: m.HIGH ?? null, low: m.LOW ?? null,
      month_change_pct: m.MONTHCHANGEPRC ?? null, year_change_pct: m.YEARCHANGEPRC ?? null, annual_high: s.ANNUALHIGH ?? null, annual_low: s.ANNUALLOW ?? null,
      value_traded_rub: m.VALTODAY ?? null, currency: s.CURRENCYID === "SUR" ? "RUB" : s.CURRENCYID ?? null, trade_date: m.TRADEDATE ?? null, updated_at: mskIso(m.SYSTIME) };
  });
}
export async function getIndex(codes) {
  if (codes === "list") {
    const [a, b] = await Promise.all([
      iss("/engines/stock/markets/index/boards/SNDX/securities.json?iss.meta=off&iss.only=securities&securities.columns=SECID,NAME", "iss.moex.com index list", 86400e3),
      iss("/engines/stock/markets/index/boards/RTSI/securities.json?iss.meta=off&iss.only=securities&securities.columns=SECID,NAME", "iss.moex.com index list", 86400e3)]);
    const items = [...issTable(a.value.json, "securities"), ...issTable(b.value.json, "securities").filter((s) => /^RTS/.test(s.SECID))]
      .map((s) => ({ code: s.SECID, name: s.NAME }));
    return { mode: "list", count: items.length, items, source: "MOEX ISS (iss.moex.com) boards SNDX + RTSI (RTS*)", fetched_at: isoNow() };
  }
  const c = await iss(`/engines/stock/markets/index/securities.json?securities=${codes.map(encodeURIComponent).join(",")}&iss.meta=off&iss.only=securities,marketdata`, "iss.moex.com index", 30e3);
  const items = indexFrom(c.value.json).filter((x) => codes.includes(x.code)).sort((a, b) => codes.indexOf(a.code) - codes.indexOf(b.code));
  if (!items.length) throw new NotFoundError(`index ${codes.join(",")} not found (try IMOEX, RTSI, MOEXBMI or code=list)`);
  return { mode: "quote", count: items.length, items, missing: codes.filter((x) => !items.some((i) => i.code === x)),
    source: "MOEX ISS (iss.moex.com)", delayed: true, delay_minutes: 15, note_delay: MOEX_NOTE, cached: c.cached, fetched_at: isoNow() };
}
export function computeMovers(rows, { limit = 10, minValue = 5e6 } = {}) {
  const ok = rows.filter((r) => r.pct !== null && Number.isFinite(r.pct) && r.price !== null && (r.value ?? 0) >= minValue);
  const g = ok.filter((r) => r.pct > 0).sort((a, b) => b.pct - a.pct).slice(0, limit);
  const l = ok.filter((r) => r.pct < 0).sort((a, b) => a.pct - b.pct).slice(0, limit);
  return { universe: ok.length, advancers: ok.filter((r) => r.pct > 0).length, decliners: ok.filter((r) => r.pct < 0).length,
    unchanged: ok.filter((r) => r.pct === 0).length, gainers: g, losers: l };
}
export function liveMoverRows(json) {
  const secs = new Map(issTable(json, "securities").map((s) => [s.SECID, s]));
  return issTable(json, "marketdata").map((m) => ({ ticker: m.SECID, name: secs.get(m.SECID)?.SHORTNAME ?? null, price: m.LAST,
    prev_close: secs.get(m.SECID)?.PREVPRICE ?? null, pct: m.LAST === null ? null : m.LASTTOPREVPRICE, value: m.VALTODAY, updated_at: mskIso(m.SYSTIME) }));
}
export const historyMoverRows = (rows) => rows.map((h) => ({ ticker: h.SECID, name: h.SHORTNAME ?? null, price: h.CLOSE, pct: h.TRENDCLSPR, value: h.VALUE, trade_date: h.TRADEDATE }));
export async function getMovers({ limit = 10, minValue = 5e6 } = {}) {
  const c = await iss("/engines/stock/markets/shares/boards/TQBR/securities.json?iss.meta=off&iss.only=securities,marketdata" +
    "&securities.columns=SECID,SHORTNAME,PREVPRICE&marketdata.columns=SECID,LAST,LASTTOPREVPRICE,VALTODAY,UPDATETIME,TRADINGSTATUS,SYSTIME", "iss.moex.com TQBR", 60e3);
  const live = liveMoverRows(c.value.json);
  const traded = live.filter((r) => r.price !== null && r.pct !== null);
  const base = { source: "MOEX ISS (iss.moex.com), board TQBR (main shares board)", board: "TQBR", limit, min_value_rub: minValue,
    delayed: true, delay_minutes: 15, note_delay: MOEX_NOTE };
  if (traded.length >= 20) {
    const asOf = live.map((r) => r.updated_at).filter(Boolean).sort().pop() ?? null;
    return { ...base, mode: "live", as_of: asOf, ...computeMovers(live, { limit, minValue }), cached: c.cached, fetched_at: isoNow() };
  }
  // Session not started (or a holiday): use the last completed session from the history endpoint.
  const h = await cached("iss:tqbr-history", 10 * 60e3, async () => {
    const page = async (start) => {
      const r = await upstream(`${ISS}/history/engines/stock/markets/shares/boards/TQBR/securities.json?iss.meta=off&iss.only=history,history.cursor` +
        `&history.columns=SECID,SHORTNAME,TRADEDATE,CLOSE,VALUE,TRENDCLSPR,TRADINGSESSION&start=${start}`, { label: "iss.moex.com TQBR history" });
      return JSON.parse(r.buf.toString("utf8"));
    };
    const first = await page(0);
    const cur = issTable(first, "history.cursor")[0] || { TOTAL: 0, PAGESIZE: 100 };
    const starts = []; for (let s = cur.PAGESIZE || 100; s < Math.min(cur.TOTAL, 1500); s += cur.PAGESIZE || 100) starts.push(s);
    const rest = await Promise.all(starts.map(page));
    return [first, ...rest].flatMap((j) => issTable(j, "history")).filter((x) => x.TRADINGSESSION === undefined || x.TRADINGSESSION === 3 || x.TRADINGSESSION === "3");
  }, { staleMs: 86400e3 });
  const rows = historyMoverRows(h.value);
  return { ...base, mode: "previous_session", as_of: rows.map((r) => r.trade_date).filter(Boolean).sort().pop() ?? null,
    note: "No trades yet in the current session: movers of the last completed session (close vs previous close).",
    ...computeMovers(rows, { limit, minValue }), cached: c.cached, fetched_at: isoNow() };
}

// ================= XLSX (minimal, dependency-free) =================
function zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip file");
  const n = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let k = 0; k < n; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad zip central directory");
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28),
      elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
    out.set(name, () => {
      const ds = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
      const raw = buf.subarray(ds, ds + csize);
      return (method === 8 ? inflateRawSync(raw) : raw).toString("utf8");
    });
    p += 46 + nlen + elen + clen;
  }
  return out;
}
const xmlDecode = (s) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" })[e.toLowerCase()] ??
  String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)));
const colIndex = (ref) => { let n = 0; for (const ch of /^[A-Z]+/.exec(ref)[0]) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
// Returns [{ name, rows: [[cell...]] }] where cells are strings or numbers (null when empty).
export function readXlsx(buf) {
  const z = zipEntries(buf), get = (n) => (z.has(n) ? z.get(n)() : null);
  const shared = [];
  const ss = get("xl/sharedStrings.xml");
  if (ss) for (const si of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(xmlDecode([...si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")));
  const wb = get("xl/workbook.xml") || "", rels = get("xl/_rels/workbook.xml.rels") || "";
  const relMap = new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [(/Id="([^"]+)"/.exec(m[0]) || [])[1], (/Target="([^"]+)"/.exec(m[0]) || [])[1]]));
  const sheets = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const name = xmlDecode((/name="([^"]*)"/.exec(m[0]) || [])[1] || ""), rid = (/r:id="([^"]+)"/.exec(m[0]) || [])[1];
    let target = relMap.get(rid) || ""; target = target.startsWith("/") ? target.slice(1) : "xl/" + target.replace(/^\.\//, "");
    const xml = get(target); if (!xml) continue;
    const rows = [];
    for (const row of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const rnum = Number((/\br="(\d+)"/.exec(row[0]) || [])[1]) || rows.length + 1;
      const cells = [];
      for (const c of (row[1] || "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1], body = c[2] || "", ref = (/r="([A-Z]+)\d+"/.exec(attrs) || [])[1];
        const t = (/t="([^"]+)"/.exec(attrs) || [])[1];
        const v = (/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1];
        let val = null;
        if (t === "s") val = v !== undefined ? shared[Number(v)] ?? null : null;
        else if (t === "inlineStr") val = xmlDecode([...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(""));
        else if (t === "str" || t === "e") val = v !== undefined ? xmlDecode(v) : null;
        else if (v !== undefined) val = Number(v);
        cells[ref ? colIndex(ref) : cells.length] = val;
      }
      rows[rnum - 1] = cells;
    }
    sheets.push({ name, rows: Array.from(rows, (r) => r || []) });
  }
  return sheets;
}

// ================= Rosstat weekly fuel prices =================
export const FUEL_URL = "https://rosstat.gov.ru/storage/mediabank/nedel_sred_cen.xlsx";
const MONTHS = { январ: 1, феврал: 2, март: 3, апрел: 4, ма: 5, июн: 6, июл: 7, август: 8, сентябр: 9, октябр: 10, ноябр: 11, декабр: 12 };
export function parseRuDate(v, fallbackYear = null) {
  if (typeof v === "number" && v > 30000 && v < 80000) return ymd(new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400e3));
  if (typeof v !== "string") return null;
  const s = v.replace(/\u00a0/g, " ").toLowerCase();
  let m = /(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})\b/.exec(s);
  if (m) { const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]); return `${y}-${pad(m[2])}-${pad(m[1])}`; }
  m = /(\d{1,2})\s+(январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)[а-я]*\.?\s*(\d{4})?/.exec(s);
  if (m) { const mon = MONTHS[m[2].startsWith("ма") ? "ма" : m[2]], y = m[3] ? Number(m[3]) : fallbackYear; return y ? `${y}-${pad(mon)}-${pad(m[1])}` : null; }
  return null;
}
export const FUELS = [
  { key: "ai92", name_en: "Petrol AI-92", re: /аи[\s-]*92/i },
  { key: "ai95", name_en: "Petrol AI-95", re: /аи[\s-]*95/i },
  { key: "ai98", name_en: "Petrol AI-98 and above", re: /аи[\s-]*98/i },
  { key: "diesel", name_en: "Diesel fuel", re: /дизельн/i },
  { key: "petrol_avg", name_en: "Motor petrol (all grades, average)", re: /^\s*бензин автомобильный\s*(,\s*л\.?)?\s*$/i },
];
// Finds the fuel rows and the date header in every sheet; keeps the sheet/series with the latest date.
export function parseFuelSheets(sheets) {
  const series = {}, labels = {}, diag = [];
  for (const sh of sheets) {
    const yearFromName = (/(20\d\d)/.exec(sh.name) || [])[1];
    const itemRows = [];
    sh.rows.forEach((row, ri) => row.forEach((cell, ci) => {
      if (typeof cell !== "string") return;
      const f = FUELS.find((x) => x.re.test(cell));
      if (f && !itemRows.some((r) => r.key === f.key)) itemRows.push({ key: f.key, ri, ci, label: cell.trim() });
    }));
    if (!itemRows.length) { diag.push(`${sh.name}: no fuel rows`); continue; }
    const firstItem = Math.min(...itemRows.map((r) => r.ri)), labelCol = itemRows[0].ci;
    // Column -> date from the header rows above the first item row (year rows propagate to the right).
    const colDate = new Map();
    let bestCount = 0;
    for (let ri = 0; ri < firstItem; ri++) {
      const row = sh.rows[ri] || [];
      let year = yearFromName ? Number(yearFromName) : null;
      const prev = sh.rows[ri - 1] || [];
      const map = new Map();
      for (let ci = labelCol + 1; ci < row.length; ci++) {
        const y = typeof prev[ci] === "number" && prev[ci] > 1990 && prev[ci] < 2100 ? prev[ci] : (/^\s*(20\d\d)/.exec(String(prev[ci] ?? "")) || [])[1];
        if (y) year = Number(y);
        const d = parseRuDate(row[ci], year);
        if (d) map.set(ci, d);
      }
      if (map.size > bestCount) { bestCount = map.size; colDate.clear(); for (const [k, v] of map) colDate.set(k, v); }
    }
    if (!colDate.size) { diag.push(`${sh.name}: fuel rows found but no date header (rows above ${firstItem + 1}: ${JSON.stringify((sh.rows[firstItem - 1] || []).slice(0, 6))})`); continue; }
    for (const it of itemRows) {
      const row = sh.rows[it.ri] || [];
      for (const [ci, d] of colDate) {
        const v = typeof row[ci] === "number" ? row[ci] : numRu(row[ci]);
        if (v === null || v <= 0) continue;
        (series[it.key] ||= new Map()).set(d, r2(v, 2));
        labels[it.key] ||= it.label;
      }
    }
  }
  const out = {};
  for (const [k, m] of Object.entries(series)) out[k] = [...m].map(([date, price]) => ({ date, price })).sort((a, b) => (a.date < b.date ? 1 : -1));
  return { series: out, labels, diag };
}
export function fuelResult(parsed, { weeks = 4 } = {}) {
  const prices = FUELS.filter((f) => parsed.series[f.key]?.length).map((f) => {
    const s = parsed.series[f.key], cur = s[0], prev = s[1] ?? null, m4 = s[4] ?? null;
    const yearStart = [...s].reverse().find((x) => x.date.slice(0, 4) === cur.date.slice(0, 4)) ?? null;
    return { fuel: f.key, name: f.name_en, label_ru: parsed.labels[f.key] ?? null, price: cur.price, as_of: cur.date,
      prev_price: prev?.price ?? null, prev_date: prev?.date ?? null,
      change: prev ? r2(cur.price - prev.price) : null, change_pct: prev ? r2(((cur.price - prev.price) / prev.price) * 100, 2) : null,
      change_4w_pct: m4 ? r2(((cur.price - m4.price) / m4.price) * 100, 2) : null,
      change_ytd_pct: yearStart && yearStart.date !== cur.date ? r2(((cur.price - yearStart.price) / yearStart.price) * 100, 2) : null,
      ...(weeks > 0 ? { history: s.slice(0, weeks + 1) } : {}) };
  });
  const asOf = prices.map((p) => p.as_of).sort().pop() ?? null;
  return { as_of: asOf, unit: "RUB per litre", region: "Russian Federation (average)", prices };
}
export async function getFuel({ weeks = 4 } = {}) {
  const c = await cached("rosstat:fuel", 6 * 3600e3, async () => {
    const r = await upstream(FUEL_URL, { label: "rosstat.gov.ru nedel_sred_cen.xlsx", timeoutMs: 15000, proxyTimeoutMs: 40000, ca: RU_TRUSTED_CA });
    let sheets;
    try { sheets = readXlsx(r.buf); } catch (e) { throw new UpstreamError(`rosstat xlsx unreadable: ${e.message} (${r.buf.length} bytes, starts ${JSON.stringify(r.buf.subarray(0, 16).toString("latin1"))})`, r.attempts); }
    const parsed = parseFuelSheets(sheets);
    if (!Object.keys(parsed.series).length) throw new UpstreamError(`rosstat xlsx: fuel rows not found; sheets=${JSON.stringify(sheets.map((s) => s.name))}; ${parsed.diag.slice(0, 4).join(" | ")}`, r.attempts);
    return { parsed, via: r.via, bytes: r.buf.length };
  }, { staleMs: 14 * 86400e3 });
  return { source: "Rosstat: weekly average consumer prices for selected goods, Russian Federation (nedel_sred_cen.xlsx)", source_url: FUEL_URL,
    ...fuelResult(c.value.parsed, { weeks }),
    note: "Rosstat publishes weekly (usually Wednesday evening, prices as of Monday). Retail pump prices averaged over Russia.",
    via: c.value.via, cached: c.cached, ...(c.stale ? { stale: true, stale_reason: c.error } : {}), fetched_at: isoNow() };
}
