"use strict";

/**
 * POST /api/auth/login — a six-digit number and a password in, a signed cookie out.
 */

const auth = require("../../lib/auth");
const users = require("../../lib/users");
const gate = require("../../lib/gate");
const { readBody } = require("../../lib/body");

/* Ten wrong tries per address per ten minutes. Enough for a typo, not enough to
 * walk a six-digit number space. */
const attempts = new Map();
const WINDOW = 10 * 60 * 1000;
const LIMIT = 10;

function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || String(req.socket && req.socket.remoteAddress) || "unknown";
}

function tooMany(ip) {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now - entry.first > WINDOW) return false;
  return entry.count >= LIMIT;
}

function noteFailure(ip) {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now - entry.first > WINDOW) attempts.set(ip, { first: now, count: 1 });
  else entry.count += 1;
  if (attempts.size > 5000) attempts.clear(); // a cheap ceiling on memory
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    return res.end(JSON.stringify({ ok: false, error: "Use POST." }));
  }

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");

  if (!auth.secret()) {
    res.statusCode = 500;
    return res.end(
      JSON.stringify({ ok: false, error: "Sign-in is not configured: set PRISM_AUTH_SECRET on the server." })
    );
  }

  const ip = clientIp(req);
  if (tooMany(ip)) {
    res.statusCode = 429;
    return res.end(JSON.stringify({ ok: false, error: "Too many tries. Wait ten minutes and try again." }));
  }

  const body = await readBody(req);
  const result = await users.verifyCredentials(body.number || body.phone, body.password);
  if (!result.ok) {
    noteFailure(ip);
    res.statusCode = 401;
    return res.end(JSON.stringify({ ok: false, error: result.reason }));
  }

  attempts.delete(ip);
  res.setHeader("Set-Cookie", auth.cookieHeader(auth.createSession(result.user)));
  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true, number: result.user.number, admin: result.user.role === "admin" }));
};
