"use strict";

/**
 * Prism live engine.
 *
 * Some sites simply cannot be proxied: their JavaScript assumes it is running
 * on the real origin, they fingerprint the network, they need websockets,
 * canvas, service workers or DRM. Prism therefore keeps a second engine that
 * drives a real Chrome over the DevTools Protocol:
 *
 *    browser pages -> JPEG screencast frames -> canvas in the Prism window
 *    mouse / wheel / keyboard -> Input.* CDP commands -> the page
 *
 * No npm dependencies: Node's built-in fetch and WebSocket are enough to speak
 * CDP. If no Chrome/Edge/Chromium is installed, `status()` reports why and the
 * app falls back to the proxy engine.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

/**
 * A headless Chrome announces itself in its user agent — that one token is
 * enough for bot protection to challenge it. Everything else about the user
 * agent is left exactly as the browser reports it: a fake string that
 * disagrees with the real browser (a Windows UA on a Mac, an old Chrome
 * version next to current client hints) is *more* suspicious than an honest
 * one, and that mismatch is what got real users stuck on Cloudflare.
 */
function userAgentFor(realUserAgent, headless) {
  if (process.env.PRISM_UA) return process.env.PRISM_UA;
  const real =
    realUserAgent ||
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  return headless ? real.replace(/HeadlessChrome\//g, "Chrome/") : real;
}

const CANDIDATES = {
  win32: [
    ["Google Chrome", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"],
    ["Google Chrome", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"],
    ["Google Chrome", path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe")],
    ["Microsoft Edge", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"],
    ["Microsoft Edge", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"],
    ["Brave", path.join(process.env.LOCALAPPDATA || "", "BraveSoftware\\Brave-Browser\\Application\\brave.exe")],
  ],
  darwin: [
    // /Applications first, then the per-user folder: a browser dragged into
    // ~/Applications (no admin password needed) is just as good.
    ["Google Chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
    ["Google Chrome", "~/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
    ["Google Chrome Canary", "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"],
    ["Google Chrome Canary", "~/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"],
    ["Chromium", "/Applications/Chromium.app/Contents/MacOS/Chromium"],
    ["Chromium", "~/Applications/Chromium.app/Contents/MacOS/Chromium"],
    ["Microsoft Edge", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
    ["Microsoft Edge", "~/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
    ["Brave", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"],
    ["Brave", "~/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"],
    ["Vivaldi", "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi"],
    ["Vivaldi", "~/Applications/Vivaldi.app/Contents/MacOS/Vivaldi"],
    ["Opera", "/Applications/Opera.app/Contents/MacOS/Opera"],
    ["Opera", "~/Applications/Opera.app/Contents/MacOS/Opera"],
    ["Arc", "/Applications/Arc.app/Contents/MacOS/Arc"],
    ["Arc", "~/Applications/Arc.app/Contents/MacOS/Arc"],
  ],
  linux: [
    ["Google Chrome", "/usr/bin/google-chrome"],
    ["Google Chrome", "/usr/bin/google-chrome-stable"],
    ["Chromium", "/usr/bin/chromium"],
    ["Chromium", "/usr/bin/chromium-browser"],
    ["Chromium (snap)", "/snap/bin/chromium"],
    ["Microsoft Edge", "/usr/bin/microsoft-edge"],
    ["Brave", "/usr/bin/brave-browser"],
  ],
};

/** `~/Applications/...` -> `/Users/me/Applications/...` */
function expandHome(candidate) {
  if (!candidate || !candidate.startsWith("~/")) return candidate;
  return path.join(os.homedir(), candidate.slice(2));
}

/**
 * Ask Spotlight where the browser is, for the case where someone keeps it in a
 * folder the list above does not know about.
 */
function spotlightFind(query) {
  if (process.platform !== "darwin") return [];
  try {
    const { execFileSync } = require("child_process");
    const out = execFileSync(
      "mdfind",
      [`kMDItemCFBundleIdentifier == "${query}"`],
      { encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"] }
    );
    return out
      .split("\n")
      .filter(Boolean)
      .map((appPath) => appPath.replace(/\/+$/, "") + "/Contents/MacOS/")
      .flatMap((dir) => {
        // the executable inside an .app is named after the bundle, but trying
        // the known names is both simpler and safer
        return ["Google Chrome", "Chromium", "Microsoft Edge", "Brave Browser", "Vivaldi", "Opera", "Arc"]
          .map((bin) => dir + bin)
          .filter((full) => {
            try {
              return fs.existsSync(full);
            } catch {
              return false;
            }
          });
      });
  } catch {
    return [];
  }
}

function discover() {
  if (process.env.PRISM_CHROME) {
    return { path: process.env.PRISM_CHROME, name: "Chrome (PRISM_CHROME)" };
  }
  const list = CANDIDATES[process.platform] || CANDIDATES.linux;
  for (const [name, raw] of list) {
    const candidate = expandHome(raw);
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate)) return { path: candidate, name };
    } catch {}
  }
  // macOS: a browser installed somewhere unusual still shows up in Spotlight.
  for (const id of [
    "com.google.Chrome",
    "org.chromium.Chromium",
    "com.microsoft.edgemac",
    "com.brave.Browser",
    "com.vivaldi.Vivaldi",
  ]) {
    const found = spotlightFind(id);
    if (found.length) return { path: found[0], name: path.basename(found[0]) };
  }
  // Last resort: whatever is on PATH.
  for (const bin of ["google-chrome", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"]) {
    for (const dir of (process.env.PATH || "").split(path.delimiter)) {
      if (!dir) continue;
      const full = path.join(dir, bin);
      try {
        if (fs.existsSync(full)) return { path: full, name: bin };
      } catch {}
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Minimal CDP client
 * ------------------------------------------------------------------ */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener("message", (event) => this._onMessage(event.data));
    ws.addEventListener("close", () => this._failAll(new Error("the live browser disconnected")));
  }

  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
    } catch {
      return;
    }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || "CDP error"));
      else resolve(msg.result || {});
      return;
    }
    if (msg.method) {
      for (const fn of this.listeners) fn(msg.method, msg.params || {}, msg.sessionId);
    }
  }

  _failAll(err) {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  onEvent(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

/* ------------------------------------------------------------------ *
 * Browser process
 * ------------------------------------------------------------------ */

class LiveBrowser {
  constructor() {
    this.state = "idle"; // idle | starting | ready | unavailable
    this.reason = "";
    this.proc = null;
    this.cdp = null;
    this.binary = null;
    this.starting = null;
    this.stderr = "";
  }

  status() {
    return {
      engine: "live",
      available: this.state === "ready",
      state: this.state,
      browser: this.binary ? this.binary.name : null,
      headless: !!this.headless,
      profile: this._profileDir || null,
      // what the browser actually reports, for bug reports
      userAgent: this.realUserAgent || "",
      reason: this.state === "unavailable" ? this.reason : "",
      hint: this.state === "unavailable" ? this.hint() : "",
    };
  }

  hint() {
    if (/Could not attach to the live browser/i.test(this.reason)) {
      return "Prism found a browser but could not connect to its local DevTools socket. The latest update retries this connection and allows local CDP access. Restart Prism; if it still fails, update Chrome/Edge and send the Live status details to support.";
    }
    switch (process.platform) {
      case "win32":
        return "Prism uses the Chrome or Edge already installed on this PC. Install Google Chrome, or set PRISM_CHROME to the full path of a Chromium browser, then restart Prism.";
      case "darwin":
        return "Install Google Chrome (or Edge/Chromium) and restart Prism, or set PRISM_CHROME to the browser executable.";
      default:
        return "Install Chromium (e.g. `apt install chromium` / `dnf install chromium`) or set PRISM_CHROME, then restart Prism. Headless shell builds also need libnss3, libatk, libgbm and libasound2.";
    }
  }

  /**
   * Chrome's profile directory.
   *
   * It used to be a fresh temp directory on every start, which meant no cookies
   * and no Cloudflare clearance: every visit was a first visit, from a machine
   * the site had never seen. Keeping the profile inside the app folder makes a
   * challenge a one-time event per site. PRISM_PROFILE_DIR overrides it.
   */
  profileDir() {
    if (this._profileDir) return this._profileDir;
    const candidates = [];
    if (process.env.PRISM_PROFILE_DIR) candidates.push(process.env.PRISM_PROFILE_DIR);
    else candidates.push(path.join(__dirname, "..", ".chrome-profile"));
    for (const dir of candidates) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        // a leftover lock from a crashed run would stop Chrome from starting
        const lock = path.join(dir, "SingletonLock");
        if (fs.existsSync(lock)) fs.rmSync(lock, { force: true });
        this._profileDir = dir;
        return dir;
      } catch {}
    }
    // read-only install: fall back to the old throw-away behaviour
    this._profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-chrome-"));
    return this._profileDir;
  }

  async start() {
    if (this.state === "ready") return this;
    if (this.starting) return this.starting;

    this.starting = (async () => {
      this.state = "starting";
      const found = discover();
      if (!found) {
        this.state = "unavailable";
        this.reason = "No Chrome, Edge or Chromium installation was found.";
        return this;
      }
      if (typeof WebSocket !== "function") {
        this.state = "unavailable";
        this.reason = `Node ${process.version} has no built-in WebSocket client; Prism needs Node 22+.`;
        return this;
      }

      this.binary = found;
      // A real browser window by default: some sites treat headless browsers
      // differently. This may help, but a site can still identify or block the
      // separate browser session Prism starts.
      // PRISM_HEADLESS=1 restores headless for servers and CI.
      const headless = /^(1|true|yes|new)$/i.test(String(process.env.PRISM_HEADLESS || ""));
      this.headless = headless;
      const userDataDir = this.profileDir();
      const args = [
        ...(headless ? ["--headless=new"] : []),
        // invisible, but a normal window as far as the page is concerned
        ...(headless ? [] : ["--window-position=-32000,-32000", "--window-size=1440,900"]),
        "--remote-debugging-port=0",
        // Bind CDP to loopback only. Recent Chromium releases also reject
        // clients whose WebSocket Origin is not explicitly allowed; this is
        // safe here because the debugging server is never exposed off-device.
        "--remote-debugging-address=127.0.0.1",
        "--remote-allow-origins=*",
        `--user-data-dir=${userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints",
        // Best-effort browser defaults; bot protection can still identify and
        // challenge this separate browser session.
        "--disable-blink-features=AutomationControlled",
        "--disable-extensions",
        "--disable-component-update",
        "--disable-sync",
        "--disable-dev-shm-usage",
        "--enable-unsafe-swiftshader",
        "--hide-scrollbars",
        // a real window is something you watch videos in, so it has sound;
        // headless has nowhere to put it
        ...(headless ? ["--mute-audio"] : []),
        "--autoplay-policy=no-user-gesture-required",
        "--window-size=1440,900",
        "--no-sandbox",
        "about:blank",
      ];

      let proc;
      try {
        proc = spawn(found.path, args, { stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        this.state = "unavailable";
        this.reason = `Could not start ${found.name}: ${e.message}`;
        return this;
      }
      this.proc = proc;
      proc.stderr.on("data", (buf) => {
        this.stderr = (this.stderr + buf.toString()).slice(-4000);
      });
      proc.stdout.on("data", () => {});

      const portFile = path.join(userDataDir, "DevToolsActivePort");
      const deadline = Date.now() + 20000;
      let port = 0;
      let wsPath = "";
      while (Date.now() < deadline) {
        if (proc.exitCode !== null) break;
        if (fs.existsSync(portFile)) {
          const text = fs.readFileSync(portFile, "utf8").trim().split("\n");
          port = Number(text[0]);
          wsPath = (text[1] || "").trim();
          if (port && wsPath) break;
        }
        await new Promise((r) => setTimeout(r, 120));
      }

      if (!port || !wsPath) {
        this.state = "unavailable";
        this.reason = this.describeFailure();
        this.stop();
        return this;
      }

      const url = `ws://127.0.0.1:${port}${wsPath}`;
      try {
        const ws = await openWebSocket(url);
        this.cdp = new Cdp(ws);
      } catch (e) {
        this.state = "unavailable";
        const tail = this.stderr.trim().split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 220);
        this.reason = `Could not attach to the live browser (${e.message})${tail ? ` — ${tail}` : ""}.`;
        this.stop();
        return this;
      }

      try {
        const version = await this.cdp.send("Browser.getVersion");
        const product = version.product;
        this.version = version.userAgent || "";
        this.realUserAgent = version.userAgent || "";
        this.binary = { ...found, name: `${found.name}${product ? ` · ${product.split("/")[0]}` : ""}` };
      } catch {}

      proc.on("exit", () => {
        this.cdp = null;
        this.proc = null;
        if (this.state === "ready") {
          this.state = "unavailable";
          this.reason = "The live browser process exited.";
        }
        // Tell every open tab instead of leaving them on a frozen frame.
        for (const session of activeSessions) {
          try {
            session.conn.send({ t: "error", message: "The live browser stopped unexpectedly.", hint: "" });
            session.conn.close?.();
          } catch {}
        }
      });

      this.state = "ready";
      this.userDataDir = userDataDir;
      return this;
    })().finally(() => {
      this.starting = null;
    });

    return this.starting;
  }

  describeFailure() {
    const tail = this.stderr.trim().split("\n").filter(Boolean).slice(-3).join(" ");
    if (/libnss3|cannot open shared object|error while loading shared libraries/i.test(this.stderr)) {
      return "The browser binary is present but its system libraries are missing (libnss3, libatk, libgbm…).";
    }
    if (tail) return `The live browser did not start: ${tail.slice(0, 240)}`;
    return "The live browser did not start in time.";
  }

  stop() {
    try {
      this.cdp?.close();
    } catch {}
    this.cdp = null;
    try {
      this.proc?.kill("SIGKILL");
    } catch {}
    this.proc = null;
  }
}

async function openWebSocket(url) {
  let lastError = new Error("websocket connection failed");
  // Chrome can publish DevToolsActivePort just before its websocket listener is
  // ready. Retry brief startup races instead of declaring Live unavailable.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await openWebSocketOnce(url);
    } catch (err) {
      lastError = err;
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
  throw lastError;
}

function openWebSocketOnce(url) {
  return new Promise((resolve, reject) => {
    let ws;
    let settled = false;
    let timer;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        try { ws?.close(); } catch {}
        reject(err);
      } else {
        resolve(ws);
      }
    };

    try {
      ws = new WebSocket(url);
    } catch (e) {
      finish(e);
      return;
    }

    timer = setTimeout(() => finish(new Error("websocket open timed out")), 5000);
    timer.unref?.();
    ws.addEventListener("open", () => finish());
    ws.addEventListener("error", (event) => {
      const detail = event && typeof event.message === "string" && event.message.trim();
      finish(new Error(detail || "websocket handshake failed"));
    });
    ws.addEventListener("close", (event) => {
      const reason = event && event.reason ? `: ${event.reason}` : "";
      finish(new Error(`websocket closed${event && event.code ? ` (${event.code})` : ""}${reason}`));
    });
  });
}

/* ------------------------------------------------------------------ *
 * One browser tab streamed to one Prism client
 * ------------------------------------------------------------------ */

const activeSessions = new Set();

const { PAGE_PROBE } = require("./botwall");

const KEY_NAMES = {
  Enter: ["Enter", 13],
  Backspace: ["Backspace", 8],
  Tab: ["Tab", 9],
  Escape: ["Escape", 27],
  Delete: ["Delete", 46],
  ArrowLeft: ["ArrowLeft", 37],
  ArrowUp: ["ArrowUp", 38],
  ArrowRight: ["ArrowRight", 39],
  ArrowDown: ["ArrowDown", 40],
  Home: ["Home", 36],
  End: ["End", 35],
  PageUp: ["PageUp", 33],
  PageDown: ["PageDown", 34],
};

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

class LiveSession {
  constructor(conn, initUrl) {
    this.conn = conn;
    this.initUrl = initUrl;
    this.sessionId = null;
    this.targetId = null;
    this.viewport = { ...DEFAULT_VIEWPORT };
    this.closed = false;
    this.currentUrl = initUrl || "about:blank";
    this.detachFn = null;
    this.pendingFrame = false;
  }

  async start(browser) {
    const cdp = browser.cdp;
    this.cdp = cdp;
    activeSessions.add(this);

    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    this.targetId = targetId;
    const attached = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    this.sessionId = attached.sessionId;

    this.detachFn = cdp.onEvent((method, params, sessionId) => {
      if (sessionId !== this.sessionId) return;
      this.onEvent(method, params);
    });

    await cdp.send("Page.enable", {}, this.sessionId);
    await cdp.send("Runtime.enable", {}, this.sessionId);
    // Only override what actually needs changing. In a real window the browser's
    // own user agent is already correct, and rewriting it would contradict the
    // client hints, the platform and the promise that this is just Chrome.
    const realUA = browser.realUserAgent || "";
    const ua = userAgentFor(realUA, browser.headless);
    // Only an explicit PRISM_UA, or the headless token that has to go, justifies
    // touching this. If the version query failed we leave the browser alone:
    // guessing a user agent is exactly how the mismatch happened before.
    const needsOverride = !!process.env.PRISM_UA || (browser.headless && realUA && ua !== realUA);
    if (needsOverride) {
      await cdp
        .send(
          "Network.setUserAgentOverride",
          { userAgent: ua, acceptLanguage: "en-US,en;q=0.9" },
          this.sessionId
        )
        .catch(() => {});
    }
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, this.sessionId).catch(() => {});
    // Remove the obvious automation tells before any page script runs.
    await cdp
      .send(
        "Page.addScriptToEvaluateOnNewDocument",
        {
          source: `(() => {
            try {
              // a real window already reports no webdriver; only patch when the
              // browser says otherwise, so nothing looks tampered with
              if (navigator.webdriver) {
                Object.defineProperty(navigator, "webdriver", { get: () => undefined });
              }
              if (!navigator.languages || !navigator.languages.length) {
                Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
              }
              if (!window.chrome) window.chrome = { runtime: {} };
            } catch (e) {}
          })();`,
        },
        this.sessionId
      )
      .catch(() => {});
    await this.resize(this.viewport.width, this.viewport.height);
    await this.startScreencast();

    if (this.initUrl) await this.navigate(this.initUrl);
    this.conn.send({ t: "ready", url: this.currentUrl });
  }

  async startScreencast() {
    await this.cdp
      .send(
        "Page.startScreencast",
        {
          format: "jpeg",
          quality: 65,
          maxWidth: this.viewport.width,
          maxHeight: this.viewport.height,
          everyNthFrame: 1,
        },
        this.sessionId
      )
      .catch(() => {});
  }

  async resize(width, height) {
    const w = Math.max(320, Math.min(4096, Math.round(width)));
    const h = Math.max(240, Math.min(4096, Math.round(height)));
    this.viewport = { width: w, height: h };
    await this.cdp
      .send(
        "Emulation.setDeviceMetricsOverride",
        { width: w, height: h, deviceScaleFactor: 1, mobile: false, screenWidth: w, screenHeight: h },
        this.sessionId
      )
      .catch(() => {});
    await this.cdp
      .send("Page.startScreencast", { format: "jpeg", quality: 65, maxWidth: w, maxHeight: h, everyNthFrame: 1 }, this.sessionId)
      .catch(() => {});
  }

  async navigate(url) {
    let target = String(url || "").trim();
    if (!target) return;
    if (!/^[a-z]+:/i.test(target)) target = "https://" + target;
    if (!/^https?:/i.test(target) && target !== "about:blank") return;
    this.currentUrl = target;
    await this.cdp.send("Page.navigate", { url: target }, this.sessionId).catch(() => {});
  }

  onEvent(method, params) {
    if (this.closed) return;
    if (method === "Page.screencastFrame") {
      const { data, metadata, sessionId } = params;
      this.conn.send({
        t: "frame",
        d: data,
        w: (metadata && metadata.deviceWidth) || this.viewport.width,
        h: (metadata && metadata.deviceHeight) || this.viewport.height,
      });
      this.cdp.send("Page.screencastFrameAck", { sessionId }, this.sessionId).catch(() => {});
      return;
    }
    if (method === "Page.frameNavigated" && params.frame && !params.frame.parentId) {
      this.mainFrameId = params.frame.id;
      this.currentUrl = params.frame.url;
      this.conn.send({ t: "url", url: params.frame.url });
      return;
    }
    if (method === "Page.frameStartedLoading" && (!this.mainFrameId || params.frameId === this.mainFrameId)) {
      this.conn.send({ t: "loading", on: true });
      return;
    }
    if (method === "Page.frameStoppedLoading") {
      this.conn.send({ t: "loading", on: false });
      return;
    }
    if (method === "Page.loadEventFired") {
      this.conn.send({ t: "loading", on: false });
      this.checkForChallenge();
      return;
    }
    if (method === "Page.javascriptDialogOpening") {
      this.cdp.send("Page.handleJavaScriptDialog", { accept: true }, this.sessionId).catch(() => {});
      return;
    }
    if (method === "Page.windowOpen") {
      const url = params.url;
      if (url && /^https?:/i.test(url)) this.conn.send({ t: "popup", url });
    }
  }

  /**
   * Is a bot wall on screen? In the live engine the user *can* pass it (it is
   * their own browser and their own IP), so tell them what to do instead of
   * leaving them staring at a spinner.
   */
  async checkForChallenge() {
    if (this.closed) return;
    let vendor = "";
    try {
      const { result } = await this.cdp.send(
        "Runtime.evaluate",
        { expression: PAGE_PROBE, returnByValue: true },
        this.sessionId
      );
      vendor = (result && result.value) || "";
    } catch {
      return;
    }
    if (!vendor) {
      this.challengeFor = null;
      return;
    }
    if (this.challengeFor === vendor) return;
    this.challengeFor = vendor;
    this.conn.send({ t: "challenge", vendor, url: this.currentUrl });
  }

  async onMessage(msg) {
    switch (msg.t) {
      case "nav":
        return this.navigate(msg.url);
      case "reload":
        return this.cdp.send("Page.reload", { ignoreCache: true }, this.sessionId).catch(() => {});
      case "back":
      case "forward":
        return this.cdp
          .send("Runtime.evaluate", { expression: msg.t === "back" ? "history.back()" : "history.forward()" }, this.sessionId)
          .catch(() => {});
      case "resize":
        return this.resize(Number(msg.w), Number(msg.h));
      case "mouse":
        return this.mouse(msg);
      case "wheel":
        await this.cdp
          .send(
            "Input.dispatchMouseEvent",
            {
              type: "mouseWheel",
              button: "none",
              x: Number(msg.x) || 0,
              y: Number(msg.y) || 0,
              deltaX: Number(msg.dx) || 0,
              deltaY: Number(msg.dy) || 0,
            },
            this.sessionId
          )
          .catch(() => {});
        return;
      case "key":
        return this.key(msg);
      case "text":
        await this.cdp.send("Input.insertText", { text: String(msg.text || "") }, this.sessionId).catch(() => {});
        return;
      default:
        return;
    }
  }

  async mouse(msg) {
    const type = msg.type === "down" ? "mousePressed" : msg.type === "up" ? "mouseReleased" : "mouseMoved";
    const button = msg.button === "right" ? "right" : msg.button === "middle" ? "middle" : "left";
    const buttons = msg.type === "down" ? (button === "right" ? 2 : 1) : 0;
    await this.cdp
      .send(
        "Input.dispatchMouseEvent",
        {
          type,
          x: Number(msg.x) || 0,
          y: Number(msg.y) || 0,
          // Chrome rejects a real button on movement; "none" is required there.
          button: type === "mouseMoved" ? "none" : button,
          buttons,
          clickCount: msg.type === "move" ? 0 : Number(msg.clickCount) || 1,
          modifiers: Number(msg.modifiers) || 0,
        },
        this.sessionId
      )
      .catch(() => {});
  }

  async key(msg) {
    const name = msg.key || "";
    const mapped = KEY_NAMES[name];
    const base = {
      modifiers: Number(msg.modifiers) || 0,
      key: name,
      code: msg.code || mapped?.[0] || name,
      windowsVirtualKeyCode: Number(msg.keyCode) || mapped?.[1] || 0,
      nativeVirtualKeyCode: Number(msg.keyCode) || mapped?.[1] || 0,
    };
    if (msg.text && !msg.modifiers) base.text = msg.text;
    if (msg.type === "down") {
      await this.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...base }, this.sessionId).catch(() => {});
    } else {
      await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base, text: undefined }, this.sessionId).catch(() => {});
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    activeSessions.delete(this);
    try {
      this.detachFn?.();
    } catch {}
    try {
      await this.cdp.send("Page.stopScreencast", {}, this.sessionId);
    } catch {}
    try {
      await this.cdp.send("Target.closeTarget", { targetId: this.targetId });
    } catch {}
  }
}

module.exports = { LiveBrowser, LiveSession, Cdp, discover, userAgentFor };
