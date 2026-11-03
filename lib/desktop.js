"use strict";

/**
 * Desktop downloads.
 *
 * Prism is a local app: it runs as a small Node server so it can drive the
 * Chrome already installed on the machine. The hosted copy cannot do that, so
 * whenever it has to say "run Prism locally" it should say it with a link.
 *
 * These URLs point at assets attached to the newest GitHub release, built by
 * `.github/workflows/release.yml` from `scripts/package.sh`. Both zips contain
 * the same app; the difference is the double-click launcher inside
 * (`Open Prism.command` on macOS, `Open Prism.bat` on Windows).
 */

const REPO = "OllieDaWrench/prism-browser";

const DOWNLOADS = {
  node: "https://nodejs.org/en/download",
  mac: {
    label: "Download for Mac",
    file: "Prism-macOS.zip",
    url: `https://github.com/${REPO}/releases/latest/download/Prism-macOS.zip`,
    launcher: "Open Prism.command",
  },
  windows: {
    label: "Download for Windows",
    file: "Prism-Windows.zip",
    url: `https://github.com/${REPO}/releases/latest/download/Prism-Windows.zip`,
    launcher: "Open Prism.bat",
  },
};

function repo() {
  return REPO;
}

/** Buttons for server-rendered pages (the bot-wall explanation). */
function downloadButtonsHtml() {
  const { mac, windows, node } = DOWNLOADS;
  return `<div class="downloads">
  <a class="download" href="${mac.url}" target="_blank" rel="noreferrer noopener">${mac.label}</a>
  <a class="download" href="${windows.url}" target="_blank" rel="noreferrer noopener">${windows.label}</a>
</div>
<p class="requires">Needs Node.js 22+ (install once from <a href="${node}" target="_blank" rel="noreferrer noopener">nodejs.org</a>). Then double-click the launcher in the folder.</p>`;
}

module.exports = { DOWNLOADS, REPO, repo, downloadButtonsHtml };
