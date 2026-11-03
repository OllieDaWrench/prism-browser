"use strict";

/**
 * Vercel entry point for the macOS installer one-liner.
 *
 * `curl -fsSL https://prism-browser.vercel.app/install.sh | bash` has to work,
 * so this returns a shell script as text — never as an attachment. The script
 * is generated per request so it points back at whichever origin served it.
 */

const { installerScript } = require("../lib/installer");

function handler(req, res) {
  const forwarded = req.headers["x-forwarded-proto"];
  const proto = (Array.isArray(forwarded) ? forwarded[0] : forwarded || "https").split(",")[0].trim();
  const host = req.headers["x-forwarded-host"] || req.headers.host || "prism-browser.vercel.app";
  const origin = `${proto}://${String(host).split(",")[0].trim()}`;

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", 'inline; filename="install.sh"');
  res.setHeader("Cache-Control", "no-store");
  res.end(installerScript(origin));
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
