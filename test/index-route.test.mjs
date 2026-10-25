// GET / : free service index with the price list generated from PAID_ROUTES (spawns the real server).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAY_TO = "0x000000000000000000000000000000000000dEaD";

async function startServer(env) {
  const port = 40000 + Math.floor(Math.random() * 20000);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "x402-index-"));
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOST: "127.0.0.1", PORT: String(port), NEWS_FILE: path.join(tmp, "news.jsonl"), ...env },
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return { base, child }; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error(`server did not start: ${log}`);
}

test("GET / is free JSON with 31 prices from the paid route table; paid routes still 402", async (t) => {
  // paid mode against a local stub facilitator that only answers /supported (no verify/settle happens for unpaid requests)
  const fac = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url.endsWith("/supported")) return res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} }));
    res.statusCode = 404; res.end("{}");
  });
  await new Promise((r) => fac.listen(0, "127.0.0.1", r));
  const { base, child } = await startServer({ PAY_TO_ADDRESS: PAY_TO, X402_NETWORK: "eip155:8453", FACILITATOR_URL: `http://127.0.0.1:${fac.address().port}/facilitator` });
  t.after(() => { child.kill(); fac.close(); });

  const r = await fetch(`${base}/`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /application\/json/);
  assert.equal(r.headers.get("payment-required"), null);
  const body = await r.json();
  assert.equal(body.payTo, PAY_TO);
  assert.equal(body.payment.network, "eip155:8453");
  assert.match(body.description, /MarketTwits/);
  assert.equal(body.links.openapi, "/openapi.json");
  assert.equal(body.links.sample, "/news/sample");
  assert.equal(body.links.health, "/health");
  assert.equal(body.links.x402scan, "https://www.x402scan.com/server/f96fbc84-8538-414c-a847-bcc948103f8d");
  assert.equal(body.links.mcp.package, "x402-markettwits-mcp");
  assert.equal(body.links.mcp.install, "npx -y x402-markettwits-mcp");
  assert.equal(body.prices.length, 31);
  assert.equal(body.paid_endpoints, 31);
  const byPath = Object.fromEntries(body.prices.map((p) => [p.path, p]));
  assert.equal(byPath["/ru/fx"].price_usd, "0.001");
  assert.equal(byPath["/news/latest"].price_usd, "0.0015");
  assert.equal(byPath["/news/digest"].price_usd, "0.005");
  for (const p of body.prices) {
    assert.equal(p.method, "GET");
    assert.match(p.price_usd, /^\d+(\.\d+)?$/);
    assert.ok(p.description.length > 5, p.path);
  }

  // price list matches the OpenAPI paid operations exactly (single source)
  const spec = await (await fetch(`${base}/openapi.json`)).json();
  const paidOps = Object.entries(spec.paths).filter(([, it]) => it.get?.["x-payment-info"]);
  assert.equal(paidOps.length, 31);
  for (const [p, it] of paidOps) assert.equal(byPath[p].price_usd, it.get["x-payment-info"].price.amount, p);
  assert.ok(spec.paths["/"], "free op documented");
  assert.equal(spec.paths["/"].get["x-payment-info"], undefined);

  assert.equal((await fetch(`${base}/ru/fx`)).status, 402);
  assert.equal((await fetch(`${base}/news/latest`)).status, 402);
  assert.equal((await fetch(`${base}/health`)).status, 200);

  // alerts + daily digest: 402 challenge with the right USDC amount (6 decimals) and bazaar metadata; bad params -> 400 before payment
  const NEW = { "/alerts/price": ["0.0025", "2500"], "/alerts/news": ["0.002", "2000"], "/alerts/fx": ["0.0015", "1500"], "/digest/daily": ["0.005", "5000"] };
  for (const [p, [usd, amount]] of Object.entries(NEW)) {
    assert.equal(byPath[p].price_usd, usd, p);
    const op = spec.paths[p].get;
    assert.ok(op.description.length < 400, `${p} description ${op.description.length} chars`);
    assert.equal(op["x-payment-info"].protocols[0].x402.amount, amount, p);
    const r402 = await fetch(`${base}${p}`);
    assert.equal(r402.status, 402, p);
    const ch = JSON.parse(Buffer.from(r402.headers.get("payment-required"), "base64").toString("utf8"));
    assert.equal(ch.accepts[0].amount, amount, p);
    assert.equal(ch.accepts[0].network, "eip155:8453");
    assert.equal(ch.accepts[0].payTo, PAY_TO);
    assert.ok(ch.resource.description.length < 400, p);
    assert.ok(ch.extensions?.bazaar, `${p} bazaar extension`);
  }
  const WB = encodeURIComponent("https://www.wildberries.ru/catalog/839226871/detail.aspx");
  const bad = [
    `/alerts/price?url=https%3A%2F%2Fexample.com%2Fx&target_price=100`, `/alerts/price?url=${WB}&target_price=-5`, `/alerts/price?url=${WB}`,
    "/alerts/news?q=", "/alerts/news?q=oil&since=yesterday", "/alerts/news?q=oil&match=some", "/alerts/news?since=389000",
    "/alerts/fx?code=US&min=1", "/alerts/fx?code=USD", "/alerts/fx?code=USD&min=90&max=80", "/alerts/fx?code=RUB&max=1", "/alerts/fx?min=70",
    "/digest/daily?limit=abc",
  ];
  for (const u of bad) {
    const rb = await fetch(`${base}${u}`);
    assert.equal(rb.status, 400, u);
    assert.equal(rb.headers.get("payment-required"), null, u);
    assert.ok((await rb.json()).error, u);
  }
  // valid params without payment -> 402; missing required params WITH a payment attached -> 400 (never charged)
  for (const u of [`/alerts/price?url=${WB}&target_price=1500`, "/alerts/news?q=oil,OPEC&since=389000", "/alerts/fx?code=USD&min=75&max=95", "/digest/daily?limit=5"]) {
    assert.equal((await fetch(`${base}${u}`)).status, 402, u);
  }
  for (const p of ["/alerts/price", "/alerts/news", "/alerts/fx"]) {
    assert.equal((await fetch(`${base}${p}`, { headers: { "payment-signature": "e30=" } })).status, 400, p);
  }
});
