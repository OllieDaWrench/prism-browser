"use strict";

/**
 * The macOS installer one-liner.
 *
 * macOS quarantines anything a browser downloads, and Gatekeeper then blocks an
 * unsigned launcher — a `.command` script cannot be signed at all. Files written
 * by curl carry no quarantine flag, which is what makes
 * `curl -fsSL <origin>/install.sh | bash` the one route to a launcher that opens
 * with a plain double-click and no Apple Developer account.
 *
 * These tests serve the script from a real Prism instance and then actually run
 * it against a fake home directory.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const express = require("express");
const { execFile, execFileSync } = require("child_process");

const { installerScript } = require("../lib/installer");

/**
 * Run the installer without blocking the event loop: the fake release server
 * lives in this same process, and the script has to be able to fetch from it.
 */
function runScript(scriptPath, env) {
  return new Promise((resolve) => {
    execFile("bash", [scriptPath], { env, encoding: "utf8" }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr });
    });
  });
}
const { LOCAL_DIR } = require("../lib/downloads");

const esbuildFreeBundle = () => {
  // Any zip at all: the installer only checks it starts with "PK", unpacks it,
  // and looks for a Prism directory inside.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-zip-"));
  const app = path.join(dir, "Prism");
  fs.mkdirSync(path.join(app, "lib"), { recursive: true });
  fs.writeFileSync(path.join(app, "server.js"), "// prism\n");
  fs.writeFileSync(path.join(app, "Open Prism.command"), "#!/bin/bash\necho started\n", { mode: 0o755 });
  const zip = path.join(dir, "Prism-macOS.zip");
  execFileSync("zip", ["-qry", zip, "Prism"], { cwd: dir });
  fs.rmSync(app, { recursive: true, force: true });
  return { zip, dir };
};

let server;
let origin;

