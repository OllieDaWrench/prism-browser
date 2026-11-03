"use strict";

/**
 * Vercel entry point for the same-origin download: streams the release asset
 * through the function so a click on "Download for Mac" saves a file instead of
 * opening GitHub (which is the point — GitHub may well be blocked for the
 * people using Prism).
 */

const { handleDownload } = require("../lib/downloads");
const gate = require("../lib/gate");

async function handler(req, res) {
  // Prism is private while it is under construction: the bundle is only handed
  // to a signed-in browser or to the installer's short-lived token.
  const allowed = gate.downloadAllowed(req);
  if (!allowed.ok) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.end("Sign in first: run the install command from the Prism site, or sign in there and download again.");
  }

  const url = new URL(req.url, "http://vercel.local");
  const platform = url.searchParams.get("platform") || url.searchParams.get("os") || "";
  try {
    await handleDownload(req, res, platform);
  } catch {
    if (res.headersSent) return res.end();
    res.statusCode = 502;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Could not fetch that download. Try the releases page directly.");
  }
}

module.exports = handler;
// Read on by Vercel; the bundles are ~1 MB, so this is only headroom for a
// slow upstream, never for a big body.
module.exports.config = { api: { bodyParser: false }, maxDuration: 60 };
