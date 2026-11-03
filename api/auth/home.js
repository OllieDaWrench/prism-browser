"use strict";

/**
 * GET / (Vercel rewrite target) — choose the sign-in page or the app itself.
 *
 * Vercel serves public/index.html as a static root before the catch-all proxy
 * rewrite can run. The explicit / rewrite sends root visits here instead, so a
 * configured private site cannot accidentally show the app to signed-out users.
 */

const fs = require("fs");
const path = require("path");
const gate = require("../../lib/gate");

const APP_HTML = path.join(__dirname, "..", "..", "public", "index.html");

module.exports = function handler(req, res) {
  if (gate.enabled() && !gate.sessionFrom(req)) {
    return gate.serveGate(res);
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex");
  res.end(fs.readFileSync(APP_HTML, "utf8"));
};
