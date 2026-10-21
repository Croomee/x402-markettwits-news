// Optional outbound proxy for the marketplace fetches in product.mjs ONLY (never used by the rest of the server).
// PROXY_URL (priority) or PROXY_HOST/PROXY_PORT/PROXY_USER/PROXY_PASS; PROXY_SCOPE (default "wb,ozon");
// PROXY_FALLBACK_DIRECT (default true). Credentials never leave this module except inside the dispatcher.
import { ProxyAgent, Socks5ProxyAgent, fetch as undiciFetch } from "undici";

const SCHEMES = new Set(["http:", "https:", "socks5:", "socks5h:"]);
const truthy = (v, def) => (v === undefined || String(v).trim() === "" ? def : !/^(0|false|no|off)$/i.test(String(v).trim()));

// Returns { configured, error?, scheme, host, port, username, password, scope:Set, fallbackDirect }.
export function parseProxyEnv(env = process.env) {
  const scope = new Set(String(env.PROXY_SCOPE ?? "wb,ozon").toLowerCase().split(/[\s,]+/).filter(Boolean)
    .map((s) => (s === "wildberries" ? "wb" : s)));
  const fallbackDirect = truthy(env.PROXY_FALLBACK_DIRECT, true);
  const base = { configured: false, scope, fallbackDirect };
  let raw = String(env.PROXY_URL ?? "").trim();
  if (!raw && String(env.PROXY_HOST ?? "").trim()) {
    const m = /^([a-z0-9]+:\/\/)?(.*)$/i.exec(String(env.PROXY_HOST).trim());
    const hp = m[2].replace(/\/+$/, ""), port = String(env.PROXY_PORT ?? "").trim() || "3128";
    const user = String(env.PROXY_USER ?? ""), pass = String(env.PROXY_PASS ?? "");
    const auth = user ? `${encodeURIComponent(user)}${pass ? ":" + encodeURIComponent(pass) : ""}@` : "";
    raw = `${m[1] || "http://"}${auth}${hp}${/:\d+$/.test(hp) ? "" : ":" + port}`;
  }
  if (!raw) return base;
  let u;
  try { u = new URL(raw); } catch { return { ...base, error: "PROXY_URL is not a valid URL" }; }
  if (!SCHEMES.has(u.protocol)) return { ...base, error: `unsupported proxy scheme ${u.protocol} (use http, https or socks5)` };
  if (!u.hostname) return { ...base, error: "proxy host missing" };
  const port = u.port || (u.protocol === "https:" ? "443" : u.protocol.startsWith("socks") ? "1080" : "3128");
  return { ...base, configured: true, scheme: u.protocol.replace(":", ""), host: u.hostname, port,
    username: decodeURIComponent(u.username || ""), password: decodeURIComponent(u.password || "") };
}

// Mask credentials (and optionally the proxy host) in any text: URLs with userinfo + known secret values.
export function maskSecrets(text, cfg) {
  let s = String(text ?? "").replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]*(?::[^\s/@]*)?@/gi, "$1***:***@");
  for (const secret of [cfg?.password, cfg?.username && cfg.username.length >= 3 ? cfg.username : null,
    cfg?.password && encodeURIComponent(cfg.password)]) {
    if (secret) s = s.split(secret).join("***");
  }
  if (cfg?.host) s = s.split(cfg.host).join("<proxy>");
  return s;
}

export function describeProxy(cfg) { // safe for logs: no host, no credentials
  if (!cfg.configured) return cfg.error ? `invalid (${cfg.error})` : "off";
  return `on (${cfg.scheme}, auth=${cfg.username ? "yes" : "no"}, scope=${[...cfg.scope].join(",")}, fallback_direct=${cfg.fallbackDirect})`;
}

let dispatcher = null;
export function proxyDispatcher(cfg) {
  if (!cfg.configured) return null;
  if (dispatcher) return dispatcher;
  if (cfg.scheme.startsWith("socks")) {
    dispatcher = new Socks5ProxyAgent(`socks5://${cfg.host}:${cfg.port}`,
      cfg.username ? { username: cfg.username, password: cfg.password } : {});
  } else {
    dispatcher = new ProxyAgent({ uri: `${cfg.scheme}://${cfg.host}:${cfg.port}`,
      ...(cfg.username ? { token: "Basic " + Buffer.from(`${cfg.username}:${cfg.password}`).toString("base64") } : {}) });
  }
  return dispatcher;
}

export { undiciFetch };
