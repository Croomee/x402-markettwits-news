// Builds MCP tools from the API's OpenAPI document: one tool per GET path that carries x-payment-info.
// At startup the live /openapi.json is used (new endpoints appear automatically); the bundled
// openapi.snapshot.json is the fallback (offline, timeout, or X402_TOOLS_SOURCE=bundled).
import fs from "node:fs";
import { z } from "zod";

const SNAPSHOT = new URL("../openapi.snapshot.json", import.meta.url);

export const snakeCase = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").toLowerCase().replace(/^_|_$/g, "");

/** Reduces a full OpenAPI doc to what the tools need (used for the bundled snapshot). */
export function slimSpec(spec) {
  const paths = {};
  for (const [path, item] of Object.entries(spec.paths || {})) {
    const op = item.get;
    if (!op?.["x-payment-info"]) continue;
    paths[path] = { get: {
      operationId: op.operationId, summary: op.summary, description: op.description, tags: op.tags,
      parameters: (op.parameters || []).filter((p) => p.in === "query").map(({ name, required, description, schema }) => ({ name, required: !!required, description, schema })),
      "x-payment-info": op["x-payment-info"],
    } };
  }
  return { openapi: spec.openapi, info: { title: spec.info?.title, version: spec.info?.version }, paths };
}

function zodFor(param) {
  const s = param.schema || {};
  let t;
  if (s.enum) t = z.enum(s.enum.map(String));
  else if (s.type === "integer" || s.type === "number") {
    t = s.type === "integer" ? z.number().int() : z.number();
    if (s.minimum !== undefined) t = t.min(s.minimum);
    if (s.maximum !== undefined) t = t.max(s.maximum);
  } else if (s.type === "boolean") t = z.boolean();
  else {
    t = z.string();
    if (s.minLength !== undefined) t = t.min(s.minLength);
    if (s.maxLength !== undefined) t = t.max(s.maxLength);
    if (s.pattern) { try { t = t.regex(new RegExp(s.pattern)); } catch {} }
    if (s.format === "date") t = t.regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
    // numeric strings (id, min_pct, min_value, target_price): accept a JSON number too
    if (s.pattern && /^\^\[0-9\]/.test(s.pattern)) t = z.union([z.number().nonnegative(), t]);
  }
  const desc = [param.description, s.default !== undefined ? `Default: ${s.default}.` : ""].filter(Boolean).join(" ");
  if (desc) t = t.describe(desc);
  return param.required ? t : t.optional();
}

export function priceOf(op) {
  const xpi = op["x-payment-info"];
  const amount = xpi?.price?.amount ?? (xpi?.protocols?.[0]?.x402?.amount ? Number(xpi.protocols[0].x402.amount) / 1e6 : null);
  return amount === null ? null : Number(amount);
}

/** -> [{ name, path, title, description, price_usd, params: [{name, required}], inputShape }] sorted by path */
export function specToTools(spec) {
  const tools = [];
  for (const [path, item] of Object.entries(spec.paths || {})) {
    const op = item.get;
    if (!op?.["x-payment-info"]) continue;
    const price = priceOf(op);
    const name = snakeCase(op.operationId || `get${path}`).slice(0, 64);
    const params = (op.parameters || []).filter((p) => p.in === undefined || p.in === "query");
    const inputShape = Object.fromEntries(params.map((p) => [p.name, zodFor(p)]));
    let body = (op.description || "").trim();
    if (body.length > 700) body = body.slice(0, 697).replace(/\s+\S*$/, "") + "…";
    const description = `${op.summary || path}. ${body}\n\nGET ${path} — price $${price} USDC per call, paid automatically via x402 on Base ` +
      `(only successful responses are charged; 400/404/502 are free).`;
    tools.push({ name, path, title: op.summary || name, description, price_usd: price, tags: op.tags || [], params: params.map((p) => ({ name: p.name, required: !!p.required })), inputShape });
  }
  const seen = new Set();
  for (const t of tools) { while (seen.has(t.name)) t.name = `${t.name}_`; seen.add(t.name); }
  return tools.sort((a, b) => a.path.localeCompare(b.path));
}

export function bundledSpec() { return JSON.parse(fs.readFileSync(SNAPSHOT, "utf8")); }

/** Live spec with a short timeout, falling back to the bundled snapshot. -> { spec, source } */
export async function loadSpec({ baseUrl, mode = "auto", fetchImpl = globalThis.fetch, timeoutMs = 6000, log = () => {} } = {}) {
  if (mode !== "bundled") {
    try {
      const r = await fetchImpl(`${baseUrl}/openapi.json`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const spec = await r.json();
      if (specToTools(spec).length === 0) throw new Error("no paid paths in the live OpenAPI");
      return { spec, source: "live" };
    } catch (e) {
      if (mode === "live") throw e;
      log(`live OpenAPI unavailable (${e.message}); using the bundled snapshot`);
    }
  }
  return { spec: bundledSpec(), source: "bundled" };
}

export function buildUrl(baseUrl, path, args = {}) {
  const u = new URL(baseUrl + path);
  for (const [k, v] of Object.entries(args)) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
  return u.toString();
}
