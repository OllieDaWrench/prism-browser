"use strict";

/** Direct-file handoff for the Apps catalog. */

const { sendAppDownload } = require("../lib/app-downloads");

module.exports = function handler(req, res) {
  const url = new URL(req.url || "/", "http://prism.local");
  const app = url.searchParams.get("app");
  const platform = url.searchParams.get("platform");
  sendAppDownload(req, res, app, platform);
};
