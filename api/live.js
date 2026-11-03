"use strict";

/**
 * Live engine status on a serverless host: always unavailable, by design.
 * The live engine keeps a Chromium process and a websocket alive, which needs
 * a long-running Node process — that only exists when Prism runs locally.
 */
const gate = require("../lib/gate");

module.exports = function handler(req, res) {
  if (!gate.check(req, res, { adminOnly: true })) return;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(
    JSON.stringify({
      engine: "live",
      available: false,
      state: "unavailable",
      hosted: true,
      browser: null,
      reason: "Live mode needs a long-running process to drive a real browser, so it is not available on this hosted copy.",
      hint: "Run Prism locally (`npm start`, or Open Prism.bat on Windows) to use Live mode, which is what loads ChatGPT, Reddit, Spotify, Twitch and other JavaScript apps.",
    })
  );
};
