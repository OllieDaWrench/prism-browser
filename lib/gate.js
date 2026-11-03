"use strict";

/**
 * The gate in front of the site.
 *
 * Prism is under construction and private: a six-digit number and a password
 * open it. The gate is off when no PRISM_AUTH_SECRET is configured, because
 * then nobody could sign in — and a copy on your own machine should still run.
 */

const fs = require("fs");
const path = require("path");
const auth = require("./auth");

let cached = null;

function gateHtml() {
  if (cached) return cached;
  try {
    cached = fs.readFileSync(path.join(__dirname, "..", "public", "gate.html"), "utf8");
  } catch {
    cached = "<!doctype html><title>Under construction</title><h1>Under construction</h1>";
  }
  return cached;
}

/** Is the gate switched on for this deployment? */
function enabled(env = process.env) {
  if (/^(0|off|false|no)$/i.test(String(env.PRISM_AUTH || ""))) return false;
  if (!auth.secret(env)) return false;
  return true;
}

function sessionFrom(req, env) {
  return auth.sessionFromCookieHeader(req.headers && req.headers.cookie, env);
}

function serveGate(res, statusCode = 200) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex");
  res.end(gateHtml());
}

function serveJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

/**
 * Guard a request. Returns true when the caller may go through, and writes the
 * refusal when not: the sign-in page for a browser, 401 JSON for an API.
 */
function check(req, res, options = {}) {
  if (!enabled(options.env)) return true;

  const session = sessionFrom(req, options.env);
  const pathname = String(req.url || "/").split("?")[0];

  if (session) {
    if (pathname === "/login") {
      // already in: the sign-in page is not somewhere to linger
      res.statusCode = 302;
      res.setHeader("Location", "/");
      res.setHeader("Cache-Control", "no-store");
      res.end();
      return false;
    }
    if (options.adminOnly && session.role !== "admin") {
      serveJson(res, 403, { ok: false, error: "Only the account owner can change access." });
      return false;
    }
    return true;
  }

  const acceptsHtml = String(req.headers.accept || "").includes("text/html");

  if (pathname === "/" || pathname === "" || pathname === "/login") {
    serveGate(res);
    return false;
  }
  if (acceptsHtml && (req.method || "GET") === "GET") {
    res.statusCode = 302;
    res.setHeader("Location", "/login");
    res.setHeader("Cache-Control", "no-store");
    res.end();
    return false;
  }
  serveJson(res, 401, { ok: false, error: "This is private while Prism is under construction." });
  return false;
}

/** The download accepts a sign-in cookie as well as an install token. */
function downloadAllowed(req, env = process.env) {
  if (!enabled(env)) return { ok: true, reason: "gate off" };

  const session = sessionFrom(req, env);
  if (session) return { ok: true, number: session.number };

  let token = null;
  try {
    token = new URL(req.url || "/", "http://x").searchParams.get("token");
  } catch {
    token = null;
  }
  const install = auth.readInstallToken(token, env);
  if (install) return { ok: true, number: install.number };

  return { ok: false };
}

module.exports = { enabled, check, serveGate, serveJson, gateHtml, sessionFrom, downloadAllowed };
