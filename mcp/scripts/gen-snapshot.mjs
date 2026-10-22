// Refreshes openapi.snapshot.json (the offline fallback) from the live API: npm run gen
import fs from "node:fs";
import { slimSpec, specToTools } from "../src/tools.mjs";
const base = (process.env.X402_BASE_URL || "https://x402-markettwits-news.onrender.com").replace(/\/+$/, "");
const r = await fetch(`${base}/openapi.json`);
if (!r.ok) throw new Error(`HTTP ${r.status}`);
const slim = slimSpec(await r.json());
fs.writeFileSync(new URL("../openapi.snapshot.json", import.meta.url), JSON.stringify(slim, null, 2) + "\n");
console.log(`snapshot: ${specToTools(slim).length} paid tools from ${base}`);
