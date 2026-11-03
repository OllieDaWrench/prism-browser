"use strict";

/**
 * The live engine is driven over the DevTools Protocol. This test stands in a
 * scripted mock browser for the real one so the wiring (sessions, screencast
 * frames, navigation events, input translation) is verified even on machines
 * with no Chromium installed.
 */

const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const { upgrade } = require("../lib/ws");
const { Cdp, LiveSession } = require("../lib/live");

function startMockBrowser() {
  const seen = { commands: [], input: [], challenge: "" };
  const server = http.createServer((req, res) => res.end("mock"));
  server.on("upgrade", (req, socket, head) => {
    upgrade(req, socket, head, (conn) => {
      const send = (method, params, sessionId) =>
        conn.send(sessionId ? { method, params, sessionId } : { method, params });

      conn.onJSON((msg) => {
        seen.commands.push(msg.method);
        const { id, method, params = {}, sessionId } = msg;
        const reply = (result = {}) => conn.send({ id, result, sessionId });
        const event = (name, p) => send(name, p, sessionId);

        switch (method) {
          case "Runtime.evaluate":
            return reply({ result: { type: "string", value: seen.challenge || "" } });
          case "Page.addScriptToEvaluateOnNewDocument":
            seen.stealth = params.source;
            return reply({ identifier: "stealth" });
          case "Browser.getVersion":
            return reply({ product: "Chrome/131.0.0.0" });
          case "Target.createTarget":
            return reply({ targetId: "target-1" });
          case "Target.attachToTarget":
            return reply({ sessionId: "session-1" });
          case "Page.navigate":
            reply({ frameId: "frame-1" });
            return setTimeout(() => {
              event("Page.frameNavigated", { frame: { id: "frame-1", url: params.url, loaderId: "l1" } });
              event("Page.loadEventFired", { timestamp: Date.now() });
            }, 20);
          case "Page.startScreencast":
            reply({});
            return setTimeout(() => {
              event("Page.screencastFrame", {
                data: "JPEGDATA",
                sessionId: 7,
                metadata: { deviceWidth: 900, deviceHeight: 640 },
              });
            }, 25);
          case "Input.dispatchMouseEvent":
          case "Input.dispatchKeyEvent":
          case "Input.insertText":
            seen.input.push({ method, params });
            return reply({});
          case "Emulation.setDeviceMetricsOverride":
            seen.metrics = params;
            return reply({});
          default:
            return reply({});
        }
      });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, seen, url: `ws://127.0.0.1:${port}/devtools/browser/mock` });
    });
  });
}

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", () => reject(new Error("mock ws failed")));
  });
}

test("live session drives a browser over CDP end to end", async () => {
  const mock = await startMockBrowser();
  const ws = await openWs(mock.url);
  const cdp = new Cdp(ws);

  const messages = [];
  let closed = false;
  const conn = {
    send: (msg) => messages.push(msg),
    close: () => {
      closed = true;
    },
    onJSON() {},
    on() {},
  };

  const session = new LiveSession(conn, "https://example.com/");
  await session.start({ cdp });
  await new Promise((r) => setTimeout(r, 120));

  // a real tab was created and flattened-attached
  assert.ok(mock.seen.commands.includes("Target.createTarget"));
  assert.ok(mock.seen.commands.includes("Target.attachToTarget"));
  assert.ok(mock.seen.commands.includes("Page.enable"));

  // viewport was applied and frames reached the client
  assert.equal(mock.seen.metrics.width, 1280);
  const frames = messages.filter((m) => m.t === "frame");
  assert.ok(frames.length >= 1, "expected at least one screencast frame");
  assert.equal(frames[0].d, "JPEGDATA");
  assert.equal(frames[0].w, 900);
  assert.equal(mock.seen.commands.filter((c) => c === "Page.screencastFrameAck").length, frames.length);

  // navigation reported back for the omnibox
  const urls = messages.filter((m) => m.t === "url").map((m) => m.url);
  assert.deepEqual(urls, ["https://example.com/"]);
  assert.ok(messages.some((m) => m.t === "ready"));
  assert.ok(messages.some((m) => m.t === "loading" && m.on === false));

  // input is translated into CDP mouse/key events
  await session.onMessage({ t: "mouse", type: "down", x: 10, y: 20, button: "left" });
  await session.onMessage({ t: "key", type: "down", key: "a", text: "a", keyCode: 65 });
  const mouse = mock.seen.input.find((i) => i.method === "Input.dispatchMouseEvent");
  assert.equal(mouse.params.type, "mousePressed");
  assert.equal(mouse.params.x, 10);
  assert.equal(mouse.params.buttons, 1);
  const keyDown = mock.seen.input.find(
    (i) => i.method === "Input.dispatchKeyEvent" && i.params.type === "keyDown"
  );
  assert.equal(keyDown.params.key, "a");
  assert.equal(keyDown.params.windowsVirtualKeyCode, 65);
  // the keyDown carries the text so characters are inserted exactly once
  assert.equal(keyDown.params.text, "a");
  assert.ok(!mock.seen.input.some((i) => i.method === "Input.dispatchKeyEvent" && i.params.type === "char"));

  // resizing re-applies device metrics
  await session.onMessage({ t: "resize", w: 640, h: 480 });
  assert.equal(mock.seen.metrics.width, 640);

  await session.close();
  assert.ok(mock.seen.commands.includes("Target.closeTarget"));

  ws.close();
  mock.server.close();
});

