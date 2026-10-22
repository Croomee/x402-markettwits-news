#!/usr/bin/env node
// stdio entry point: npx -y x402-markettwits-mcp
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, VERSION } from "./server.mjs";

if (process.argv.includes("--version")) { console.log(VERSION); process.exit(0); }
const { server } = await createServer();
await server.connect(new StdioServerTransport());
