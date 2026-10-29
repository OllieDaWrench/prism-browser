"use strict";

/** Live engine status on serverless: always unavailable, by design. */
module.exports = function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(
    JSON.stringify({
      engine: "live",
      available: false,
      state: "unavailable",
      browser: null,
      reason: "Live mode needs a long-running Node process (it drives a real browser).",
      hint: "Run Prism locally with `npm start` to use Live mode.",
    })
  );
};
