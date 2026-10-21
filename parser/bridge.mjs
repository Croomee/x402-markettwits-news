// Chromium cannot use a SOCKS5 proxy that requires username/password. This bridge listens on 127.0.0.1 as an
// unauthenticated HTTP CONNECT proxy and tunnels every CONNECT through the authenticated upstream SOCKS5 proxy.
// Bound to loopback only; plain-HTTP (non-CONNECT) requests are refused (WB/Ozon are HTTPS-only).
import http from "node:http";
import { SocksClient } from "socks";

export function startBridge(cfg, { port = 0, host = "127.0.0.1", timeoutMs = 20000, log = () => {} } = {}) {
  const server = http.createServer((req, res) => { res.writeHead(501, { "content-type": "text/plain" }); res.end("CONNECT only"); });
  server.on("connect", async (req, client, head) => {
    const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(req.url || "");
    if (!m) { client.end("HTTP/1.1 400 Bad Request\r\n\r\n"); return; }
    client.on("error", () => {});
    try {
      const { socket } = await SocksClient.createConnection({
        proxy: { host: cfg.host, port: Number(cfg.port), type: 5,
          ...(cfg.username ? { userId: cfg.username, password: cfg.password } : {}) },
        command: "connect", destination: { host: m[1], port: Number(m[2]) }, timeout: timeoutMs,
      });
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) socket.write(head);
      socket.pipe(client); client.pipe(socket);
      const end = () => { socket.destroy(); client.destroy(); };
      socket.on("error", end); socket.on("close", end); client.on("close", end);
    } catch (e) {
      log(`bridge: CONNECT ${m[1]}:${m[2]} failed: ${String(e?.message || e).slice(0, 120)}`);
      client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve({ server, port: server.address().port, url: `http://${host}:${server.address().port}`,
      close: () => new Promise((r) => server.close(() => r())) }));
  });
}
