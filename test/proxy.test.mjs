import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { parseProxyEnv, maskSecrets, describeProxy, proxyDispatcher, undiciFetch } from "../proxy-config.mjs";

test("no proxy by default", () => {
  const c = parseProxyEnv({});
  assert.equal(c.configured, false); assert.deepEqual([...c.scope], ["wb", "ozon"]); assert.equal(c.fallbackDirect, true);
  assert.equal(describeProxy(c), "off");
});
test("PROXY_URL parsing (http/https/socks5) and priority", () => {
  const c = parseProxyEnv({ PROXY_URL: "http://us%40er:p%3Ass@1.2.3.4:3128", PROXY_HOST: "9.9.9.9" });
  assert.equal(c.configured, true); assert.equal(c.scheme, "http"); assert.equal(c.host, "1.2.3.4"); assert.equal(c.port, "3128");
  assert.equal(c.username, "us@er"); assert.equal(c.password, "p:ss");
  assert.equal(parseProxyEnv({ PROXY_URL: "https://h.example:8443" }).scheme, "https");
  const s = parseProxyEnv({ PROXY_URL: "socks5://u:p@h.example" });
  assert.equal(s.scheme, "socks5"); assert.equal(s.port, "1080");
  assert.match(parseProxyEnv({ PROXY_URL: "ftp://h:1" }).error, /unsupported/);
  assert.equal(parseProxyEnv({ PROXY_URL: "not a url" }).configured, false);
});
test("PROXY_HOST/PORT/USER/PASS, scope and fallback flags", () => {
  const c = parseProxyEnv({ PROXY_HOST: "5.6.7.8", PROXY_PORT: "8080", PROXY_USER: "bob", PROXY_PASS: "s3cr3t/+", PROXY_SCOPE: "wb", PROXY_FALLBACK_DIRECT: "false" });
  assert.deepEqual([c.scheme, c.host, c.port, c.username, c.password], ["http", "5.6.7.8", "8080", "bob", "s3cr3t/+"]);
  assert.deepEqual([...c.scope], ["wb"]); assert.equal(c.fallbackDirect, false);
  assert.equal(parseProxyEnv({ PROXY_HOST: "socks5://5.6.7.8:1081" }).scheme, "socks5");
  assert.equal(parseProxyEnv({ PROXY_HOST: "5.6.7.8" }).port, "3128");
  assert.equal(parseProxyEnv({ PROXY_FALLBACK_DIRECT: "0" }).fallbackDirect, false);
  assert.equal(parseProxyEnv({ PROXY_FALLBACK_DIRECT: "yes" }).fallbackDirect, true);
});
test("masking never leaks credentials or host", () => {
  const c = parseProxyEnv({ PROXY_URL: "http://alice:Sup3rSecret@10.1.2.3:3128" });
  const m = maskSecrets("connect http://alice:Sup3rSecret@10.1.2.3:3128 failed; pass=Sup3rSecret user alice host 10.1.2.3", c);
  for (const leak of ["Sup3rSecret", "alice", "10.1.2.3"]) assert.ok(!m.includes(leak), m);
  assert.match(m, /\*\*\*:\*\*\*@/);
  assert.ok(!describeProxy(c).includes("alice") && !describeProxy(c).includes("10.1.2.3"));
});
test("http proxy dispatcher sends Basic auth through a CONNECT tunnel", async () => {
  const target = http.createServer((req, res) => res.end("hello via " + req.url)).listen(0, "127.0.0.1");
  let auth = null;
  const proxy = http.createServer((_q, r) => r.writeHead(405).end()).listen(0, "127.0.0.1");
  proxy.on("connect", (req, sock, head) => {
    auth = req.headers["proxy-authorization"] || null;
    if (auth !== "Basic " + Buffer.from("u:p@ss").toString("base64")) { sock.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n"); return; }
    const [h, port] = req.url.split(":");
    const up = net.connect(Number(port), h, () => { sock.write("HTTP/1.1 200 Connection Established\r\n\r\n"); up.write(head); up.pipe(sock); sock.pipe(up); });
  });
  await Promise.all([new Promise((r) => target.on("listening", r)), new Promise((r) => proxy.on("listening", r))]);
  const cfg = parseProxyEnv({ PROXY_URL: `http://u:p%40ss@127.0.0.1:${proxy.address().port}` });
  const res = await undiciFetch(`http://127.0.0.1:${target.address().port}/x`, { dispatcher: proxyDispatcher(cfg) });
  assert.equal(await res.text(), "hello via /x");
  assert.ok(auth?.startsWith("Basic "));
  await proxyDispatcher(cfg).close(); target.close(); proxy.close();
});

import { errText } from "../product.mjs";
test("errText surfaces proxy CONNECT status from the undici cause chain", () => {
  const inner = Object.assign(new Error("Proxy response (407) !== 200 when HTTP Tunneling"), { code: "UND_ERR_ABORTED" });
  const e = new TypeError("fetch failed", { cause: new Error("Request was cancelled.", { cause: inner }) });
  assert.match(errText(e), /proxy CONNECT rejected with HTTP 407 \(proxy auth failed\)/);
  assert.equal(errText(Object.assign(new Error("x"), { name: "TimeoutError" })), "timeout");
});