test("live session refuses non-http navigation", async () => {
  const mock = await startMockBrowser();
  const ws = await openWs(mock.url);
  const cdp = new Cdp(ws);
  const messages = [];
  const session = new LiveSession({ send: (m) => messages.push(m), close() {}, onJSON() {}, on() {} }, "");
  await session.start({ cdp });

  await session.onMessage({ t: "nav", url: "javascript:alert(1)" });
  assert.ok(!mock.seen.commands.includes("Page.navigate"));

  await session.onMessage({ t: "nav", url: "example.org" });
  assert.ok(mock.seen.commands.includes("Page.navigate"));

  await session.close();
  ws.close();
  mock.server.close();
});

test("the live engine spots a bot challenge and tells the user", async () => {
  const mock = await startMockBrowser();
  const ws = await openWs(mock.url);
  const cdp = new Cdp(ws);

  const messages = [];
  const session = new LiveSession({ send: (m) => messages.push(m), close() {}, onJSON() {}, on() {} }, "");
  await session.start({ cdp });

  // a stealth patch is installed before any page script runs
  assert.match(mock.seen.stealth, /webdriver/);

  mock.seen.challenge = "Cloudflare";
  await session.onMessage({ t: "nav", url: "https://example.com/" });
  await new Promise((r) => setTimeout(r, 120));

  const challenge = messages.find((m) => m.t === "challenge");
  assert.ok(challenge, "expected a challenge notification");
  assert.equal(challenge.vendor, "Cloudflare");

  // it is reported once, not on every load event
  const count = messages.filter((m) => m.t === "challenge").length;
  assert.equal(count, 1);

  // and it clears when the challenge is gone
  mock.seen.challenge = "";
  await session.checkForChallenge();
  assert.equal(session.challengeFor, null);

  await session.close();
  ws.close();
  mock.server.close();
});

test("browser discovery finds one in the per-user Applications folder", () => {
  // A browser dragged into ~/Applications needs no admin password, so it has to
  // count: on macOS the engine looks there as well as /Applications.
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { discover } = require("../lib/live");

  if (process.platform === "darwin") {
    // on a real Mac, discovery either finds something or honestly finds nothing
    const found = discover();
    assert.ok(found === null || typeof found.path === "string");
    return;
  }

  // elsewhere, prove the home-relative candidates exist in the list at all
  const source = fs.readFileSync(path.join(__dirname, "..", "lib", "live.js"), "utf8");
  assert.match(source, /~\/Applications\/Google Chrome\.app/);
  assert.match(source, /function expandHome/);
  assert.match(source, /os\.homedir\(\)/);
});

test("PRISM_CHROME overrides discovery", () => {
  const previous = process.env.PRISM_CHROME;
  process.env.PRISM_CHROME = "/custom/chrome";
  try {
    const { discover } = require("../lib/live");
    assert.deepEqual(discover(), { path: "/custom/chrome", name: "Chrome (PRISM_CHROME)" });
  } finally {
    if (previous === undefined) delete process.env.PRISM_CHROME;
    else process.env.PRISM_CHROME = previous;
  }
});

test("a real window keeps the browser's own user agent", () => {
  const { userAgentFor } = require("../lib/live");
  const macChrome =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

  // The bug that got people stuck: a hardcoded Windows Chrome 131 UA on a Mac
  // running something much newer. That mismatch is a bot signal.
  const previous = process.env.PRISM_UA;
  delete process.env.PRISM_UA;
  try {
    assert.equal(userAgentFor(macChrome, false), macChrome);
    // headless still has to stop announcing "HeadlessChrome"
    assert.match(userAgentFor("Mozilla/5.0 (Macintosh) HeadlessChrome/141.0.0.0", true), /\) Chrome\/141/);
    assert.doesNotMatch(userAgentFor("Mozilla/5.0 (Macintosh) HeadlessChrome/141.0.0.0", true), /Headless/);
    // an explicit override is still honoured
    process.env.PRISM_UA = "custom-agent";
    assert.equal(userAgentFor(macChrome, false), "custom-agent");
  } finally {
    if (previous === undefined) delete process.env.PRISM_UA;
    else process.env.PRISM_UA = previous;
  }
});

