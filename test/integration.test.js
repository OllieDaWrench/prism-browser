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
    if (url.pathname === "/challenged") {
      res.statusCode = 403;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("cf-mitigated", "challenge");
      res.setHeader("cf-ray", "8a1b2c3d-SYD");
      res.setHeader("Server", "cloudflare");
      res.end(`<!DOCTYPE html><html><head><title>Just a moment...</title></head>
        <body><h2>Checking your browser before accessing example.test</h2>
        <script>window._cf_chl_opt={cvId:"3"};</script></body></html>`);
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

test("serves the public homepage and keeps the browser shell on /app", async () => {
  const home = await fetch(prism + "/");
  assert.equal(home.status, 200);
  const landing = await home.text();
  assert.match(landing, /Web Browser/);
  assert.match(landing, /Apps/);
  assert.match(landing, /Games/);
  assert.match(landing, /Feedback/);
  assert.doesNotMatch(landing, /id="omnibox"/);

  const app = await fetch(prism + "/app");
  assert.equal(app.status, 200);
  const shell = await app.text();
  assert.match(shell, /id="omnibox"/);
  assert.match(shell, /live/);
});

test("local feedback submissions are written to the configured feedback file", async (t) => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const previousFile = process.env.PRISM_FEEDBACK_FILE;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-feedback-server-"));
  const file = path.join(dir, "feedback.jsonl");
  process.env.PRISM_FEEDBACK_FILE = file;
  t.after(() => {
    if (previousFile === undefined) delete process.env.PRISM_FEEDBACK_FILE;
    else process.env.PRISM_FEEDBACK_FILE = previousFile;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const res = await fetch(prism + "/api/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "A private integration note" }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.doesNotMatch(JSON.stringify(body), /private integration note/i);
  const entry = JSON.parse(fs.readFileSync(file, "utf8").trim());
  assert.equal(entry.message, "A private integration note");
  assert.ok(entry.createdAt);
});

test("a gated local browser is under construction for non-admins but available to admins", async (t) => {
  const auth = require("../lib/auth");
  const previousSecret = process.env.PRISM_AUTH_SECRET;
  const previousAuth = process.env.PRISM_AUTH;
  process.env.PRISM_AUTH_SECRET = "integration-admin-test-secret";
  process.env.PRISM_AUTH = "1";
  t.after(() => {
    if (previousSecret === undefined) delete process.env.PRISM_AUTH_SECRET;
    else process.env.PRISM_AUTH_SECRET = previousSecret;
    if (previousAuth === undefined) delete process.env.PRISM_AUTH;
    else process.env.PRISM_AUTH = previousAuth;
  });

  const publicHome = await fetch(prism + "/");
  assert.match(await publicHome.text(), /Web Browser/);

  const anonymous = await fetch(prism + "/app", { headers: { Accept: "text/html" } });
  assert.match(await anonymous.text(), /Under construction/);

  const userCookie = `prism_session=${auth.createSession({ number: "482913", role: "user" })}`;
  const user = await fetch(prism + "/app", { headers: { Cookie: userCookie, Accept: "text/html" } });
  assert.match(await user.text(), /Under construction/);

  const adminCookie = `prism_session=${auth.createSession({ number: "111222", role: "admin" })}`;
  const admin = await fetch(prism + "/app", { headers: { Cookie: adminCookie, Accept: "text/html" } });
  assert.match(await admin.text(), /id="omnibox"/);
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

test("Explains a Cloudflare challenge instead of rendering it", async () => {
  const res = await fetch(target + "/challenged");
  // the wall itself is a failed fetch, but Prism answers with its own page so
  // the user is not left staring at a dead "Just a moment..."
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-prism-blocked"), "Cloudflare");
  const html = await res.text();
  assert.match(html, /Cloudflare bot protection/);
  assert.match(html, /Live mode/);
  assert.match(html, /prism-blocked/);
  assert.doesNotMatch(html, /_cf_chl_opt/);
});

test("keeps upstream error status codes", async () => {
  const res = await fetch(target + "/missing");
  assert.equal(res.status, 404);
});

test("marks every proxy response so the UI can verify routing", async () => {
  const res = await fetch(target + "/");
  assert.equal(res.headers.get("x-prism-proxy"), "1");
  const rejected = await fetch(prism + "/https/!invalid!/");
  assert.equal(rejected.headers.get("x-prism-proxy"), "1");
});

test("serves the rewrite-free /api/proxy endpoint in query mode", async () => {
  const res = await fetch(`${prism}/api/proxy?url=${encodeURIComponent(origin + "/")}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-prism-proxy"), "1");
  const html = await res.text();
  // every emitted url stays on the endpoint that needs no rewrite rules
  assert.match(html, /href="\/api\/proxy\?url=http%3A%2F%2F127\.0\.0\.1%3A\d+%2Fnext"/);
  assert.match(html, /src="\/api\/proxy\?url=http%3A%2F%2F127\.0\.0\.1%3A\d+%2Fpic\.png"/);
});

test("query mode redirects stay inside the endpoint", async () => {
  const res = await fetch(`${prism}/api/proxy?url=${encodeURIComponent(origin + "/redir")}`, {
    redirect: "manual",
  });
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location"), /^\/api\/proxy\?url=http%3A%2F%2F127\.0\.0\.1%3A\d+%2Fnext$/);
});

test("path mode redirects stay path mapped", async () => {
  const res = await fetch(target + "/redir", { redirect: "manual" });
  assert.match(res.headers.get("location"), /^\/http\/127\.0\.0\.1:\d+\/next$/);
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

test("healthz identifies Prism so the launchers can find it on any port", async () => {
  const res = await fetch(prism + "/healthz");
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.prism, true);
  assert.match(json.version, /^\d+\.\d+\.\d+$/);
});

test("download links are same-origin and stream a file", async () => {
  // Put a bundle where scripts/package.sh would leave one, so this stays a real
  // end-to-end check without depending on the network.
  const fs = require("fs");
  const path = require("path");
  const { LOCAL_DIR } = require("../lib/downloads");
  const madeDir = !fs.existsSync(LOCAL_DIR);
  fs.mkdirSync(LOCAL_DIR, { recursive: true });
  const bundle = path.join(LOCAL_DIR, "Prism-macOS.zip");
  fs.writeFileSync(bundle, Buffer.concat([Buffer.from("PK\x03\x04", "latin1"), Buffer.alloc(512, 9)]));

  const res = await fetch(prism + "/download/mac");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition") || "", /attachment; filename="Prism-macOS.zip"/);
  assert.match(res.headers.get("content-type") || "", /zip/);
  const body = Buffer.from(await res.arrayBuffer());
  assert.equal(body.subarray(0, 2).toString("latin1"), "PK");
  assert.equal(body.length, 516);

  fs.rmSync(bundle, { force: true });
  if (madeDir) fs.rmSync(LOCAL_DIR, { recursive: true, force: true });
});

test("the browser shell points download buttons at /download", async () => {
  const html = await (await fetch(prism + "/app")).text();
  assert.match(html, /href="\/download\/mac"/);
  assert.match(html, /href="\/download\/windows"/);
  assert.doesNotMatch(html, /href="https:\/\/github\.com\/[^"]*releases/);
});

test("the macOS one-liner is served by the app itself", async () => {
  // Piping into bash needs the body, so this must be text/plain — never an
  // attachment, and never HTML.
  const res = await fetch(prism + "/install.sh");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/plain/);
  assert.doesNotMatch(res.headers.get("content-disposition") || "", /attachment/);
  const body = await res.text();
  assert.match(body, /^#!\/bin\/bash/);
  // it points back at this server, so a local install uses the local bundle
  assert.ok(body.includes(`ORIGIN="${prism}"`), "should fetch its bundle from this origin");
  assert.match(body, /BUNDLE_URL=.*\$ORIGIN\/download\/mac/);
  assert.doesNotMatch(body, /\bsudo\b/);
});

test("the browser shell offers the warning-free install for Macs", async () => {
  const html = await (await fetch(prism + "/app")).text();
  assert.match(html, /id="install-cmd"/);
  assert.match(html, /\/install\.sh \| bash/);
  assert.match(html, /copy-install/);
});

test("the app can hand a page to the user's own browser", async () => {
  // The reliable route past bot protection. Spawning is stubbed by the library's
  // own validation here: a bad address must be rejected before anything runs.
  const bad = await fetch(prism + "/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: "file:///etc/passwd" }),
  });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).ok, false);

  // and a cross-origin caller is refused outright
  const cross = await fetch(prism + "/open", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
    body: JSON.stringify({ url: "https://example.com/" }),
  });
  assert.equal(cross.status, 403);

  // nothing was launched for either
  const empty = await fetch(prism + "/open", { method: "POST" });
  assert.equal(empty.status, 400);
});
