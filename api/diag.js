"use strict";

/** Temporary diagnostic: report what the hosted download does, in text. */

const { assetFor, releaseUrl } = require("../lib/downloads");

module.exports = async function handler(req, res) {
  const url = new URL(req.url, "http://x");
  const mode = url.searchParams.get("mode") || "info";

  if (mode === "text-attachment") {
    res.status(200);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="x.txt"');
    return res.end("hello");
  }

  if (mode === "zip-small" || mode === "zip-full") {
    const r = await fetch(releaseUrl(assetFor("mac")), {
      redirect: "follow",
      headers: { accept: "application/octet-stream" },
    });
    const buf = Buffer.from(await r.arrayBuffer());
    const body = mode === "zip-small" ? buf.subarray(0, 64) : buf;
    res.status(200);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Length", String(body.length));
    res.setHeader("Content-Disposition", 'attachment; filename="Prism-macOS.zip"');
    return res.end(body);
  }

  if (mode === "zip-nodisposition") {
    const r = await fetch(releaseUrl(assetFor("mac")), {
      redirect: "follow",
      headers: { accept: "application/octet-stream" },
    });
    const buf = Buffer.from(await r.arrayBuffer());
    res.status(200);
    res.setHeader("Content-Type", "application/zip");
    return res.end(buf);
  }

  res.status(200);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("diag ok " + mode);
};
