"use strict";

/**
 * Boots the real Prism server against a throwaway origin and checks the whole
 * load path: markup rewriting, cookie scoping, redirects, POST bodies, binary
 * passthrough, websocket tunnelling and the engine status endpoint.
 */

process.env.PRISM_ALLOW_PRIVATE = "1";
process.env.PRISM_NO_LIVE = "1";
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const { upgrade } = require("../lib/ws");

let originServer;
let origin;
let prismServer;
let prism;
let target;

function startOrigin() {
  originServer = http.createServer((req, res) => {
    const url = new URL(req.url, "http://origin.test");
    if (url.pathname === "/") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Set-Cookie", "sid=abc; Path=/; Domain=origin.test; HttpOnly; SameSite=None; Secure");
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
      res.end(`<html><head><link rel=stylesheet href="/s.css"><script src="js/app.js"></script></head>
        <body><a href="/next">next</a><img src="pic.png"></body></html>`);
      return;
    }
    if (url.pathname === "/s.css") {
      res.setHeader("Content-Type", "text/css");
      res.end(".a{background:url(/bg.png)}");
      return;
    }
    if (url.pathname === "/redir") {
      res.writeHead(302, { Location: "/next" });
      res.end();
      return;
    }
    if (url.pathname === "/echo") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ body, cookie: req.headers.cookie || "", origin: req.headers.origin || "" }));
      });
      return;
    }
    if (url.pathname === "/blob") {
      res.setHeader("Content-Type", "application/octet-stream");
      res.end(Buffer.alloc(1024, 3));
      return;
    }
    res.statusCode = 404;
    res.end("nope");
  });

  originServer.on("upgrade", (req, socket, head) => {
    upgrade(req, socket, head, (conn) => {
      conn.onJSON((msg) => conn.send(JSON.stringify({ echo: msg })));
    });
  });

  return new Promise((resolve) => {
    originServer.listen(0, "127.0.0.1", () => {
      origin = `http://127.0.0.1:${originServer.address().port}`;
      resolve();
    });
  });
}

test.before(async () => {
  await startOrigin();
  const { start } = require("../server");
  const port = await start(0, "127.0.0.1");
  prism = `http://127.0.0.1:${port}`;
  target = `${prism}/http/127.0.0.1:${originServer.address().port}`;
});

test.after(async () => {
  originServer?.closeAllConnections?.();
  originServer?.close();
  const { server, browser } = require("../server");
  browser.stop();
  await new Promise((resolve) => server.close(resolve));
});

test("serves the app shell", async () => {
  const res = await fetch(prism + "/");
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /id="omnibox"/);
  assert.match(html, /live/);
});

test("rewrites a page and strips framing policy", async () => {
  const res = await fetch(target + "/");
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /href="\/http\/127\.0\.0\.1:\d+\/s\.css"/);
  assert.match(html, /src="\/http\/127\.0\.0\.1:\d+\/js\/app\.js"/);
  assert.match(html, /href="\/http\/127\.0\.0\.1:\d+\/next"/);
  assert.match(html, /src="\/http\/127\.0\.0\.1:\d+\/pic\.png"/);
  assert.match(html, /data-prism="shim"/);
  assert.equal(res.headers.get("x-frame-options"), null);
  assert.equal(res.headers.get("content-security-policy"), null);

  // cookies are re-scoped to the target's path bubble, Secure/SameSite=None dropped on http
  const cookie = res.headers.get("set-cookie");
  assert.match(cookie, /sid=abc/);
  assert.match(cookie, /Path=\/http\/127\.0\.0\.1:\d+/);
  assert.doesNotMatch(cookie, /Domain=/i);
  assert.doesNotMatch(cookie, /SameSite=None/i);
});

test("rewrites stylesheets", async () => {
  const res = await fetch(target + "/s.css");
  const css = await res.text();
  assert.match(css, /url\(\/http\/127\.0\.0\.1:\d+\/bg\.png\)/);
});

test("turns upstream redirects into local ones", async () => {
  const res = await fetch(target + "/redir", { redirect: "manual" });
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location"), /^\/http\/127\.0\.0\.1:\d+\/next$/);
});

test("forwards POST bodies and rewrites the origin header", async () => {
  const res = await fetch(target + "/echo", {
    method: "POST",
    headers: { "Content-Type": "text/plain", Origin: prism, Cookie: "sid=abc" },
    body: "payload",
  });
  const json = await res.json();
  assert.equal(json.body, "payload");
  assert.equal(json.cookie, "sid=abc");
  assert.equal(json.origin, origin);
});

test("streams binary bodies untouched", async () => {
  const res = await fetch(target + "/blob");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/octet-stream");
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.length, 1024);
  assert.equal(buf[0], 3);
});

test("keeps upstream error status codes", async () => {
  const res = await fetch(target + "/missing");
  assert.equal(res.status, 404);
});

test("supports the legacy query form and /p/ form", async () => {
  const viaQuery = await fetch(`${prism}/proxy?url=${encodeURIComponent(origin + "/")}`);
  assert.equal(viaQuery.status, 200);
  const b64 = Buffer.from(origin + "/").toString("base64url");
  const viaPath = await fetch(`${prism}/p/${b64}`);
  assert.equal(viaPath.status, 200);
});

test("tunnels websockets through /ws/", async () => {
  const wsUrl = `ws://127.0.0.1:${new URL(prism).port}/ws/http/127.0.0.1:${originServer.address().port}/socket`;
  const result = await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => reject(new Error("websocket tunnel timed out")), 5000);
    ws.addEventListener("open", () => ws.send(JSON.stringify({ hi: 1 })));
    ws.addEventListener("message", (event) => {
      clearTimeout(timer);
      ws.close();
      resolve(JSON.parse(event.data));
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("websocket tunnel failed"));
    });
  });
  assert.deepEqual(result, { echo: { hi: 1 } });
});

test("reports live engine status", async () => {
  const res = await fetch(prism + "/live/status");
  const json = await res.json();
  assert.equal(json.engine, "live");
  assert.equal(typeof json.available, "boolean");
  if (!json.available) assert.ok(json.reason);
});

test("health check", async () => {
  const res = await fetch(prism + "/healthz");
  assert.deepEqual((await res.json()).ok, true);
});

test("script navigations to root-relative paths are recovered via the referer", async () => {
  const res = await fetch(prism + "/settings/profile?tab=1", {
    redirect: "manual",
    headers: {
      Accept: "text/html,application/xhtml+xml",
      Referer: `${target}/some/deep/page`,
    },
  });
  assert.equal(res.status, 302);
  assert.match(
    res.headers.get("location"),
    /^\/http\/127\.0\.0\.1:\d+\/settings\/profile\?tab=1$/
  );
});

test("unknown addresses get a Prism error page, not an express stack trace", async () => {
  const res = await fetch(prism + "/definitely-not-a-page");
  assert.equal(res.status, 404);
  const html = await res.text();
  assert.match(html, /Prism proxy/);
  assert.doesNotMatch(html, /Cannot GET/);
});
