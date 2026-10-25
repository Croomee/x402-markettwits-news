#!/usr/bin/env node
// Paid end-to-end monitor for the x402 API: one real paid call per run (run it hourly), rotating through cheap endpoints.
// Checks: HTTP 200, PAYMENT-RESPONSE with success + tx hash, sane body, (optional) tx receipt on Base, USDC balance.
// On failure: JSON line on stdout + appended to MONITOR_LOG, "ALERT ..." on stderr, exit code 1, Telegram message if
// TG_BOT_TOKEN + TG_CHAT_ID are set. A recovery after a failure is announced once; low balance at most once per 24 h.
//
//   node scripts/paid-monitor.mjs              # paid check of this hour's group (needs X402_PRIVATE_KEY or X402_PRIVATE_KEY_FILE)
//   node scripts/paid-monitor.mjs --dry-run    # no payment: checks /health and the 402 challenge of every group
//   options: --group <name>  --no-telegram  --no-onchain
// Dependencies come from ../mcp (cd mcp && npm ci --omit=dev). Exit codes: 0 ok, 1 failure, 2 bad usage/config.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readConfig, createPayer, X402Error, USDC } from "../mcp/src/x402.mjs";

const EXPECTED_PAY_TO = (process.env.MONITOR_PAY_TO || "0x2c257EE70952a16f00c99d40fDFF2d28f1A5b8A2").toLowerCase();
const LOG = process.env.MONITOR_LOG || path.join(os.homedir(), ".x402-monitor", "paid-monitor.jsonl");
const STATE = process.env.MONITOR_STATE || path.join(path.dirname(LOG), "state.json");
const RPC = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const TG_API = (process.env.TG_API_BASE || "https://api.telegram.org").replace(/\/+$/, "");
const LOW_BALANCE_USD = Number(process.env.MONITOR_LOW_BALANCE_USD || 0.5);
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

