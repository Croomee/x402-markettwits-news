// MCP server tests: tools/list over an in-memory MCP transport, and the x402 flow against a mocked API
// (real 402 challenge captured from prod; the payment is signed locally with a throwaway key and never sent anywhere).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { encodePaymentRequiredHeader, decodePaymentSignatureHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createServer } from "../src/server.mjs";
import { specToTools, bundledSpec, snakeCase, buildUrl } from "../src/tools.mjs";
import { readConfig, readPrivateKey } from "../src/x402.mjs";

const CHALLENGE = JSON.parse(fs.readFileSync(new URL("./fixtures/challenge-ru-fx.json", import.meta.url), "utf8"));
const TX = "0x" + "ab".repeat(32);
const BASE = "https://api.test";
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** Mock API: /openapi.json -> bundled snapshot; paid paths -> 402 until a PAYMENT-SIGNATURE arrives. */
function mockApi({ amount = "1500", afterPay = null, routes = {} } = {}) {
  const seen = { calls: [], payments: [] };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url), h = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    seen.calls.push({ path: u.pathname, query: u.search, paid: Boolean(h["payment-signature"]) });
    if (u.pathname === "/openapi.json") return json(200, bundledSpec());
    if (routes[u.pathname]) return routes[u.pathname](u);
    if (!h["payment-signature"]) {
      const ch = structuredClone(CHALLENGE);
      ch.resource.url = url; ch.accepts[0].amount = amount;
      return json(402, {}, { "payment-required": encodePaymentRequiredHeader(ch) });
    }
    const payload = decodePaymentSignatureHeader(h["payment-signature"]);
    seen.payments.push(payload);
    if (afterPay) return afterPay(payload, u);
    return json(200, { date: "2026-10-22", rates: [{ code: "USD", per_unit: 81.9739 }] }, {
      "payment-response": encodePaymentResponseHeader({ success: true, transaction: TX, network: "eip155:8453", payer: payload.payload.authorization.from }),
    });
  };
  return { fetchImpl, seen };
}

