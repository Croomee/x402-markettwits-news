# x402-markettwits-news

x402-paid HTTP API serving English translations of MarketTwits (t.me/markettwits) market news.
Built with Express and the official x402 v2 packages (`@x402/express`, `@x402/core`, `@x402/evm`).

## Endpoints
| Route | Access | Notes |
|---|---|---|
| `GET /health` | free | mode, network, facilitator (`cdp`/`x402.org`/`custom`), price, item count, newest id, ingest on/off |
| `GET /news/sample` | free | newest item, text truncated to 80 chars (discovery) |
| `GET /news/latest?limit=N` | **x402: $0.003 USDC** | newest first, default 20, max 50 |
| `GET /news/important?limit=N` | **x402: $0.003 USDC** | only `importance=high`, newest first |
| `GET /news/search?q=WORDS&limit=N` | **x402: $0.003 USDC** | case-insensitive, all words must match, `#tag` = `tag`; `q` 1-100 chars. Invalid `q` → 400 before payment (missing `q` without a payment → 402 so discovery probes work); no match → 200 `items: []` |
| `GET /news/alerts/check?q=WORDS&hours=24` | **x402: $0.004 USDC** | keyword alert: count of matching items in the last N hours (1-168) + 5 most recent: `{query, hours, count, since, latest_id, latest_published_at, items}` |
| `GET /news/summary?q=WORDS&limit=10` | **x402: $0.008 USDC** | 3-5 sentence extractive English summary of the latest matching items (limit 1-50): `{query, count, summary, items}` |
| `GET /news/top-topics?hours=6` | **x402: $0.005 USDC** | top 5 hashtags/keywords in high-importance items of the last N hours (1-72); falls back to the last 20 high items (`fallback: true`) |
| `GET /openapi.json` | free, CORS `*` | OpenAPI 3.1 discovery doc for x402scan / agentcash (network, price, payTo from live config) |
| `POST /ingest` | `Authorization: Bearer <INGEST_TOKEN>` | one item or an array; dedupe by id; 401 bad token; 404 if `INGEST_TOKEN` unset |

The three analytics routes have fixed prices (independent of `PRICE`) and use the same `q` matching and
pre-payment validation as `/news/search`; a non-numeric `hours`/`limit` also returns 400 before payment.
The summary is deterministic (no LLM): a lead sentence (`N matching items since <time>; X high-importance.`)
plus the de-duplicated first sentence/headline of the matching items, high-importance first, then newest.
Logic lives in `news-logic.mjs`; `npm test` runs its unit tests.

Default network: **Base mainnet `eip155:8453`** (USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, resolved
automatically by `@x402/evm` from the `$` price), via the **Coinbase CDP facilitator**
(`https://api.cdp.coinbase.com/platform/v2/x402`, authenticated with `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` through
`createFacilitatorConfig()` from `@coinbase/x402`, which signs a per-request CDP JWT).

Facilitator selection: CDP keys set → CDP; otherwise `FACILITATOR_URL` (default `https://x402.org/facilitator`,
testnet only). On mainnet without CDP keys and with the x402.org facilitator the server refuses to start.
Testnet: `X402_NETWORK=eip155:84532` (Base Sepolia, USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`) without CDP keys.

### Item schema (also the JSONL line format)
```json
{"id":389638,"source_url":"https://t.me/markettwits/389638","published_at":"2026-10-20T12:20:00Z",
 "importance":"high","text_en":"...","posted_to_x":true,"buffer_post_id":"6ad7...","stored_at":"2026-10-20T12:23:03Z"}
```
`id`, `published_at`, `importance` (high|medium|low) and `text_en` are required; the rest is filled in.
The server keeps the newest 500 items in memory and appends new ones to `NEWS_FILE` (default `./data/news.jsonl`)
best-effort; on startup and whenever the file changes it is re-read.

## Configuration (env)
| Var | Default | |
|---|---|---|
| `PAY_TO_ADDRESS` | — (required) | receiving wallet; server refuses to start without it unless `DEV_MODE=1` |
| `X402_NETWORK` | `eip155:8453` | Base mainnet; `eip155:84532` = Base Sepolia |
| `CDP_API_KEY_ID` | — | CDP facilitator (required on mainnet) |
| `CDP_API_KEY_SECRET` | — | CDP facilitator (required on mainnet) |
| `FACILITATOR_URL` | `https://x402.org/facilitator` | used only without CDP keys |
| `PRICE` | `$0.003` | |
| `INGEST_TOKEN` | — | enables `POST /ingest` |
| `PORT` / `HOST` | `4021` / `0.0.0.0` | Render sets `PORT` |
| `NEWS_FILE` | `data/news.jsonl` | |
| `PUBLIC_URL` | — | `servers[0].url` in `/openapi.json`; default = request proto/host |
| `DEV_MODE` | — | `1` = run without payments (local only) |

## Run locally
```bash
npm ci
cp .env.example .env   # fill in INGEST_TOKEN
node --env-file=.env server.mjs
curl -i localhost:4021/news/latest          # 402 + PAYMENT-REQUIRED header (base64 JSON)
curl -s -D- -o /dev/null localhost:4021/news/latest | grep -i payment-required | cut -d' ' -f2 | base64 -d
```

## Deploy on Render
1. Render dashboard → **New → Blueprint**, pick this GitHub repo (uses `render.yaml`),
   or **New → Web Service**: runtime Node, build `npm ci`, start `node server.mjs`, health check `/health`.
2. Set `PAY_TO_ADDRESS`, `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` (prompted; `sync: false`). `INGEST_TOKEN` is auto-generated by the blueprint —
   copy it from the service's Environment tab.
3. After deploy: `curl https://<service>.onrender.com/health` → 200; `/news/latest` → 402.
4. Feeding data: on the machine that produces translations, put the service URL in `api_url.txt` and the token
   in `ingest_token.txt` (chmod 600) and run `push_to_api.sh` (POSTs the newest 50 items; server dedupes).

Notes: Render free instances sleep after ~15 min idle (first request is slow) and have an ephemeral disk —
the in-memory/file store is lost on restart/redeploy, and is refilled by the next push (newest 50).
For durable history use a paid instance with a persistent disk or an external DB.

## Paying client
Use `@x402/fetch` or `@x402/axios` with a Base wallet holding USDC (mainnet), or testnet USDC on Base Sepolia
(https://faucet.circle.com) when running with `X402_NETWORK=eip155:84532`.

## Discovery (x402scan)
`GET /openapi.json` follows the agentcash/x402scan discovery spec v1: `info.x-guidance`, `info.contact.email`,
and on the paid operation `responses.402` plus structured
`x-payment-info: {"price":{"mode":"fixed","currency":"USD","amount":"0.003"},"protocols":[{"x402":{...}}]}`.
The runtime 402 challenge also carries the Bazaar extension (`extensions.bazaar`, input/output schema).
Check with: `npx @agentcash/discovery discover <origin> -v` and `npx @agentcash/discovery check <origin>/news/latest`.
Register at https://www.x402scan.com (Add Server → origin URL).
