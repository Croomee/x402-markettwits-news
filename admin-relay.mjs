// TEMPORARY verification aid: token-gated byte relay to the configured PROXY host:port ONLY (not an open relay).
// Lets an operator test the residential proxy from a network that cannot reach it directly. Removed after use.
import net from "node:net";
import crypto from "node:crypto";
export function attachProxyRelay(server, { tokenOk, proxyConfig }) {
  server.on("upgrade", (req, sock) => {
    const fail = (code) => { try { sock.end(`HTTP/1.1 ${code}\r\nConnection: close\r\n\r\n`); } catch {} };
    if (!req.url.startsWith("/admin/proxy-relay")) return fail("404 Not Found");
    if (!tokenOk(req.headers.authorization)) return fail("401 Unauthorized");
    const p = proxyConfig();
    if (!p.configured) return fail("404 Not Found");
    const up = net.connect(Number(p.port), p.host, () => {
      const acc = crypto.createHash("sha1").update(String(req.headers["sec-websocket-key"] || "") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acc}\r\n\r\n`);
      sock.pipe(up); up.pipe(sock);
    });
    up.setTimeout(120000, () => up.destroy()); sock.setTimeout(120000, () => sock.destroy());
    up.on("error", () => sock.destroy()); sock.on("error", () => up.destroy());
    up.on("close", () => sock.destroy()); sock.on("close", () => up.destroy());
  });
}
