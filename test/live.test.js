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
  const seen = { commands: [], input: [] };
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