async function connect(env, api) {
  const { server, tools, address, specSource } = await createServer({ env: { X402_BASE_URL: BASE, ...env }, fetchImpl: api.fetchImpl, log: () => {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(b);
  const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); return { isError: r.isError, ...JSON.parse(r.content[0].text) }; };
  return { client, call, tools, address, specSource };
}

test("snapshot -> 27 tools with prices, unique names, required params", () => {
  const tools = specToTools(bundledSpec());
  assert.equal(tools.length, 27);
  assert.equal(new Set(tools.map((t) => t.name)).size, 27);
  for (const t of tools) {
    assert.match(t.name, /^[a-z][a-z0-9_]{2,63}$/);
    assert.ok(t.price_usd > 0 && t.price_usd <= 0.01, t.name);
    assert.ok(t.description.includes(`$${t.price_usd} USDC`), t.name);
  }
  const byPath = Object.fromEntries(tools.map((t) => [t.path, t]));
  assert.equal(byPath["/ru/fx"].price_usd, 0.0015);
  assert.equal(byPath["/tg/search"].price_usd, 0.006);
  assert.deepEqual(byPath["/tg/search"].params.filter((p) => p.required).map((p) => p.name), ["q", "channels"]);
  assert.equal(snakeCase("getCbrFxRates"), "get_cbr_fx_rates");
  assert.equal(buildUrl(BASE, "/ru/fx", { codes: "USD,EUR", date: undefined }), `${BASE}/ru/fx?codes=USD%2CEUR`);
});

test("config: key validation never echoes the key; cap default 0.02", () => {
  assert.equal(readConfig({}).maxUsd, 0.02);
  assert.equal(readConfig({ X402_MAX_PAYMENT_USD: "0.005" }).maxUsd, 0.005);
  assert.equal(readConfig({}).baseUrl, "https://x402-markettwits-news.onrender.com");
  const bad = readConfig({ X402_PRIVATE_KEY: "0xnot-a-key-SECRET123" });
  assert.equal(bad.privateKey, null);
  assert.ok(bad.problems.length === 1 && !bad.problems[0].includes("SECRET123"));
  const k = generatePrivateKey();
  assert.equal(readPrivateKey({ X402_PRIVATE_KEY: k.slice(2) }).key, k, "0x prefix optional");
});

test("tools/list over MCP: 27 tools, live spec preferred, bundled fallback", async () => {
  const live = await connect({}, mockApi());
  const { tools } = await live.client.listTools();
  assert.equal(tools.length, 27);
  assert.equal(live.specSource, "live");
  const quote = tools.find((t) => t.name === "get_moex_quote");
  assert.deepEqual(quote.inputSchema.required, ["ticker"]);
  assert.equal(quote.annotations.readOnlyHint, true);
  const down = await connect({}, { fetchImpl: async () => { throw new Error("offline"); } });
  assert.equal(down.specSource, "bundled");
  assert.equal((await down.client.listTools()).tools.length, 27);
});

test("no key: clear payment_required error with the price, nothing signed", async () => {
  const api = mockApi();
  const { call } = await connect({}, api);
  const r = await call("get_cbr_fx_rates", { codes: "USD" });
  assert.equal(r.isError, true);
  assert.equal(r.error, "payment_required");
  assert.equal(r.price.price_usd, 0.0015);
  assert.match(r.message, /X402_PRIVATE_KEY/);
  assert.equal(api.seen.payments.length, 0);
});

test("mocked 402 flow: signs USDC EIP-3009 authorization for the exact amount, returns data + settlement tx", async () => {
  const key = generatePrivateKey(), addr = privateKeyToAccount(key).address;
  const api = mockApi();
  const { call, address } = await connect({ X402_PRIVATE_KEY: key }, api);
  assert.equal(address, addr);
  const r = await call("get_cbr_fx_rates", { codes: "USD" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.data.rates[0].code, "USD");
  assert.deepEqual([r.payment.transaction, r.payment.charged, r.payment.price_usd, r.payment.payer], [TX, true, 0.0015, addr]);
  assert.equal(api.seen.payments.length, 1);
  const p = api.seen.payments[0];
  assert.equal(p.x402Version, 2);
  assert.equal(p.accepted.amount, "1500");
  assert.equal(p.payload.authorization.value, "1500");
  assert.equal(p.payload.authorization.to, CHALLENGE.accepts[0].payTo);
  assert.equal(p.payload.authorization.from, addr);
  assert.match(p.payload.signature, /^0x[0-9a-f]{130}$/i);
  assert.equal(api.seen.calls.filter((c) => c.path === "/ru/fx").map((c) => c.paid).join(), "false,true");
});

test("spend cap: a price above X402_MAX_PAYMENT_USD is refused before signing", async () => {
  const api = mockApi({ amount: "30000" });
  const { call } = await connect({ X402_PRIVATE_KEY: generatePrivateKey(), X402_MAX_PAYMENT_USD: "0.02" }, api);
  const r = await call("get_news_digest", {});
  assert.equal(r.error, "price_above_cap");
  assert.equal(r.price.price_usd, 0.03);
  assert.equal(api.seen.payments.length, 0);
});

test("400 / 404 / 502 / rejected payment / config error are mapped and flagged as not charged", async () => {
  const api = mockApi({
    routes: { "/moex/movers": () => json(400, { error: "limit must be a number" }) },
    afterPay: (_p, u) => u.pathname === "/moex/quote" ? json(404, { error: "not_found", detail: "ticker NOPE not found" })
      : u.pathname === "/ru/fuel" ? json(502, { error: "upstream_unavailable", detail: "rosstat down" })
      : json(402, { error: "insufficient_funds" }, { "payment-required": encodePaymentRequiredHeader({ ...CHALLENGE, error: "insufficient_funds" }) }),
  });
  const { call } = await connect({ X402_PRIVATE_KEY: generatePrivateKey() }, api);
  const bad = await call("get_moex_movers", { limit: 5 });
  assert.deepEqual([bad.status, bad.error, bad.detail.error], [400, "invalid_params", "limit must be a number"]);
  const nf = await call("get_moex_quote", { ticker: "NOPE" });
  assert.deepEqual([nf.status, nf.error, nf.payment.charged, nf.payment.transaction], [404, "not_found", false, null]);
  const up = await call("get_ru_fuel_prices", {});
  assert.deepEqual([up.status, up.error], [502, "upstream_unavailable"]);
  assert.match(up.note, /No payment was settled/);
  const rej = await call("get_cbr_key_rate", {});
  assert.equal(rej.error, "payment_rejected");
  assert.match(rej.message, /insufficient_funds/);
  const cfg = await connect({ X402_PRIVATE_KEY: "nope" }, mockApi());
  const ce = await cfg.call("get_cbr_key_rate", {});
  assert.equal(ce.error, "config_error");
});
