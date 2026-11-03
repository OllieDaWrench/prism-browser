"use strict";

/** POST /api/feedback — accept short anonymous notes and store them privately. */

const { normalizeMessage, submitFeedback } = require("../lib/feedback");
const { readBody } = require("../lib/body");

const WINDOW_MS = 15 * 60 * 1000;
const LIMIT = 5;
const attempts = new Map();

function clientIp(req) {
  const forwarded = String((req.headers && req.headers["x-forwarded-for"]) || "").split(",")[0].trim();
  return forwarded || String((req.socket && req.socket.remoteAddress) || "unknown");
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function sameOrigin(req) {
  const origin = req.headers && req.headers.origin;
  if (!origin) return String((req.headers && req.headers["sec-fetch-site"]) || "").toLowerCase() !== "cross-site";
  try {
    const originHost = new URL(origin).host.toLowerCase();
    const forwarded = String((req.headers && req.headers["x-forwarded-host"]) || "").split(",")[0].trim().toLowerCase();
    const host = String((req.headers && req.headers.host) || "").toLowerCase();
    return originHost === host || Boolean(forwarded && originHost === forwarded);
  } catch {
    return false;
  }
}

function tooMany(ip) {
  const now = Date.now();
  let item = attempts.get(ip);
  if (!item || now - item.first >= WINDOW_MS) {
    item = { first: now, count: 0 };
    attempts.set(ip, item);
  }
  if (attempts.size > 5000) attempts.clear();
  if (item.count >= LIMIT) return true;
  item.count += 1;
  return false;
}

async function handler(req, res) {
  if ((req.method || "GET") !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { ok: false, error: "Use POST." });
  }

  if (!sameOrigin(req)) return json(res, 403, { ok: false, error: "Cross-origin feedback submissions are not allowed." });

  const ip = clientIp(req);
  if (tooMany(ip)) return json(res, 429, { ok: false, error: "Too many submissions. Please try again later." });

  const body = await readBody(req, 4096);
  // Quietly accept honeypot submissions without storing them.
  if (typeof body.website === "string" && body.website.trim()) return json(res, 200, { ok: true });

  let message;
  try {
    message = normalizeMessage(body.message);
  } catch (err) {
    return json(res, 400, { ok: false, error: err.message });
  }

  try {
    const saved = await submitFeedback(message);
    return json(res, 200, { ok: true, id: saved.id });
  } catch (err) {
    console.error("[feedback] storage failed:", err && err.message);
    return json(res, 503, { ok: false, error: "Feedback storage is unavailable right now. Please try again later." });
  }
}

handler._resetRateLimitForTests = () => attempts.clear();
module.exports = handler;
