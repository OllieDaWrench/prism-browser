"use strict";

/**
 * Vercel entry point.
 *
 * Serverless Prism can only run the proxy engine: the live engine needs a
 * long-lived process to keep a Chromium instance and its websocket alive, so
 * `/api/live.js` reports it as unavailable and the app falls back cleanly.
 */

const { handleProxy, errorPage } = require("../lib/proxy");

module.exports = async function handler(req, res) {
  const incoming = new URL(req.url, "http://vercel.local");
  const mapped = incoming.searchParams.get("__path");
  if (mapped) {
    // vercel.json rewrites "/https/host/path" to "/api/proxy?__path=https/host/path"
    const rest = mapped.includes("?") ? mapped.slice(mapped.indexOf("?")) : "";
    const pathPart = mapped.split("?")[0];
    req.url = "/" + pathPart + rest;
  }

  try {
    await handleProxy(req, res);
  } catch (err) {
    if (res.headersSent) return res.end();
    res.statusCode = 502;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(errorPage((err && err.message) || "Proxy failure", req.url, 502));
  }
};
