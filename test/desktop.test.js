"use strict";

/**
 * Download links are easy to break silently: a renamed asset, a typo in a URL,
 * a launcher that is not executable. These tests pin the whole chain from the
 * URL in the UI to the file name the release workflow uploads.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { DOWNLOADS, downloadButtonsHtml } = require("../lib/desktop");

const ROOT = path.join(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");

test("both platforms have a stable download url", () => {
  assert.equal(
    DOWNLOADS.mac.url,
    "https://github.com/OllieDaWrench/prism-browser/releases/latest/download/Prism-macOS.zip"
  );
  assert.equal(
    DOWNLOADS.windows.url,
    "https://github.com/OllieDaWrench/prism-browser/releases/latest/download/Prism-Windows.zip"
  );
  // `latest/download` requires the assets to keep exactly these names
  assert.equal(DOWNLOADS.mac.file, "Prism-macOS.zip");
  assert.equal(DOWNLOADS.windows.file, "Prism-Windows.zip");
  assert.match(DOWNLOADS.node, /^https:\/\/nodejs\.org/);
});

test("the UI links to exactly those urls", () => {
  const html = read("public", "index.html");
  assert.ok(html.includes(`href="${DOWNLOADS.mac.url}"`), "index.html is missing the macOS link");
  assert.ok(html.includes(`href="${DOWNLOADS.windows.url}"`), "index.html is missing the Windows link");
  assert.ok(html.includes(DOWNLOADS.node), "index.html should link to the Node.js download");

  // links inside the app's overlay must not navigate the app itself away
  for (const id of ["dl-mac", "dl-windows"]) {
    const tag = html.match(new RegExp(`<a[^>]*id="${id}"[^>]*>`))[0];
    assert.match(tag, /target="_blank"/);
    assert.match(tag, /rel="noreferrer noopener"/);
  }
});

test("app.js and the file:// landing page use the same urls", () => {
  const app = read("public", "app.js");
  assert.ok(app.includes(DOWNLOADS.mac.url));
  assert.ok(app.includes(DOWNLOADS.windows.url));

  const landing = read("Prism.html");
  assert.ok(landing.includes(DOWNLOADS.mac.url));
  assert.ok(landing.includes(DOWNLOADS.windows.url));
});

test("the README documents both downloads", () => {
  const readme = read("README.md");
  assert.ok(readme.includes(DOWNLOADS.mac.url));
  assert.ok(readme.includes(DOWNLOADS.windows.url));
  assert.match(readme, /Open Prism\.command/);
});

test("the bot-wall page offers the downloads only when it has to", () => {
  const offline = downloadButtonsHtml();
  assert.match(offline, /Download for Mac/);
  assert.match(offline, /Download for Windows/);
  assert.ok(offline.includes(DOWNLOADS.mac.url));
  assert.match(offline, /nodejs\.org/);

  const { blockPage } = require("../lib/botwall");
  const noLive = blockPage("Cloudflare", "https://www.reddit.com/", { liveAvailable: false });
  assert.match(noLive, /Download for Mac/);
  assert.ok(noLive.includes(DOWNLOADS.mac.url));
  assert.match(noLive, /target="_blank"/);

  // with Live mode available Prism just switches engines, so no download noise
  const withLive = blockPage("Cloudflare", "https://www.reddit.com/", { liveAvailable: true });
  assert.doesNotMatch(withLive, /Download for Mac/);
});

test("a launcher exists for each platform", () => {
  const mac = path.join(ROOT, "Open Prism.command");
  const win = path.join(ROOT, "Open Prism.bat");
  assert.ok(fs.existsSync(mac), "missing Open Prism.command");
  assert.ok(fs.existsSync(win), "missing Open Prism.bat");

  // the macOS launcher must be executable in the repo, or a zip will not be
  const mode = fs.statSync(mac).mode & 0o777;
  assert.ok(mode & 0o111, `Open Prism.command is not executable (mode ${mode.toString(8)})`);

  const macScript = fs.readFileSync(mac, "utf8");
  assert.match(macScript, /^#!\/bin\/bash/);
  assert.match(macScript, /node/);
  assert.match(macScript, /npm install/);
  assert.match(macScript, /server\.js/);
  assert.match(macScript, /http:\/\/localhost/);

  const winScript = fs.readFileSync(win, "utf8");
  assert.match(winScript, /node server\.js/);
  assert.match(winScript, /npm install/);
  assert.match(winScript, /http:\/\/localhost:3000/);
});

test("the packaging script builds the asset names the links expect", () => {
  const script = read("scripts", "package.sh");
  assert.ok(script.includes(DOWNLOADS.mac.file), "package.sh must produce Prism-macOS.zip");
  assert.ok(script.includes(DOWNLOADS.windows.file), "package.sh must produce Prism-Windows.zip");
  // both launchers travel with the bundle
  assert.match(script, /Open Prism\.command/);
  assert.match(script, /Open Prism\.bat/);
  assert.match(script, /chmod \+x/);
  assert.match(script, /set -euo pipefail/);
});

test("the release workflow publishes on tags and checks the bundles", () => {
  const workflow = read(".github", "workflows", "release.yml");
  assert.match(workflow, /tags:/);
  assert.match(workflow, /"v\*"/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /scripts\/package\.sh/);
  // the workflow must attach exactly the names the app links to
  assert.ok(workflow.includes(DOWNLOADS.mac.file));
  assert.ok(workflow.includes(DOWNLOADS.windows.file));
  // and verify them before publishing, so a broken zip is never released
  assert.match(workflow, /unzip -l/);
  assert.match(workflow, /server\.js/);
  assert.match(workflow, /gh release create/);
});
