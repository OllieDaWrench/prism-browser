"use strict";

/* ------------------------------------------------------------------ *
 * elements
 * ------------------------------------------------------------------ */
const iframe = document.getElementById("view");
const start = document.getElementById("start");
const liveView = document.getElementById("live");
const liveFrame = document.getElementById("live-frame");
const liveInput = document.getElementById("live-input");
const liveOverlay = document.getElementById("live-overlay");
const liveReason = document.getElementById("live-reason");
const liveHint = document.getElementById("live-hint");
const urlInput = document.getElementById("url");
const progress = document.getElementById("progress");
const backBtn = document.getElementById("back");
const fwdBtn = document.getElementById("fwd");
const reloadBtn = document.getElementById("reload");
const homeBtn = document.getElementById("home");
const engineBtn = document.getElementById("engine");
const engineLabel = document.getElementById("engine-label");
const engineNote = document.getElementById("engine-note");
const banner = document.getElementById("banner");
const bannerText = document.getElementById("banner-text");
const bannerAction = document.getElementById("banner-action");
const bannerClose = document.getElementById("banner-close");
const startTitle = document.getElementById("start-title");

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */
const stack = [];
let index = -1;
let browsing = false;
let preference = localStorage.getItem("prism:engine") || "auto";
let live = { available: false, state: "idle", browser: null, reason: "", hint: "", hosted: false, proxyMode: "path" };
/**
 * How this copy of Prism reaches its proxy. "path" maps target URLs onto
 * /https/<host>/... and needs the server (or the host's rewrite rules) to hand
 * those paths to the proxy. "query" is the rewrite-free fallback used when a
 * deployment only routes /api/proxy, so a hosted Prism cannot 404 itself.
 */
let transport = { mode: "path", base: null };
/** false when nothing proxies at all — e.g. the serverless function is missing. */
let proxyReachable = true;
/** Pages already moved to Live mode because of a bot wall (avoid flip-flopping). */
const autoEscalated = new Set();
let liveConn = null;
let liveSession = null; // { url }

const INTERNAL_NAV = /^\/(live|proxy|p|r|ws)(\/|$)/;
/** Mirror of lib/desktop.js — test/desktop.test.js keeps these in sync. */
const DOWNLOAD_MAC = "https://github.com/OllieDaWrench/prism-browser/releases/latest/download/Prism-macOS.zip";
const DOWNLOAD_WINDOWS = "https://github.com/OllieDaWrench/prism-browser/releases/latest/download/Prism-Windows.zip";

/**
 * Sites whose JavaScript cannot survive being re-served from another origin.
 * In "auto" mode these prefer the live engine when a browser is available.
 */
const JS_HEAVY = [
  "chatgpt.com", "openai.com", "chat.openai.com", "claude.ai", "gemini.google.com",
  "reddit.com", "twitter.com", "x.com", "instagram.com", "facebook.com", "threads.net",
  "tiktok.com", "spotify.com", "twitch.tv", "discord.com", "netflix.com", "poki.com",
  "youtube.com", "youtu.be", "music.youtube.com", "mail.google.com", "docs.google.com",
  "drive.google.com", "calendar.google.com", "maps.google.com", "google.com",
  "gmail.com", "outlook.com", "office.com", "notion.so", "figma.com", "canva.com",
  "amazon.com", "ebay.com", "netflix.net", "hulu.com", "roblox.com", "epicgames.com",
  "steamcommunity.com", "store.steampowered.com", "soundcloud.com", "pinterest.com",
  "linkedin.com", "tumblr.com", "whatsapp.com", "web.whatsapp.com", "zoom.us",
  "chatgpt.live", "perplexity.ai", "huggingface.co", "codepen.io", "codesandbox.io",
  "vercel.com", "netlify.app", "cloudflare.com", "paypal.com", "coinbase.com",
];

/* ------------------------------------------------------------------ *
 * url helpers
 * ------------------------------------------------------------------ */
function looksLikeUrl(raw) {
  return /^(https?:\/\/)/i.test(raw) || /^[\w.-]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(raw);
}

function canonical(value) {
  try {
    return new URL(value).href;
  } catch {
    return value;
  }
}

/** Split user input into either a URL to open or a search query. */
function describeInput(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return { url: canonical(value) };
  if (looksLikeUrl(value)) return { url: canonical("https://" + value) };
  if (/^localhost(:\d+)?(\/|$)/i.test(value) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(value)) {
    return { url: "http://" + value };
  }
  return { query: value };
}

