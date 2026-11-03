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

test("downloads are served by Prism itself, not by GitHub", () => {
  // a click must save a file with no trip to github.com
  assert.equal(DOWNLOADS.mac.url, "/download/mac");
  assert.equal(DOWNLOADS.windows.url, "/download/windows");
  assert.equal(DOWNLOADS.mac.path, "/download/mac");
  assert.equal(DOWNLOADS.windows.path, "/download/windows");

  // the release asset names still matter: they are what the endpoint streams
  assert.equal(DOWNLOADS.mac.file, "Prism-macOS.zip");
  assert.equal(DOWNLOADS.windows.file, "Prism-Windows.zip");

  // and each has a direct link as a last resort
  assert.match(DOWNLOADS.mac.fallback, /releases\/latest\/download\/Prism-macOS\.zip$/);
  assert.match(DOWNLOADS.windows.fallback, /releases\/latest\/download\/Prism-Windows\.zip$/);
});

test("the UI links to exactly those urls", () => {
  const html = read("public", "index.html");
  assert.ok(html.includes(`href="${DOWNLOADS.mac.url}"`), "index.html is missing the macOS link");
  assert.ok(html.includes(`href="${DOWNLOADS.windows.url}"`), "index.html is missing the Windows link");

  // same-origin + download attribute: the browser saves the file in place
  for (const id of ["dl-mac", "dl-windows"]) {
    const tag = html.match(new RegExp(`<a[^>]*id="${id}"[^>]*>`))[0];
    assert.match(tag, /href="\/download\//);
    assert.match(tag, /\bdownload\b/);
    assert.doesNotMatch(tag, /github\.com/);
    assert.doesNotMatch(tag, /target="_blank"/);
  }

  // no "install Node first" requirement any more: the bundle carries it
  assert.doesNotMatch(html, /nodejs\.org/);
  assert.match(html, /admin rights/);
});

test("app.js uses the same same-origin urls", () => {
  const app = read("public", "app.js");
  assert.ok(app.includes(`"${DOWNLOADS.mac.url}"`));
  assert.ok(app.includes(`"${DOWNLOADS.windows.url}"`));
  // the banner link downloads in place too
  assert.match(app, /setAttribute\("download"/);
});

test("the README documents both downloads and the no-admin promise", () => {
  const readme = read("README.md");
  assert.ok(readme.includes(DOWNLOADS.mac.fallback));
  assert.ok(readme.includes(DOWNLOADS.windows.fallback));
  assert.match(readme, /Open Prism\.command/);
  assert.match(readme, /admin/i);
});

test("the bot-wall page offers the downloads only when it has to", () => {
  const offline = downloadButtonsHtml();
  assert.match(offline, /Download for Mac/);
  assert.match(offline, /Download for Windows/);
  assert.ok(offline.includes(DOWNLOADS.mac.url));
  assert.ok(offline.includes(DOWNLOADS.windows.url));
  assert.doesNotMatch(offline, /github\.com/);

  const { blockPage } = require("../lib/botwall");
  const noLive = blockPage("Cloudflare", "https://www.reddit.com/", { liveAvailable: false });
  assert.match(noLive, /Download for Mac/);
  assert.ok(noLive.includes(DOWNLOADS.mac.url));
  assert.match(noLive, /\bdownload\b/);

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
  assert.match(macScript, /server\.js/);
  // uses the portable runtime shipped in the bundle, per architecture
  assert.match(macScript, /runtime\/bin\/node/);
  assert.match(macScript, /mac-arm64/);
  assert.match(macScript, /mac-x64/);
  assert.match(macScript, /RUNTIME_ARCH/);
  assert.match(macScript, /uname -m/);
  // prefers the vendored dependencies, only falling back to npm
  assert.match(macScript, /node_modules\/express/);
  // opens the browser itself so the port is always right
  assert.match(macScript, /PRISM_OPEN=1/);
  // and never asks for elevation
  assert.doesNotMatch(macScript, /\bsudo\b/);
  assert.match(macScript, /admin/i);

  const winScript = fs.readFileSync(win, "utf8");
  assert.match(winScript, /runtime\\node\.exe/);
  assert.match(winScript, /node_modules\\express/);
  assert.match(winScript, /PRISM_OPEN=1/);
  assert.match(winScript, /healthz/);
  assert.doesNotMatch(winScript, /runas/i);
  assert.match(winScript, /administrator/i);
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
  // self-contained bundles: portable runtime + vendored deps, per platform
  assert.match(script, /--runtime/);
  assert.match(script, /--deps/);
  assert.match(script, /--platform/);
  assert.match(script, /node_modules/);
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
  // the zips must stay under Vercel's 4.5 MB response cap, or the hosted
  // download button breaks
  assert.match(workflow, /MAX_BUNDLE_BYTES/);
  assert.match(workflow, /4500000/);
  // a portable runtime is fetched for the smoke test, and the launcher's own
  // runtime bootstrap is exercised too
  assert.match(workflow, /darwin-x64/);
  assert.match(workflow, /PRISM_LAUNCHER_CHECK/);
  assert.match(workflow, /PRISM_NODE_URL/);
  // and verified before publishing, so a broken zip is never released
  assert.match(workflow, /unzip -l/);
  assert.match(workflow, /server\.js/);
  assert.match(workflow, /gh release create/);
  // the smoke test proves the bundle runs with nothing but its own runtime
  assert.match(workflow, /env -i/);
  // no runtime is shipped inside the zips any more
  assert.match(workflow, /grep -q "Prism\/runtime\/"/);
});

test("the packaging script works with a relative output directory", () => {
  // Regression: the script `cd`s into the output directory, so a relative path
  // (which is what the release workflow passes) was applied twice and the
  // step exited non-zero after building both zips.
  const { execFileSync } = require("child_process");
  const os = require("os");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "prism-pack-"));
  const rel = path.join(out, "out");

  execFileSync("bash", [path.join(ROOT, "scripts", "package.sh"), path.basename(rel)], {
    cwd: out,
    stdio: "pipe",
  });

  for (const asset of [DOWNLOADS.mac.file, DOWNLOADS.windows.file]) {
    const zip = path.join(rel, asset);
    assert.ok(fs.existsSync(zip), `${asset} was not produced`);
    assert.ok(fs.statSync(zip).size > 20000, `${asset} looks empty`);
  }

  // both launchers travel inside the bundle
  const listing = execFileSync("unzip", ["-l", path.join(rel, DOWNLOADS.mac.file)], { encoding: "utf8" });
  assert.match(listing, /Prism\/Open Prism\.command/);
  assert.match(listing, /Prism\/Open Prism\.bat/);
  assert.match(listing, /Prism\/START HERE\.txt/);
  assert.match(listing, /Prism\/lib\/live\.js/);

  // and the macOS launcher keeps its executable bit inside the zip
  const modes = execFileSync("unzip", ["-Z", path.join(rel, DOWNLOADS.mac.file), "Prism/Open Prism.command"], {
    encoding: "utf8",
  });
  assert.match(modes, /-rwx/);

  fs.rmSync(out, { recursive: true, force: true });
});

