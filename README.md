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
| `GET /news/summary/recent?q=WORDS&hours=12` | **x402: $0.007 USDC** | like `/news/summary` but over matching items from the last N hours (1-168, max 50 items): `{query, hours, since, count, high_count, summary, items}` |
| `GET /news/alerts/new?q=WORDS&hours=6` | **x402: $0.005 USDC** | only HIGH-importance matches in the last N hours (1-168): `{query, hours, since, has_new, count, latest}` (`latest` null if none) |
| `GET /news/topics/trending?hours=6` | **x402: $0.004 USDC** | top 5 topics in high items of the last N hours (1-72) with `prev_count`, `change` (= count − count in the previous equal window) and `latest_id`/`latest_source_url`; same fallback as `/news/top-topics` (then compared with the 20 high items before) |
| `GET /news/since?id=LAST_ID&limit=50` | **x402: $0.002 USDC** | cursor polling: items with `id > LAST_ID` (0 = from the oldest stored), **oldest first**, up to `limit` (1-100, default 50): `{since_id, count, has_more, next_id, latest_id, items}`; pass `next_id` back as `id`. Bad `id`/`limit` → 400 before payment; no `id` and no payment → 402 |
| `GET /news/movers?hours=6&min_pct=2` | **x402: $0.005 USDC** | top 10 gainers / losers parsed from `#TICKER [Name] = ±X%` lines (sign from ⬆️/⬇️ when missing, country from the flag; `m/m`, `y/y` data excluded) in the last N hours (1-72), newest mention per ticker, `|pct| >= min_pct` (0-100): `{hours, min_pct, since, tickers_found, gainers, losers}` |
| `GET /news/country?code=RU&hours=24&importance=all` | **x402: $0.004 USDC** | items of the last N hours (1-168) with the country's flag or keywords (14 countries have keyword lists, e.g. RU: Russia/Kremlin/Bank of Russia/MOEX; any ISO-2 code matches by flag; `UK` = `GB`; `EU`): `{code, flag, count, high_count, by_flag, share_of_window, top_topics, latest[10]}`; `importance` = all/high/medium/low |
| `GET /news/data-surprises?hours=24&q=CPI` | **x402: $0.006 USDC** | macro releases (`X = A (exp E / prev P)`) and earnings (`3Q REV. $A, EST. $E`) vs. expectations in the last N hours (1-168), optional `q`: `{count, above, below, items:[{kind, indicator, ticker?, actual, expected, previous, unit, surprise, surprise_pct, direction}]}` |
| `GET /news/sentiment?q=oil&hours=24` | **x402: $0.005 USDC** | heuristic tone of items matching `q` (keyword + emoji lexicon, parsed `= ±X%` moves weigh double; **not a model**): `{count, bullish, bearish, neutral, score∈[-1,1], label, method:"heuristic", examples}`. `q` required (missing + no payment → 402, empty → 400) |
| `GET /news/digest?hours=24` | **x402: $0.01 USDC** | sectioned briefing of the last N hours (1-48): `sections.{central_banks, macro, energy, equities, crypto, geopolitics}` each `{count, high_count, items[≤5]}` (an item may be in several), `unclassified_count`, `top_topics` of high items |
| `GET /product/info?url=PRODUCT_URL` | **x402: $0.004 USDC** | Wildberries (`wildberries.ru`, `*.wildberries.ru`, `wb.ru` `/catalog/<id>/`) or Ozon (`*.ozon.ru` `/product/<slug>-<id>/`) product: `{source, url, product_id, title, price:{amount, currency:"RUB", original_amount?}, rating, reviews_count, availability, in_stock, fetched_at}`. Bad/foreign url → 400 before payment; marketplace blocked/failed → **502 `upstream_unavailable`, not settled**. 10-min cache per product, ~10 s timeout |
| `GET /product/compare?urls=U1,U2[,...]` | **x402: $0.006 USDC** | 2-5 product URLs (comma-separated `urls=` and/or repeated `url=`), fetched with the same chain as `/product/info` (2 in flight): `{count, succeeded, items:[{product_id, title, price, original_price, in_stock, rating, reviews_count, url, error?}], cheapest, most_expensive, price_diff:{abs, percent}, in_stock_count, all_in_stock, fetched_at}`. <2 / >5 / duplicate / any invalid URL → 400 before payment; nothing given and no payment → 402; per-item errors allowed, **502 (not settled) only if fewer than 2 items returned a price** |
| `GET /product/monitor?url=&target_price=RUB` | **x402: $0.005 USDC** | `{below_target, current_price, original_price, target_price, diff_abs, diff_percent, in_stock, title, product, checked_at, note?}`; `below_target` = current ≤ target **and not out of stock**. `target_price` must be a positive number (else 400 before payment). Out of stock with no price → **200** with `below_target:false, current_price:null, in_stock:false` + note (a useful, billable answer); no product data at all → 502 (not settled) |
| `GET /product/history?url=` | **x402: $0.004 USDC** | Wildberries: weekly points from WB's public `basket-NN.wbbasket.ru/…/price-history.json` (`weekly_cdn`), prices observed by this service on earlier lookups (`observed`, **in-memory, reset on every restart/redeploy**) and the live price (`live`): `{current, points:[{date, price, source}], stats:{min,max,avg,count,from,to}, change_30d, history_limited, note?, sources}`. `history_limited:true` when only the current price exists. Ozon: live only (currently blocked). 502 only when there is no price at all |
| `GET /ru/fx?date=YYYY-MM-DD&codes=USD,EUR` | **x402: $0.0015 USDC** | Bank of Russia official RUB rates (`cbr.ru/scripts/XML_daily.asp`): `{source, base:"RUB", date, previous_date, count, missing?, rates:[{code, name, nominal, value, per_unit, prev_per_unit, change, change_pct}]}`; `date` 1992-07-01..tomorrow (default latest set; CBR publishes the next day's rates in the afternoon), `codes` 1-30 ISO codes (default all). Cache 30 min (latest) / 7 days (past dates) |
| `GET /ru/key-rate?months=24` | **x402: $0.0015 USDC** | Bank of Russia key rate (SOAP `DailyInfo.asmx` KeyRateXML, fallback the `/hd_base/KeyRate/` page): `{rate, as_of, effective_since, previous_rate, last_change_bp, changes:[{date, rate, prev_rate, change_bp}], min, max}` over the last `months` (1-120). Cache 3 h |
| `GET /moex/quote?ticker=SBER` | **x402: $0.003 USDC** | MOEX ISS shares (TQBR preferred): `{ticker, board, short_name, isin, currency, lot_size, price, price_source:"last_trade"|"previous_close", last, prev_close, change, change_pct, open/high/low, bid/offer, volume, value_rub, market_cap_rub, update_time, delayed:true, delay_minutes:15}`. Unknown ticker → 404 (not settled). `ticker` required (missing + no payment → 402) |
| `GET /moex/index?code=IMOEX` | **x402: $0.003 USDC** | MOEX indices: up to 5 comma-separated codes (default `IMOEX`; `IMOEX,RTSI,MOEXOG`, …): `{items:[{code, name, value, prev_close, change, change_pct, open, high, low, month/year_change_pct, annual_high/low, value_traded_rub, currency}]}`; `code=list` → all ~90 index codes and names |
| `GET /moex/movers?limit=10&min_value=5000000` | **x402: $0.004 USDC** | top gainers/losers on TQBR among shares that traded ≥ `min_value` RUB (liquidity filter); `mode:"live"` during the session, `mode:"previous_session"` (from ISS history) before the open/at weekends: `{mode, as_of, universe, advancers, decliners, gainers, losers}`. Delayed ~15 min |
| `GET /ru/fuel?weeks=4` | **x402: $0.003 USDC** | Rosstat weekly average retail fuel prices, Russia: AI-92, AI-95, AI-98+, diesel, all petrol (`rosstat.gov.ru/storage/mediabank/nedel_sred_cen.xlsx`): `{as_of, prices:[{fuel, price, prev_price, change, change_pct, change_4w_pct, change_ytd_pct, history[weeks+1]}]}`. Updated weekly (Wednesdays, prices as of the Monday); cache 6 h, a stale copy is served up to 14 days if Rosstat is down |
| `GET /tg/channel/latest?channel=markettwits&limit=20` | **x402: $0.004 USDC** | newest posts of a **public** Telegram channel from its web preview `t.me/s/<channel>` (up to 4 pages): `{channel, title, subscribers, count, items:[{id, channel, date, text, views, link, media[], edited, forwarded_from?}]}` newest first, `limit` 1-50. Channel name `^[A-Za-z][A-Za-z0-9_]{3,31}$` (`@x`, `t.me/x` accepted); no such channel / no public preview → 404 (not settled) |
| `GET /tg/search?q=oil&channels=a,b` | **x402: $0.006 USDC** | Telegram's own in-channel search (`t.me/s/<ch>?q=`) across 1-5 public channels, merged newest first (`limit` 1-50, default 20): `{query, channels, count, per_channel:[{channel, count, error?}], items}`; per-channel errors allowed, 404 if all channels unknown, 502 if all failed. `q` 1-100 chars |
| `GET /admin/product-probe?url=` | `Authorization: Bearer <INGEST_TOKEN>` | diagnostic: same fetch logic without cache, returns result or the per-upstream errors; `&op=compare|monitor|history` or `&op=news-since|news-movers|news-country|news-data-surprises|news-sentiment|news-digest` or `&op=ru-fx|ru-key-rate|moex-quote|moex-index|moex-movers|ru-fuel|tg-latest|tg-search` (+ that route's params) runs the paid logic without payment and returns `{ok, op, status, ms, body}`; not in OpenAPI |
| `GET /openapi.json` | free, CORS `*` | OpenAPI 3.1 discovery doc for x402scan / agentcash (network, price, payTo from live config) |
| `POST /ingest` | `Authorization: Bearer <INGEST_TOKEN>` | one item or an array; dedupe by id; 401 bad token; 404 if `INGEST_TOKEN` unset |

The six analytics routes have fixed prices (independent of `PRICE`) and use the same `q` matching and
pre-payment validation as `/news/search`; a non-numeric `hours`/`limit` also returns 400 before payment.
The summary is deterministic (no LLM): a lead sentence (`N matching items since <time>; X high-importance.`)
plus the de-duplicated first sentence/headline of the matching items, high-importance first, then newest.
`/product/info` (in `product.mjs`): Wildberries tries the public card API `card.wb.ru/cards/v4|v2|v1/detail` (price in kopecks,
rating, feedbacks, stock), then the page JSON-LD, then the static CDN (`basket-NN.wbbasket.ru` card.json + feedbacks +
weekly `price-history.json`; then `price.as_of` is set, availability is `unknown`, prices older than 60 days are refused).
Ozon tries the page JSON-LD, then `composer-api.bx/page/json/v2`. Both marketplaces run anti-bot protection that often blocks
datacenter IPs; then the route answers 502. x402 v2 (`exact` on EVM = "authorization" flow) verifies the payment before the
handler and settles only if the handler's status is < 400, so a 4xx/5xx is never charged.
**RU data and Telegram routes** (`ru-data.mjs`, `tg.mjs`, `upstream.mjs`). Each upstream call goes direct first (8 s; Rosstat 15 s)
and, if that fails (network error, timeout or a non-2xx status), once more through `PROXY_URL` (disable with `DATA_PROXY_FALLBACK=0`); a host
that only worked through the proxy goes proxy-first for an hour. Responses are cached in memory (CBR 30 min/7 d, key rate 3 h,
MOEX 30-60 s, Rosstat 6 h, Telegram 2 min) with a stale copy served if the upstream is down; failures with no cached copy → 502
`upstream_unavailable` (not settled). rosstat.gov.ru uses the Russian Trusted Root CA, which is not in Node's trust store: the public
Root + Sub CA certificates are bundled in `ru-ca.mjs` and used only for Rosstat requests (verification stays on).
MOEX ISS data is public and delayed ~15 min; Telegram routes read only public web previews.
**Marketplace proxy (optional).** Wildberries/Ozon block datacenter IPs, so `/product/info` (and the admin probe) can go
through an HTTP(S)/SOCKS5 proxy in Russia. Only these marketplace fetches use it as the first path; the RU data / Telegram routes below use it only as a fallback.
`PROXY_URL` (e.g. `http://user:pass@1.2.3.4:3128`, also `https://`, `socks5://`) takes priority over
`PROXY_HOST`/`PROXY_PORT`/`PROXY_USER`/`PROXY_PASS`. `PROXY_SCOPE` (default `wb,ozon`) selects the marketplaces;
`PROXY_FALLBACK_DIRECT` (default `true`) retries directly when the proxy path fails (proxy phase ≤ 9 s, direct ≤ 6 s).
With the proxy the live paths are tried first (card.wb.ru; Ozon page/composer); the WB static CDN stays the last resort.
Responses carry `via: "proxy"|"direct"`; `/health` shows only `proxy_configured: true|false`; credentials and the proxy
host are masked in errors and never logged. Without a proxy the behaviour is unchanged (`via: "direct"`).
Proxy on a Russian VPS (Ubuntu/Debian, as root; squid with basic auth, CONNECT :443 only, systemd, ufw/iptables):
`curl -fsSL https://raw.githubusercontent.com/Croomee/x402-markettwits-news/main/scripts/beget-proxy-setup.sh | bash`
(`| bash -s -- 8080 --reset` for another port / new credentials). It prints `PROXY_URL=...`; set that on Render.

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
| `PROXY_URL` | — | optional marketplace proxy for `/product/info` (http/https/socks5); or `PROXY_HOST`/`PROXY_PORT`/`PROXY_USER`/`PROXY_PASS` |
| `DATA_PROXY_FALLBACK` | `1` | `0` disables the `PROXY_URL` fallback for the RU data / Telegram routes |
| `PROXY_SCOPE` | `wb,ozon` | which marketplaces use the proxy |
| `PROXY_FALLBACK_DIRECT` | `true` | retry directly if the proxy path fails |
| `DEV_MODE` | — | `1` = run without payments (local only) |

## Headless-browser parser (WB / Ozon anti-bot)

Plain HTTP requests to Wildberries/Ozon are blocked even from Russian residential IPs (WB `wbaas` 403/498 token
challenge, Ozon `?__rr=1` / `abt` challenge). `parser/` is a small Playwright + Chromium service for a VPS that loads
the real page through the residential proxy, lets the site's own JavaScript pass the challenge, and then reads the
site's own JSON (WB `__internal/u-card/cards/v4/detail`; Ozon entrypoint-api / ld+json).

- `GET /parse?url=<WB or Ozon product URL>` (or `POST {"url": ...}`), header `Authorization: Bearer $PARSER_TOKEN`.
  200 → `{ok, source, product_id, url, title, price, old_price, currency, rating, reviews_count, in_stock, availability,
  brand, seller, data_source, fetched_at, ms, cached}`. 400 invalid url, 401 bad token, 404 product not found,
  502 `blocked` (anti-bot, e.g. Ozon captcha), 504 timeout, 503 queue full. `GET /health` (no auth).
- One shared browser/context: cookies and the WB token are reused (and saved to `STATE_DIR`), so after the first
  cold request (~10–20 s incl. challenge) WB items take well under a second. Concurrency 2, 25 s per request,
  10 min cache; images/fonts/media are not downloaded (saves residential-proxy traffic).
- Chromium cannot use a SOCKS5 proxy with a password, so a `socks5://` / `socks5h://` `PROXY_URL` is served through a
  built-in loopback HTTP-CONNECT bridge (`parser/bridge.mjs`). `http://USER:PASS@host:port` proxies are passed to
  Chromium directly.
- Memory: Chromium with a warm WB tab ≈ 500–800 MB. On < 1.5 GB RAM the setup script sets `CONCURRENCY=1` and
  `LOW_MEMORY=1` (fewer renderer processes, smaller JS heap); it adds a 2 GB swapfile when RAM < 2 GB and there is no
  swap. The unit has `MemoryMax=1200M` and restarts daily. The SOCKS bridge refuses Chromium's own Google background
  hosts (`BRIDGE_DENY`) so they don't consume proxy traffic.
- Setup script: logs every step to `/var/log/x402-parser-setup.log` and prints the failing step + log tail; `--debug`
  for `set -x`. Node 20 goes to `/usr/local` from the official tarball (nodejs.org → npmmirror.com), leaving an apt
  nodejs (e.g. Ubuntu 24.04's v18) untouched; NodeSource is only a fallback. npm falls back to registry.npmmirror.com,
  Chromium to npmmirror.com/mirrors/playwright, then the distro `chromium` package (Debian; not Ubuntu's snap).

Install / update on the VPS (root; re-run to update, keeps the token):

```bash
PROXY_URL='socks5h://USER:PASS@v2.proxyempire.io:5000' \
  bash <(curl -fsSL https://raw.githubusercontent.com/Croomee/x402-markettwits-news/main/scripts/beget-parser-setup.sh)
```

It prints `PARSER_URL` and `PARSER_TOKEN`; set both on Render. `/product/info` then calls the parser first
(timeout `PARSER_TIMEOUT_MS`, default 30 s), returns `via: "browser"`, and on any parser failure falls back to the
existing proxy/direct chain. 400-before-payment / 402 / settle-only-on-2xx are unchanged; a 502 is still never charged.
Security: the parser is protected only by the bearer token over plain HTTP (Render has no static egress IPs to
allow-list). Keep the token secret, rotate it with `--reset-token`, and put it behind HTTPS (e.g. Caddy) when possible.

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
