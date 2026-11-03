"use strict";

/**
 * Desktop downloads.
 *
 * Prism is a local app: it runs as a small Node server so it can drive the
 * Chrome already installed on the machine. The hosted copy cannot do that, so
 * whenever it has to say "run Prism locally" it should say it with a link.
 *
 * The download is same-origin: Prism streams its own zip, so clicking a button
 * saves a file instead of sending anyone to GitHub (`fallback` is only used if
 * that stream fails). The zips are built by `.github/workflows/release.yml`
 * from `scripts/package.sh`. Both contain the same app; the difference is the
 * double-click launcher inside (`Open Prism.command` on macOS, `Open Prism.bat`
 * on Windows). They carry the app and its dependencies but not a Node runtime,
 * which the launcher downloads into the same folder on first start — that keeps
 * the zip small enough for the hosted copy to serve it, and still needs no
 * administrator.
 */

const REPO = "OllieDaWrench/prism-browser";

const DOWNLOADS = {
  // last resort only, if a user has no way to fetch the runtime
  node: "https://nodejs.org/en/download",
  mac: {
    label: "Download for Mac",
    file: "Prism-macOS.zip",
    // Served by Prism itself (Content-Disposition: attachment), so clicking
    // saves the file instead of navigating to GitHub.
    path: "/download/mac",
    url: "/download/mac",
    fallback: `https://github.com/${REPO}/releases/latest/download/Prism-macOS.zip`,
    launcher: "Open Prism.command",
  },
  windows: {
    label: "Download for Windows",
    file: "Prism-Windows.zip",
    path: "/download/windows",
    url: "/download/windows",
    fallback: `https://github.com/${REPO}/releases/latest/download/Prism-Windows.zip`,
    launcher: "Open Prism.bat",
  },
};

function repo() {
  return REPO;
}

/** Buttons for server-rendered pages (the bot-wall explanation). */
function downloadButtonsHtml() {
  const { mac, windows } = DOWNLOADS;
  return `<div class="downloads">
  <a class="download" href="${mac.path}" download>${mac.label}</a>
  <a class="download" href="${windows.path}" download>${windows.label}</a>
</div>
<p class="requires">No installer and no admin rights: unzip it and double-click the launcher. It fetches its own engine into that folder the first time.</p>`;
}

module.exports = { DOWNLOADS, REPO, repo, downloadButtonsHtml };