// cheap endpoint groups; amount = expected atomic USDC price; check(body) -> null | problem
export const GROUPS = [
  { name: "cbr-fx", path: "/ru/fx?codes=USD", amount: "1000",
    check: (b) => b?.rates?.[0]?.code === "USD" && b.rates[0].per_unit > 1 && b.rates[0].per_unit < 1000 ? null : "no sane USD rate" },
  { name: "cbr-key-rate", path: "/ru/key-rate?months=1", amount: "1000",
    check: (b) => typeof b?.rate === "number" && b.rate > 0 && b.rate < 100 && b.as_of ? null : "no sane key rate" },
  { name: "news-since", path: "/news/since?id=0&limit=1", amount: "1000",
    check: (b) => !Array.isArray(b?.items) ? "no items array" : b.items.length === 0 ? "news store is EMPTY (refill after a redeploy?)" : null },
  { name: "moex-index", path: "/moex/index?code=IMOEX", amount: "1500",
    check: (b) => b?.items?.[0]?.code === "IMOEX" && b.items[0].value > 100 ? null : "no sane IMOEX value" },
  { name: "tg-latest", path: "/tg/channel/latest?channel=markettwits&limit=1", amount: "2000",
    check: (b) => b?.items?.[0]?.id > 0 && b.items[0].link ? null : "no Telegram post" },
];

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
function record(line) {
  const s = JSON.stringify(line);
  console.log(s);
  try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, s + "\n"); }
  catch (e) { console.error(`cannot write ${LOG}: ${e.code || e.message}`); }
}
async function telegram(text) {
  const token = process.env.TG_BOT_TOKEN, chat = process.env.TG_CHAT_ID;
  if (!token || !chat || flag("--no-telegram")) return "off";
  try {
    const r = await fetch(`${TG_API}/bot${token}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: text.slice(0, 4000), disable_web_page_preview: true }), signal: AbortSignal.timeout(15000),
    });
    return r.ok ? "sent" : `failed HTTP ${r.status}`; // never echo the token or URL
  } catch (e) { return `failed ${e.name}`; }
}
async function rpc(method, params) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(10000) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
async function usdcBalance(addr, network) {
  const data = "0x70a08231" + addr.slice(2).toLowerCase().padStart(64, "0");
  return Number(BigInt(await rpc("eth_call", [{ to: USDC[network], data }, "latest"]))) / 1e6;
}
async function receipt(tx) {
  for (let i = 0; i < 6; i++) {
    const r = await rpc("eth_getTransactionReceipt", [tx]);
    if (r) return r.status === "0x1" ? "success" : "reverted";
    await new Promise((s) => setTimeout(s, 2500));
  }
  return "not_found_yet";
}

async function dryRun(config, payer) {
  const problems = [], groups = [];
  try {
    const h = await (await payer.get(`${config.baseUrl}/health`)).json();
    if (!h.ok || h.mode !== "paid") problems.push(`/health: ok=${h.ok} mode=${h.mode}`);
    groups.push({ name: "health", ok: Boolean(h.ok), mode: h.mode, items: h.items, facilitator: h.facilitator });
    if (h.items === 0) problems.push("news store is EMPTY (refill after a redeploy?)");
  } catch (e) { problems.push(`/health: ${e.message}`); }
  for (const g of GROUPS) {
    const t0 = Date.now();
    try {
      const res = await payer.get(config.baseUrl + g.path);
      if (res.status !== 402) { problems.push(`${g.path}: expected 402, got ${res.status}`); groups.push({ name: g.name, status: res.status }); continue; }
      const ch = await payer.challenge(res);
      const r = ch.requirement, bad = [];
      if (r.amount !== g.amount) bad.push(`amount ${r.amount} != ${g.amount}`);
      if (String(r.payTo).toLowerCase() !== EXPECTED_PAY_TO) bad.push(`payTo ${r.payTo} unexpected`);
      if (!ch.paymentRequired.extensions?.bazaar) bad.push("no bazaar extension");
      if (bad.length) problems.push(`${g.path}: ${bad.join(", ")}`);
      groups.push({ name: g.name, status: 402, price_usd: ch.price_usd, network: r.network, pay_to: r.payTo, ok: !bad.length, ms: Date.now() - t0 });
    } catch (e) { problems.push(`${g.path}: ${e.message}`); groups.push({ name: g.name, error: e.code || "error" }); }
  }
  return { problems, groups };
}

async function paidRun(config, payer) {
  const g = opt("--group") ? GROUPS.find((x) => x.name === opt("--group")) : GROUPS[Math.floor(Date.now() / 3600e3) % GROUPS.length];
  if (!g) { console.error(`unknown --group; use one of ${GROUPS.map((x) => x.name).join(", ")}`); process.exit(2); }
  const out = { group: g.name, path: g.path, problems: [], warnings: [] };
  const t0 = Date.now();
  let res;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try { res = await payer.request(config.baseUrl + g.path); }
    catch (e) { out.problems.push(`${e.code || "error"}: ${e.message}`); res = null; break; }
    if (res.status === 502 && attempt === 1) { await new Promise((s) => setTimeout(s, 30000)); continue; } // not charged, retry once
    break;
  }
  out.ms = Date.now() - t0;
  if (res) {
    out.status = res.status;
    const p = res.payment;
    out.price_usd = p?.price_usd; out.tx = p?.transaction || null; out.payer = p?.payer;
    if (res.status !== 200) out.problems.push(`HTTP ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
    if (!p) out.problems.push("server answered without asking for payment (paywall off?)");
    else {
      if (!p.settled || !/^0x[0-9a-fA-F]{64}$/.test(p.transaction || "")) out.problems.push(`no valid settlement in PAYMENT-RESPONSE${p.error_reason ? ` (${p.error_reason})` : ""}`);
      if (p.amount !== g.amount) out.warnings.push(`price changed: ${p.amount} != expected ${g.amount}`);
      if (String(p.pay_to).toLowerCase() !== EXPECTED_PAY_TO) out.problems.push(`payTo ${p.pay_to} is not ours`);
    }
    if (res.status === 200) { const why = g.check(res.body); if (why) out.problems.push(`body: ${why}`); }
    if (out.tx && !flag("--no-onchain")) {
      try { out.onchain = await receipt(out.tx); if (out.onchain === "reverted") out.problems.push(`tx ${out.tx} reverted on Base`); }
      catch (e) { out.warnings.push(`receipt check skipped: ${e.message}`); }
    }
  }
  if (payer.address) {
    try { out.balance_usdc = await usdcBalance(payer.address, config.network); if (out.balance_usdc < LOW_BALANCE_USD) out.low_balance = true; }
    catch (e) { out.warnings.push(`balance check skipped: ${e.message}`); }
  }
  return out;
}

const config = readConfig(process.env);
const dry = flag("--dry-run");
if (!dry && (config.problems.length || !config.privateKey)) {
  console.error(`config: ${config.problems.join("; ") || "X402_PRIVATE_KEY (or X402_PRIVATE_KEY_FILE) is required for paid mode; use --dry-run to only check the 402 challenge"}`);
  process.exit(2);
}
const payer = createPayer({ ...config, privateKey: dry ? null : config.privateKey });
const state = readJson(STATE, {});
const started = new Date().toISOString();
const r = dry ? await dryRun(config, payer) : await paidRun(config, payer);
const ok = r.problems.length === 0;
const line = { ts: started, mode: dry ? "dry-run" : "paid", ok, base: config.baseUrl, ...r };
record(line);

let tg = null;
const summary = dry ? "402 challenge check" : `${line.group} ${line.path}`;
if (!ok) {
  console.error(`ALERT x402 monitor (${summary}): ${r.problems.join(" | ")}`);
  tg = await telegram(`🔴 x402 monitor FAILED (${summary})\n${r.problems.join("\n")}${line.tx ? `\ntx ${line.tx}` : ""}\n${config.baseUrl}`);
} else if (state.last_ok === false) {
  tg = await telegram(`🟢 x402 monitor recovered (${summary})${line.tx ? `\ntx https://basescan.org/tx/${line.tx}` : ""}`);
}
if (line.low_balance && Date.now() - (state.low_balance_alert_at || 0) > 86400e3) {
  console.error(`ALERT x402 monitor: wallet ${line.payer} has ${line.balance_usdc} USDC (< ${LOW_BALANCE_USD})`);
  const s = await telegram(`🟡 x402 monitor wallet low: ${line.balance_usdc} USDC on Base (${line.payer})`);
  tg = tg || s; state.low_balance_alert_at = Date.now();
}
if (tg && tg !== "off") console.error(`telegram: ${tg}`);
try { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify({ ...state, last_ok: ok, last_run: started })); } catch {}
process.exit(ok ? 0 : 1);
