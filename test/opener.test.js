"use strict";

/**
 * "Open in my own browser" — the reliable route past bot protection.
 *
 * Live mode drives a Chrome that Prism started, over the DevTools protocol,
 * which Cloudflare and friends can recognise. The user's own browser cannot be
 * distinguished from the user, so this endpoint exists — and because it spawns
 * a process from an HTTP request, it is tested hard.
 */

const test = require("node:test");
const assert = require("node:assert");
const { openExternal, normalise, openerCommand } = require("../lib/opener");

function recorder() {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    return { unref() {}, on() {} };
  };
  return { calls, spawnImpl };
}

test("only http(s) addresses are launched", () => {
  assert.equal(normalise("https://www.youtube.com/"), "https://www.youtube.com/");
  assert.equal(normalise("www.youtube.com"), "https://www.youtube.com/");
  assert.equal(normalise("youtube.com/watch?v=1"), "https://youtube.com/watch?v=1");
  assert.equal(normalise("http://localhost:3000/x"), "http://localhost:3000/x");

  // everything else is refused
  assert.equal(normalise("file:///etc/passwd"), null);
  assert.equal(normalise("javascript:alert(1)"), null);
  assert.equal(normalise("data:text/html,hi"), null);
  assert.equal(normalise(""), null);
  assert.equal(normalise(null), null);
  assert.equal(normalise("not a url"), null);
});

test("a quote or control character never reaches a command line", () => {
  assert.equal(normalise('https://example.com/"quote'), null);
  assert.equal(normalise("https://example.com/'quote"), null);
  assert.equal(normalise("https://example.com/\u0000nul"), null);
  assert.equal(normalise("https://example.com/\nnewline"), null);
});

test("each platform gets its own opener, with the url as an argument", () => {
  assert.deepEqual(openerCommand("darwin", "https://a.test/"), {
    command: "open",
    args: ["https://a.test/"],
  });
  assert.deepEqual(openerCommand("win32", "https://a.test/"), {
    command: "rundll32",
    args: ["url.dll,FileProtocolHandler", "https://a.test/"],
  });
  assert.deepEqual(openerCommand("linux", "https://a.test/"), {
    command: "xdg-open",
    args: ["https://a.test/"],
  });
});

test("opening passes the url as an argv entry, never through a shell", () => {
  const { calls, spawnImpl } = recorder();
  const result = openExternal("https://www.youtube.com/watch?v=abc&list=xyz", {
    platform: "darwin",
    spawn: spawnImpl,
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "open");
  // a single argv entry: `&` cannot become a shell operator
  assert.deepEqual(calls[0].args, ["https://www.youtube.com/watch?v=abc&list=xyz"]);
  assert.equal(calls[0].options.shell, undefined);
  assert.equal(calls[0].options.detached, true);
});

test("a refused address never spawns anything", () => {
  const { calls, spawnImpl } = recorder();
  const result = openExternal("file:///etc/passwd", { platform: "darwin", spawn: spawnImpl });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 0);
});

test("a missing opener reports an error instead of throwing", () => {
  const result = openExternal("https://a.test/", {
    platform: "linux",
    spawn: () => {
      throw new Error("spawn xdg-open ENOENT");
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /ENOENT/);
});
