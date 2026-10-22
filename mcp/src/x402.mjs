// Minimal, explicit x402 v2 client flow (official @x402/fetch + @x402/evm), shared by the MCP server and scripts/paid-monitor.mjs:
//   1) plain GET; anything but 402 is returned as is (400/404/502 are never charged by the server)
//   2) 402 -> decode PAYMENT-REQUIRED, pick exact/USDC on the configured network, enforce the per-call USD cap
//   3) sign an EIP-3009 authorization locally, retry with PAYMENT-SIGNATURE, decode PAYMENT-RESPONSE (settlement tx)
// The private key never leaves this process and is never logged.
import fs from "node:fs";
import { x402Client, x402HTTPClient } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

export const DEFAULT_BASE_URL = "https://x402-markettwits-news.onrender.com";
export const DEFAULT_NETWORK = "eip155:8453";
export const DEFAULT_MAX_USD = 0.02;
export const USDC = {
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};
const USDC_DECIMALS = 6;

export class X402Error extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

/** Reads the key from X402_PRIVATE_KEY or the file in X402_PRIVATE_KEY_FILE. Returns {key|null, problem|null}; never echoes the key. */
export function readPrivateKey(env = process.env) {
  let raw = env.X402_PRIVATE_KEY;
  if (!raw && env.X402_PRIVATE_KEY_FILE) {
    try { raw = fs.readFileSync(env.X402_PRIVATE_KEY_FILE, "utf8"); } catch (e) { return { key: null, problem: `cannot read X402_PRIVATE_KEY_FILE (${e.code || "error"})` }; }
  }
  raw = String(raw ?? "").trim();
  if (!raw) return { key: null, problem: null };
  const hex = raw.startsWith("0x") || raw.startsWith("0X") ? raw.slice(2) : raw;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return { key: null, problem: "X402_PRIVATE_KEY is not a 32-byte hex private key (0x + 64 hex chars)" };
  return { key: `0x${hex.toLowerCase()}`, problem: null };
}

