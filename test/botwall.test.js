"use strict";

/**
 * Bot walls: Prism must recognise them (never render a dead "Just a moment…"
 * page as if it were the site) and must not misfire on ordinary pages that
 * merely mention Cloudflare.
 */

const test = require("node:test");
const assert = require("node:assert");
const vm = require("vm");
const { detect, blockPage, PAGE_PROBE } = require("../lib/botwall");

const CLOUDFLARE_CHALLENGE = `<!DOCTYPE html><html><head><title>Just a moment...</title>
<meta http-equiv="refresh" content="390"></head><body>
<div id="challenge-stage"><div id="challenge-form">
<h2>Checking your browser before accessing example.com</h2>
</div></div>
<script>window._cf_chl_opt={cvId:'3',cType:'managed'};</script>
</body></html>`;

const CLOUDFLARE_BLOCK = `<!DOCTYPE html><html><head><title>Access denied | example.com</title></head>
<body><h1>Access denied</h1><p>Error code 1020</p><p>Cloudflare Ray ID: 7f3a</p>
<div id="cf-error-details">You have been blocked</div></body></html>`;

const TURNSTILE = `<html><head><title>Attention Required! | Cloudflare</title></head>
<body><h1>Verify you are human</h1><div class="cf-turnstile"></div>
<p>Enable JavaScript and cookies to continue</p></body></html>`;

test("detects a Cloudflare interstitial from the body alone", () => {
  assert.equal(detect({ status: 403, text: CLOUDFLARE_CHALLENGE }), "Cloudflare");
  assert.equal(detect({ status: 503, text: CLOUDFLARE_CHALLENGE }), "Cloudflare");
});

test("detects the cf-mitigated challenge header even with an unusual body", () => {
  assert.equal(
    detect({ status: 403, headers: { "cf-mitigated": "challenge" }, text: "<html>wait</html>" }),
    "Cloudflare"
  );
});

test("detects an outright Cloudflare block (error 1020)", () => {
  assert.equal(
    detect({ status: 403, headers: { "cf-ray": "7f3a-SYD" }, text: CLOUDFLARE_BLOCK }),
    "Cloudflare"
  );
});

test("detects a Turnstile interstitial", () => {
  assert.equal(detect({ status: 403, text: TURNSTILE }), "Cloudflare");
});

test("detects other vendors", () => {
  assert.equal(
    detect({
      status: 403,
      headers: { "x-iinfo": "9-12345" },
      text: "<html><title>Pardon our interruption</title><body>_Incapsula_Resource</body></html>",
    }),
    "Imperva"
  );
  assert.equal(
    detect({ status: 429, text: "<title>Access to this page has been denied</title> px-captcha" }),
    "PerimeterX"
  );
  assert.equal(
    detect({ status: 403, text: "<div>captcha-delivery.com</div><p>geo.captcha-delivery</p>" }),
    "DataDome"
  );
});

test("leaves normal pages alone, including ones about Cloudflare", () => {
  const article = `<html><head><title>How Cloudflare works</title></head><body>
  <h1>How Cloudflare works</h1><p>Cloudflare sits in front of a site and checks each request.
  It can show a page that says "just a moment" while it verifies you. Error code 1020 means a
  blocked IP. Verify you are human prompts are challenges.</p>
  <pre>cf_chl_opt</pre></body></html>`;

  assert.equal(detect({ status: 200, headers: { "content-type": "text/html" }, text: article }), null);
  assert.equal(detect({ status: 200, text: "<html><title>Example</title><body>Hello</body></html>" }), null);
  assert.equal(detect({ status: 404, text: "<html><title>Not found</title></html>" }), null);
});

test("a 200 page with a single weak signature is not a wall", () => {
  assert.equal(detect({ status: 200, text: "<p>we use cf-error-details in our docs</p>" }), null);
});

test("the block page explains the situation and tells the UI", () => {
  const html = blockPage("Cloudflare", "https://www.reddit.com/r/all", { liveAvailable: true });
  assert.match(html, /Cloudflare is blocking the proxy/);
  assert.match(html, /Live mode/);
  assert.match(html, /www\.reddit\.com/);
  assert.match(html, /prism-blocked/);
  assert.match(html, /vendor:"Cloudflare"/);

  // without Live mode it hands over the download instead of a terminal command,
  // served same-origin so nothing navigates away to GitHub
  const offline = blockPage("Cloudflare", "https://www.reddit.com/", { liveAvailable: false });
  assert.match(offline, /Download for Mac/);
  assert.match(offline, /href="\/download\/mac"/);
  assert.match(offline, /href="\/download\/windows"/);
  assert.doesNotMatch(offline, /github\.com/);
});

test("the in-page probe recognises a challenge the live browser lands on", () => {
  const run = (title, body, href) => {
    const sandbox = {
      document: { title, body: { innerText: body } },
      location: { href },
      RegExp,
      JSON,
    };
    sandbox.window = sandbox;
    return vm.runInNewContext(PAGE_PROBE, sandbox);
  };

  assert.equal(run("Just a moment...", "Checking your browser before accessing", "https://x.com/"), "Cloudflare");
  assert.equal(run("Access denied", "Error code 1020", "https://x.com/"), "Cloudflare");
  assert.equal(run("Example Domain", "This domain is for use in examples.", "https://example.com/"), "");
  assert.equal(run("", "", "https://example.com/"), "");
});
