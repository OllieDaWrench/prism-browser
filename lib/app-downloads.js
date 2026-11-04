"use strict";

const DOWNLOADS = Object.freeze({
  "github-desktop": Object.freeze({
    "mac-arm64": "https://drive.google.com/uc?export=download&id=19GnBC4T5KCoC9TvbUiIGz-waL159bP_A",
    "mac-x64": "https://drive.google.com/uc?export=download&id=",
    windows: "https://drive.google.com/uc?export=download&id=",
  }),
  "virtualbox": Object.freeze({
    // Oracle VirtualBox 7.2.22, build 175245.
    "mac-arm64": "https://drive.google.com/uc?export=download&id=",
    "mac-x64": "https://drive.google.com/uc?export=download&id=",
    "windows": "https://drive.google.com/uc?export=download&id=",
  }),
  "tor-browser": Object.freeze({
    // Tor Browser 16.0; the macOS package is universal, Windows is x64 portable.
    "mac": "https://drive.google.com/uc?export=download&id=1CXifZ2IcyWcJzOlBwTVswhHr8k_3KsCI",
    "windows": "https://drive.google.com/uc?export=download&id=",
  }),
  "blender": Object.freeze({
    // Blender 5.2.3
    "mac": "https://drive.google.com/uc?export=download&id="
    "windows": "https://drive.google.com/uc?export=download&id="
  })
});

function targetFor(app, platform) {
  const appKey = String(app || "").toLowerCase();
  const platformKey = String(platform || "").toLowerCase();
  const choices = DOWNLOADS[appKey];
  if (!choices) return null;
  if (choices[platformKey]) return choices[platformKey];
  if (["macos", "darwin", "apple"].includes(platformKey)) return choices.mac || null;
  if (["win", "win32", "win64", "pc"].includes(platformKey)) return choices.windows || null;
  if (["mac-arm", "mac-arm64", "apple-silicon"].includes(platformKey)) return choices["mac-arm64"] || choices.mac || null;
  if (["mac-intel", "mac-x64", "intel"].includes(platformKey)) return choices["mac-x64"] || choices.mac || null;
  return null;
}

function sendAppDownload(req, res, app, platform) {
  if ((req.method || "GET") !== "GET" && (req.method || "GET") !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, HEAD");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Use GET or HEAD.");
    return;
  }

  const target = targetFor(app, platform);
  if (!target) {
    res.statusCode = 404;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("That app download is not available.");
    return;
  }

  res.statusCode = 302;
  res.setHeader("Location", target);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end();
}

module.exports = { DOWNLOADS, targetFor, sendAppDownload };