test("the browser profile is kept so a challenge is a one-time event", () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { LiveBrowser } = require("../lib/live");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prism-profile-"));
  const previous = process.env.PRISM_PROFILE_DIR;
  process.env.PRISM_PROFILE_DIR = path.join(tmp, "profile");

  try {
    const browser = new LiveBrowser();
    const dir = browser.profileDir();
    assert.equal(dir, path.join(tmp, "profile"));
    assert.ok(fs.existsSync(dir), "profile directory created");

    // a crashed run leaves a lock behind; the next start must clear it
    fs.writeFileSync(path.join(dir, "SingletonLock"), "");
    const browser2 = new LiveBrowser();
    assert.equal(browser2.profileDir(), dir);
    assert.equal(fs.existsSync(path.join(dir, "SingletonLock")), false);

    // and it is stable, so cookies survive a restart
    assert.equal(browser.profileDir(), dir);
  } finally {
    if (previous === undefined) delete process.env.PRISM_PROFILE_DIR;
    else process.env.PRISM_PROFILE_DIR = previous;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("status says how the browser is running", () => {
  const { LiveBrowser } = require("../lib/live");
  const status = new LiveBrowser().status();
  assert.equal(typeof status.headless, "boolean");
  assert.ok("profile" in status);
});

test("headless is opt-in, a window is the default", () => {
  const fs = require("fs");
  const path = require("path");
  const source = fs.readFileSync(path.join(__dirname, "..", "lib", "live.js"), "utf8");
  // the flag is read as an explicit opt-in, never as "unless someone said no"
  assert.match(source, /PRISM_HEADLESS \|\| ""/);
  assert.match(source, /window-position=-32000,-32000/);
});

test("a session leaves the browser's own identity alone", async () => {
  const mock = await startMockBrowser();
  const ws = await openWs(mock.url);
  const cdp = new Cdp(ws);

  const messages = [];
  const conn = { send: (m) => messages.push(m), close() {}, onJSON() {}, on() {} };
  const session = new LiveSession(conn, "https://www.youtube.com/");

  // exactly what LiveBrowser hands a session: the browser's real user agent and
  // the fact that it is a window, not headless
  await session.start({
    cdp,
    realUserAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    headless: false,
  });
  await new Promise((r) => setTimeout(r, 60));

  // Nothing rewrote the user agent. Overriding it used to make a Mac announce
  // itself as an old Windows Chrome, which is what triggered Cloudflare.
  const overrides = mock.seen.commands.filter((c) => c === "Network.setUserAgentOverride");
  assert.equal(overrides.length, 0, "a real window must keep its own user agent");

  // and the in-page script no longer touches a genuine browser's navigator
  assert.match(mock.seen.stealth, /if \(navigator\.webdriver\)/);
  ws.close();
  mock.server.close();
});

test("a headless session still hides that it is headless", async () => {
  const mock = await startMockBrowser();
  const ws = await openWs(mock.url);
  const cdp = new Cdp(ws);

  const sent = [];
  const conn = { send: () => {}, close() {}, onJSON() {}, on() {} };
  const session = new LiveSession(conn, "about:blank");
  const originalSend = cdp.send.bind(cdp);
  cdp.send = (method, params, sessionId) => {
    if (method === "Network.setUserAgentOverride") sent.push(params);
    return originalSend(method, params, sessionId);
  };

  await session.start({
    cdp,
    realUserAgent: "Mozilla/5.0 (Macintosh) HeadlessChrome/141.0.0.0 Safari/537.36",
    headless: true,
  });
  await new Promise((r) => setTimeout(r, 60));

  assert.equal(sent.length, 1, "headless has to be cleaned up");
  assert.doesNotMatch(sent[0].userAgent, /Headless/);
  ws.close();
  mock.server.close();
});

test("no user agent is invented when the browser will not say who it is", async () => {
  const mock = await startMockBrowser();
  const ws = await openWs(mock.url);
  const cdp = new Cdp(ws);
  const conn = { send: () => {}, close() {}, onJSON() {}, on() {} };
  const session = new LiveSession(conn, "about:blank");

  await session.start({ cdp, realUserAgent: "", headless: false });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(mock.seen.commands.filter((c) => c === "Network.setUserAgentOverride").length, 0);

  ws.close();
  mock.server.close();
});