test("packaging bundles a runtime and vendored deps when asked", () => {
  const { execFileSync } = require("child_process");
  const os = require("os");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "prism-runtime-"));

  // stand in for the portable Node the release workflow downloads: any
  // executable file named node (per architecture) plus a fake node_modules
  const runtime = path.join(out, "runtimes");
  for (const arch of ["mac-arm64", "mac-x64"]) {
    fs.mkdirSync(path.join(runtime, arch, "bin"), { recursive: true });
    fs.writeFileSync(path.join(runtime, arch, "bin", "node"), "#!/bin/sh\necho v22.0.0\n", { mode: 0o755 });
  }

  const dist = path.join(out, "dist");
  execFileSync(
    "bash",
    [path.join(ROOT, "scripts", "package.sh"), "--platform", "macos", "--runtime", runtime, dist],
    { cwd: ROOT, stdio: "pipe" }
  );

  const zip = path.join(dist, DOWNLOADS.mac.file);
  assert.ok(fs.existsSync(zip), "expected a macOS bundle");

  const listing = execFileSync("unzip", ["-l", zip], { encoding: "utf8" });
  // both architectures travel in the one download
  assert.match(listing, /Prism\/runtime\/mac-arm64\/bin\/node/);
  assert.match(listing, /Prism\/runtime\/mac-x64\/bin\/node/);
  assert.match(listing, /Prism\/Open Prism\.command/);
  assert.match(listing, /Prism\/Open Prism\.bat/);
  assert.match(listing, /Prism\/START HERE\.txt/);

  fs.rmSync(out, { recursive: true, force: true });
});

test("the start-here note promises no installer and no admin", () => {
  const script = read("scripts", "package.sh");
  assert.match(script, /START HERE\.txt/);
  assert.match(script, /No installer, no admin rights/);
  assert.match(script, /read-only for normal/);
  // and it tells a Mac user the one command that avoids the Gatekeeper warning
  assert.match(script, /curl -fsSL https:\/\/prism-browser\.vercel\.app\/install\.sh \| bash/);
});

test("a default build ships no runtime and fits the hosted response budget", () => {
  const { execFileSync } = require("child_process");
  const os = require("os");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "prism-light-"));
  const { MAX_RESPONSE_BYTES } = require("../lib/downloads");

  execFileSync("bash", [path.join(ROOT, "scripts", "package.sh"), "--platform", "macos", "--deps", out], {
    cwd: ROOT,
    stdio: "pipe",
  });

  const zip = path.join(out, "Prism-macOS.zip");
  const size = fs.statSync(zip).size;
  assert.ok(size < MAX_RESPONSE_BYTES, `${size} bytes must fit a hosted response`);
  assert.ok(size < 5 * 1024 * 1024);

  const listing = execFileSync("unzip", ["-l", zip], { encoding: "utf8" });
  assert.doesNotMatch(listing, /Prism\/runtime\//, "the runtime is fetched on first launch instead");
  assert.match(listing, /Prism\/node_modules\/express/);
  assert.match(listing, /Prism\/START HERE\.txt/);

  const readme = execFileSync("unzip", ["-p", zip, "Prism/START HERE.txt"], { encoding: "utf8" });
  assert.match(readme, /no admin rights/i);
  assert.match(readme, /Node\.js/);

  // The Terminal command must be in the shipped note, spelled out in full, near
  // the top — that is what the user is told to run.
  const command = "curl -fsSL https://prism-browser.vercel.app/install.sh | bash";
  assert.ok(readme.includes(command), "START HERE must name the install command");
  assert.ok(readme.indexOf(command) < readme.indexOf("Prism unpacks its own copy"), "before the Node note");
  assert.match(readme, /Terminal/);
  assert.match(readme, /right-click -> Open/, "the zip path stays documented too");
  assert.doesNotMatch(readme, /\bsudo\b/);

  fs.rmSync(out, { recursive: true, force: true });
});
