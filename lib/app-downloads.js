"use strict";

/**
 * Curated third-party installer targets for the Apps page.
 *
 * These are exact official file URLs, never product or release-page URLs. The
 * endpoint redirects to the file because these installers are hundreds of MB
 * and Vercel Functions cannot proxy bodies that large.
 */

const DOWNLOADS = Object.freeze({
  "github-desktop": Object.freeze({
    "mac-arm64": "https://github.com/desktop/desktop/releases/latest/download/GitHub.Desktop-arm64.zip",
    "mac-x64": "https://github.com/desktop/desktop/releases/latest/download/GitHub.Desktop-x64.zip",
    windows: "https://github.com/desktop/desktop/releases/latest/download/GitHubDesktopSetup-x64.exe",
  }),
  virtualbox: Object.freeze({
    // Oracle VirtualBox 7.2.22, build 175245.
    "mac-arm64": "https://download.virtualbox.org/virtualbox/7.2.22/VirtualBox-7.2.22-175245-macOSArm64.dmg",
    "mac-x64": "https://download.virtualbox.org/virtualbox/7.2.22/VirtualBox-7.2.22-175245-OSX.dmg",
    windows: "https://download.virtualbox.org/virtualbox/7.2.22/VirtualBox-7.2.22-175245-Win.exe",
  }),
  "tor-browser": Object.freeze({
    // Tor Browser 16.0; the macOS package is universal, Windows is x64 portable.
    mac: "https://www.torproject.org/dist/torbrowser/16.0/tor-browser-macos-16.0.dmg",
    windows: "https://archive.torproject.org/tor-package-archive/torbrowser/16.0/tor-browser-windows-x86_64-portable-16.0.exe",
  }),
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
