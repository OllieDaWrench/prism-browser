"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { DOWNLOADS, targetFor, sendAppDownload } = require("../lib/app-downloads");
const handler = require("../api/app-download");

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    end(body) { this.body = String(body || ""); this.ended = true; },
  };
}

function request(url, method = "GET") {
  return { url, method };
}

test("the catalog has direct official-file targets for each requested platform", () => {
  assert.match(targetFor("github-desktop", "mac-arm64"), /github\.com\/desktop\/desktop\/releases\/latest\/download\/GitHub\.Desktop-arm64\.zip$/);
  assert.match(targetFor("github-desktop", "mac-x64"), /GitHub\.Desktop-x64\.zip$/);
  assert.match(targetFor("github-desktop", "windows"), /GitHubDesktopSetup-x64\.exe$/);
  assert.match(targetFor("virtualbox", "mac-arm64"), /download\.virtualbox\.org\/virtualbox\/7\.2\.22\/VirtualBox-7\.2\.22-175245-macOSArm64\.dmg$/);
  assert.match(targetFor("virtualbox", "mac-x64"), /VirtualBox-7\.2\.22-175245-OSX\.dmg$/);
  assert.match(targetFor("virtualbox", "windows"), /VirtualBox-7\.2\.22-175245-Win\.exe$/);
  assert.match(targetFor("tor-browser", "mac"), /tor-browser-macos-16\.0\.dmg$/);
  assert.match(targetFor("tor-browser", "windows"), /tor-browser-windows-x86_64-portable-16\.0\.exe$/);
  assert.equal(targetFor("unknown", "windows"), null);
  assert.equal(targetFor("virtualbox", "linux"), null);
  assert.equal(Object.keys(DOWNLOADS).length, 3);
});

test("the Prism endpoint redirects to an allowlisted installer file, not a product page", () => {
  const res = response();
  handler(request("/api/app-download?app=tor-browser&platform=windows"), res);
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, targetFor("tor-browser", "windows"));
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.headers["referrer-policy"], "no-referrer");
  assert.equal(res.body, "");
});

test("bad app/platform requests and unsupported methods are refused", () => {
  const invalid = response();
  handler(request("/api/app-download?app=virtualbox&platform=linux"), invalid);
  assert.equal(invalid.statusCode, 404);
  assert.doesNotMatch(invalid.body, /https?:/);

  const method = response();
  handler(request("/api/app-download?app=tor-browser&platform=windows", "POST"), method);
  assert.equal(method.statusCode, 405);
  assert.equal(method.headers.allow, "GET, HEAD");
});

test("the Vercel and local routes send app downloads through Prism", () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "vercel.json"), "utf8"));
  const index = config.rewrites.findIndex((rule) => rule.source === "/download/app/:app/:platform");
  assert.ok(index >= 0);
  assert.equal(config.rewrites[index].destination, "/api/app-download?app=:app&platform=:platform");
  assert.ok(index < config.rewrites.findIndex((rule) => rule.source === "/(.*)"));
  assert.equal(fs.existsSync(path.join(__dirname, "..", "api", "app-download.js")), true);

  const apps = fs.readFileSync(path.join(__dirname, "..", "public", "apps.html"), "utf8");
  for (const app of ["github-desktop", "virtualbox", "tor-browser"]) {
    assert.match(apps, new RegExp(`/download/app/${app}/`));
  }
  assert.match(apps, /href="\/download\/mac"/);
  assert.match(apps, /href="\/download\/windows"/);
});

test("the helper only redirects GET and HEAD", () => {
  const res = response();
  sendAppDownload(request("/", "PUT"), res, "github-desktop", "windows");
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.allow, "GET, HEAD");
});
