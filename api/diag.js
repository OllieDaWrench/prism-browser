"use strict";

/** Temporary diagnostic: report what the hosted download does, in text. */

const { assetFor, releaseUrl } = require("../lib/downloads");

module.exports = async function handler(req, res) {
  const out = { steps: [], node: process.version, cwd: process.cwd() };
  const url = new URL(req.url, "http://x");
  const platform = url.searchParams.get("platform") || "mac";
  const asset = assetFor(platform);
  out.asset = asset && asset.file;
  const target = releaseUrl(asset);
  out.url = target;

  try {
    out.steps.push("fetch start");
    const r = await fetch(target, { redirect: "follow", headers: { accept: "application/octet-stream" } });
    out.steps.push("fetch done");
    out.status = r.status;
    out.ok = r.ok;
    out.finalUrl = r.url;
    out.headers = Object.fromEntries(r.headers.entries());
    const buf = Buffer.from(await r.arrayBuffer());
    out.steps.push("body read");
    out.bytes = buf.length;
    out.magic = buf.subarray(0, 2).toString("latin1");
  } catch (err) {
    out.steps.push("threw");
    out.error = String(err && (err.stack || err.message || err));
    out.cause = err && err.cause ? String(err.cause) : null;
  }

  res.status(200);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(JSON.stringify(out, null, 2));
};
