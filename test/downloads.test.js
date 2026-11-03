"use strict";

/**
 * Same-origin downloads: a click must save a file, never navigate to GitHub.
 * These tests drive the real handler with a fake upstream, plus the on-disk
 * path used by a locally built bundle.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Readable, Writable } = require("stream");
const { handleDownload, assetFor, releaseUrl, ASSETS } = require("../lib/downloads");

function fakeRes() {
  class FakeRes extends Writable {
    constructor() {
      super();
      this.statusCode = 200;
      this.headers = {};
      this.chunks = [];
      this.ended = false;
    }
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    }
    getHeader(k) {
      return this.headers[k.toLowerCase()];
    }
    status(code) {
      this.statusCode = code;
      return this;
    }
    _write(chunk, enc, cb) {
      this.chunks.push(Buffer.from(chunk));
      cb();
    }
    end(body) {
      if (body !== undefined) this.chunks.push(Buffer.from(String(body)));
      this.ended = true;
      super.end();
      if (this.onEnd) this.onEnd();
      return this;
    }
    get body() {
      return Buffer.concat(this.chunks);
    }
  }
  return new FakeRes();
}

function fakeReq(method = "GET") {
  return { method };
}

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);

function fakeFetch(response) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (typeof response === "function") return response(url, init);
    return response;
  };
  fn.calls = calls;
  return fn;
}

function zipResponse(body = ZIP) {
  const headers = { "content-type": "application/zip", "content-length": String(body.length) };
  return {
    ok: true,
    status: 200,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    body: Readable.toWeb(Readable.from([body])),
  };
}

const run = (req, res, platform, options) =>
  new Promise((resolve, reject) => {
    res.onEnd = resolve;
    handleDownload(req, res, platform, options).then(resolve, reject);
  });

test("platform aliases resolve to the two release assets", () => {
  assert.equal(assetFor("mac").file, "Prism-macOS.zip");
  assert.equal(assetFor("macos").file, "Prism-macOS.zip");
  assert.equal(assetFor("darwin").file, "Prism-macOS.zip");
  assert.equal(assetFor("windows").file, "Prism-Windows.zip");
  assert.equal(assetFor("win").file, "Prism-Windows.zip");
  assert.equal(assetFor("linux"), null);
  assert.equal(ASSETS.mac.filename, "Prism-macOS.zip");
});

test("the upstream is the stable latest-release asset url", () => {
  assert.equal(
    releaseUrl(ASSETS.mac),
    "https://github.com/OllieDaWrench/prism-browser/releases/latest/download/Prism-macOS.zip"
  );
});

test("streams the release asset with a download disposition", async () => {
  const fetchImpl = fakeFetch(zipResponse());
  const res = fakeRes();
  await run(fakeReq(), res, "mac", { fetch: fetchImpl });

  assert.equal(res.statusCode, 200);
  assert.equal(res.getHeader("content-type"), "application/zip");
  assert.equal(res.getHeader("content-disposition"), 'attachment; filename="Prism-macOS.zip"');
  assert.equal(res.getHeader("content-length"), String(ZIP.length));
  assert.deepEqual(res.body, ZIP);

  // it followed the release redirect and asked for bytes, not a page
  const call = fetchImpl.calls[0];
  assert.equal(call.url, releaseUrl(ASSETS.mac));
  assert.equal(call.init.redirect, "follow");
  assert.equal(call.init.headers.accept, "application/octet-stream");
});

test("windows downloads get their own filename", async () => {
  const res = fakeRes();
  await run(fakeReq(), res, "windows", { fetch: fakeFetch(zipResponse()) });
  assert.equal(res.getHeader("content-disposition"), 'attachment; filename="Prism-Windows.zip"');
});

test("HEAD reports the size without a body", async () => {
  const res = fakeRes();
  await run(fakeReq("HEAD"), res, "mac", { fetch: fakeFetch(zipResponse()) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.getHeader("content-disposition"), 'attachment; filename="Prism-macOS.zip"');
  assert.equal(res.body.length, 0);
});

test("an upstream failure explains itself and offers the direct link", async () => {
  const res = fakeRes();
  await run(fakeReq(), res, "mac", {
    fetch: fakeFetch(async () => {
      throw new Error("network down");
    }),
  });
  assert.equal(res.statusCode, 502);
  const html = res.body.toString();
  assert.match(html, /Couldn't fetch the download/);
  assert.match(html, /releases\/latest\/download\/Prism-macOS\.zip/);
});

test("an HTML error page is never saved as a zip", async () => {
  const res = fakeRes();
  await run(fakeReq(), res, "mac", {
    fetch: fakeFetch({
      ok: true,
      status: 200,
      headers: { get: (k) => (k.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
      body: Readable.toWeb(Readable.from([Buffer.from("<html>404</html>")])),
    }),
  });
  assert.equal(res.statusCode, 502);
  assert.doesNotMatch(res.getHeader("content-disposition") || "", /attachment/);
  assert.match(res.body.toString(), /Couldn't fetch the download/);
});

test("a 404 from the release is reported, not streamed", async () => {
  // make sure no locally built bundle can short-circuit this
  fs.rmSync(path.join(require("../lib/downloads").LOCAL_DIR, "Prism-Windows.zip"), { force: true });
  const res = fakeRes();
  await run(fakeReq(), res, "windows", {
    fetch: fakeFetch({
      ok: false,
      status: 404,
      headers: { get: () => null },
      body: Readable.toWeb(Readable.from([Buffer.from("nope")])),
    }),
  });
  assert.equal(res.statusCode, 502);
});

test("unknown platforms list the two that exist", async () => {
  const res = fakeRes();
  await run(fakeReq(), res, "linux", { fetch: fakeFetch(zipResponse()) });
  assert.equal(res.statusCode, 404);
  assert.match(res.body.toString(), /\/download\/mac/);
  assert.match(res.body.toString(), /\/download\/windows/);
});

test("a bundle in dist/ is served straight from disk", async () => {
  // scripts/package.sh writes here, and a local Prism then hands out its own build
  const { LOCAL_DIR } = require("../lib/downloads");
  const madeDir = !fs.existsSync(LOCAL_DIR);
  fs.mkdirSync(LOCAL_DIR, { recursive: true });
  const file = path.join(LOCAL_DIR, "Prism-Windows.zip");
  const body = Buffer.alloc(2048, 7);
  fs.writeFileSync(file, body);

  const fetchImpl = fakeFetch(zipResponse());
  const res = fakeRes();
  await run(fakeReq(), res, "windows", { fetch: fetchImpl });

  assert.equal(res.statusCode, 200);
  assert.equal(res.getHeader("content-length"), "2048");
  assert.equal(res.getHeader("content-disposition"), 'attachment; filename="Prism-Windows.zip"');
  assert.deepEqual(res.body, body);
  assert.equal(fetchImpl.calls.length, 0, "should not touch the network");

  fs.rmSync(file, { force: true });
  if (madeDir) fs.rmSync(LOCAL_DIR, { recursive: true, force: true });
});

test("the handler is safe to call twice for HEAD and GET", async () => {
  for (const method of ["HEAD", "GET"]) {
    const res = fakeRes();
    await run(fakeReq(method), res, "mac", { fetch: fakeFetch(zipResponse()) });
    assert.ok(res.ended, `${method} should finish the response`);
  }
});

test("the Vercel config routes downloads before the catch-all", () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "vercel.json"), "utf8"));
  const sources = config.rewrites.map((r) => r.source);
  const download = sources.indexOf("/download/:platform");
  const catchAll = sources.indexOf("/(.*)");
  assert.ok(download >= 0, "vercel.json must route /download/:platform");
  assert.ok(download < catchAll, "/download must be routed before the proxy catch-all");
  assert.equal(
    config.rewrites[download].destination,
    "/api/download?platform=:platform"
  );
  assert.ok(fs.existsSync(path.join(__dirname, "..", "api", "download.js")));
});

test("an asset too big for a hosted response is refused, not truncated", async () => {
  // Vercel caps a Function response body at 4.5 MB. Handing over half a zip
  // would look like a corrupt download, so Prism explains instead.
  const { MAX_RESPONSE_BYTES } = require("../lib/downloads");
  assert.ok(MAX_RESPONSE_BYTES < 4.5 * 1024 * 1024, "must stay under the Vercel cap");

  const huge = {
    ok: true,
    status: 200,
    headers: {
      get: (k) =>
        ({ "content-type": "application/zip", "content-length": String(MAX_RESPONSE_BYTES + 1) })[
          k.toLowerCase()
        ] ?? null,
    },
    body: { cancel: async () => {} },
  };

  const res = fakeRes();
  await run(fakeReq(), res, "mac", { fetch: fakeFetch(huge) });

  assert.equal(res.statusCode, 502);
  assert.match(res.body.toString(), /too large/);
  // and it points at a working fallback instead of a dead end
  assert.match(res.body.toString(), /releases\/latest\/download\/Prism-macOS\.zip/);
});

test("the bundled download stays inside the hosted response budget", () => {
  // The whole reason the zips no longer carry a Node runtime: the launchers
  // fetch one on first launch, which keeps this a ~1 MB document.
  const { MAX_RESPONSE_BYTES } = require("../lib/downloads");
  const script = fs.readFileSync(path.join(__dirname, "..", "scripts", "package.sh"), "utf8");
  assert.match(script, /--runtime/);
  const launcher = fs.readFileSync(path.join(__dirname, "..", "Open Prism.command"), "utf8");
  assert.match(launcher, /nodejs\.org\/dist/);
  assert.match(launcher, /runtime\/\$RUNTIME_ARCH/);
  assert.ok(MAX_RESPONSE_BYTES > 1000000);
});
