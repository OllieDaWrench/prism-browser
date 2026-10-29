"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { parseTarget, proxyPath, hostPrefix, rewriteHtml, rewriteCss, assertSafe } = require("../lib/proxy");

test("parseTarget understands the path mapping", () => {
  assert.equal(parseTarget("/https/example.com/a/b?x=1"), "https://example.com/a/b?x=1");
  assert.equal(parseTarget("/http/example.com:8080/"), "http://example.com:8080/");
  assert.equal(parseTarget("/https/example.com"), "https://example.com");
  assert.equal(parseTarget("/https/example.com?q=hi"), "https://example.com?q=hi");
});

test("parseTarget still accepts the older /p/<base64> form", () => {
  const b64 = Buffer.from("https://example.com/x?y=1").toString("base64url");
  assert.equal(parseTarget(`/p/${b64}`), "https://example.com/x?y=1");
});

test("parseTarget rejects non-targets", () => {
  assert.equal(parseTarget("/"), null);
  assert.equal(parseTarget("/live/ws"), null);
  assert.equal(parseTarget("/app.js"), null);
});

test("proxyPath round-trips", () => {
  const url = "https://news.ycombinator.com/item?id=1#top";
  assert.equal(proxyPath(url), "/https/news.ycombinator.com/item?id=1#top");
  assert.equal(parseTarget(proxyPath(url)), url);
});

test("hostPrefix scopes cookies per target host", () => {
  assert.equal(hostPrefix("https://example.com/a"), "/https/example.com");
  assert.equal(hostPrefix("http://example.com:8080/"), "/http/example.com:8080");
});

test("html rewriting maps relative, root-relative and same-origin urls", () => {
  const html = rewriteHtml(
    `<html><head><link href="/style.css"><script src="app.js"></script>
     <meta http-equiv="Content-Security-Policy" content="default-src 'none'">
     <base href="https://elsewhere.example/">
     </head><body>
     <img src="https://example.com/logo.png" integrity="sha384-abc">
     <img src="https://cdn.other.com/x.png">
     <a href="//example.com/two">two</a>
     <form action="/submit"></form>
     <div style="background:url(/bg.png)"></div>
     </body></html>`,
    "https://example.com/dir/page?q=1"
  );

  assert.match(html, /href="\/https\/example\.com\/style\.css"/);
  assert.match(html, /src="\/https\/example\.com\/dir\/app\.js"/);
  assert.match(html, /src="\/https\/example\.com\/logo\.png"/);
  assert.match(html, /href="\/https\/example\.com\/two"/);
  assert.match(html, /action="\/https\/example\.com\/submit"/);
  assert.match(html, /url\(\/https\/example\.com\/bg\.png\)/);
  // cross-origin assets are left alone so they load straight from their CDN
  assert.match(html, /src="https:\/\/cdn\.other\.com\/x\.png"/);
  // framing / integrity / base policy is removed
  assert.doesNotMatch(html, /Content-Security-Policy/);
  assert.doesNotMatch(html, /<base/i);
  assert.doesNotMatch(html, /integrity=/);
  // shim is injected
  assert.match(html, /data-prism="shim"/);
});

test("srcset is rewritten per candidate", () => {
  const html = rewriteHtml(
    `<img srcset="/a.png 1x, /b.png 2x">`,
    "https://example.com/"
  );
  assert.match(html, /srcset="\/https\/example\.com\/a\.png 1x, \/https\/example\.com\/b\.png 2x"/);
});

test("css rewriting resolves against the stylesheet url", () => {
  const css = rewriteCss(
    `@import "/reset.css"; .a{background:url(../img/a.png)} .b{background:url(https://cdn.other.com/b.png)} .c{background:url(data:image/png;base64,AA==)}`,
    "https://example.com/css/site/main.css"
  );
  assert.match(css, /@import "\/https\/example\.com\/reset\.css"/);
  assert.match(css, /url\(\/https\/example\.com\/css\/img\/a\.png\)/);
  assert.match(css, /url\(https:\/\/cdn\.other\.com\/b\.png\)/);
  assert.match(css, /url\(data:image\/png;base64,AA==\)/);
});

test("rewriting leaves script bodies and weird protocols alone", () => {
  const html = rewriteHtml(
    `<a href="javascript:void(0)">x</a><a href="#hash">y</a><img src="data:image/gif;base64,AAA">`,
    "https://example.com/"
  );
  assert.match(html, /href="javascript:void\(0\)"/);
  assert.match(html, /href="#hash"/);
  assert.match(html, /src="data:image\/gif;base64,AAA"/);
});

test("proxyPath of a relative-ish value is unchanged", () => {
  assert.equal(proxyPath("not a url"), "not a url");
});

test("the SSRF guard rejects local addresses by default", async () => {
  const previous = process.env.PRISM_ALLOW_PRIVATE;
  delete process.env.PRISM_ALLOW_PRIVATE;
  await assert.rejects(() => assertSafe("http://127.0.0.1:8080/"), /private|blocked/i);
  await assert.rejects(() => assertSafe("http://localhost/"), /blocked/i);
  await assert.rejects(() => assertSafe("http://169.254.169.254/latest/meta-data/"), /blocked|private/i);
  await assert.rejects(() => assertSafe("file:///etc/passwd"), /http/i);
  process.env.PRISM_ALLOW_PRIVATE = "1";
  assert.equal((await assertSafe("http://127.0.0.1:8080/")).href, "http://127.0.0.1:8080/");
  if (previous === undefined) delete process.env.PRISM_ALLOW_PRIVATE;
  else process.env.PRISM_ALLOW_PRIVATE = previous;
});
