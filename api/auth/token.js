"use strict";

/**
 * POST /api/auth/token — the installer's way in.
 *
 * The terminal command asks for the number and password, posts them here and
 * gets a fifteen-minute token for the download. The password never appears in a
 * URL, a log or the shell history.
 */

const auth = require("../../lib/auth");
const users = require("../../lib/users");
const { readBody } = require("../../lib/body");

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    return res.end(JSON.stringify({ ok: false, error: "Use POST." }));
  }
  if (!auth.secret()) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ ok: false, error: "Sign-in is not configured: set PRISM_AUTH_SECRET." }));
  }

  const body = await readBody(req);
  const result = await users.verifyCredentials(body.number, body.password);
  if (!result.ok) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ ok: false, error: result.reason }));
  }

  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true, token: auth.createInstallToken(result.user) }));
};
