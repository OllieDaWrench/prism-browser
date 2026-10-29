"use strict";

/**
 * Prism proxy engine.
 *
 * A target URL is mapped onto a path of the Prism origin:
 *
 *     https://news.ycombinator.com/item?id=1  ->  /https/news.ycombinator.com/item?id=1
 *
 * Why a path and not `?url=`:
 *   - relative and root-relative URLs resolve to the right proxied address
 *     without a fragile HTML rewrite pass,
 *   - the browser keeps its own history / reload behaviour,
 *   - cookies can be scoped with `Path=/<scheme>/<host>` so every target site
 *     gets its own cookie bubble,
 *   - redirects can be re-emitted as local 302s instead of being swallowed.
 */

const dns = require("dns").promises;
const net = require("net");
const tls = require("tls");
const { Readable } = require("stream");
const { scriptTag } = require("./shim");

const UA =
  process.env.PRISM_UA ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const MAX_BODY = 25 * 1024 * 1024;
const allowPrivate = () => process.env.PRISM_ALLOW_PRIVATE === "1";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Headers that stop an embedded page from working: the proxy is the embedder,
 * so the target's own framing / CSP policy is re-implemented by Prism.
 */
const STRIP_RESPONSE_HEADERS = new Set([
  ...HOP_BY_HOP,
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "x-xss-protection",
  "clear-site-data",
  "strict-transport-security",
  "content-encoding",
  "content-length",
  "set-cookie",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
  "origin-agent-cluster",
  "alt-svc",
  "report-to",
  "reporting-endpoints",
  "nel",
]);

/* ------------------------------------------------------------------ *
 * URL <-> path mapping
 * ------------------------------------------------------------------ */

