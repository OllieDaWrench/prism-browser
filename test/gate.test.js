"use strict";

/**
 * The gate: who gets in, and what they see when they don't.
 *
 * Two rules matter, and both are easy to break by accident:
 *   - with no secret configured nothing is locked, because a local copy must run
 *   - a locked site hands a browser the sign-in page, never a bare 401
 */

const test = require("node:test");
const assert = require("node:assert");

const gate = require("../lib/gate");
const auth = require("../lib/auth");

const SECRET = "test-secret-that-is-long-enough";

function request(url, { cookie, accept, token } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (accept) headers.accept = accept;
  return { url: token ? `${url}?token=${token}` : url, headers, method: "GET" };
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    ended: false,
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value;
    },
    end(body) {
      this.body = body;
      this.ended = true;
    },
  };
}

function enable(t) {
  const previous = process.env.PRISM_AUTH_SECRET;
  const previousAuth = process.env.PRISM_AUTH;
  const previousVercel = process.env.VERCEL;
  process.env.PRISM_AUTH_SECRET = SECRET;
  delete process.env.PRISM_AUTH;
  delete process.env.VERCEL;
  t.after(() => {
    if (previous === undefined) delete process.env.PRISM_AUTH_SECRET;
    else process.env.PRISM_AUTH_SECRET = previous;
    if (previousAuth === undefined) delete process.env.PRISM_AUTH;
    else process.env.PRISM_AUTH = previousAuth;
    if (previousVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previousVercel;
  });
}

test("a local gate is off when no secret is configured", (t) => {
  const previous = process.env.PRISM_AUTH_SECRET;
  const previousVercel = process.env.VERCEL;
  delete process.env.PRISM_AUTH_SECRET;
  delete process.env.VERCEL;
  t.after(() => {
    if (previous !== undefined) process.env.PRISM_AUTH_SECRET = previous;
    if (previousVercel !== undefined) process.env.VERCEL = previousVercel;
  });

  assert.equal(gate.enabled(), false);
  const res = response();
  assert.equal(gate.check(request("/"), res), true, "a local copy keeps working");
  assert.equal(res.ended, false);
});

test("a hosted site always fails closed, even without a secret or with auth disabled", () => {
  assert.equal(gate.enabled({ VERCEL: "1" }), true);
  assert.equal(gate.enabled({ VERCEL: "1", PRISM_AUTH: "0" }), true);

  const res = response();
  assert.equal(gate.check(request("/", { accept: "text/html" }), res, { env: { VERCEL: "1" } }), false);
  assert.match(res.body, /Under construction/i);
});

test("PRISM_AUTH=0 switches the gate off even with a secret set", (t) => {
  enable(t);
  process.env.PRISM_AUTH = "0";
  assert.equal(gate.enabled(), false);

  process.env.PRISM_AUTH = "1";
  assert.equal(gate.enabled(), true);
});

test("an anonymous visitor to / gets the sign-in page, not an error", (t) => {
  enable(t);
  const res = response();
  assert.equal(gate.check(request("/", { accept: "text/html" }), res), false);
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /under construction/i);
});

test("an anonymous visitor at /login gets the same page, not a redirect loop", (t) => {
  enable(t);
  const res = response();
  assert.equal(gate.check(request("/login", { accept: "text/html" }), res), false);
  assert.equal(res.statusCode, 200, "serving the page is what breaks the loop");
  assert.match(res.body, /six-digit number/i);
});

test("an anonymous visitor to another page is sent to the sign-in page", (t) => {
  enable(t);
  const res = response();
  assert.equal(gate.check(request("/history", { accept: "text/html" }), res), false);
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, "/login");
});

test("an API caller gets 401 JSON instead of a page it cannot render", (t) => {
  enable(t);
  const res = response();
  assert.equal(gate.check(request("/api/proxy", { accept: "application/json" }), res), false);
  assert.equal(res.statusCode, 401);
  assert.equal(JSON.parse(res.body).ok, false);
});

test("a signed-in visitor is let through, and is moved off the sign-in page", (t) => {
  enable(t);
  const cookie = `prism_session=${auth.createSession({ number: "482913", role: "user" })}`;

  const app = response();
  assert.equal(gate.check(request("/", { cookie, accept: "text/html" }), app), true);
  assert.equal(app.ended, false);

  const login = response();
  assert.equal(gate.check(request("/login", { cookie, accept: "text/html" }), login), false);
  assert.equal(login.statusCode, 302);
  assert.equal(login.headers.location, "/");
});

test("a plain account cannot open the console; a manager can", (t) => {
  enable(t);
  const plain = `prism_session=${auth.createSession({ number: "482913", role: "user" })}`;
  const admin = `prism_session=${auth.createSession({ number: "111222", role: "admin" })}`;

  const refused = response();
  assert.equal(gate.check(request("/admin", { cookie: plain, accept: "text/html" }), refused, { adminOnly: true }), false);
  assert.equal(refused.statusCode, 403);

  const allowed = response();
  assert.equal(gate.check(request("/admin", { cookie: admin, accept: "text/html" }), allowed, { adminOnly: true }), true);
});

test("an install token does not open the site", (t) => {
  enable(t);
  const token = auth.createInstallToken({ number: "482913" });
  const res = response();
  assert.equal(gate.check(request("/", { cookie: `prism_session=${token}`, accept: "text/html" }), res), false);
  assert.match(res.body, /under construction/i, "they get the sign-in page, not the app");
});

test("downloads need a session or an install token", (t) => {
  enable(t);
  const token = auth.createInstallToken({ number: "482913" });

  assert.equal(gate.downloadAllowed(request("/download/mac")).ok, false, "nothing at all");
  assert.equal(gate.downloadAllowed(request("/download/mac", { token })).ok, true, "installer token");
  assert.equal(
    gate.downloadAllowed(request("/download/mac", { cookie: `prism_session=${auth.createSession({ number: "482913" })}` })).ok,
    true,
    "signed-in browser"
  );
  // the token is single-purpose in both directions
  assert.equal(gate.downloadAllowed(request("/download/mac", { cookie: `prism_session=${token}` })).ok, false);
  assert.equal(
    gate.downloadAllowed(request(`/download/mac?token=${auth.createSession({ number: "482913" })}`)).ok,
    false,
    "a session is not an install token"
  );
});

test("downloads stay open on a local copy when the gate is off", (t) => {
  const previous = process.env.PRISM_AUTH_SECRET;
  const previousVercel = process.env.VERCEL;
  delete process.env.PRISM_AUTH_SECRET;
  delete process.env.VERCEL;
  t.after(() => {
    if (previous !== undefined) process.env.PRISM_AUTH_SECRET = previous;
    if (previousVercel !== undefined) process.env.VERCEL = previousVercel;
  });
  assert.equal(gate.downloadAllowed(request("/download/mac")).ok, true);
});
