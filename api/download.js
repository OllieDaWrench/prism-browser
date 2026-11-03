"use strict";

/**
 * Vercel entry point for the same-origin download: streams the release asset
 * through the function so a click on "Download for Mac" saves a file instead of
 * opening GitHub (which is the point — GitHub may well be blocked for the
 * people using Prism).
 */

const { handleDownload } = require("../lib/downloads");

module.exports.config = {
  api: { bodyParser: false },
  maxDuration: 60,
};

module.exports = async function handler(req, res) {
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
};
