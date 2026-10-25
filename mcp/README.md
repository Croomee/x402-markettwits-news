# x402-markettwits-mcp

MCP server (stdio) for the pay-per-call **x402-markettwits-news** API: MarketTwits market news in English plus
Russian market data (Bank of Russia FX and key rate, MOEX quotes, indices and movers, Rosstat fuel prices),
public Telegram channels and Wildberries product prices.

Every API endpoint is one MCP tool (27 tools). Each call costs a fixed **$0.001–$0.005 in USDC on Base**, paid
automatically through [x402](https://x402.org) from a wallet you configure. Only successful responses are charged;
invalid parameters (400), not found (404) and upstream failures (502) are free.

## Requirements
- Node.js 20+
- a **dedicated hot wallet** on Base with a few USDC (no ETH needed: payments are gasless EIP-3009 authorizations
  settled by the facilitator). $3 is enough for 300–2,000 calls. Never use your main wallet's key.

## Configuration
| Env | Default | |
|---|---|---|
| `X402_PRIVATE_KEY` | — | 0x-prefixed private key of the hot wallet (or `X402_PRIVATE_KEY_FILE` = path to a file holding it). Without it, tools return a `payment_required` error with the price |
| `X402_MAX_PAYMENT_USD` | `0.02` | per-call cap: a 402 asking for more is refused before signing |
| `X402_BASE_URL` | `https://x402-markettwits-news.onrender.com` | API base URL |
| `X402_TOOLS_SOURCE` | `auto` | `auto` = tools from the live `/openapi.json` (new endpoints appear automatically), falling back to the bundled snapshot; `bundled` / `live` force one |
| `X402_NETWORK` | `eip155:8453` | `eip155:84532` (Base Sepolia) for a testnet deployment |

## Claude Desktop
`claude_desktop_config.json` (Settings → Developer → Edit Config):
```json
{
  "mcpServers": {
    "markettwits": {
      "command": "npx",
      "args": ["-y", "x402-markettwits-mcp"],
      "env": { "X402_PRIVATE_KEY": "0x...", "X402_MAX_PAYMENT_USD": "0.02" }
    }
  }
}
```

## Cursor
`~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):
```json
{
  "mcpServers": {
    "markettwits": {
      "command": "npx",
      "args": ["-y", "x402-markettwits-mcp"],
      "env": { "X402_PRIVATE_KEY": "0x..." }
    }
  }
}
```

## Claude Code
```bash
claude mcp add markettwits --env X402_PRIVATE_KEY=0x... -- npx -y x402-markettwits-mcp
```

## Docker
```bash
docker build -t x402-markettwits-mcp .
docker run -i --rm -e X402_PRIVATE_KEY x402-markettwits-mcp
```

## Tools
| Tool | Endpoint | Price |
|---|---|---|
| `get_latest_news` / `get_important_news` / `search_news` | `/news/latest`, `/news/important`, `/news/search` | $0.0015 |
| `get_news_since` | `/news/since` (cursor polling) | $0.001 |
| `check_news_alert` / `check_new_high_alert` | `/news/alerts/check`, `/news/alerts/new` | $0.002 / $0.0025 |
| `summarize_news` / `summarize_recent_news` | `/news/summary`, `/news/summary/recent` | $0.004 / $0.0035 |
| `get_top_topics` / `get_trending_topics` | `/news/top-topics`, `/news/topics/trending` | $0.0025 / $0.002 |
| `get_news_movers` / `get_country_news` | `/news/movers`, `/news/country` | $0.0025 / $0.002 |
| `get_data_surprises` / `get_news_sentiment` / `get_news_digest` | `/news/data-surprises`, `/news/sentiment`, `/news/digest` | $0.003 / $0.0025 / $0.005 |
| `get_cbr_fx_rates` / `get_cbr_key_rate` | `/ru/fx`, `/ru/key-rate` | $0.001 |
| `get_moex_quote` / `get_moex_index` / `get_moex_movers` | `/moex/quote`, `/moex/index`, `/moex/movers` (delayed ~15 min) | $0.0015 / $0.0015 / $0.002 |
| `get_ru_fuel_prices` | `/ru/fuel` (Rosstat weekly) | $0.0015 |
| `get_telegram_channel_latest` / `search_telegram_channels` | `/tg/channel/latest`, `/tg/search` | $0.002 / $0.003 |
| `get_product_info` / `compare_products` / `monitor_product_price` / `get_product_price_history` | `/product/*` (Wildberries) | $0.002 / $0.003 / $0.0025 / $0.002 |

Each tool returns JSON: `{ ok: true, endpoint, data, payment: { price_usd, transaction, payer, ... } }`, or
`{ ok: false, error, ... }` with `isError: true`. The error codes are:
- `payment_required`: no key
- `price_above_cap`
- `invalid_params`: 400
- `not_found`: 404
- `upstream_unavailable`: 502
- `payment_rejected`: e.g. insufficient USDC
- `config_error`
- `network_error`

## Development
```bash
npm ci
npm test       # tools/list over MCP + mocked 402 flow (no real payments)
npm run gen    # refresh openapi.snapshot.json from the live API
```
