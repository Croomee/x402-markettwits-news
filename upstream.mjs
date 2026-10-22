// Shared upstream fetch for the data endpoints (CBR, MOEX, Rosstat, Telegram): direct first, then the
// server's PROXY_URL (RU residential) as a fallback; hosts that only work through the proxy are remembered
// for an hour. Every failure throws UpstreamError (-> 502, never settled) or NotFoundError (-> 404).
// Proxy credentials never appear in errors (maskSecrets).
import { parseProxyEnv, proxyDispatcher, maskSecrets, undiciFetch } from "./proxy-config.mjs";
import { errText } from "./product.mjs";
import { Agent, ProxyAgent, Socks5ProxyAgent } from "undici";

export class UpstreamError extends Error {
  constructor(detail, attempts = []) { super(detail); this.detail = detail; this.attempts = attempts; this.status = 502; }
}
export class NotFoundError extends Error {
  constructor(detail) { super(detail); this.detail = detail; this.status = 404; }
}

export const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
let PROXY = parseProxyEnv(process.env);
let FETCH = (url, opts) => fetch(url, opts);
export function setUpstreamForTests({ proxy, fetchImpl } = {}) { if (proxy) PROXY = proxy; if (fetchImpl) FETCH = fetchImpl; }
const proxyAllowed = () => PROXY.configured && !/^(0|false|no|off)$/i.test(String(process.env.DATA_PROXY_FALLBACK ?? "").trim());
const preferProxy = new Map(); // hostname -> until (ms)
// Dispatchers with an extra CA bundle (e.g. Russian Trusted Root for rosstat.gov.ru), cached per bundle.
const caAgents = new WeakMap();
function caDispatcher(ca, via) {
  let d = caAgents.get(ca);
  if (!d) { d = {}; caAgents.set(ca, d); }
  if (d[via]) return d[via];
  if (via === "direct") d.direct = new Agent({ connect: { ca } });
  else if (PROXY.scheme.startsWith("socks")) d.proxy = new Socks5ProxyAgent(`socks5://${PROXY.host}:${PROXY.port}`,
    { ...(PROXY.username ? { username: PROXY.username, password: PROXY.password } : {}), requestTls: { ca } });
  else d.proxy = new ProxyAgent({ uri: `${PROXY.scheme}://${PROXY.host}:${PROXY.port}`, requestTls: { ca },
    ...(PROXY.username ? { token: "Basic " + Buffer.from(`${PROXY.username}:${PROXY.password}`).toString("base64") } : {}) });
  return d[via];
}
export const upstreamStatus = () => ({ proxy_fallback: proxyAllowed(), proxy_first_hosts: [...preferProxy].filter(([, t]) => t > Date.now()).map(([h]) => h) });

// Returns { status, buf (Buffer), headers, location, via, attempts }. 3xx is returned (redirect: "manual") when manual=true.
export async function upstream(url, { method = "GET", headers = {}, body, timeoutMs = 8000, proxyTimeoutMs = 20000, label = "upstream",
  manual = false, notFoundOn404 = false, ca = null } = {}) {
  const host = new URL(url).hostname, attempts = [];
  const useProxy = proxyAllowed();
  const routes = useProxy && (preferProxy.get(host) || 0) > Date.now() ? ["proxy", "direct"] : useProxy ? ["direct", "proxy"] : ["direct"];
  for (const via of routes) {
    const opts = { method, body, redirect: manual ? "manual" : "follow",
      headers: { "User-Agent": UA, "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8", ...headers },
      signal: AbortSignal.timeout(via === "proxy" ? proxyTimeoutMs : timeoutMs) };
    try {
      const r = ca ? await undiciFetch(url, { ...opts, dispatcher: caDispatcher(ca, via) })
        : via === "proxy" ? await undiciFetch(url, { ...opts, dispatcher: proxyDispatcher(PROXY) }) : await FETCH(url, opts);
      if (manual && r.status >= 300 && r.status < 400) {
        await r.body?.cancel().catch(() => {});
        return { status: r.status, buf: Buffer.alloc(0), headers: r.headers, location: r.headers.get("location"), via, attempts };
      }
      if (r.status === 404 && notFoundOn404) { await r.body?.cancel().catch(() => {}); throw new NotFoundError(`${label}: not found`); }
      if (!r.ok) { attempts.push(`${label} ${via}: HTTP ${r.status}`); await r.body?.cancel().catch(() => {}); continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      if (via === "proxy" && routes[0] === "direct") preferProxy.set(host, Date.now() + 3600e3);
      if (via === "direct") preferProxy.delete(host);
      return { status: r.status, buf, headers: r.headers, location: null, via, attempts };
    } catch (e) {
      if (e instanceof NotFoundError) throw e;
      attempts.push(`${label} ${via}: ${errText(e)}`);
    }
  }
  throw new UpstreamError(`${label} unavailable`, attempts.map((a) => maskSecrets(a, PROXY)));
}

// Tiny TTL cache with in-flight de-duplication and optional stale serving on upstream failure.
const CACHE = new Map(); // key -> { value, at, exp }
const INFLIGHT = new Map();
export function clearDataCache() { CACHE.clear(); INFLIGHT.clear(); }
export async function cached(key, ttlMs, fn, { staleMs = 0 } = {}) {
  const hit = CACHE.get(key), now = Date.now();
  if (hit && hit.exp > now) return { value: hit.value, cached: true, stale: false, at: hit.at };
  if (INFLIGHT.has(key)) return INFLIGHT.get(key);
  const p = (async () => {
    try {
      const value = await fn();
      CACHE.set(key, { value, at: Date.now(), exp: Date.now() + ttlMs });
      if (CACHE.size > 1000) CACHE.delete(CACHE.keys().next().value);
      return { value, cached: false, stale: false, at: Date.now() };
    } catch (e) {
      if (hit && staleMs && now - hit.at < staleMs && !(e instanceof NotFoundError)) return { value: hit.value, cached: true, stale: true, at: hit.at, error: e.detail || e.message };
      throw e;
    } finally { INFLIGHT.delete(key); }
  })();
  INFLIGHT.set(key, p);
  return p;
}
export const isoNow = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
