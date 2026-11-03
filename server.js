"use strict";

const http = require("http");
const { spawn } = require("child_process");
const path = require("path");
const express = require("express");

const { handleProxy, tunnelWebSocket, errorPage, targetFromLocal, proxyPath } = require("./lib/proxy");
const { upgrade: wsUpgrade } = require("./lib/ws");
const { LiveBrowser, LiveSession } = require("./lib/live");
const { handleDownload } = require("./lib/downloads");
const { installerScript } = require("./lib/installer");
const { openExternal } = require("./lib/opener");
const auth = require("./lib/auth");
const users = require("./lib/users");
const gate = require("./lib/gate");
const { readBody } = require("./lib/body");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

const app = express();
const server = http.createServer(app);
const browser = new LiveBrowser();

app.disable("x-powered-by");

/* Optional sign-in for the app itself (PRISM_AUTH=1). Off by default: this is
 * your own machine. The account endpoints stay reachable either way, so /admin
 * works without turning the gate on. */
app.use((req, res, next) => {
  if (!gate.enabled()) return next();
  const route = String(req.path || "/");
  if (route.startsWith("/api/") || route.startsWith("/live/") || route === "/healthz") return next();
  if (["/login", "/admin", "/gate.html", "/favicon.svg", "/install.sh", "/install"].includes(route)) return next();
  if (/^\/(download|open)(\/|$)/.test(route)) return next();
  if (gate.sessionFrom(req)) return next();
  if (String(req.headers.accept || "").includes("text/html")) return res.redirect(302, "/login");
  return res.status(401).json({ ok: false, error: "Sign in first." });
});

/* ---------------- live engine ---------------- */

app.get("/live/status", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (browser.state === "idle" || browser.state === "starting") await browser.start();
  res.json({ ...browser.status(), hosted: false, proxyMode: "path" });
});

/* ---------------- accounts ---------------- */
/* The same sign-in and account console as the hosted copy, so /admin works on
 * this machine too. Sign-in for the app itself is off by default here — it is
 * your own computer — and PRISM_AUTH=1 turns it on. */

app.get("/login", (req, res) => {
  if (gate.sessionFrom(req)) return res.redirect(302, "/");
  gate.serveGate(res);
});

app.get("/admin", (req, res) => {
  if (gate.enabled() && !gate.sessionFrom(req)) return res.redirect(302, "/login");
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("/api/auth/status", async (req, res) => {
  const session = gate.sessionFrom(req);
  let needsSetup = false;
  try {
    needsSetup = await users.needsSetup();
  } catch {}
  res.setHeader("Cache-Control", "no-store");
  res.json({
    ok: true,
    authenticated: Boolean(session),
    number: session ? session.number : null,
    admin: session ? session.role === "admin" : false,
    needsSetup,
    configured: Boolean(auth.secret()),
    storage: users.storageMode(),
    canWrite: users.canWrite(),
  });
});

app.post("/api/auth/login", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!auth.secret()) return res.status(500).json({ ok: false, error: "Set PRISM_AUTH_SECRET to use sign-in." });

  const body = await readBody(req);
  const result = await users.verifyCredentials(body.number || body.phone, body.password);
  if (!result.ok) return res.status(401).json({ ok: false, error: result.reason });

  // Local http has no TLS, so the cookie cannot be Secure here or it is dropped.
  res.setHeader("Set-Cookie", auth.cookieHeader(auth.createSession(result.user), { secure: false }));
  res.json({ ok: true, number: result.user.number, admin: result.user.role === "admin" });
});

app.post("/api/auth/logout", (req, res) => {
  res.setHeader("Set-Cookie", auth.clearCookieHeader());
  res.json({ ok: true });
});

app.post("/api/auth/token", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!auth.secret()) return res.status(500).json({ ok: false, error: "Set PRISM_AUTH_SECRET." });

  const body = await readBody(req);
  const result = await users.verifyCredentials(body.number || body.phone, body.password);
  if (!result.ok) return res.status(401).json({ ok: false, error: result.reason });
  res.json({ ok: true, token: auth.createInstallToken(result.user) });
});

