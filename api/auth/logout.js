"use strict";

/** POST /api/auth/logout — drop the cookie. */

const auth = require("../../lib/auth");

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Set-Cookie", auth.clearCookieHeader());
  res.end(JSON.stringify({ ok: true }));
};
