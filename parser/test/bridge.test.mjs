import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import { startBridge, denied, DEFAULT_DENY } from "../bridge.mjs";

// Minimal SOCKS5 server with username/password auth (RFC 1928/1929), CONNECT only.
function socks5Server(user, pass) {
  const seen = [];
  const srv = net.createServer((c) => {
    c.once("data", (g) => {
      assert.equal(g[0], 5); c.write(Buffer.from([5, 2]));
      c.once("data", (a) => {
        const ul = a[1], u = a.subarray(2, 2 + ul).toString(), pl = a[2 + ul], p = a.subarray(3 + ul, 3 + ul + pl).toString();
        const ok = u === user && p === pass; c.write(Buffer.from([1, ok ? 0 : 1])); if (!ok) return c.end();
        c.once("data", (r) => {
          let host, i = 4;
          if (r[3] === 3) { const l = r[4]; host = r.subarray(5, 5 + l).toString(); i = 5 + l; } else { host = [...r.subarray(4, 8)].join("."); i = 8; }
          const port = r.readUInt16BE(i); seen.push(`${host}:${port}`);
          const up = net.connect(port, "127.0.0.1", () => { c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); up.pipe(c); c.pipe(up); });
          up.on("error", () => c.destroy());
        });
      });
    });
  });
  return { srv, seen };
}
const connectVia = (bridgePort, target) => new Promise((resolve, reject) => {
  const req = http.request({ host: "127.0.0.1", port: bridgePort, method: "CONNECT", path: target });
  req.on("connect", (res, sock) => resolve({ status: res.statusCode, sock })); req.on("error", reject); req.end();
});

test("bridge tunnels CONNECT through an authenticated SOCKS5 upstream", async () => {
  const echo = net.createServer((s) => s.pipe(s)); await new Promise((r) => echo.listen(0, "127.0.0.1", r));
  const { srv, seen } = socks5Server("u-sid-1", "secret!"); await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const br = await startBridge({ host: "127.0.0.1", port: srv.address().port, username: "u-sid-1", password: "secret!" });
  try {
    const { status, sock } = await connectVia(br.port, `echo.test:${echo.address().port}`);
    assert.equal(status, 200);
    sock.write("ping"); const got = await new Promise((r) => sock.once("data", (d) => r(d.toString()))); sock.destroy();
    assert.equal(got, "ping"); assert.deepEqual(seen, [`echo.test:${echo.address().port}`]); // hostname forwarded (remote DNS, socks5h)
    assert.equal(br.url.startsWith("http://127.0.0.1:"), true);
  } finally { await br.close(); srv.close(); echo.close(); }
});

test("bridge returns 502 when SOCKS5 auth fails, and refuses plain HTTP", async () => {
  const { srv } = socks5Server("u", "right"); await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const br = await startBridge({ host: "127.0.0.1", port: srv.address().port, username: "u", password: "wrong" });
  try {
    const { status, sock } = await connectVia(br.port, "example.com:443"); sock.destroy();
    assert.equal(status, 502);
    const code = await new Promise((r) => http.get({ host: "127.0.0.1", port: br.port, path: "http://example.com/" }, (res) => { res.resume(); r(res.statusCode); }));
    assert.equal(code, 501);
  } finally { await br.close(); srv.close(); }
});

test("bridge refuses Chromium background hosts (saves proxy traffic)", async () => {
  const list = DEFAULT_DENY.split(",");
  assert.equal(denied("update.googleapis.com", list), true); assert.equal(denied("accounts.google.com", list), true);
  assert.equal(denied("www.wildberries.ru", list), false); assert.equal(denied("notgoogle.com", list), false);
  const br = await startBridge({ host: "127.0.0.1", port: 9, username: "u", password: "p" });
  try { const { status, sock } = await connectVia(br.port, "accounts.google.com:443"); sock.destroy(); assert.equal(status, 403); }
  finally { await br.close(); }
});
