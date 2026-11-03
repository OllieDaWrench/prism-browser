"use strict";

/**
 * GET /app (Vercel rewrite target) — serve the private browser shell only to
 * administrators. Everyone else gets the public, under-construction page. The
 * public homepage is static in public/; the browser shell stays outside it.
 */

const fs = require("fs");
const path = require("path");
const gate = require("../../lib/gate");

const APP_HTML = path.join(__dirname, "..", "..", "private", "app.html");
const UNDER_CONSTRUCTION_HTML = path.join(__dirname, "..", "..", "private", "web-under-construction.html");

module.exports = function handler(req, res) {
  const session = gate.sessionFrom(req);
  const allowed = !gate.enabled() || (session && session.role === "admin");
  const page = allowed ? APP_HTML : UNDER_CONSTRUCTION_HTML;

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex");
  res.end(fs.readFileSync(page, "utf8"));
};
