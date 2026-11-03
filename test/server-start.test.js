"use strict";

/**
 * Starting Prism the way a launcher does: no privileged ports, no crash when
 * something else already owns the port, and no browser spawning during tests.
 */

const test = require("node:test");
const assert = require("node:assert");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");

const SERVER = path.join(__dirname, "..", "server.js");

function occupy() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function runServer(env, until) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, PRISM_NO_LIVE: "1", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`server did not start: ${out}`));
    }, 20000);

    const onData = (buf) => {
      out += buf.toString();
      const match = until(out);
      if (match) {
        clearTimeout(timer);
        resolve({ child, match, output: out });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited (${code}): ${out}`));
    });
  });
}

test("a busy port makes Prism move to the next one instead of exiting", async (t) => {
  const blocker = await occupy();
  const busyPort = blocker.address().port;
  t.after(() => blocker.close());

  const { child, match, output } = await runServer({ PORT: String(busyPort), HOST: "127.0.0.1" }, (text) => {
    const m = text.match(/Prism running at http:\/\/localhost:(\d+)/);
    return m ? m : null;
  });

  t.after(() => child.kill("SIGKILL"));

  const actual = Number(match[1]);
  assert.notEqual(actual, busyPort, "should not have bound the port that was taken");
  assert.match(output, new RegExp(`Port ${busyPort} was busy`, "i"));

  const res = await fetch(`http://127.0.0.1:${actual}/healthz`);
  const json = await res.json();
  assert.equal(json.prism, true, "healthz identifies Prism for the launchers");

  child.kill("SIGTERM");
  await new Promise((resolve) => child.on("exit", resolve));
});

test("healthz carries the version so a launcher can tell copies apart", async (t) => {
  const { child, match } = await runServer({ PORT: "0", HOST: "127.0.0.1" }, (text) => {
    const m = text.match(/Prism running at http:\/\/localhost:(\d+)/);
    return m ? m : null;
  });
  t.after(() => child.kill("SIGTERM"));

  const res = await fetch(`http://127.0.0.1:${match[1]}/healthz`);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.prism, true);
  assert.match(json.version, /^\d+\.\d+\.\d+$/);
});