function proxyPath(absUrl) {
  let u;
  try {
    u = new URL(absUrl);
  } catch {
    return absUrl;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return absUrl;
  return `/${u.protocol.slice(0, -1)}/${u.host}${u.pathname}${u.search}${u.hash}`;
}

function hostPrefix(absUrl) {
  try {
    const u = new URL(absUrl);
    return `/${u.protocol.slice(0, -1)}/${u.host}`;
  } catch {
    return "/";
  }
}

/** Extract the target URL from a raw request URL (`/https/host/path?q`). */
function parseTarget(rawUrl) {
  const raw = String(rawUrl || "");
  const qIndex = raw.indexOf("?");
  const path = qIndex === -1 ? raw : raw.slice(0, qIndex);
  const search = qIndex === -1 ? "" : raw.slice(qIndex);

  if (path.startsWith("/https/")) return "https://" + path.slice(7) + search;
  if (path.startsWith("/http/")) return "http://" + path.slice(6) + search;
  if (path.startsWith("/p/") || path.startsWith("/r/")) {
    const rest = path.slice(3) + search;
    const plain = safeDecode(rest);
    if (/^https?:\/\//i.test(plain)) return plain;
    const b64 = decodeBase64Url(rest.split("?")[0]);
    if (b64 && /^https?:\/\//i.test(b64)) {
      const extra = rest.includes("?") ? "?" + rest.split("?").slice(1).join("?") : "";
      return b64 + extra;
    }
    return null;
  }
  return null;
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function decodeBase64Url(s) {
  try {
    const normalized = s.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(normalized, "base64").toString("utf8");
  } catch {
    return null;
  }
}

/** Target URL -> local path for use in Location headers / rewritten markup. */
function toLocal(target, fallback) {
  const abs = absolutise(target, fallback);
  return abs ? proxyPath(abs) : null;
}

function absolutise(value, base) {
  try {
    const u = new URL(String(value), base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.href;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * SSRF guard
 * ------------------------------------------------------------------ */

function isPrivateIp(ip) {
  if (net.isIP(ip) === 4) {
    const p = ip.split(".").map(Number);
    if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
    return false;
  }
  if (net.isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
    if (lower.startsWith("::ffff:")) return isPrivateIp(lower.slice(7));
    return false;
  }
  return true;
}

async function assertSafe(target) {
  let u;
  try {
    u = new URL(target);
  } catch {
    throw new ProxyError("That doesn't look like a valid URL.", 400);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new ProxyError("Only http:// and https:// addresses can be opened.", 400);
  }
  if (allowPrivate()) return u;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new ProxyError("Local network addresses are blocked by this proxy.", 400);
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new ProxyError("Local network addresses are blocked by this proxy.", 400);
    return u;
  }
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw new ProxyError(`Couldn't resolve ${host}. Check the address or your connection.`, 502);
  }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
    throw new ProxyError("That address points inside a private network and is blocked.", 400);
  }
  return u;
}

class ProxyError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

/* ------------------------------------------------------------------ *
 * Markup / CSS rewriting
 * ------------------------------------------------------------------ */

function rewriteCss(css, base) {
  return css
    .replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, (m, q, u) => {
      const trimmed = u.trim();
      if (!trimmed || /^(data:|#)/i.test(trimmed)) return m;
      const mapped = rewriteRef(trimmed, base);
      return `url(${q}${mapped}${q})`;
    })
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, u) => {
      const mapped = rewriteRef(u, base);
      return `@import ${q}${mapped}${q}`;
    });
}

/** Rewrite a single URL reference found in markup or CSS. */
function rewriteRef(value, base) {
  const raw = String(value).trim();
  if (!raw) return value;
  if (/^(data:|blob:|javascript:|mailto:|tel:|about:|#|\{)/i.test(raw)) return value;

  const resolved = absolutise(raw, base);
  if (!resolved) return value;

  let baseUrl;
  try {
    baseUrl = new URL(base);
  } catch {
    return value;
  }
  const target = new URL(resolved);

  const rootRelative = raw.startsWith("/") && !raw.startsWith("//");
  const sameOrigin = target.origin === baseUrl.origin;

  if (sameOrigin || rootRelative) return proxyPath(resolved);
  return value;
}

function rewriteSrcset(value, base) {
  return value
    .split(/,\s*(?=[^,]*$|https?:|\/)/)
    .map((part) => {
      const t = part.trim();
      if (!t) return part;
      const sp = t.search(/\s/);
      if (sp === -1) return rewriteRef(t, base);
      return rewriteRef(t.slice(0, sp), base) + t.slice(sp);
    })
    .join(", ");
}

const ATTR_RE =
  /(\s(?:src|href|action|poster|formaction|data-src|data-href|data-url|data-srcset|imagesrcset|srcset|cite|manifest)\s*=\s*)(["'])([^"']*)\2/gi;

function rewriteHtml(html, pageUrl) {
  const prefix = hostPrefix(pageUrl);

  // A <base> tag would send every relative URL somewhere else entirely.
  html = html.replace(/<base\b[^>]*>/gi, "");
  // The proxy re-implements framing policy, so drop the page's own.
  html = html.replace(
    /<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi,
    ""
  );
  // SRI digests cannot match rewritten/re-served bytes.
  html = html.replace(/\s(?:integrity|nonce)\s*=\s*["'][^"']*["']/gi, "");

  html = html.replace(ATTR_RE, (m, pre, q, value) => {
    const isSrcset = /srcset/i.test(pre);
    const mapped = isSrcset ? rewriteSrcset(value, pageUrl) : rewriteRef(value, pageUrl);
    return pre + q + mapped + q;
  });

  // inline styles + <style> blocks
  html = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, a, css, b) => a + rewriteCss(css, pageUrl) + b);
  html = html.replace(/\sstyle=(["'])([\s\S]*?)\1/gi, (m, q, css) => ` style=${q}${rewriteCss(css, pageUrl)}${q}`);
  html = html.replace(/(<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=\s*["'])([^"']*)(["'])/gi, (m, pre, content, post) => {
    const mapped = content.replace(/url\s*=\s*([^\s;]+)/i, (mm, u) => "url=" + rewriteRef(u, pageUrl));
    return pre + mapped + post;
  });

  const inject = scriptTag(pageUrl, prefix);
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (m) => m + inject);
  if (/<html\b[^>]*>/i.test(html)) return html.replace(/<html\b[^>]*>/i, (m) => m + inject);
  if (/<!doctype[^>]*>/i.test(html)) return html.replace(/<!doctype[^>]*>/i, (m) => m + inject);
  return inject + html;
}

/* ------------------------------------------------------------------ *
 * Cookies
 * ------------------------------------------------------------------ */

/** Re-scope a target site's Set-Cookie header onto our local path space. */
function rewriteSetCookie(line, pageUrl) {
  const parts = String(line).split(";");
  const pair = parts.shift();
  if (!pair || pair.indexOf("=") === -1) return null;

  const prefix = hostPrefix(pageUrl);
  const isHttps = pageUrl.startsWith("https:");
  const out = [pair.trim()];
  let sameSite = null;

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    const key = (eq === -1 ? trimmed : trimmed.slice(0, eq)).toLowerCase();
    const value = eq === -1 ? "" : trimmed.slice(eq + 1);
    if (key === "domain" || key === "priority" || key === "partitioned") continue;
    if (key === "path") {
      out.push(`Path=${prefix}`);
      continue;
    }
    if (key === "samesite") {
      sameSite = value || "Lax";
      continue;
    }
    if (key === "secure") {
      // only meaningful when the local page itself is https
      if (isHttps) out.push("Secure");
      continue;
    }
    out.push(trimmed);
  }

  let site = (sameSite || "").toLowerCase();
  if (site === "none" && !isHttps) site = "lax";
  out.push(`SameSite=${site === "strict" ? "Strict" : site === "none" ? "None" : "Lax"}`);
  if (!out.some((p) => /^Path=/i.test(p))) out.push(`Path=${prefix}`);
  return out.join("; ");
}

/* ------------------------------------------------------------------ *
 * Request plumbing
 * ------------------------------------------------------------------ */

const FORWARD_REQUEST_HEADERS = [
  "accept",
  "accept-language",
  "accept-encoding",
  "cache-control",
  "content-type",
  "if-none-match",
  "if-modified-since",
  "if-range",
  "range",
  "pragma",
  "x-requested-with",
];

/** Decode a prism-local URL (e.g. a Referer) back into a target URL. */
function localToTarget(value, reqOrigin) {
  if (!value) return null;
  try {
    const u = new URL(value, reqOrigin);
    const target = parseTarget(u.pathname + u.search);
    return target;
  } catch {
    return null;
  }
}

function buildUpstreamHeaders(req, target, reqOrigin) {
  const headers = {
    "user-agent": req.headers["user-agent"] && !/prism/i.test(req.headers["user-agent"]) ? req.headers["user-agent"] : UA,
    accept: req.headers.accept || "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": req.headers["accept-language"] || "en-US,en;q=0.9",
    "accept-encoding": "gzip, deflate, br",
  };
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = req.headers[name];
    if (value && !(name in headers)) headers[name] = value;
  }

  const targetUrl = new URL(target);
  if (req.headers.cookie && !/prism_sid/.test(req.headers.cookie)) headers.cookie = req.headers.cookie;
  else if (req.headers.cookie) {
    const cleaned = req.headers.cookie
      .split(";")
      .map((c) => c.trim())
      .filter((c) => c && !c.startsWith("prism_"))
      .join("; ");
    if (cleaned) headers.cookie = cleaned;
  }

  const referer = localToTarget(req.headers.referer, reqOrigin);
  headers.referer = referer || targetUrl.origin + "/";

  const origin = localToTarget(req.headers.origin, reqOrigin);
  if (origin) headers.origin = new URL(origin).origin;
  else if (req.headers.origin && req.headers.origin === reqOrigin) headers.origin = targetUrl.origin;

  if (req.headers["sec-fetch-site"]) headers["sec-fetch-site"] = "same-origin";
  if (req.headers["sec-fetch-mode"]) headers["sec-fetch-mode"] = "cors";
  return headers;
}

async function readBody(req) {
  if (req.method === "GET" || req.method === "HEAD") return null;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new ProxyError("That upload is too large for Prism (25 MB max).", 413);
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : null;
}

/** Decode a body using the charset the server declared (or the meta tag). */
function decodeBody(buffer, contentType, sniffMeta) {
  let charset = null;
  const declared = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType || "");
  if (declared) charset = declared[1];
  if (!charset && sniffMeta) {
    const head = buffer.subarray(0, 2048).toString("latin1");
    const meta =
      /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head) ||
      /<meta[^>]+content\s*=\s*["'][^"']*charset=([\w.:-]+)/i.exec(head);
    if (meta) charset = meta[1];
  }
  if (!charset || /^utf-?8$/i.test(charset) || /^unicode-1-1-utf-8$/i.test(charset)) {
    return buffer.toString("utf8");
  }
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buffer);
  } catch {
    return buffer.toString("utf8");
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function errorPage(message, url, status) {
  const hint =
    status >= 500
      ? "The site refused the connection or never answered. JavaScript-heavy sites (ChatGPT, Reddit, Spotify…) usually cannot be proxied at all — switch Prism to Live mode, which renders them in a real browser."
      : "";
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Couldn’t load page</title><style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#101218;color:#e8e6e1;font-family:"Segoe UI",system-ui,sans-serif;padding:24px}
.card{max-width:520px;padding:28px 30px;border:1px solid #2c3340;border-radius:18px;background:#181c24;box-shadow:0 24px 60px rgba(0,0,0,.45)}
.badge{display:inline-block;margin-bottom:14px;padding:4px 10px;border-radius:999px;background:rgba(226,182,87,.14);color:#e2b657;font-size:11px;letter-spacing:.14em;text-transform:uppercase}
h1{margin:0 0 10px;font-size:19px;color:#e2b657}
p{margin:0 0 10px;color:#9aa3b2;line-height:1.6;word-break:break-word}
.url{margin-top:14px;padding:10px 12px;border-radius:10px;background:#0d1016;border:1px solid #232a36;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#8d96a6;word-break:break-all}
.hint{margin-top:16px;font-size:13px;color:#7d8798}
</style></head><body><div class="card"><span class="badge">Prism proxy</span><h1>Couldn’t load this page</h1><p>${escapeHtml(
    message
  )}</p><div class="url">${escapeHtml(url || "")}</div>${hint ? `<p class="hint">${escapeHtml(hint)}</p>` : ""}</div><script>try{if(window.top!==window)window.top.postMessage({type:"prism-proxy-error"},"*")}catch(e){}</script></body></html>`;
}

function sendError(res, err, target) {
  const status = err instanceof ProxyError ? err.status : 502;
  const message = err && err.message ? err.message : "Something went wrong while loading this page.";
  if (res.headersSent) {
    try {
      res.end();
    } catch {}
    return;
  }
  res.status(status);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(errorPage(message, target, status));
}

function relativeCssTargets(css, base) {
  return css.replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, (m, q, u) => {
    const trimmed = u.trim();
    if (!trimmed || /^(data:|#)/i.test(trimmed)) return m;
    return `url(${q}${rewriteRef(trimmed, base)}${q})`;
  });
}

/* ------------------------------------------------------------------ *
 * Main handler
 * ------------------------------------------------------------------ */

async function handleProxy(req, res, opts = {}) {
  const reqOrigin = `${req.headers["x-forwarded-proto"] || (req.socket && req.socket.encrypted ? "https" : "http")}://${req.headers.host || "localhost"}`;
  let target = parseTarget(req.url);
  if (!target) {
    const qs = new URL(req.url, reqOrigin);
    const param = qs.searchParams.get("url") || qs.searchParams.get("u");
    if (param) target = param;
  }
  if (!target) return sendError(res, new ProxyError("No address to load.", 400), "");

  let url;
  try {
    url = await assertSafe(target);
  } catch (e) {
    return sendError(res, e, target);
  }

  const headers = buildUpstreamHeaders(req, url.href, reqOrigin);
  const init = { method: req.method, headers, redirect: "manual" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  init.signal = controller.signal;

  try {
    const body = await readBody(req);
    if (body && body.length) init.body = body;
  } catch (e) {
    clearTimeout(timer);
    return sendError(res, e, url.href);
  }

  let response;
  try {
    response = await fetch(url.href, init);
  } catch (e) {
    clearTimeout(timer);
    const reason =
      e && e.name === "AbortError"
        ? "The site took too long to answer."
        : `The site did not answer (${(e && e.message) || "connection failed"}).`;
    return sendError(res, new ProxyError(reason, 502), url.href);
  }
  clearTimeout(timer);

  // Hand redirects to the browser as local redirects so its address bar,
  // history and relative resolution stay correct.
  if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
    const next = absolutise(response.headers.get("location"), url.href);
    try {
      await response.body?.cancel();
    } catch {}
    if (!next) {
      res.status(response.status);
      res.end();
      return;
    }
    if (response.status === 304) {
      res.status(304);
      res.end();
      return;
    }
    res.status(response.status === 303 ? 303 : response.status);
    res.setHeader("Location", proxyPath(next));
    res.setHeader("Cache-Control", "no-store");
    res.end();
    return;
  }

  const contentType = (response.headers.get("content-type") || "application/octet-stream").toLowerCase();
  // Only real HTML documents get rewritten; XML (RSS, sitemaps) must stay byte
  // exact or it stops parsing.
  const isHtml = contentType.includes("html");
  const isCss = contentType.startsWith("text/css");
  const encoded = Boolean(response.headers.get("content-encoding"));

  response.headers.forEach((value, name) => {
    const key = name.toLowerCase();
    if (STRIP_RESPONSE_HEADERS.has(key)) return;
    // A cookie jar is pointless when we forward cookies to the browser.
    try {
      res.setHeader(key, value);
    } catch {}
  });

  // Length survives only when the body reached us untouched and unmodified.
  const declaredLength = response.headers.get("content-length");
  if (!encoded && declaredLength && !isHtml && !isCss) res.setHeader("Content-Length", declaredLength);

  const cookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  const rewrittenCookies = cookies.map((line) => rewriteSetCookie(line, url.href)).filter(Boolean);
  if (rewrittenCookies.length) res.setHeader("Set-Cookie", rewrittenCookies);

  if (req.method === "HEAD") {
    res.status(response.status);
    res.end();
    return;
  }

  if (isHtml) {
    let text;
    try {
      text = decodeBody(Buffer.from(await response.arrayBuffer()), contentType, true);
    } catch (e) {
      return sendError(res, new ProxyError("The page body could not be read.", 502), url.href);
    }
    res.status(response.status);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(rewriteHtml(text, url.href));
    return;
  }

  if (isCss) {
    let text;
    try {
      text = decodeBody(Buffer.from(await response.arrayBuffer()), contentType, false);
    } catch {
      return sendError(res, new ProxyError("The stylesheet could not be read.", 502), url.href);
    }
    res.status(response.status);
    res.setHeader("Content-Type", "text/css; charset=utf-8");
    res.end(rewriteCss(text, url.href));
    return;
  }

  res.status(response.status);
  if (!response.body) {
    res.end();
    return;
  }
  try {
    await new Promise((resolve, reject) => {
      const stream = Readable.fromWeb(response.body);
      stream.on("error", reject);
      res.on("close", () => stream.destroy());
      stream.pipe(res);
      stream.on("end", resolve);
    });
  } catch {
    try {
      res.end();
    } catch {}
  }
}

/* ------------------------------------------------------------------ *
 * Websocket tunnelling: /ws/<scheme>/<host>/<path>
 * ------------------------------------------------------------------ */

function parseWsTarget(rawUrl) {
  const raw = String(rawUrl || "");
  if (!raw.startsWith("/ws/")) return null;
  const rest = raw.slice(4);
  if (!/^https?\//i.test(rest)) return null;
  return rest.slice(0, rest.indexOf("/")) + "://" + rest.slice(rest.indexOf("/") + 1);
}

function tunnelWebSocket(req, socket, head) {
  const target = parseWsTarget(req.url);
  if (!target) {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }

  let url;
  try {
    url = new URL(target);
  } catch {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }

  const secure = url.protocol === "https:";
  const port = Number(url.port) || (secure ? 443 : 80);
  const host = url.hostname.replace(/^\[|\]$/g, "");

  const key = req.headers["sec-websocket-key"] || Buffer.from(String(Math.random())).toString("base64");
  const lines = [
    `GET ${url.pathname}${url.search} HTTP/1.1`,
    `Host: ${url.host}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
    `User-Agent: ${UA}`,
  ];
  for (const name of ["origin", "cookie", "sec-websocket-protocol", "sec-websocket-extensions", "authorization"]) {
    const value = req.headers[name];
    if (!value) continue;
    if (name === "origin") {
      try {
        lines.push(`Origin: ${new URL(url.href).origin}`);
      } catch {}
      continue;
    }
    lines.push(`${name.replace(/(^|-)\w/g, (m) => m.toUpperCase())}: ${value}`);
  }

  const upstream = secure
    ? tls.connect({ host, port, servername: host })
    : net.connect({ host, port });

  const fail = (msg) => {
    try {
      if (!socket.destroyed) socket.end(`HTTP/1.1 502 Bad Gateway\r\nX-Prism-Error: ${msg}\r\n\r\n`);
    } catch {}
    try {
      upstream.destroy();
    } catch {}
  };

  upstream.setNoDelay(true);
  upstream.on("error", () => fail("upstream websocket failed"));
  upstream.on("close", () => {
    try {
      socket.destroy();
    } catch {}
  });
  socket.on("close", () => {
    try {
      upstream.destroy();
    } catch {}
  });
  socket.on("error", () => {
    try {
      upstream.destroy();
    } catch {}
  });

  upstream.on("connect", () => {
    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    if (head && head.length) {
      try {
        upstream.write(head);
      } catch {}
    }
    upstream.pipe(socket);
    socket.pipe(upstream);
  });

  // Long-lived, mostly-idle sockets must not be reaped by the http server.
  socket.setTimeout(0);
  socket.setNoDelay(true);
  upstream.setTimeout(0);
}

/** Recover the target URL from a prism-local page address. */
function targetFromLocal(href, origin) {
  try {
    const u = new URL(href, origin);
    if (origin && u.origin !== origin) return null;
    return parseTarget(u.pathname + u.search);
  } catch {
    return null;
  }
}

module.exports = {
  handleProxy,
  assertSafe,
  decodeBody,
  targetFromLocal,
  tunnelWebSocket,
  parseTarget,
  proxyPath,
  hostPrefix,
  rewriteHtml,
  rewriteCss,
  errorPage,
  UA,
};
