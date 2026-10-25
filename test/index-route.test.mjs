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

test("GET / is free JSON with 27 prices from the paid route table; paid routes still 402", async (t) => {
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
  assert.equal(body.prices.length, 27);
  assert.equal(body.paid_endpoints, 27);
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
  assert.equal(paidOps.length, 27);
  for (const [p, it] of paidOps) assert.equal(byPath[p].price_usd, it.get["x-payment-info"].price.amount, p);
  assert.ok(spec.paths["/"], "free op documented");
  assert.equal(spec.paths["/"].get["x-payment-info"], undefined);

  assert.equal((await fetch(`${base}/ru/fx`)).status, 402);
  assert.equal((await fetch(`${base}/news/latest`)).status, 402);
  assert.equal((await fetch(`${base}/health`)).status, 200);
});
