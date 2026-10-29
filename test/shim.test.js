"use strict";

/**
 * The injected shim is the piece of the proxy that runs inside every page, so
 * it is verified here against a tiny fake DOM rather than by eye.
 */

const test = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const { boot } = require("../lib/shim");

const PAGE = "https://example.com/dir/page?q=1";
const PREFIX = "/https/example.com";

function makeEnv(page = PAGE) {
  const calls = { fetch: [], xhr: [], ws: [], history: [], cookies: [], opened: [] };

  class FakeDocument {
    addEventListener() {}
    get cookie() {
      return "existing=1";
    }
    set cookie(value) {
      calls.cookies.push(value);
    }
  }

  class FakeXhr {
    open(method, url) {
      calls.xhr.push(url);
    }
  }

  class FakeWebSocket {
    constructor(url) {
      calls.ws.push(url);
    }
  }
  FakeWebSocket.CONNECTING = 0;
  FakeWebSocket.OPEN = 1;
  FakeWebSocket.CLOSING = 2;
  FakeWebSocket.CLOSED = 3;

  class FakeEventSource {
    constructor(url) {
      calls.xhr.push(url);
    }
  }

  const location = {
    protocol: "https:",
    host: "prism.local",
    origin: "https://prism.local",
    href: "https://prism.local" + PREFIX + "/dir/page?q=1",
    assign(url) {
      calls.opened.push(url);
    },
  };

  const windowObj = {
    __prismShim: false,
    fetch(url) {
      calls.fetch.push(url);
      return Promise.resolve({});
    },
    XMLHttpRequest: FakeXhr,
    WebSocket: FakeWebSocket,
    EventSource: FakeEventSource,
    history: {
      pushState(state, title, url) {
        calls.history.push(url);
      },
      replaceState(state, title, url) {
        calls.history.push(url);
      },
    },
    open(url) {
      calls.opened.push(url);
    },
    location,
    top: null,
    parent: null,
    document: new FakeDocument(),
    addEventListener() {},
    navigator: { serviceWorker: { register: () => Promise.resolve() }, sendBeacon: () => true },
  };
  windowObj.top = windowObj;
  windowObj.parent = windowObj;

  const sandbox = {
    window: windowObj,
    location,
    document: windowObj.document,
    navigator: windowObj.navigator,
    history: windowObj.history,
    XMLHttpRequest: FakeXhr,
    Document: FakeDocument,
    WebSocket: FakeWebSocket,
    EventSource: FakeEventSource,
    Request: class {},
    URL,
    Promise,
    Error,
    Object,
    Array,
    String,
    JSON,
    console,
  };
  sandbox.globalThis = sandbox;

  vm.runInNewContext(`(${boot.toString()})(${JSON.stringify({ page, prefix: PREFIX })})`, sandbox);
  return { calls, window: windowObj, sandbox };
}

test("shim maps root-relative fetches into the proxy path space", async () => {
  const { calls } = makeEnv();
  await calls;
  const env = makeEnv();
  await env.window.fetch("/api/items?page=2");
  assert.deepEqual(env.calls.fetch, ["/https/example.com/api/items?page=2"]);
});

test("shim maps relative fetches against the page url", async () => {
  const env = makeEnv();
  await env.window.fetch("sibling.json");
  assert.deepEqual(env.calls.fetch, ["/https/example.com/dir/sibling.json"]);
});

test("shim maps same-origin absolute fetches", async () => {
  const env = makeEnv();
  await env.window.fetch("https://example.com/checkout");
  assert.deepEqual(env.calls.fetch, ["/https/example.com/checkout"]);
});

test("shim recovers urls that were built from location.origin", async () => {
  const env = makeEnv();
  await env.window.fetch("https://prism.local/socket/status");
  assert.deepEqual(env.calls.fetch, ["/https/example.com/socket/status"]);
});

test("shim leaves genuine cross-origin requests alone", async () => {
  const env = makeEnv();
  await env.window.fetch("https://api.other.com/v1/thing");
  assert.deepEqual(env.calls.fetch, ["https://api.other.com/v1/thing"]);
});

test("shim never double-maps an already proxied url", async () => {
  const env = makeEnv();
  await env.window.fetch("https://prism.local/https/example.com/already/here");
  assert.deepEqual(env.calls.fetch, ["https://prism.local/https/example.com/already/here"]);
});

test("a real path that happens to look proxied is still mapped once", async () => {
  const env = makeEnv();
  await env.window.fetch("/https/example.com/already/here");
  assert.deepEqual(env.calls.fetch, ["/https/example.com/https/example.com/already/here"]);
});

test("shim does not rewrite non-http protocols or fragments", async () => {
  const env = makeEnv();
  await env.window.fetch("data:text/plain,hi");
  assert.deepEqual(env.calls.fetch, ["data:text/plain,hi"]);
});

test("shim maps XHR, websockets and history", async () => {
  const env = makeEnv();
  new env.sandbox.XMLHttpRequest().open("GET", "/xhr/endpoint");
  assert.deepEqual(env.calls.xhr, ["/https/example.com/xhr/endpoint"]);

  new env.window.WebSocket("wss://example.com/live");
  assert.deepEqual(env.calls.ws, ["wss://prism.local/ws/https/example.com/live"]);

  env.window.history.pushState({}, "", "/spa/route");
  assert.deepEqual(env.calls.history, ["/https/example.com/spa/route"]);
});

test("shim scopes document.cookie writes to the target host", () => {
  const env = makeEnv();
  env.sandbox.document.cookie = "token=abc; max-age=60";
  assert.match(env.calls.cookies[0], /^token=abc; max-age=60; path=\/https\/example\.com$/);
});

test("shim replaces a page supplied cookie path", () => {
  const env = makeEnv();
  env.sandbox.document.cookie = "token=abc; path=/";
  assert.match(env.calls.cookies[0], /path=\/https\/example\.com/);
});

test("shim blocks service worker registration", async () => {
  const env = makeEnv();
  await assert.rejects(env.sandbox.navigator.serviceWorker.register("/sw.js"));
});
