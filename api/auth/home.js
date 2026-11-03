"use strict";

/**
 * GET /app (Vercel rewrite target) — serve the private app shell only to a
 * signed-in user. The public root is a static invitation page in public/; the
 * app shell lives outside Vercel's public output directory.
 */

const fs = require("fs");
const path = require("path");
const gate = require("../../lib/gate");

const APP_HTML = path.join(__dirname, "..", "..", "private", "app.html");

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
