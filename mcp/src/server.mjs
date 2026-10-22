// MCP server: one tool per paid endpoint of the x402 MarketTwits / RU market data API.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readConfig, createPayer, toToolResult } from "./x402.mjs";
import { loadSpec, specToTools, buildUrl } from "./tools.mjs";

export const VERSION = "0.1.0";

/**
 * createServer({env, fetchImpl, log}) -> { server, tools, config, address, specSource }
 * fetchImpl is used both for the OpenAPI lookup and for paid calls (tests pass a mock).
 */
export async function createServer({ env = process.env, fetchImpl = globalThis.fetch, log = (m) => process.stderr.write(`[x402-markettwits-mcp] ${m}\n`) } = {}) {
  const config = readConfig(env);
  const payer = createPayer({ ...config, fetchImpl });
  const mode = (env.X402_TOOLS_SOURCE || "auto").toLowerCase();
  const { spec, source } = await loadSpec({ baseUrl: config.baseUrl, mode, fetchImpl, log });
  const tools = specToTools(spec);

  const server = new McpServer({ name: "x402-markettwits-mcp", version: VERSION }, {
    instructions: "Paid market data tools (MarketTwits news in English, Bank of Russia FX/key rate, MOEX quotes/indices/movers, " +
      "Rosstat fuel prices, public Telegram channels, Wildberries product prices). Every call costs a fixed small amount of USDC " +
      "on Base (see each tool's description), paid automatically from the configured wallet; failed calls (400/404/502) are free. " +
      "Prefer the cheapest tool that answers the question; do not call tools in tight loops.",
  });

  for (const t of tools) {
    server.registerTool(t.name, {
      title: t.title,
      description: t.description,
      inputSchema: t.inputShape,
      annotations: { title: t.title, readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, async (args) => {
      const url = buildUrl(config.baseUrl, t.path, args || {});
      let out;
      try { out = toToolResult(await payer.request(url), { endpoint: t.path }); }
      catch (e) { out = toToolResult(e, { endpoint: t.path }); }
      if (out.json.payment?.transaction) log(`${t.name}: paid $${out.json.payment.price_usd} tx ${out.json.payment.transaction}`);
      return { isError: out.isError, content: [{ type: "text", text: JSON.stringify(out.json, null, 2) }] };
    });
  }

  log(`${tools.length} tools from ${source} OpenAPI; base ${config.baseUrl}; network ${config.network}; cap $${config.maxUsd}/call; ` +
    (payer.address ? `wallet ${payer.address}` : config.problems.length ? "no valid wallet" : "no wallet (X402_PRIVATE_KEY unset): paid calls return payment_required") +
    (config.problems.length ? `; CONFIG PROBLEMS: ${config.problems.join("; ")}` : ""));
  return { server, tools, config, address: payer.address, specSource: source };
}
