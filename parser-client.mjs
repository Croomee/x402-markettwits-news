// Optional headless-browser parser (parser/ on a VPS). Used by /product/info first when PARSER_URL + PARSER_TOKEN are set.
// Read lazily so the env can be set after import (tests) and secrets are never cached in module scope logs.
const parserEnv = () => ({ PARSER_URL: String(process.env.PARSER_URL || "").trim().replace(/\/+$/, ""), PARSER_TOKEN: String(process.env.PARSER_TOKEN || "").trim() });
export const parserConfigured = (env = parserEnv()) => !!(env.PARSER_URL && env.PARSER_TOKEN);
export class ParserError extends Error { constructor(msg, code) { super(msg); this.code = code; } }

// Map the parser's flat JSON to the /product/info response shape. Returns null when there is no usable price.
export function mapParserResult(j, p) {
  if (!j || j.ok !== true) return null;
  const amount = typeof j.price === "number" && Number.isFinite(j.price) ? j.price : null;
  const inStock = typeof j.in_stock === "boolean" ? j.in_stock : null;
  const base = { source: p.source, url: p.url, product_id: p.product_id, title: j.title ?? null,
    rating: typeof j.rating === "number" ? j.rating : null, reviews_count: Number.isInteger(j.reviews_count) ? j.reviews_count : null,
    availability: inStock === true ? "in_stock" : inStock === false ? "out_of_stock" : "unknown", in_stock: inStock,
    fetched_at: typeof j.fetched_at === "string" ? j.fetched_at : new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    data_source: `browser: ${j.data_source || "parser"}`, via: "browser" };
  if (amount === null) return { hint: base };
  const old = typeof j.old_price === "number" && j.old_price > amount ? j.old_price : null;
  return { value: { ...base, price: { amount, currency: "RUB", ...(old ? { original_amount: old } : {}) } } };
}

export async function fetchViaParser(p, { env = parserEnv(), timeoutMs = Number(process.env.PARSER_TIMEOUT_MS || 30000), fetchImpl = fetch } = {}) {
  let r;
  try {
    r = await fetchImpl(`${env.PARSER_URL.replace(/\/+$/, "")}/parse?url=${encodeURIComponent(p.url)}`, {
      headers: { authorization: `Bearer ${env.PARSER_TOKEN}`, accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new ParserError(e?.name === "TimeoutError" ? `parser timeout after ${timeoutMs}ms` : `parser unreachable (${e?.cause?.code || e?.message || e})`, "unreachable");
  }
  let j = null; try { j = await r.json(); } catch {}
  if (r.status === 401) throw new ParserError("parser rejected PARSER_TOKEN (401)", "auth");
  if (!r.ok || !j?.ok) throw new ParserError(`parser HTTP ${r.status}: ${String(j?.error || "")}${j?.message ? " - " + String(j.message).slice(0, 160) : ""}`, j?.error || "http");
  const m = mapParserResult(j, p);
  if (!m) throw new ParserError("parser returned an unexpected payload", "payload");
  return m;
}