app.get("/api/auth/users", async (req, res) => {
  const session = gate.sessionFrom(req);
  if (!session) return res.status(401).json({ ok: false, error: "Please sign in first." });

  const list = await users.listUsers();
  res.setHeader("Cache-Control", "no-store");
  res.json({
    ok: true,
    me: session.number,
    storage: users.storageMode(),
    canWrite: users.canWrite(),
    users: list.map(users.publicUser),
  });
});

app.post("/api/auth/users", async (req, res) => {
  const session = gate.sessionFrom(req);
  if (!session) return res.status(401).json({ ok: false, error: "Please sign in first." });
  if (session.role !== "admin") {
    return res.status(403).json({ ok: false, error: "Only the account owner can change access." });
  }
  if (!users.canWrite()) {
    return res.status(409).json({ ok: false, error: "This copy has nowhere permanent to save accounts." });
  }

  const body = await readBody(req);
  const action = String(body.action || "").toLowerCase();
  const number = body.number || body.phone;

  try {
    if (action === "add") {
      const user = await users.addUser({ number, password: body.password, name: body.name, role: body.role });
      return res.json({ ok: true, user });
    }
    if (action === "update") {
      const user = await users.updateUser(number, {
        password: body.password,
        active: body.active,
        name: body.name,
        role: body.role,
      });
      return res.json({ ok: true, user });
    }
    if (action === "remove") {
      await users.removeUser(number);
      return res.json({ ok: true });
    }
    res.status(400).json({ ok: false, error: "Unknown action." });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.all("/download/:platform", (req, res) => {
  // Same rule as the hosted copy: a sign-in cookie or the installer's token.
  if (!gate.downloadAllowed(req).ok) {
    res.status(401).setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.end("Sign in first, then download again.");
  }
  handleDownload(req, res, req.params.platform).catch(() => {
    if (!res.headersSent) res.status(502).end();
  });
});

app.get("/download", (req, res) => res.redirect(302, "/download/mac"));

/* The macOS one-liner. A script fetched by curl is never quarantined, so this
 * is the only way to hand someone a launcher that opens without Gatekeeper
 * objecting — see lib/installer.js. */
app.get(["/install.sh", "/install"], (req, res) => {
  const origin = `${req.protocol}://${req.get("host")}`;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", "inline; filename=\"install.sh\"");
  res.setHeader("Cache-Control", "no-store");
  res.send(installerScript(origin));
});

/* Open a page in the user's own browser — the reliable way past bot protection.
 * Local only: the hosted copy has no desktop to open anything on. */
app.post("/open", express.json({ limit: "8kb" }), (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const url = (req.body && (req.body.url || req.body.target)) || req.query.url;
  if (!url) return res.status(400).json({ ok: false, error: "No address given." });
  // A remote page must not be able to make Prism launch things: only our own UI
  // is allowed to call this.
  const origin = req.get("origin");
  const host = req.get("host");
  if (origin && host && origin.replace(/^https?:\/\//, "") !== host) {
    return res.status(403).json({ ok: false, error: "Cross-origin request refused." });
  }
  const result = openExternal(url);
  res.status(result.ok ? 200 : 400).json(result);
});

app.post("/live/warm", async (req, res) => {
  if (browser.state === "idle") browser.start();
  res.json({ ...browser.status(), hosted: false, proxyMode: "path" });
});

/* ---------------- proxy engine ---------------- */

const proxyRoute = ["/proxy", "/api/proxy", "/https/*", "/http/*", "/p/*", "/r/*", "/r"];

app.all(proxyRoute, (req, res) => {
  const started = Date.now();
  // The block page must not promise Live mode when this machine has no browser
  // Prism can drive: ask for the engine's state before writing that page.
  const liveState = browser.status();
  handleProxy(req, res, {
    liveAvailable: liveState.available,
    liveReason: liveState.reason,
    bundled: true,
  }).catch((err) => {
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
 * Static files are served after every route, so a page like /admin wins over a
 * file that happens to share its name.
 */
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

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
