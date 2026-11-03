"use strict";

const http = require("http");
const { spawn } = require("child_process");
const path = require("path");
const express = require("express");

const { handleProxy, tunnelWebSocket, errorPage, targetFromLocal, proxyPath } = require("./lib/proxy");
const { upgrade: wsUpgrade } = require("./lib/ws");
const { LiveBrowser, LiveSession } = require("./lib/live");
const { handleDownload } = require("./lib/downloads");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

const app = express();
const server = http.createServer(app);
const browser = new LiveBrowser();

app.disable("x-powered-by");
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

/* ---------------- live engine ---------------- */

app.get("/live/status", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (browser.state === "idle" || browser.state === "starting") await browser.start();
  res.json({ ...browser.status(), hosted: false, proxyMode: "path" });
});

app.all("/download/:platform", (req, res) => {
  handleDownload(req, res, req.params.platform).catch(() => {
    if (!res.headersSent) res.status(502).end();
  });
});

app.get("/download", (req, res) => res.redirect(302, "/download/mac"));

app.post("/live/warm", async (req, res) => {
  if (browser.state === "idle") browser.start();
  res.json({ ...browser.status(), hosted: false, proxyMode: "path" });
});

/* ---------------- proxy engine ---------------- */

const proxyRoute = ["/proxy", "/api/proxy", "/https/*", "/http/*", "/p/*", "/r/*", "/r"];

app.all(proxyRoute, (req, res) => {
  const started = Date.now();
  handleProxy(req, res).catch((err) => {
    console.error("[proxy]", req.method, req.originalUrl, err && err.message);
    if (!res.headersSent) {
      res.status(502).setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(errorPage(err && err.message ? err.message : "Proxy failure", req.originalUrl, 502));
    }
  });
  res.on("finish", () => {
    const ms = Date.now() - started;
    if (ms > 4000) console.log(`[slow] ${req.method} ${req.originalUrl} ${ms}ms`);
  });
});

app.get("/healthz", (req, res) =>
  res.json({ ok: true, prism: true, version: require("./package.json").version, uptime: process.uptime() })
);

/**
 * Safety net for pages that navigate by script (`location = "/settings"`).
 * The browser resolves that against Prism's origin, so it arrives here without
 * the target prefix. If the request came from a proxied page, send it to the
 * mapped address instead of showing a bare 404.
 */
app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  if (!/text\/html/i.test(req.headers.accept || "")) return next();
  if (/^\/(https|http|p|r|ws|live|api)\//.test(req.url) || req.url === "/") return next();

  const referer = req.headers.referer;
  if (!referer) return next();
  let base;
  try {
    base = targetFromLocal(new URL(referer).pathname + new URL(referer).search, `${req.protocol}://${req.headers.host}`);
  } catch {
    base = null;
  }
  if (!base) return next();

  let next_url;
  try {
    next_url = proxyPath(new URL(req.url, base).href);
  } catch {
    return next();
  }
  if (!next_url || next_url === req.url) return next();
  res.redirect(302, next_url);
});

app.use((req, res) => {
  res.status(404).setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(
    errorPage(
      "That address is not part of a page Prism is showing. If you followed a link, open it from the address bar instead.",
      req.originalUrl,
      404
    )
  );
});

/* ---------------- websockets ---------------- */

server.on("upgrade", async (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/live/ws") {
    const initial = url.searchParams.get("url") || "";
    wsUpgrade(req, socket, head, async (conn) => {
      let session;
      try {
        await browser.start();
        if (browser.state !== "ready") {
          conn.send({ t: "error", message: browser.status().reason || "Live browser unavailable", hint: browser.status().hint });
          conn.close();
          return;
        }
        session = new LiveSession(conn, initial);
        await session.start(browser);
      } catch (e) {
        conn.send({ t: "error", message: `Live engine failed: ${e.message}` });
        conn.close();
        try {
          await session?.close();
        } catch {}
        return;
      }
      conn.onJSON((msg) => {
        session.onMessage(msg).catch(() => {});
      });
      conn.on("close", () => {
        session.close().catch(() => {});
      });
    });
    return;
  }

  if (url.pathname.startsWith("/ws/")) {
    tunnelWebSocket(req, socket, head);
    return;
  }

  socket.destroy();
});

/* ---------------- lifecycle ---------------- */

/** Open the user's default browser. Used by the launchers (PRISM_OPEN=1). */
function openBrowser(url) {
  if (process.env.PRISM_OPEN !== "1") return;
  const attempts =
    process.platform === "win32"
      ? [["cmd", ["/c", "start", "", url]]]
      : process.platform === "darwin"
        ? [["open", [url]]]
        : [
            ["xdg-open", [url]],
            ["gio", ["open", url]],
          ];
  for (const [cmd, args] of attempts) {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
      child.on("error", () => {});
      child.unref();
      return;
    } catch {}
  }
}

/**
 * Listen on an unprivileged port. If it is taken (something else on 3000), walk
 * up a few ports instead of failing: the launchers just want a working Prism,
 * and none of these need elevated privileges.
 */
function start(port = PORT, host = HOST) {
  return new Promise((resolve, reject) => {
    let candidate = port;
    let attempts = 0;

    const attempt = () => {
      const onError = (err) => {
        server.removeListener("listening", onListening);
        if ((err.code === "EADDRINUSE" || err.code === "EACCES") && attempts < 10) {
          attempts += 1;
          candidate += 1;
          attempt();
          return;
        }
        reject(err);
      };

      const onListening = () => {
        server.removeListener("error", onError);
        const actual = server.address().port;
        if (actual !== port) console.log(`Port ${port} was busy, so Prism used ${actual}.`);
        console.log(`Prism running at http://localhost:${actual}`);
        // Warm the live browser in the background so the first click is instant.
        if (process.env.PRISM_NO_LIVE !== "1") {
          browser.start().then((b) => {
            const s = b.status();
            console.log(
              s.available
                ? `Live engine ready (${s.browser})`
                : `Live engine unavailable: ${s.reason || s.state}`
            );
          });
        }
        openBrowser(`http://localhost:${actual}`);
        resolve(actual);
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(candidate, host);
    };

    attempt();
  });
}

function shutdown() {
  console.log("\nShutting down Prism…");
  browser.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}

if (require.main === module) {
  start().catch((err) => {
    if (err && err.code === "EADDRINUSE") {
      console.error(`\nPorts ${PORT}-${PORT + 10} are all busy. Close whatever is using them, or set PORT.`);
    } else {
      console.error("\nPrism could not start:", err && err.message);
    }
    process.exitCode = 1;
  });
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("uncaughtException", (err) => {
    console.error("[uncaught]", err);
  });
  process.on("unhandledRejection", (err) => {
    console.error("[unhandled]", err && err.message ? err.message : err);
  });
}

module.exports = { app, server, start, browser };