/**
 * Text search is the one place where the engine decides the site: Google needs
 * JavaScript (live only), DuckDuckGo's HTML endpoint is built for proxies.
 */
function searchUrl(query, engine) {
  const q = encodeURIComponent(query);
  return engine === "live"
    ? `https://www.google.com/search?q=${q}`
    : `https://duckduckgo.com/html/?q=${q}`;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function isJsHeavy(url) {
  const host = hostOf(url);
  return JS_HEAVY.some((h) => host === h || host.endsWith("." + h));
}

function toProxyPath(url) {
  try {
    const u = new URL(url);
    return `/${u.protocol.slice(0, -1)}/${u.host}${u.pathname}${u.search}${u.hash}`;
  } catch {
    return null;
  }
}

/** The address Prism should frame for a target URL, in the active transport. */
function toProxyUrl(url) {
  if (transport.mode === "query") {
    return (transport.base || "/api/proxy?url=") + encodeURIComponent(url);
  }
  return toProxyPath(url) || url;
}

function targetFromLocal(href) {
  let u;
  try {
    u = new URL(href, location.origin);
  } catch {
    return null;
  }
  if (u.origin !== location.origin) return null;
  const p = u.pathname;
  if (p.startsWith("/https/")) return "https://" + p.slice(7) + u.search + u.hash;
  if (p.startsWith("/http/")) return "http://" + p.slice(6) + u.search + u.hash;
  if (u.pathname === "/api/proxy" || u.pathname === "/proxy") {
    const viaQuery = u.searchParams.get("url") || u.searchParams.get("u");
    if (viaQuery && /^https?:\/\//i.test(viaQuery)) return viaQuery;
    return null;
  }
  if (p.startsWith("/p/")) {
    const rest = p.slice(3);
    try {
      const plain = decodeURIComponent(rest);
      if (/^https?:\/\//i.test(plain)) return plain + u.search + u.hash;
    } catch {}
    try {
      const b64 = rest.replace(/-/g, "+").replace(/_/g, "/");
      const decoded = decodeURIComponent(escape(atob(b64)));
      if (/^https?:\/\//i.test(decoded)) return decoded + u.search + u.hash;
    } catch {}
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * transport: does this copy of Prism serve path-mapped urls?
 * ------------------------------------------------------------------ */
async function detectTransport() {
  // Any target will do; an invalid one is rejected before any network call, so
  // this probe is instant and works offline.
  const probe = "/https/!invalid-host!/";
  try {
    const res = await fetch(probe, { method: "HEAD", cache: "no-store" });
    if (res.headers.get("x-prism-proxy") === "1") {
      proxyReachable = true;
      transport = { mode: "path", base: null };
      return;
    }
  } catch {}

  // Path mapping is not routed here. Try the endpoint serverless deploys can
  // always reach, and verify it actually is Prism answering. Asking for no
  // target is answered straight away with Prism's 400 page.
  const base = "/api/proxy?url=";
  try {
    const res = await fetch("/api/proxy", { method: "HEAD", cache: "no-store" });
    if (res.headers.get("x-prism-proxy") === "1") {
      proxyReachable = true;
      transport = { mode: "query", base };
      return;
    }
  } catch {}

  proxyReachable = false;
  transport = { mode: "path", base: null };
}

/* ------------------------------------------------------------------ *
 * engine
 * ------------------------------------------------------------------ */
function liveUsable() {
  return live.available && live.state === "ready";
}

function resolveEngine(url) {
  if (preference === "live") return liveUsable() ? "live" : "proxy";
  if (preference === "proxy") return "proxy";
  return liveUsable() && isJsHeavy(url) ? "live" : "proxy";
}

function renderEngine() {
  const engine = browsing && stack[index] ? stack[index].engine : null;
  let effective = engine || resolveEngine(urlInput.value || "");
  // A page can be sitting in Live mode when the engine dies mid-session.
  if (effective === "live" && !liveUsable()) effective = "proxy";
  engineBtn.dataset.engine = effective;
  engineLabel.textContent = effective === "live" ? "Live" : "Proxy";
  engineBtn.title =
    preference === "auto"
      ? `Engine: Auto (currently ${effective}). Click to pin Proxy.`
      : `Engine pinned to ${preference === "live" ? "Live" : "Proxy"}. Click to change.`;

  if (!proxyReachable) {
    engineNote.textContent =
      "This copy of Prism is not running its proxy: pages cannot be loaded. Run Prism locally with `npm start`, or check the deployment's routing.";
  } else if (!live.available) {
    engineNote.textContent = live.state === "starting"
      ? "Starting the live browser engine…"
      : live.hosted
        ? "Hosted copy — proxy engine only. Download Prism for Live mode (real browser, Cloudflare-capable)."
        : `Proxy engine only — ${live.reason || "no Chromium browser found"}`;
  } else if (preference === "auto") {
    engineNote.textContent = `Auto engine. Live browser ready (${live.browser}) — pages that need real JavaScript will open there.`;
  } else if (preference === "live") {
    engineNote.textContent = `Live engine pinned (${live.browser}).`;
  } else {
    engineNote.textContent = "Proxy engine pinned. Junk-free, but JavaScript-heavy sites may break.";
  }
}

function setPreference(next) {
  preference = next;
  localStorage.setItem("prism:engine", next);
  renderEngine();
}

engineBtn.addEventListener("click", () => {
  const order = liveUsable() ? ["auto", "live", "proxy"] : ["auto", "proxy"];
  const next = order[(order.indexOf(preference) + 1) % order.length];
  setPreference(next);
  if (!liveUsable() && preference === "live") showBanner("Live mode is not available on this machine.", "Details", () => showLiveUnavailable());
  // Re-resolve the current page under the new preference.
  if (browsing && stack[index]) navigate(stack[index].url, { push: false, force: true });
});

/* ------------------------------------------------------------------ *
 * history / loading UI
 * ------------------------------------------------------------------ */
function updateNav() {
  backBtn.disabled = index <= 0;
  fwdBtn.disabled = index < 0 || index >= stack.length - 1;
}

function setLoading(on) {
  progress.hidden = !on;
}

function showStage(which) {
  start.hidden = which !== "start";
  iframe.hidden = which !== "proxy";
  liveView.hidden = which !== "live";
}

let bannerLink = null;

/**
 * Banner with an optional "get Prism for your computer" link, used wherever the
 * hosted copy has to admit that something needs the local app.
 */
function showDownloadBanner(text) {
  showBanner(text, null, null);
  if (!bannerLink) {
    bannerLink = document.createElement("a");
    bannerLink.className = "banner-link";
    bannerLink.target = "_blank";
    bannerLink.rel = "noreferrer noopener";
    bannerLink.textContent = "Download for Mac / Windows";
    banner.appendChild(bannerLink);
  }
  bannerLink.href = DOWNLOAD_MAC;
  bannerLink.dataset.mac = DOWNLOAD_MAC;
  bannerLink.dataset.windows = DOWNLOAD_WINDOWS;
  bannerLink.hidden = false;
}

function hideBannerLink() {
  if (bannerLink) bannerLink.hidden = true;
}

function showBanner(text, actionLabel, action) {
  bannerText.textContent = text;
  banner.hidden = false;
  hideBannerLink();
  if (actionLabel && action) {
    bannerAction.hidden = false;
    bannerAction.textContent = actionLabel;
    bannerAction.onclick = () => {
      banner.hidden = true;
      action();
    };
  } else {
    bannerAction.hidden = true;
  }
}

bannerClose.addEventListener("click", () => {
  banner.hidden = true;
});

function goHome() {
  browsing = false;
  teardownLive();
  iframe.hidden = true;
  iframe.removeAttribute("src");
  showStage("start");
  urlInput.value = "";
  setLoading(false);
  updateNav();
  renderEngine();
  document.getElementById("start-q").focus();
}

/* ------------------------------------------------------------------ *
 * proxy engine
 * ------------------------------------------------------------------ */
function loadProxy(url) {
  teardownLive();
  showStage("proxy");
  setLoading(true);
  iframe.src = toProxyUrl(url);
}

iframe.addEventListener("error", () => {
  setLoading(false);
  onProxyFailure();
});

iframe.addEventListener("load", () => {
  setLoading(false);
  let href = null;
  try {
    href = iframe.contentWindow.location.href;
  } catch {}
  if (!href) return;
  if (/\/proxy\?/.test(href)) {
    const q = new URL(href);
    const t = q.searchParams.get("url");
    if (t) setCurrentUrl(t);
    return;
  }
  const target = targetFromLocal(href);
  if (target) setCurrentUrl(target);
});

/* ------------------------------------------------------------------ *
 * live engine
 * ------------------------------------------------------------------ */
function showLiveUnavailable(context) {
  showStage("live");
  liveOverlay.hidden = false;
  const lead = context ? `${context} ` : "";
  if (live.hosted) {
    liveReason.textContent =
      lead +
      "This is the hosted copy of Prism. Live mode needs a real browser on your own machine, so it only runs locally — that is also the only way Cloudflare-protected sites load.";
    liveHint.textContent =
      "Download Prism, unzip it, and start it with the launcher inside. It uses the Chrome, Edge or Chromium already on your computer.";
  } else {
    liveReason.textContent = lead + (live.reason || "No Chromium-based browser was found.");
    liveHint.textContent = live.hint || "";
  }
  document.getElementById("dl-mac").href = DOWNLOAD_MAC;
  document.getElementById("dl-windows").href = DOWNLOAD_WINDOWS;
}

document.getElementById("live-fallback").addEventListener("click", () => {
  liveOverlay.hidden = true;
  setPreference("proxy");
  if (stack[index]) navigate(stack[index].url, { push: false, force: true });
});

function teardownLive() {
  if (liveConn) {
    try {
      liveConn.close();
    } catch {}
  }
  liveConn = null;
  liveSession = null;
}

function loadLive(url) {
  showStage("live");
  liveOverlay.hidden = true;
  liveSession = { url };
  setLoading(true);

  const wanted = url;
  if (liveConn && liveConn.readyState === WebSocket.OPEN) {
    liveConn.send(JSON.stringify({ t: "nav", url: wanted }));
    return;
  }

  teardownLive();
  liveSession = { url: wanted };
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const conn = new WebSocket(`${proto}//${location.host}/live/ws?url=${encodeURIComponent(wanted)}`);
  liveConn = conn;

  conn.addEventListener("open", () => {
    if (!liveSession) return;
    sendLiveViewport();
  });

  conn.addEventListener("message", (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    handleLiveMessage(msg);
  });

  conn.addEventListener("close", () => {
    if (liveConn === conn) liveConn = null;
    setLoading(false);
    if (browsing && stack[index] && stack[index].engine === "live") {
      showBanner("The live browser session ended.", "Reconnect", () => {
        if (stack[index]) navigate(stack[index].url, { push: false, force: true });
      });
    }
  });

  conn.addEventListener("error", () => {
    setLoading(false);
  });
}

function handleLiveMessage(msg) {
  switch (msg.t) {
    case "frame":
      liveFrame.src = "data:image/jpeg;base64," + msg.d;
      if (msg.w && msg.h) liveFrame.dataset.viewport = `${msg.w}x${msg.h}`;
      setLoading(false);
      return;
    case "url":
      if (msg.url && /^https?:/i.test(msg.url)) {
        liveSession = liveSession || {};
        liveSession.url = msg.url;
        setCurrentUrl(msg.url);
      }
      return;
    case "loading":
      setLoading(!!msg.on);
      return;
    case "ready":
      setLoading(false);
      if (msg.url && /^https?:/i.test(msg.url)) {
        liveSession = liveSession || {};
        liveSession.url = msg.url;
        setCurrentUrl(msg.url);
      }
      return;
    case "challenge":
      showBanner(
        `${msg.vendor || "Bot protection"} is checking this browser. If a checkbox appears, click it — then the page loads normally.`,
        "Reload",
        () => liveSend({ t: "reload" })
      );
      return;
    case "popup":
      if (msg.url) showBanner(`This site tried to open a popup: ${msg.url}`, "Open here", () => navigate(msg.url));
      return;
    case "error":
      live.available = false;
      live.state = "unavailable";
      live.reason = msg.message || "Live engine failed.";
      live.hint = msg.hint || "";
      renderEngine();
      showLiveUnavailable();
      teardownLive();
      return;
    default:
      return;
  }
}

function liveSend(payload) {
  if (liveConn && liveConn.readyState === WebSocket.OPEN) {
    liveConn.send(JSON.stringify(payload));
    return true;
  }
  return false;
}

function liveViewportSize() {
  const rect = liveView.getBoundingClientRect();
  return { w: Math.round(rect.width), h: Math.round(rect.height) };
}

function sendLiveViewport() {
  const { w, h } = liveViewportSize();
  liveSend({ t: "resize", w, h });
}

/* --- input forwarding --- */
function pointFor(event) {
  const rect = liveFrame.getBoundingClientRect();
  const vp = (liveFrame.dataset.viewport || `${rect.width}x${rect.height}`).split("x").map(Number);
  const scaleX = vp[0] / rect.width || 1;
  const scaleY = vp[1] / rect.height || 1;
  return {
    x: Math.round((event.clientX - rect.left) * scaleX),
    y: Math.round((event.clientY - rect.top) * scaleY),
  };
}

function modifiersFor(event) {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
}

let lastMove = 0;
liveView.addEventListener("mousemove", (event) => {
  const now = performance.now();
  if (now - lastMove < 25) return;
  lastMove = now;
  const { x, y } = pointFor(event);
  liveSend({ t: "mouse", type: "move", x, y });
});

liveView.addEventListener("mousedown", (event) => {
  liveInput.focus({ preventScroll: true });
  const { x, y } = pointFor(event);
  liveSend({ t: "mouse", type: "down", x, y, button: event.button === 2 ? "right" : "left", clickCount: 1, modifiers: modifiersFor(event) });
  event.preventDefault();
});

liveView.addEventListener("mouseup", (event) => {
  const { x, y } = pointFor(event);
  liveSend({ t: "mouse", type: "up", x, y, button: event.button === 2 ? "right" : "left", clickCount: 1, modifiers: modifiersFor(event) });
});

liveView.addEventListener("contextmenu", (event) => event.preventDefault());

liveView.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    const { x, y } = pointFor(event);
    liveSend({ t: "wheel", x, y, dx: event.deltaX, dy: event.deltaY });
  },
  { passive: false }
);

liveInput.addEventListener("keydown", (event) => {
  if (event.isComposing) return;
  event.preventDefault();
  const printable = event.key.length === 1;
  liveSend({
    t: "key",
    type: "down",
    key: event.key,
    code: event.code,
    keyCode: event.keyCode,
    text: printable && !event.ctrlKey && !event.metaKey ? event.key : undefined,
    modifiers: modifiersFor(event),
  });
});

liveInput.addEventListener("keyup", (event) => {
  event.preventDefault();
  liveSend({
    t: "key",
    type: "up",
    key: event.key,
    code: event.code,
    keyCode: event.keyCode,
    modifiers: modifiersFor(event),
  });
});

liveInput.addEventListener("paste", (event) => {
  const text = (event.clipboardData || window.clipboardData)?.getData("text");
  if (text) liveSend({ t: "text", text });
  event.preventDefault();
});

liveInput.addEventListener("input", () => {
  liveInput.value = "";
});

if (typeof ResizeObserver === "function") {
  new ResizeObserver(() => {
    if (browsing && stack[index] && stack[index].engine === "live") sendLiveViewport();
  }).observe(liveView);
} else {
  window.addEventListener("resize", () => {
    if (browsing && stack[index] && stack[index].engine === "live") sendLiveViewport();
  });
}

/* ------------------------------------------------------------------ *
 * navigation
 * ------------------------------------------------------------------ */
function setCurrentUrl(url) {
  urlInput.value = url;
  if (index >= 0 && stack[index]) stack[index].url = url;
  renderEngine();
}

function navigate(raw, { push = true, force = false, engine: pinnedEngine } = {}) {
  const input = describeInput(raw);
  if (!input) return;

  const current = stack[index];
  // `engine` is set when replaying a history entry, which must keep the engine
  // it was loaded with. Everything else resolves from the current preference,
  // including forced re-loads (that is how a bot wall escalates to Live mode).
  let engine;
  if (pinnedEngine) engine = pinnedEngine;
  else if (input.url) engine = resolveEngine(input.url);
  else engine = liveUsable() && preference !== "proxy" ? "live" : "proxy";

  const url = input.url || searchUrl(input.query, engine);
  if (!force && current && current.url === url && current.engine === engine) return;

  browsing = true;
  showStage(engine === "live" ? "live" : "proxy");
  urlInput.value = url;

  if (push) {
    stack.splice(index + 1);
    stack.push({ url, engine });
    index = stack.length - 1;
  } else if (stack[index]) {
    stack[index] = { url, engine };
  } else {
    stack.push({ url, engine });
    index = 0;
  }

  if (engine === "live") loadLive(url);
  else loadProxy(url);

  updateNav();
  renderEngine();
}

/* ------------------------------------------------------------------ *
 * wiring
 * ------------------------------------------------------------------ */
document.getElementById("omnibox").addEventListener("submit", (event) => {
  event.preventDefault();
  navigate(urlInput.value);
});

document.getElementById("start-form").addEventListener("submit", (event) => {
  event.preventDefault();
  navigate(document.getElementById("start-q").value);
});

document.querySelectorAll("[data-go]").forEach((btn) => {
  btn.addEventListener("click", () => navigate(btn.getAttribute("data-go")));
});

backBtn.addEventListener("click", () => {
  if (index <= 0) return;
  index -= 1;
  const entry = stack[index];
  navigate(entry.url, { push: false, force: true, engine: entry.engine });
});

fwdBtn.addEventListener("click", () => {
  if (index >= stack.length - 1) return;
  index += 1;
  const entry = stack[index];
  navigate(entry.url, { push: false, force: true, engine: entry.engine });
});

reloadBtn.addEventListener("click", () => {
  if (!browsing || index < 0) return;
  const entry = stack[index];
  if (entry.engine === "live") {
    liveSend({ t: "reload" });
    setLoading(true);
  } else {
    iframe.src = toProxyUrl(entry.url);
    setLoading(true);
  }
});

homeBtn.addEventListener("click", goHome);

window.addEventListener("message", (event) => {
  if (!event.data) return;
  if (event.data.type === "prism-url" && event.data.url) setCurrentUrl(event.data.url);
  if (event.data.type === "prism-go" && event.data.url) navigate(event.data.url);
  if (event.data.type === "prism-proxy-error") onProxyFailure();
  if (event.data.type === "prism-blocked") onBotWall(event.data.vendor || "Bot protection", event.data.url);
});

/**
 * A proxied page came back as a bot wall (Cloudflare, DataDome…). The proxy
 * cannot pass those; the live browser usually can, because it is a real
 * browser on the user's own network.
 */
function onBotWall(vendor, pageUrl) {
  const key = pageUrl || (stack[index] && stack[index].url) || "";
  const host = hostOf(key) || key;

  if (liveUsable() && !autoEscalated.has(key)) {
    autoEscalated.add(key);
    showBanner(
      `${vendor} challenged this page, so Prism opened it in Live mode — a real browser on your machine. If you see a checkbox, click it.`,
      "Stay in Live",
      () => {
        banner.hidden = true;
      }
    );
    setPreference("live");
    navigate(key, { push: false, force: true });
    return;
  }

  if (liveUsable()) {
    showBanner(`${vendor} is still checking this page. Click the checkbox in the page, or reload.`, "Reload", () => {
      reloadBtn.click();
    });
    return;
  }

  showBanner(
    `${vendor} blocks the proxy engine — it sees a server, not your browser. The local app drives your own Chrome, on your own network, and gets through.`,
    "How?",
    () => {
      showLiveUnavailable(`${vendor} blocks requests that come from a server.`);
      if (!live.hosted) {
        liveHint.textContent =
          "In the local app, Prism opens this page in Live mode — your own Chrome, your own IP — where the check can actually be passed.";
      }
    }
  );
  if (live.hosted) showDownloadBanner(`${vendor} blocks the hosted proxy. Run Prism locally to load ${host}.`);
}

function onProxyFailure() {
  if (stack[index] && stack[index].engine === "live") return;
  if (liveUsable()) {
    showBanner("This page needs a real browser. Open it in Live mode?", "Switch to Live", () => {
      setPreference("live");
      if (stack[index]) navigate(stack[index].url, { push: false, force: true });
    });
  } else {
    showBanner("This page could not be proxied, and Live mode is not available on this machine.");
  }
  setLoading(false);
}

document.addEventListener("keydown", (event) => {
  const inField = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || "");
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l") {
    event.preventDefault();
    urlInput.focus();
    urlInput.select();
  }
  if (event.key === "F5" || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r")) {
    if (!inField) {
      event.preventDefault();
      reloadBtn.click();
    }
  }
  if (event.altKey && event.key === "ArrowLeft") backBtn.click();
  if (event.altKey && event.key === "ArrowRight") fwdBtn.click();
});

/* ------------------------------------------------------------------ *
 * boot
 * ------------------------------------------------------------------ */
async function boot() {
  renderEngine();
  await Promise.all([
    (async () => {
      try {
        const res = await fetch("/live/status", { cache: "no-store" });
        const json = await res.json();
        live = { ...live, ...json };
      } catch {
        live = { ...live, available: false, state: "unavailable", reason: "Could not reach the Prism server." };
      }
    })(),
    detectTransport(),
  ]);
  renderEngine();
  if (!proxyReachable) {
    showDownloadBanner(
      "This copy of Prism cannot proxy: the proxy endpoint is not answering. The local app works:"
    );
  } else if (live.hosted) {
    // Hosted copies can proxy, but never drive a browser: make the way out
    // visible instead of only mentioning it in a card the user has to find.
    showDownloadBanner(
      "Hosted copy: proxy engine only. Most sites work; anything needing a real browser (or behind Cloudflare) needs the local app."
    );
  }
}

boot();