test.before(async () => {
  const app = express();
  app.get(["/install.sh", "/install"], (req, res) => {
    res.type("text/plain");
    res.send(installerScript(`http://127.0.0.1:${server.address().port}`));
  });
  app.get("/download/mac", (req, res) => {
    res.download(path.join(LOCAL_DIR, "Prism-macOS.zip"), "Prism-macOS.zip");
  });
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

test("the one-liner is served as text, not as a download", async () => {
  const res = await fetch(`${origin}/install.sh`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/plain/);
  // piping into bash needs the body, so it must never be an attachment
  assert.doesNotMatch(res.headers.get("content-disposition") || "", /attachment/);
  const body = await res.text();
  assert.match(body, /^#!\/bin\/bash/);
  assert.match(body, /curl -fsSL http:\/\/127\.0\.0\.1:\d+\/install\.sh \| bash/);
});

test("the script is valid bash and never asks for elevation", () => {
  const script = installerScript("https://prism-browser.vercel.app");
  execFileSync("bash", ["-n"], { input: script });
  assert.doesNotMatch(script, /\bsudo\b/);
  assert.doesNotMatch(script, /osascript/);
  assert.match(script, /Downloading Prism/);
  assert.match(script, /xattr -dr com\.apple\.quarantine/);
  assert.match(script, /"required":true/, "a required but unconfigured site fails closed");
  assert.doesNotMatch(script, /github\.com|FALLBACK_URL/i, "downloads never bypass the site gate");
});

test("it installs into a home directory and leaves a double-clickable launcher", async (t) => {
  const { zip } = esbuildFreeBundle();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "prism-home-"));
  fs.mkdirSync(path.join(home, "Desktop"), { recursive: true });

  // the bundle the installer will fetch from this server
  const distZip = path.join(LOCAL_DIR, "Prism-macOS.zip");
  const hadDist = fs.existsSync(distZip);
  const backup = hadDist ? fs.readFileSync(distZip) : null;
  fs.mkdirSync(LOCAL_DIR, { recursive: true });
  fs.copyFileSync(zip, distZip);
  t.after(() => {
    if (hadDist) fs.writeFileSync(distZip, backup);
    else fs.rmSync(distZip, { force: true });
  });

  // uname only decides the platform guard; everything else is real
  const fakeBin = path.join(home, ".fakebin");
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, "uname"), "#!/bin/sh\necho Darwin\n", { mode: 0o755 });

  const script = await (await fetch(`${origin}/install.sh`)).text();
  const scriptPath = path.join(home, "install.sh");
  fs.writeFileSync(scriptPath, script);

  const run = await runScript(scriptPath, {
    HOME: home,
    PATH: `${fakeBin}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    PRISM_NO_START: "1",
  });
  assert.equal(run.code, 0, run.stderr || run.stdout);
  const out = run.stdout;

  assert.match(out, /Installing into .*Prism/);
  // the app landed in the home directory, not somewhere system-wide
  const dest = path.join(home, "Prism");
  assert.ok(fs.existsSync(path.join(dest, "server.js")), "app files installed");
  assert.ok(fs.statSync(path.join(dest, "Open Prism.command")).mode & 0o111, "launcher is executable");

  // and the thing the user actually clicks
  const desktop = path.join(home, "Desktop", "Prism.command");
  assert.ok(fs.existsSync(desktop), "desktop launcher created");
  const desktopScript = fs.readFileSync(desktop, "utf8");
  assert.match(desktopScript, new RegExp(`exec "${dest}/Open Prism\\.command"`));
  assert.match(desktopScript, /Open Prism\.command" "\$@"/, "the desktop launcher forwards terminal options");
  assert.equal(fs.statSync(desktop).mode & 0o111, 0o111, "launcher is executable");

  fs.rmSync(home, { recursive: true, force: true });
});

test("an upgrade keeps the downloaded Node runtime", async (t) => {
  const { zip } = esbuildFreeBundle();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "prism-home2-"));
  const dest = path.join(home, "Prism");
  fs.mkdirSync(path.join(dest, "runtime", "mac-arm64", "bin"), { recursive: true });
  fs.writeFileSync(path.join(dest, "runtime", "mac-arm64", "bin", "node"), "old");
  fs.mkdirSync(path.join(dest, ".chrome-profile"), { recursive: true });
  fs.writeFileSync(path.join(dest, ".chrome-profile", "profile-marker"), "keep me");

  const distZip = path.join(LOCAL_DIR, "Prism-macOS.zip");
  const hadDist = fs.existsSync(distZip);
  const backup = hadDist ? fs.readFileSync(distZip) : null;
  fs.mkdirSync(LOCAL_DIR, { recursive: true });
  fs.copyFileSync(zip, distZip);
  t.after(() => {
    if (hadDist) fs.writeFileSync(distZip, backup);
    else fs.rmSync(distZip, { force: true });
  });

  const fakeBin = path.join(home, ".fakebin");
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, "uname"), "#!/bin/sh\necho Darwin\n", { mode: 0o755 });
  const scriptPath = path.join(home, "install.sh");
  fs.writeFileSync(scriptPath, await (await fetch(`${origin}/install.sh`)).text());

  const run = await runScript(scriptPath, {
    HOME: home,
    PATH: `${fakeBin}:/usr/local/bin:/usr/bin:/bin`,
    PRISM_NO_START: "1",
  });
  assert.equal(run.code, 0, run.stderr || run.stdout);

  assert.match(run.stdout, /Keeping the existing Node runtime/);
  assert.equal(fs.readFileSync(path.join(dest, "runtime", "mac-arm64", "bin", "node"), "utf8"), "old");
  assert.equal(fs.readFileSync(path.join(dest, ".chrome-profile", "profile-marker"), "utf8"), "keep me");

  fs.rmSync(home, { recursive: true, force: true });
});

test("it refuses to delete anything that is not an app folder", () => {
  const script = installerScript("https://prism-browser.vercel.app");
  // the guard that matters: ~ and / are never valid targets
  assert.match(script, /refusing to install into/);
  assert.match(script, /case "\$DEST" in/);
});

test("a non-macOS system gets an explanation instead of a half install", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "prism-home3-"));
  const scriptPath = path.join(home, "install.sh");
  fs.writeFileSync(scriptPath, installerScript(origin));
  const run = await runScript(scriptPath, { HOME: home, PATH: "/usr/bin:/bin" });
  assert.notEqual(run.code, 0, "should exit non-zero off macOS");
  assert.match(run.stderr, /this installer is for macOS/);
  fs.rmSync(home, { recursive: true, force: true });
});

test("the installer has no public GitHub fallback that can bypass sign-in", () => {
  const script = installerScript("https://prism-browser.vercel.app");
  assert.doesNotMatch(script, /github\.com|FALLBACK_URL/i);
});

test("the installer asks for a six-digit number and password before downloading", () => {
  const script = installerScript("https://prism.example");

  // without this prompt, anyone with the one-liner gets the bundle
  assert.match(script, /Six-digit number:/);
  assert.match(script, /Password:/);
  assert.match(script, /stty -echo/, "the password must not be echoed");
  assert.match(script, /\/api\/auth\/token/, "credentials are exchanged for a token");
  assert.match(script, /\?token=/, "the download carries that token");

  // only prompt when the site says it is private: a copy with no secret has
  // nobody to sign in as
  assert.match(script, /"configured":true/);

  // non-interactive runs get a clear message instead of hanging on /dev/tty
  assert.match(script, /PRISM_NUMBER/);
  assert.match(script, /PRISM_PASSWORD/);
});

test("the generated installer is valid shell", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { execFileSync } = require("node:child_process");

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "prism-inst-")), "install.sh");
  fs.writeFileSync(file, installerScript("https://prism.example"));
  // bash -n parses without running: the cheapest guard against a broken one-liner
  execFileSync("bash", ["-n", file]);
});
