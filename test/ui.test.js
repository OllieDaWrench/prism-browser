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

function makeUi(available) {
  const dom = new JSDOM(html, {
    url: ORIGIN + "/",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      FakeWebSocket.instances = [];
      window.WebSocket = FakeWebSocket;
      window.fetch = async (url) => {
        if (String(url).includes("/live/status")) {
          return { ok: true, json: async () => liveStatus(available) };
        }
        return { ok: true, json: async () => ({}) };
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
