"use strict";

/**
 * Opening a page in the user's own browser.
 *
 * This exists because of one stubborn fact: Prism's Live mode drives Chrome
 * over the DevTools protocol, with a debugging port and a profile of its own,
 * and bot protection may still recognise that separate browser session. A
 * user-agent change cannot guarantee that a site will accept it.
 *
 * Handing the URL to the user's everyday browser can help when the separate
 * Prism-controlled browser is challenged: that browser may already have the
 * user's normal profile and cookies. It is not a guarantee; the site can still
 * block the account or network. Prism cannot screenshot that window, so the
 * page opens outside Prism.
 *
 * Safety rules, because this spawns a process from an HTTP request:
 *   — http/https only, no file://, no javascript:, nothing with a quote or a
 *     control character in it;
 *   — arguments are passed as an array, never through a shell;
 *   — the endpoint is only reachable on the local app, never the hosted copy.
 */

const { spawn } = require("child_process");

/** Add a scheme to something that looks like a bare host, or return null. */
function normalise(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // A URL is handed to an OS launcher. Keep it to characters that cannot be
  // reinterpreted by a command line.
  if (/["'`\u0000-\u001f\u007f]/.test(candidate)) return null;
  return url.href;
}

/** The command that opens a URL in the default browser, per platform. */
function openerCommand(platform, url) {
  switch (platform) {
    case "darwin":
      return { command: "open", args: [url] };
    case "win32":
      // rundll32 hands the URL straight to the protocol handler, so cmd's
      // metacharacters (&, ^) can never be re-parsed.
      return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
    default:
      return { command: "xdg-open", args: [url] };
  }
}

/**
 * Open `raw` in the default browser.
 * `spawnImpl` is injectable so the tests never launch anything.
 */
function openExternal(raw, options = {}) {
  const url = normalise(raw);
  if (!url) return { ok: false, error: "That is not an http(s) address." };

  const platform = options.platform || process.platform;
  if (!["darwin", "win32", "linux"].includes(platform) && !options.platform) {
    return { ok: false, error: `Opening a browser is not supported on ${platform}.` };
  }

  const { command, args } = openerCommand(platform, url);
  const spawnImpl = options.spawn || spawn;
  try {
    const child = spawnImpl(command, args, {
      detached: true,
      stdio: "ignore",
    });
    if (child && typeof child.unref === "function") child.unref();
    if (child && child.on) child.on("error", () => {});
  } catch (err) {
    return { ok: false, error: `Could not open your browser: ${err.message}` };
  }
  return { ok: true, url };
}

module.exports = { openExternal, normalise, openerCommand };
