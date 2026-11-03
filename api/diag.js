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

  if (mode === "selfcheck") {
    // Ask this same deployment for the download, the way a browser would, and
    // report what came back as text.
    const base = process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : `https://${process.env.VERCEL_URL}`;
    const out = { base };
    try {
      const r = await fetch(base + "/download/mac", { redirect: "follow" });
      out.status = r.status;
      out.headers = Object.fromEntries(r.headers.entries());
      const buf = Buffer.from(await r.arrayBuffer());
      out.bytes = buf.length;
      out.magic = buf.subarray(0, 2).toString("latin1");
      out.isZip = out.magic === "PK";
    } catch (err) {
      out.error = String((err && err.stack) || err);
    }
    res.status(200);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.end(JSON.stringify(out, null, 2));
  }

  if (mode === "bin-as-text") {
    // same bytes as zip-small, but declared as text: separates "binary body"
    // from "application/zip content type" as the cause
    const r = await fetch(releaseUrl(assetFor("mac")), {
      redirect: "follow",
      headers: { accept: "application/octet-stream" },
    });
    const buf = Buffer.from(await r.arrayBuffer()).subarray(0, 64);
    res.status(200);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.end(buf);
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
