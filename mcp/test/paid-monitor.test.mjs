// scripts/paid-monitor.mjs against a local mock API + Base RPC + Telegram (no real payment; throwaway key).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { encodePaymentRequiredHeader, decodePaymentSignatureHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { generatePrivateKey } from "viem/accounts";

const SCRIPT = new URL("../../scripts/paid-monitor.mjs", import.meta.url).pathname;
const CHALLENGE = JSON.parse(fs.readFileSync(new URL("./fixtures/challenge-ru-fx.json", import.meta.url), "utf8"));
const PRICES = { "/ru/fx": "1000", "/ru/key-rate": "1000", "/news/since": "1000", "/moex/index": "1500", "/tg/channel/latest": "2000" };
const BODIES = {
  "/ru/fx": { rates: [{ code: "USD", per_unit: 81.97 }] }, "/ru/key-rate": { rate: 14, as_of: "2026-10-21" },
  "/news/since": { items: [{ id: 1 }] }, "/moex/index": { items: [{ code: "IMOEX", value: 2447 }] }, "/tg/channel/latest": { items: [{ id: 5, link: "https://t.me/x/5" }] },
};

function mock({ settle = true, emptyNews = false } = {}) {
  const seen = { payments: 0, tg: [], rpc: [] };
  const srv = http.createServer((req, res) => {
    let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => {
      const u = new URL(req.url, "http://x"), send = (code, obj, h = {}) => { res.writeHead(code, { "content-type": "application/json", ...h }); res.end(JSON.stringify(obj)); };
      if (u.pathname === "/rpc") {
        const j = JSON.parse(body); seen.rpc.push(j.method);
        return send(200, { jsonrpc: "2.0", id: 1, result: j.method === "eth_call" ? "0x" + (300000).toString(16) : { status: "0x1" } }); // 0.3 USDC
      }
      if (u.pathname.startsWith("/bot")) { seen.tg.push({ path: u.pathname, ...JSON.parse(body) }); return send(200, { ok: true }); }
      if (u.pathname === "/health") return send(200, { ok: true, mode: "paid", items: 5 });
      if (!PRICES[u.pathname]) return send(404, {});
      const sig = req.headers["payment-signature"];
      if (!sig) {
        const ch = structuredClone(CHALLENGE); ch.accepts[0].amount = PRICES[u.pathname];
        return send(402, {}, { "payment-required": encodePaymentRequiredHeader(ch) });
      }
      const p = decodePaymentSignatureHeader(sig); seen.payments++;
      const b = u.pathname === "/news/since" && emptyNews ? { items: [] } : BODIES[u.pathname];
      return send(200, b, { "payment-response": encodePaymentResponseHeader(settle
        ? { success: true, transaction: "0x" + "cd".repeat(32), network: "eip155:8453", payer: p.payload.authorization.from }
        : { success: false, errorReason: "insufficient_funds", transaction: "", network: "eip155:8453" }) });
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, seen, base: `http://127.0.0.1:${srv.address().port}` })));
}

function run(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH, ...env } });
    let out = "", err = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code, out, err, line: out.trim() ? JSON.parse(out.trim().split("\n").pop()) : null }));
  });
}

test("paid monitor: success, failure alert (Telegram + log + exit 1), recovery, dry-run", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-"));
  const key = generatePrivateKey(), token = "123456:TEST-TOKEN-should-never-print";
  const ok = await mock();
  const env = (m) => ({ X402_BASE_URL: m.base, X402_PRIVATE_KEY: key, BASE_RPC_URL: `${m.base}/rpc`, TG_API_BASE: m.base, TG_BOT_TOKEN: token, TG_CHAT_ID: "42",
    MONITOR_LOG: path.join(dir, "m.jsonl"), MONITOR_PAY_TO: CHALLENGE.accepts[0].payTo, MONITOR_LOW_BALANCE_USD: "0.1" });

  const a = await run(["--group", "cbr-fx"], env(ok));
  assert.equal(a.code, 0, a.err);
  assert.deepEqual([a.line.ok, a.line.status, a.line.price_usd, a.line.onchain, a.line.balance_usdc], [true, 200, 0.001, "success", 0.3]);
  assert.match(a.line.tx, /^0x(cd){32}$/);
  assert.equal(ok.seen.tg.length, 0, "no alert on success");

  const bad = await mock({ settle: false, emptyNews: true });
  const b = await run(["--group", "news-since"], env(bad));
  assert.equal(b.code, 1);
  assert.equal(b.line.ok, false);
  assert.ok(b.line.problems.some((p) => /settlement/.test(p)) && b.line.problems.some((p) => /EMPTY/.test(p)), b.line.problems.join("|"));
  assert.match(b.err, /^ALERT x402 monitor/m);
  assert.equal(bad.seen.tg.length, 1);
  assert.equal(bad.seen.tg[0].chat_id, "42");
  assert.match(bad.seen.tg[0].text, /FAILED/);
  for (const s of [b.out, b.err, fs.readFileSync(path.join(dir, "m.jsonl"), "utf8")]) assert.ok(!s.includes(token) && !s.includes(key.slice(2)), "no secrets in output");

  const c = await run(["--group", "tg-latest"], env(ok));
  assert.equal(c.code, 0);
  assert.equal(ok.seen.tg.length, 1);
  assert.match(ok.seen.tg[0].text, /recovered/);

  const low = await run(["--group", "cbr-key-rate"], { ...env(ok), MONITOR_LOW_BALANCE_USD: "1" });
  assert.equal(low.code, 0);
  assert.match(low.err, /wallet .* has 0.3 USDC/);
  const low2 = await run(["--group", "cbr-key-rate"], { ...env(ok), MONITOR_LOW_BALANCE_USD: "1" });
  assert.ok(!/wallet .* has/.test(low2.err), "low balance alert at most once a day");

  const d = await run(["--dry-run"], { ...env(ok), X402_PRIVATE_KEY: "" });
  assert.equal(d.code, 0, d.out);
  assert.equal(d.line.groups.filter((g) => g.status === 402 && g.ok).length, 5);
  assert.equal(fs.readFileSync(path.join(dir, "m.jsonl"), "utf8").trim().split("\n").length, 6);
  const nokey = await run([], { ...env(ok), X402_PRIVATE_KEY: "" });
  assert.equal(nokey.code, 2);
  assert.ok(ok.seen.payments >= 4 && bad.seen.payments === 1);
  ok.srv.close(); bad.srv.close();
});
