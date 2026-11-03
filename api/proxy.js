"use strict";

/**
 * Vercel entry point for the proxy engine.
 *
 * A serverless rewrite hands the function its *destination* path, so the
 * original address has to travel in the query string:
 *
 *     /https/example.com/a?x=1
 *       -> /api/proxy?__path=https/example.com/a&x=1
 *
 * This adapter reassembles the real target from `__path` plus whatever query
 * parameters Vercel merged in, then hands over to the shared proxy engine.
 *
 * It also accepts `/api/proxy?url=...` directly. That form is the fallback the
 * UI switches to when path rewrites are not in effect for a deployment, so a
 * hosted Prism keeps working even if only the function itself is reachable.
 */

const { handleProxy, errorPage, MODE_QUERY } = require("../lib/proxy");

/** Turn a rewritten request url back into the url the proxy expects. */
function rebuildUrl(rawUrl) {
  const qIndex = rawUrl.indexOf("?");
  if (qIndex === -1) return rawUrl;

  const params = new URLSearchParams(rawUrl.slice(qIndex + 1));
  const mapped = params.get("__path");
  if (!mapped) return rawUrl; // already a plain /api/proxy?url=... request

  params.delete("__path");
  const extra = params.toString();
  const path = "/" + String(mapped).replace(/^\/+/, "");

  if (path.includes("?")) return extra ? `${path}&${extra}` : path;
  return extra ? `${path}?${extra}` : path;
}

module.exports = async function handler(req, res) {
  const original = req.url || "/";
  req.url = rebuildUrl(original);

  // No target at all: answer with Prism's own error page rather than letting
  // the host produce a bare 404, and mark the response as Prism's.
  const opts = /__path=/.test(original)
    ? {}
    : { mode: MODE_QUERY, proxyBase: "/api/proxy?url=" };

  try {
    await handleProxy(req, res, opts);
  } catch (err) {
    if (res.headersSent) return res.end();
    res.statusCode = 502;
    res.setHeader("x-prism-proxy", "1");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(errorPage((err && err.message) || "Proxy failure", original, 502));
  }
};

module.exports.rebuildUrl = rebuildUrl;
