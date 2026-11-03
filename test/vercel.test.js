"use strict";

/**
 * The hosted build has its own failure modes: rewrite rules that hand the
 * function a destination path, query parameters that arrive merged or split,
 * and deployments where the path rewrites simply never happen. These tests
 * pin the adapter and the config down so a deploy cannot silently 404.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const handler = require("../api/proxy");
const home = require("../api/auth/home");
const auth = require("../lib/auth");
const { rebuildUrl } = handler;
const { PROXY_MARKER_HEADER } = require("../lib/proxy");

const ROOT = path.join(__dirname, "..");

test("vercel.json routes every shape of request at the proxy", () => {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
  const sources = config.rewrites.map((r) => r.source);

  // The browser shell lives outside public/ and /app is handled by an
  // administrator-only function; the homepage remains public.
  assert.equal(sources[0], "/app");
  assert.equal(config.rewrites[0].destination, "/api/auth/home");
  const publicHome = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  const signInPage = fs.readFileSync(path.join(ROOT, "public", "gate.html"), "utf8");
  const privateApp = fs.readFileSync(path.join(ROOT, "private", "app.html"), "utf8");
  assert.notEqual(publicHome, signInPage, "the public homepage is separate from admin sign-in");
  assert.match(publicHome, /Web Browser/);
  assert.match(publicHome, /Apps/);
  assert.match(publicHome, /Games/);
  assert.match(publicHome, /disabled/);
  assert.match(publicHome, /Feedback/);
  assert.match(publicHome, /Admin sign-in/);
  assert.doesNotMatch(publicHome, /Six-digit number/);
  assert.match(privateApp, /Browse through Prism/);
  assert.match(fs.readFileSync(path.join(ROOT, "private", "web-under-construction.html"), "utf8"), /Under construction/);
  assert.equal(fs.existsSync(path.join(ROOT, "public", "app.html")), false, "the app shell is not a public static file");

  // api routes must short-circuit before the catch-all, or they would loop
  assert.equal(sources[1], "/api/:path*");
  assert.equal(config.rewrites[1].destination, "/api/:path*");
  assert.match(config.functions["api/auth/home.js"].includeFiles, /private\/\*\.html/);

  for (const source of ["/https/:path*", "/http/:path*", "/p/:path*", "/r/:path*"]) {
    assert.ok(sources.includes(source), `missing rewrite for ${source}`);
  }

  // the safety net: anything else goes to the proxy with its path attached
  const catchAll = config.rewrites[config.rewrites.length - 1];
  assert.equal(catchAll.source, "/(.*)");
  assert.equal(catchAll.destination, "/api/proxy?__path=$1");

  // static shell is served from public/
  assert.equal(config.outputDirectory, "public");
  // and the proxy function gets room for slow upstreams
  assert.equal(config.functions["api/proxy.js"].maxDuration, 60);
});

test("rebuildUrl turns a rewritten path back into a target url", () => {
  assert.equal(
    rebuildUrl("/api/proxy?__path=https/github.com/explore"),
    "/https/github.com/explore"
  );
  assert.equal(
    rebuildUrl("/api/proxy?__path=http%3A%2F%2Fexample.com%2Fa%2Fb"),
    "/http://example.com/a/b"
  );
});

test("rebuildUrl keeps the original query string, which arrives separately", () => {
  // Vercel merges the incoming query with the destination query, so a search
  // for "cats" must not be dropped on the floor.
  assert.equal(
    rebuildUrl("/api/proxy?__path=https/www.google.com/search&q=cats&hl=en"),
    "/https/www.google.com/search?q=cats&hl=en"
  );
  assert.equal(
    rebuildUrl("/api/proxy?__path=https/example.com/a%3Fb%3D1&c=2"),
    "/https/example.com/a?b=1&c=2"
  );
});

test("rebuildUrl leaves plain proxy requests alone", () => {
  const direct = "/api/proxy?url=" + encodeURIComponent("https://example.com/");
  assert.equal(rebuildUrl(direct), direct);
  assert.equal(rebuildUrl("/api/proxy"), "/api/proxy");
});

function fakeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    getHeader(k) {
      return this.headers[k.toLowerCase()];
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    end(body) {
      this.body = body === undefined ? "" : String(body);
      this.ended = true;
    },
    write(chunk) {
      this.body += String(chunk);
      return true;
    },
    on() {},
    once() {},
    emit() {},
  };
  return res;
}

function fakeReq(url, headers = {}) {
  return {
    method: "GET",
    url,
    headers: { host: "prism.vercel.app", "x-forwarded-proto": "https", ...headers },
    socket: {},
    [Symbol.asyncIterator]: async function* () {},
  };
}

test("the hosted browser route shows under construction unless the visitor is an admin", (t) => {
  const oldSecret = process.env.PRISM_AUTH_SECRET;
  const oldAuth = process.env.PRISM_AUTH;
  process.env.PRISM_AUTH_SECRET = "a-test-secret-long-enough";
  delete process.env.PRISM_AUTH;
  t.after(() => {
    if (oldSecret === undefined) delete process.env.PRISM_AUTH_SECRET;
    else process.env.PRISM_AUTH_SECRET = oldSecret;
    if (oldAuth === undefined) delete process.env.PRISM_AUTH;
    else process.env.PRISM_AUTH = oldAuth;
  });

  const anonymous = fakeRes();
  home(fakeReq("/"), anonymous);
  assert.equal(anonymous.statusCode, 200);
  assert.match(anonymous.body, /Under construction/);
  assert.doesNotMatch(anonymous.body, /Six-digit number/);
  assert.doesNotMatch(anonymous.body, /Browse through Prism/);

  const userSession = auth.createSession({ number: "482913", role: "user" });
  const signedInUser = fakeRes();
  home(fakeReq("/", { cookie: `prism_session=${userSession}` }), signedInUser);
  assert.match(signedInUser.body, /Under construction/);
  assert.doesNotMatch(signedInUser.body, /Browse through Prism/);

  const adminSession = auth.createSession({ number: "111222", role: "admin" });
  const admin = fakeRes();
  home(fakeReq("/", { cookie: `prism_session=${adminSession}` }), admin);
  assert.equal(admin.statusCode, 200);
  assert.match(admin.body, /Browse through Prism/);
  assert.doesNotMatch(admin.body, /Under construction/);
});

test("an ungated /app route still serves the local browser", (t) => {
  const oldSecret = process.env.PRISM_AUTH_SECRET;
  const oldAuth = process.env.PRISM_AUTH;
  delete process.env.PRISM_AUTH_SECRET;
  delete process.env.PRISM_AUTH;
  t.after(() => {
    if (oldSecret !== undefined) process.env.PRISM_AUTH_SECRET = oldSecret;
    if (oldAuth !== undefined) process.env.PRISM_AUTH = oldAuth;
  });

  const res = fakeRes();
  home(fakeReq("/"), res);
  assert.match(res.body, /Browse through Prism/);
});

test("a request with no target answers with Prism's own page, not a bare 404", async (t) => {
  const realFetch = global.fetch;
  t.after(() => {
    global.fetch = realFetch;
  });
  global.fetch = async () => {
    throw new Error("no network expected");
  };

  const res = fakeRes();
  await handler(fakeReq("/api/proxy"), res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.getHeader(PROXY_MARKER_HEADER), "1");
  assert.match(res.body, /Prism proxy/);
});

test("the adapter proxies a rewritten request and reports query-mode urls", async (t) => {
  const realFetch = global.fetch;
  const seen = [];
  t.after(() => {
    global.fetch = realFetch;
  });
  global.fetch = async (url) => {
    seen.push(url);
    return new Response('<html><head></head><body><a href="/next">next</a></body></html>', {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  };

  const res = fakeRes();
  await handler(fakeReq("/api/proxy?url=" + encodeURIComponent("https://example.com/start")), res);

  assert.deepEqual(seen, ["https://example.com/start"]);
  assert.equal(res.statusCode, 200);
  assert.equal(res.getHeader(PROXY_MARKER_HEADER), "1");
  // query mode keeps every link on the endpoint that definitely exists
  assert.match(res.body, /href="\/api\/proxy\?url=https%3A%2F%2Fexample\.com%2Fnext"/);
});

test("the adapter keeps path mode for rewritten paths so assets resolve relatively", async (t) => {
  const realFetch = global.fetch;
  t.after(() => {
    global.fetch = realFetch;
  });
  global.fetch = async () =>
    new Response('<html><head></head><body><a href="/next">next</a><img src="pic.png"></body></html>', {
      status: 200,
      headers: { "content-type": "text/html" },
    });

  const res = fakeRes();
  await handler(fakeReq("/api/proxy?__path=https/example.com/start"), res);

  assert.match(res.body, /href="\/https\/example\.com\/next"/);
  assert.match(res.body, /src="\/https\/example\.com\/pic\.png"/);
});