export function readConfig(env = process.env) {
  const baseUrl = String(env.X402_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const capRaw = env.X402_MAX_PAYMENT_USD;
  const maxUsd = capRaw === undefined || capRaw === "" ? DEFAULT_MAX_USD : Number(capRaw);
  const network = env.X402_NETWORK || DEFAULT_NETWORK;
  const timeoutMs = Number(env.X402_TIMEOUT_MS) || 60000;
  const { key, problem } = readPrivateKey(env);
  const problems = [];
  if (!/^https?:\/\//.test(baseUrl)) problems.push("X402_BASE_URL must start with http:// or https://");
  if (!Number.isFinite(maxUsd) || maxUsd < 0) problems.push("X402_MAX_PAYMENT_USD must be a non-negative number (USD)");
  if (!USDC[network]) problems.push(`X402_NETWORK ${network} is not supported (use eip155:8453 or eip155:84532)`);
  if (problem) problems.push(problem);
  return { baseUrl, maxUsd: Number.isFinite(maxUsd) && maxUsd >= 0 ? maxUsd : DEFAULT_MAX_USD, network, timeoutMs, privateKey: key, problems };
}

async function readBody(res) {
  const text = await res.text();
  try { return text ? JSON.parse(text) : null; } catch { return text.slice(0, 2000); }
}
const usd = (atomic) => Number(atomic) / 10 ** USDC_DECIMALS;

/**
 * createPayer({privateKey, maxUsd, network, fetchImpl, timeoutMs}) -> { address, request(url) }
 * request() resolves to { status, ok, body, headers, payment|null } or throws X402Error with a code:
 *   payment_required (no key), price_above_cap, unsupported_payment, bad_payment_challenge, payment_rejected, network_error, config_error
 */
export function createPayer({ privateKey = null, maxUsd = DEFAULT_MAX_USD, network = DEFAULT_NETWORK, fetchImpl = globalThis.fetch, timeoutMs = 60000, problems = [] } = {}) {
  const account = privateKey ? privateKeyToAccount(privateKey) : null;
  const client = account ? x402Client.fromConfig({
    schemes: [{ network, client: new ExactEvmScheme(account) }],
    spendControls: { maxAmountPerPayment: `$${maxUsd}` }, // library-level guard in addition to the explicit check below
  }) : null;
  const http = client ? new x402HTTPClient(client) : new x402HTTPClient(new x402Client());

  async function get(url, headers = {}) {
    try {
      return await fetchImpl(url, { method: "GET", headers: { accept: "application/json", "user-agent": "x402-markettwits-mcp/0.1", ...headers }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new X402Error("network_error", `request failed: ${e.name === "TimeoutError" ? `timeout after ${timeoutMs} ms` : e.message}`);
    }
  }

  /** Decodes the 402 challenge and picks exact/USDC on our network. Exported for the monitor's dry-run. */
  async function challenge(res) {
    const body = await readBody(res);
    let pr;
    try { pr = http.getPaymentRequiredResponse((n) => res.headers.get(n), body); }
    catch (e) { throw new X402Error("bad_payment_challenge", `402 without a valid PAYMENT-REQUIRED challenge: ${e.message}`); }
    const usdc = USDC[network].toLowerCase();
    const req = (pr.accepts || []).find((a) => a.scheme === "exact" && a.network === network && String(a.asset).toLowerCase() === usdc);
    if (!req) {
      throw new X402Error("unsupported_payment", `no exact USDC option on ${network}; offered: ${(pr.accepts || []).map((a) => `${a.scheme}/${a.network}/${a.asset}`).join(", ") || "none"}`);
    }
    return { paymentRequired: pr, requirement: req, price_usd: usd(req.amount), body };
  }

  async function request(url) {
    if (problems.length) throw new X402Error("config_error", problems.join("; "));
    const first = await get(url);
    if (first.status !== 402) return { status: first.status, ok: first.ok, body: await readBody(first), headers: first.headers, payment: null };

    const ch = await challenge(first);
    const price = { price_usd: ch.price_usd, amount: ch.requirement.amount, asset: ch.requirement.asset, network, pay_to: ch.requirement.payTo };
    if (ch.price_usd > maxUsd) throw new X402Error("price_above_cap", `price $${ch.price_usd} is above X402_MAX_PAYMENT_USD=$${maxUsd}; not paid`, { price });
    if (!client) {
      throw new X402Error("payment_required", `this endpoint costs $${ch.price_usd} USDC on ${network}; set X402_PRIVATE_KEY (a Base wallet holding USDC) to pay automatically`, { price });
    }
    let headers;
    try {
      const payload = await http.createPaymentPayload({ ...ch.paymentRequired, accepts: [ch.requirement] });
      headers = http.encodePaymentSignatureHeader(payload);
    } catch (e) {
      throw new X402Error("payment_rejected", `could not create the payment: ${e.message}`, { price });
    }
    const paid = await get(url, headers);
    const body = await readBody(paid);
    if (paid.status === 402) {
      let reason = body && typeof body === "object" ? body.error || body.message : null;
      try { reason = http.getPaymentRequiredResponse((n) => paid.headers.get(n), body).error || reason; } catch {}
      throw new X402Error("payment_rejected", `payment was not accepted${reason ? `: ${reason}` : ""} (check the wallet's USDC balance on Base)`, { price });
    }
    let settle = null;
    try { if (paid.headers.get("payment-response")) settle = http.getPaymentSettleResponse((n) => paid.headers.get(n)); } catch {}
    const payment = {
      ...price, payer: account.address,
      charged: paid.status < 400 && Boolean(settle?.success),
      transaction: settle?.transaction || null,
      settled: settle ? Boolean(settle.success) : false,
      ...(settle && !settle.success && settle.errorReason ? { error_reason: settle.errorReason } : {}),
    };
    return { status: paid.status, ok: paid.ok, body, headers: paid.headers, payment };
  }

  return { address: account?.address || null, request, challenge, get };
}

/** Maps an HTTP result / X402Error to the JSON the MCP tool returns. */
export function toToolResult(r, { endpoint }) {
  if (r instanceof Error) {
    return { isError: true, json: { ok: false, endpoint, error: r.code || "error", message: r.message, ...(r.price ? { price: r.price } : {}) } };
  }
  const notCharged = "No payment was settled (the server only charges successful responses).";
  if (r.status === 200) return { isError: false, json: { ok: true, endpoint, data: r.body, payment: r.payment } };
  const detail = r.body && typeof r.body === "object" ? r.body : { message: r.body };
  const map = { 400: "invalid_params", 404: "not_found", 502: "upstream_unavailable", 503: "service_unavailable", 429: "rate_limited" };
  return { isError: true, json: { ok: false, endpoint, status: r.status, error: map[r.status] || `http_${r.status}`, detail, note: notCharged, payment: r.payment } };
}
