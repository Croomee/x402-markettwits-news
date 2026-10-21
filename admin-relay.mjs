// TEMPORARY verification aid: token-gated WebSocket byte relay to the configured PROXY host:port ONLY (not an open relay).
// Lets an operator test the residential proxy from a network that cannot reach it directly. Removed after use.
import net from "node:net";
import { WebSocketServer, createWebSocketStream } from "ws";
export function attachProxyRelay(server, { tokenOk, proxyConfig }) {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, sock, head) => {
    const fail = (code) => { try { sock.end(`HTTP/1.1 ${code}\r\nConnection: close\r\n\r\n`); } catch {} };
    if (!req.url.startsWith("/admin/proxy-relay")) return fail("404 Not Found");
    if (!tokenOk(req.headers.authorization)) return fail("401 Unauthorized");
    const p = proxyConfig();
    if (!p.configured) return fail("404 Not Found");
    wss.handleUpgrade(req, sock, head, (ws) => {
      const s = createWebSocketStream(ws);
      const up = net.connect(Number(p.port), p.host);
      s.pipe(up); up.pipe(s);
      up.setTimeout(120000, () => up.destroy());
      const end = () => { up.destroy(); s.destroy(); };
      up.on("error", end); s.on("error", end); up.on("close", end); s.on("close", end);
    });
  });
}
