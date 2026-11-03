"use strict";

/**
 * Drives the real browser UI (public/app.js) against a fake window so the
 * engine choice, navigation and live-stream handling are covered without a
 * display. Skips itself when jsdom is not installed (it is a devDependency).
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

let JSDOM;
try {
  ({ JSDOM } = require("jsdom"));
} catch {
  JSDOM = null;
}
if (!JSDOM) {
  console.log("ui.test.js: jsdom is not installed, skipping UI tests (npm i --no-save jsdom)");
}

const ORIGIN = "http://127.0.0.1:4321";
const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8").replace(
  /<script src="\/app\.js"><\/script>/,
  ""
);
const appJs = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

class FakeWebSocket {
  static instances = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  constructor(url) {
    this.url = url;
    this.readyState = 1; // OPEN
    this.listeners = {};
    this.sent = [];
    FakeWebSocket.instances.push(this);
    setTimeout(() => this.dispatch("open", {}), 0);
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  dispatch(type, event) {
    for (const fn of this.listeners[type] || []) fn(event);
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.dispatch("close", {});
  }
}

function liveStatus(available) {
  return available
    ? {
        engine: "live",
        available: true,
        state: "ready",
        browser: "Chrome · Chrome/131",
        reason: "",
        hint: "",
      }
    : {
        engine: "live",
        available: false,
        state: "unavailable",
        browser: null,
        reason: "No Chrome, Edge or Chromium installation was found.",
        hint: "Install a Chromium browser.",
      };
}

function makeUi(available, serverOptions = {}) {
  const { pathRewrites = true, proxyEndpoint = true, hosted = false } = serverOptions;
  const dom = new JSDOM(html, {
    url: ORIGIN + "/",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      FakeWebSocket.instances = [];
      window.WebSocket = FakeWebSocket;
      window.fetch = async (url, init) => {
        const href = String(url);
        if (href.includes("/live/status")) {
          return {
            ok: true,
            headers: { get: () => null },
            json: async () => ({ ...liveStatus(available), hosted }),
          };
        }
        // the transport probes
        if (href.startsWith("/https/!invalid-host!/")) {
          if (!pathRewrites) throw new Error("404 from host");
          return { ok: false, headers: { get: (k) => (k.toLowerCase() === "x-prism-proxy" ? "1" : null) } };
        }
        if (href === "/api/proxy") {
          if (!proxyEndpoint) {
            return { ok: false, headers: { get: () => null } };
          }
          return { ok: false, headers: { get: (k) => (k.toLowerCase() === "x-prism-proxy" ? "1" : null) } };
        }
        return { ok: true, headers: { get: () => null }, json: async () => ({}) };
      };
      window.ResizeObserver = undefined;
    },
  });
  const { window } = dom;
  window.eval(appJs);
  return dom;
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function submit(window, selector, value) {
  const input = window.document.querySelector(selector);
  input.value = value;
  const form = input.closest("form");
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
}

test("proxy-only machine: search goes to the HTML search endpoint", { skip: !JSDOM && "jsdom not installed" }, async () => {
  const dom = makeUi(false);
  const { window } = dom;
  await tick();

  assert.match(window.document.getElementById("engine-note").textContent, /Proxy engine only/);
  assert.equal(window.document.getElementById("engine-label").textContent, "Proxy");

  submit(window, "#start-q", "prism browser");
  await tick();

  const iframe = window.document.getElementById("view");
  assert.match(iframe.src, /duckduckgo\.com\/html\/\?q=prism%20browser/);
  assert.equal(window.document.getElementById("start").hidden, true);
  assert.equal(iframe.hidden, false);
  assert.equal(window.document.getElementById("back").disabled, true);
  dom.window.close();
});

test("proxy-only machine: an address is mapped onto the proxy path", { skip: !JSDOM && "jsdom not installed" }, async () => {
  const dom = makeUi(false);
  const { window } = dom;
  await tick();

  submit(window, "#start-q", "wikipedia.org");
  await tick();

  assert.equal(window.document.getElementById("view").src, `${ORIGIN}/https/wikipedia.org/`);

  // a second navigation enables Back
  submit(window, "#url", "example.com/page");
  await tick();
  assert.equal(window.document.getElementById("view").src, `${ORIGIN}/https/example.com/page`);
  assert.equal(window.document.getElementById("back").disabled, false);

  window.document.getElementById("back").click();
  await tick();
  assert.equal(window.document.getElementById("view").src, `${ORIGIN}/https/wikipedia.org/`);
  dom.window.close();
});

test("a failing proxied page offers live mode when it exists", { skip: !JSDOM && "jsdom not installed" }, async () => {
  const dom = makeUi(true);
  const { window } = dom;
  await tick();

  window.postMessage({ type: "prism-proxy-error" }, "*");
  await tick();
  const banner = window.document.getElementById("banner");
  assert.equal(banner.hidden, false);
  assert.match(window.document.getElementById("banner-text").textContent, /real browser/);
  assert.equal(window.document.getElementById("banner-action").textContent, "Switch to Live");
  dom.window.close();
});

test("live machine: js-heavy sites open in the live engine and stream frames", { skip: !JSDOM && "jsdom not installed" }, async () => {
  const dom = makeUi(true);
  const { window } = dom;
  await tick();

  assert.match(window.document.getElementById("engine-note").textContent, /Live browser ready/);

  submit(window, "#url", "chatgpt.com");
  await tick();

  const sockets = FakeWebSocket.instances;
  assert.equal(sockets.length, 1);
  assert.match(sockets[0].url, /^ws:\/\/127\.0\.0\.1:4321\/live\/ws\?url=https%3A%2F%2Fchatgpt\.com%2F$/);
  assert.equal(window.document.getElementById("live").hidden, false);
  assert.equal(window.document.getElementById("view").hidden, true);

  // the server announces itself, then streams a JPEG frame
  sockets[0].dispatch("message", {
    data: JSON.stringify({ t: "ready", url: "https://chatgpt.com/" }),
  });
  sockets[0].dispatch("message", {
    data: JSON.stringify({ t: "url", url: "https://chatgpt.com/auth/login" }),
  });
  sockets[0].dispatch("message", {
    data: JSON.stringify({ t: "frame", d: "FRAMEBYTES", w: 1440, h: 900 }),
  });
  await tick();

  assert.equal(window.document.getElementById("url").value, "https://chatgpt.com/auth/login");
  assert.match(window.document.getElementById("live-frame").src, /^data:image\/jpeg;base64,FRAMEBYTES$/);
  assert.equal(window.document.getElementById("live-frame").dataset.viewport, "1440x900");

  // input is forwarded to the live browser
  const frame = window.document.getElementById("live-frame");
  frame.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1440, height: 900 });
  const down = new window.MouseEvent("mousedown", { bubbles: true, clientX: 100, clientY: 50 });
  window.document.getElementById("live").dispatchEvent(down);
  await tick();
  const mouse = sockets[0].sent.find((m) => m.t === "mouse");
  assert.deepEqual(
    { type: mouse.type, x: mouse.x, y: mouse.y },
    { type: "down", x: 100, y: 50 }
  );

  // back inside live mode navigates the same session
  submit(window, "#url", "reddit.com");
  await tick();
  const nav = sockets[0].sent.find((m) => m.t === "nav");
  assert.equal(nav.url, "https://reddit.com/");
  dom.window.close();
});

test("live failure falls back to a clear explanation", { skip: !JSDOM && "jsdom not installed" }, async () => {
  const dom = makeUi(true);
  const { window } = dom;
  await tick();

  submit(window, "#url", "twitch.tv");
  await tick();
  const socket = FakeWebSocket.instances[0];
  socket.dispatch("message", {
    data: JSON.stringify({ t: "error", message: "Live engine failed: boom", hint: "install chromium" }),
  });
  await tick();

  assert.equal(window.document.getElementById("live-overlay").hidden, false);
  assert.match(window.document.getElementById("live-reason").textContent, /boom/);
  assert.equal(window.document.getElementById("engine-label").textContent, "Proxy");
  dom.window.close();
});

test("the engine pill pins an engine and remembers it", { skip: !JSDOM && "jsdom not installed" }, async () => {
  const dom = makeUi(true);
  const { window } = dom;
  await tick();

  const pill = window.document.getElementById("engine");
  assert.equal(window.localStorage.getItem("prism:engine"), null);
  pill.click();
  await tick();
  // auto -> live
  assert.equal(window.localStorage.getItem("prism:engine"), "live");
  assert.equal(window.document.getElementById("engine-label").textContent, "Live");
  pill.click();
  await tick();
  assert.equal(window.localStorage.getItem("prism:engine"), "proxy");
  assert.equal(window.document.getElementById("engine-label").textContent, "Proxy");
  dom.window.close();
});

test("hosted deploy with dead path rewrites falls back to the rewrite-free endpoint", async () => {
  if (!JSDOM) return;
  const dom = makeUi(false, { hosted: true, pathRewrites: false, proxyEndpoint: true });
  const { window } = dom;
  await tick(60);

  submit(window, "#start-q", "example.com");
  await tick();

  assert.equal(
    window.document.getElementById("view").src,
    `${ORIGIN}/api/proxy?url=${encodeURIComponent("https://example.com/")}`
  );
  assert.match(window.document.getElementById("engine-note").textContent, /Hosted copy/);
  // the banner now carries the "get the local app" link rather than hiding
  assert.match(window.document.getElementById("banner-text").textContent, /Hosted copy/);
  dom.window.close();
});

test("working path rewrites are preferred even on a hosted deploy", async () => {
  if (!JSDOM) return;
  const dom = makeUi(false, { hosted: true, pathRewrites: true });
  const { window } = dom;
  await tick(60);

  submit(window, "#start-q", "example.com");
  await tick();
  assert.equal(window.document.getElementById("view").src, `${ORIGIN}/https/example.com/`);
  dom.window.close();
});

test("a deploy with no proxy at all says so instead of showing a blank page", async () => {
  if (!JSDOM) return;
  const dom = makeUi(false, { hosted: true, pathRewrites: false, proxyEndpoint: false });
  const { window } = dom;
  await tick(60);

  const banner = window.document.getElementById("banner");
  assert.equal(banner.hidden, false);
  assert.match(window.document.getElementById("banner-text").textContent, /cannot proxy/);
  assert.match(window.document.getElementById("engine-note").textContent, /not running its proxy/);
  dom.window.close();
});

test("a Cloudflare-blocked page is escalated to Live mode automatically", async () => {
  if (!JSDOM) return;
  const dom = makeUi(true);
  const { window } = dom;
  await tick();

  submit(window, "#url", "reddit.com");
  await tick();
  // auto mode sends reddit to live anyway; force proxy to model a site that
  // only reveals its bot wall through the proxy
  window.localStorage.setItem("prism:engine", "proxy");
  window.document.getElementById("view").dispatchEvent(new window.Event("load"));
  submit(window, "#url", "news.example.com");
  await tick();
  assert.match(window.document.getElementById("view").src, /\/https\/news\.example\.com\//);

  window.postMessage(
    { type: "prism-blocked", vendor: "Cloudflare", url: "https://news.example.com/" },
    "*"
  );
  await tick();

  // it switched to the live engine and said why
  assert.match(window.document.getElementById("banner-text").textContent, /Cloudflare challenged this page/);
  assert.equal(window.document.getElementById("engine-label").textContent, "Live");
  // a live session is showing, and it is pointed at the blocked page — either a
  // fresh socket or a nav command on the session that is already open
  assert.equal(window.document.getElementById("live").hidden, false);
  const liveSessions = FakeWebSocket.instances.filter((s) => s.url.includes("/live/ws"));
  assert.ok(liveSessions.length >= 1, "expected a live session");
  const pointedAtNews = liveSessions.some(
    (s) =>
      s.url.includes("news.example.com") ||
      s.sent.some((m) => m.t === "nav" && m.url.includes("news.example.com"))
  );
  assert.ok(pointedAtNews, "the live session should be navigating to the blocked page");

  // and it does not ping-pong: a second wall on the same url stays in live
  const before = FakeWebSocket.instances.length;
  window.postMessage(
    { type: "prism-blocked", vendor: "Cloudflare", url: "https://news.example.com/" },
    "*"
  );
  await tick();
  assert.equal(FakeWebSocket.instances.length, before);
  dom.window.close();
});

test("without Live mode a Cloudflare block explains how to get through", async () => {
  if (!JSDOM) return;
  const dom = makeUi(false, { hosted: true });
  const { window } = dom;
  await tick();

  window.postMessage(
    { type: "prism-blocked", vendor: "Cloudflare", url: "https://www.reddit.com/" },
    "*"
  );
  await tick();

  assert.match(
    window.document.getElementById("banner-text").textContent,
    /Cloudflare blocks the hosted proxy|Cloudflare blocks the proxy engine/
  );
  assert.equal(window.document.getElementById("banner-action").textContent, "How?");

  // the explanation points at the download instead of at a terminal command
  window.document.getElementById("banner-action").click();
  await tick();
  assert.equal(window.document.getElementById("live-overlay").hidden, false);
  assert.match(window.document.getElementById("live-reason").textContent, /hosted copy/i);
  assert.equal(
    window.document.getElementById("dl-mac").getAttribute("href"),
    require("../lib/desktop").DOWNLOADS.mac.url
  );
  // and that button is a way into the download pop-up, not a dead end
  assert.equal(window.document.getElementById("dl-mac").hasAttribute("data-download-open"), true);
  dom.window.close();
});

test("a live-mode challenge points at the checkbox instead of hanging", async () => {
  if (!JSDOM) return;
  const dom = makeUi(true);
  const { window } = dom;
  await tick();

  submit(window, "#url", "twitch.tv");
  await tick();
  const socket = FakeWebSocket.instances.find((s) => s.url.includes("/live/ws"));
  socket.dispatch("message", {
    data: JSON.stringify({ t: "challenge", vendor: "Cloudflare", url: "https://twitch.tv/" }),
  });
  await tick();

  const bannerText = window.document.getElementById("banner-text").textContent;
  assert.match(bannerText, /does not trust the browser Prism started/);
  assert.match(bannerText, /checkbox/);
  // and it offers the route that actually works: the user's own browser
  assert.equal(window.document.getElementById("banner-action").textContent, "Open in my Chrome");
  dom.window.close();
});

test("a challenge banner can hand the page to the real browser", async () => {
  if (!JSDOM) return;
  const dom = makeUi(true);
  const { window } = dom;
  await tick();

  const opened = [];
  window.fetch = async (url, init) => {
    opened.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
    return { ok: true, json: async () => ({ ok: true }) };
  };

  submit(window, "#url", "youtube.com");
  await tick();
  const socket = FakeWebSocket.instances.find((s) => s.url.includes("/live/ws"));
  socket.dispatch("message", {
    data: JSON.stringify({ t: "challenge", vendor: "Cloudflare", url: "https://youtube.com/" }),
  });
  await tick();

  window.document.getElementById("banner-action").click();
  await tick();

  assert.equal(opened.length, 1);
  assert.equal(opened[0].url, "/open");
  assert.equal(opened[0].body.url, "https://youtube.com/");
  dom.window.close();
});

test("a hosted copy shows working download links for both platforms", async () => {
  if (!JSDOM) return;
  const dom = makeUi(false, { hosted: true });
  const { window } = dom;
  await tick(60);

  const { DOWNLOADS } = require("../lib/desktop");
  const absolute = (url) => new URL(url, window.location.origin).href;

  // the banner offers a way out as soon as the app boots, and it opens the
  // download pop-up rather than jumping straight to a file
  const bannerLink = window.document.querySelector(".banner-link");
  assert.ok(bannerLink, "expected a download link in the banner");
  assert.equal(bannerLink.hidden, false);
  assert.equal(bannerLink.href, absolute(DOWNLOADS.mac.url));
  assert.equal(bannerLink.hasAttribute("data-download-open"), true);

  // and the "live unavailable" card is explicit about both platforms
  const mac = window.document.getElementById("dl-mac");
  const win = window.document.getElementById("dl-windows");
  assert.equal(mac.getAttribute("href"), DOWNLOADS.mac.url);
  assert.equal(win.getAttribute("href"), DOWNLOADS.windows.url);
  assert.match(mac.textContent, /Download for Mac/);
  assert.match(win.textContent, /Download for Windows/);
  // the href stays so the button still works without JavaScript
  assert.equal(mac.hasAttribute("download"), true);
  assert.equal(win.hasAttribute("download"), true);

  // and the card explains why the hosted copy cannot do it itself
  window.postMessage({ type: "prism-blocked", vendor: "Cloudflare", url: "https://reddit.com/" }, "*");
  await tick();
  window.document.getElementById("banner-action").click();
  await tick();
  assert.equal(window.document.getElementById("live-overlay").hidden, false);
  assert.match(window.document.getElementById("live-reason").textContent, /hosted copy/i);
  assert.match(window.document.getElementById("live-hint").textContent, /Chrome|Edge|browser/i);
  dom.window.close();
});

test("the bot wall on a hosted copy points at the downloads", async () => {
  if (!JSDOM) return;
  const dom = makeUi(false, { hosted: true });
  const { window } = dom;
  await tick(60);

  window.postMessage(
    { type: "prism-blocked", vendor: "Cloudflare", url: "https://www.reddit.com/" },
    "*"
  );
  await tick();

  const bannerLink = window.document.querySelector(".banner-link");
  assert.ok(bannerLink && !bannerLink.hidden, "expected a download link next to the wall explanation");
  assert.equal(
    bannerLink.href,
    new URL(require("../lib/desktop").DOWNLOADS.mac.url, window.location.origin).href
  );
  assert.equal(bannerLink.hasAttribute("data-download-open"), true);
  assert.match(window.document.getElementById("banner-text").textContent, /blocks the hosted proxy|blocks the proxy engine/);
  dom.window.close();
});

test("a local install is not nagged with download links", async () => {
  if (!JSDOM) return;
  const dom = makeUi(false, { hosted: false });
  const { window } = dom;
  await tick(60);

  const bannerLink = window.document.querySelector(".banner-link");
  assert.ok(!bannerLink || bannerLink.hidden, "a local install should not be told to download Prism");
  dom.window.close();
});

test("clicking Download opens a pop-up with the command and the zips", async () => {
  if (!JSDOM) return;
  const dom = makeUi(false, { hosted: true });
  const { window } = dom;
  await tick(60);

  const doc = window.document;
  const modal = doc.getElementById("download-modal");
  // nothing is in the way until you ask for a download
  assert.equal(modal.hidden, true);

  // the button the user actually presses
  doc.getElementById("dl-mac").click();
  assert.equal(modal.hidden, false, "clicking Download opens the pop-up");

  // it shows the Terminal command, ready to copy, pointing at this origin
  const command = doc.getElementById("install-cmd").textContent.trim();
  assert.equal(command, `curl -fsSL ${window.location.origin}/install.sh | bash`);

  // and both zip files, as real downloads
  const mac = doc.getElementById("modal-dl-mac");
  const win = doc.getElementById("modal-dl-windows");
  assert.equal(mac.getAttribute("href"), "/download/mac");
  assert.equal(win.getAttribute("href"), "/download/windows");
  assert.equal(mac.hasAttribute("download"), true);
  assert.equal(win.hasAttribute("download"), true);

  // Escape closes it and focus goes back to the button that opened it
  const event = new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  doc.dispatchEvent(event);
  assert.equal(modal.hidden, true);
  // jsdom does not move focus the way a browser does, so the focus-restore
  // behaviour is only checked here for the state that does matter: the panel is
  // hidden and the page is scrollable again
  assert.equal(doc.body.classList.contains("modal-open"), false);

  // and so does the close button / backdrop
  doc.getElementById("dl-windows").click();
  assert.equal(modal.hidden, false);
  doc.getElementById("download-close").click();
  assert.equal(modal.hidden, true);

  doc.getElementById("dl-mac").click();
  assert.equal(modal.hidden, false);
  doc.querySelector(".modal-backdrop").click();
  assert.equal(modal.hidden, true);

  dom.window.close();
});

test("the start screen can open the pop-up before anything fails", async () => {
  if (!JSDOM) return;
  const dom = makeUi(false, { hosted: true });
  const { window } = dom;
  await tick(60);

  const doc = window.document;
  const opener = doc.querySelector("#start [data-download-open]");
  assert.ok(opener, "expected a download trigger on the start screen");
  assert.equal(doc.getElementById("download-modal").hidden, true);

  opener.click();
  assert.equal(doc.getElementById("download-modal").hidden, false);
  // the command carries a real origin, so it can be pasted as-is
  assert.match(doc.getElementById("install-cmd").textContent, /curl -fsSL http:\/\/127\.0\.0\.1:4321\/install\.sh \| bash/);

  dom.window.close();
});
