const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");
const path = require("path");
const express = require("express");

const PORT = Number(process.env.PORT) || 3000;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const app = express();
const jars = new Map();

app.use(express.static(path.join(__dirname, "public")));
app.use("/proxy", express.raw({ type: "*/*", limit: "25mb" }));

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function sidFrom(req, res) {
  let sid = parseCookies(req.headers.cookie).prism_sid;
  if (!sid) {
    sid = crypto.randomBytes(16).toString("hex");
    res.append("Set-Cookie", `prism_sid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
  }
  return sid;
}

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
    throw new Error("Invalid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Only http and https are allowed");
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("That address is not allowed");
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error("That address is not allowed");
    return u;
  }
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw new Error("Could not resolve hostname");
  }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error("That address is not allowed");
  }
  return u;
}

function preferLite(u) {
  const host = u.hostname.replace(/^www\./, "");
  if (host === "google.com" || host.endsWith(".google.com")) {
    if (u.pathname === "/" || u.pathname === "/webhp" || u.pathname === "/search") {
      u.searchParams.set("gbv", "1");
    }
  }
  return u;
}

function mergeProxyQuery(target, req) {
  if (req.method !== "GET" && req.method !== "HEAD") return target;
  let u;
  try {
    u = new URL(target);
  } catch {
    return target;
  }
  for (const [key, value] of Object.entries(req.query || {})) {
    if (key === "url") continue;
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) u.searchParams.append(key, String(item));
  }
  return u.href;
}

function rewriteUrl(raw, base) {
  const s = String(raw).trim();
  if (!s || s.startsWith("#") || /^(javascript:|data:|mailto:|tel:|blob:)/i.test(s)) return raw;
  if (s.startsWith("/proxy?url=")) return raw;
  try {
    return "/proxy?url=" + encodeURIComponent(new URL(s, base).href);
  } catch {
    return raw;
  }
}

function rewriteCss(css, base) {
  return css
    .replace(/url\(\s*(['"]?)([^)"']+)\1\s*\)/gi, (m, q, u) => {
      if (!u || u.trim().startsWith("data:")) return m;
      return `url(${q}${rewriteUrl(u.trim(), base)}${q})`;
    })
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, u) => `@import ${q}${rewriteUrl(u, base)}${q}`);
}

function rewriteSrcset(val, base) {
  return val
    .split(",")
    .map((part) => {
      const t = part.trim();
      const sp = t.search(/\s/);
      if (sp === -1) return rewriteUrl(t, base);
      return rewriteUrl(t.slice(0, sp), base) + t.slice(sp);
    })
    .join(", ");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

function errorPage(msg, url) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#101218;color:#e8e6e1;font-family:Segoe UI,system-ui,sans-serif}
.card{max-width:440px;padding:28px;border:1px solid #2c3340;border-radius:18px;background:#181c24}
h1{margin:0 0 10px;font-size:18px;color:#e2b657}
p{margin:0 0 8px;color:#9aa3b2;line-height:1.55;word-break:break-all}
</style></head><body><div class="card"><h1>Couldn’t load page</h1><p>${escapeHtml(msg)}</p><p>${escapeHtml(url || "")}</p></div></body></html>`;
}

function injectScript(pageUrl) {
  return `<script data-prism="1">(function(){
  var PAGE=${JSON.stringify(pageUrl)};
  var ORIGIN=location.origin;
  function abs(u){try{return new URL(u,PAGE).href}catch(e){return u}}
  function prox(u){
    if(!u) return u;
    var s=String(u);
    if(/^(javascript:|data:|mailto:|tel:|blob:|#)/i.test(s)) return s;
    if(s.indexOf("/proxy?url=")!==-1) return s;
    return ORIGIN+"/proxy?url="+encodeURIComponent(abs(s));
  }
  try{if(window.top!==window) window.top.postMessage({type:"prism-url",url:PAGE},"*")}catch(e){}
  if(navigator.serviceWorker){navigator.serviceWorker.register=function(){return Promise.reject(new Error("blocked"))}}
  document.addEventListener("click",function(e){
    var a=e.target.closest&&e.target.closest("a");
    if(!a) return;
    var href=a.getAttribute("href");
    if(!href||/^(javascript:|mailto:|tel:|#)/i.test(href)) return;
    e.preventDefault();
    var next=abs(href);
    try{window.top.postMessage({type:"prism-go",url:next},"*")}catch(err){location.href=prox(href)}
  },true);
  document.addEventListener("submit",function(e){
    var f=e.target;
    if(!f||f.tagName!=="FORM") return;
    var action=f.getAttribute("action")||PAGE;
    var method=(f.getAttribute("method")||"get").toLowerCase();
    if(method==="get"){
      e.preventDefault();
      try{
        var dest=new URL(abs(action));
        var fd=new FormData(f);
        fd.forEach(function(v,k){dest.searchParams.append(k,v)});
        window.top.postMessage({type:"prism-go",url:dest.href},"*");
      }catch(err){f.setAttribute("action",prox(action))}
      return;
    }
    if(String(action).indexOf("/proxy")!==-1) return;
    f.setAttribute("action",prox(action));
  },true);
  var ofetch=window.fetch;
  window.fetch=function(input,init){
    if(typeof input==="string") input=prox(input);
    else if(input&&input.url) input=new Request(prox(input.url),input);
    return ofetch.call(this,input,init);
  };
  var oxhr=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(m,u){
    if(typeof u==="string") arguments[1]=prox(u);
    return oxhr.apply(this,arguments);
  };
})();</script>`;
}

function rewriteHtml(html, pageUrl) {
  html = html.replace(/<base\b[^>]*>/gi, "");
  html = html.replace(/<meta\b[^>]*http-equiv=["']?content-security-policy["']?[^>]*>/gi, "");
  html = html.replace(/\s(?:integrity|nonce)=["'][^"']*["']/gi, "");
  html = html.replace(
    /((?:href|src|action|poster|formaction|data-src|data-href|cite)\s*=\s*)(["'])([^"']*)\2/gi,
    (m, pre, q, u) => pre + q + rewriteUrl(u, pageUrl) + q
  );
  html = html.replace(
    /(\ssrcset\s*=\s*)(["'])([^"']*)\2/gi,
    (m, pre, q, u) => pre + q + rewriteSrcset(u, pageUrl) + q
  );
  html = html.replace(
    /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (m, a, css, b) => a + rewriteCss(css, pageUrl) + b
  );
  html = html.replace(/\sstyle=(["'])([\s\S]*?)\1/gi, (m, q, css) => ` style=${q}${rewriteCss(css, pageUrl)}${q}`);
  const inject = injectScript(pageUrl);
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + inject);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + inject);
  return inject + html;
}

function storeCookies(jar, url, headers) {
  const host = new URL(url).hostname;
  const list = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  if (!list.length) return;
  const current = jar.get(host) || {};
  for (const line of list) {
    const nv = String(line).split(";")[0];
    const eq = nv.indexOf("=");
    if (eq < 1) continue;
    const name = nv.slice(0, eq).trim();
    const val = nv.slice(eq + 1).trim();
    if (!val || /deleted/i.test(val)) delete current[name];
    else current[name] = val;
  }
  jar.set(host, current);
}

function cookieHeader(jar, url) {
  const host = new URL(url).hostname;
  const parts = host.split(".");
  const merged = {};
  for (let i = 0; i < parts.length - 1; i++) {
    Object.assign(merged, jar.get(parts.slice(i).join(".")) || {});
  }
  if (host.includes("google.")) {
    if (!merged.CONSENT) merged.CONSENT = "YES+";
    if (!merged.SOCS) merged.SOCS = "CAISNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjQwNDAxLjA4X3AwGgVlbi1VUyACGgYIgA";
  }
  return Object.entries(merged)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

app.all("/proxy", async (req, res) => {
  const sid = sidFrom(req, res);
  const target = req.query.url;
  if (!target) return res.status(400).send(errorPage("Missing url", ""));

  let parsed;
  try {
    parsed = preferLite(await assertSafe(mergeProxyQuery(String(target), req)));
  } catch (e) {
    return res.status(400).send(errorPage(e.message, String(target)));
  }

  const jar = jars.get(sid) || new Map();
  jars.set(sid, jar);

  const headers = {
    "User-Agent": UA,
    Accept: req.headers.accept || "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": req.headers["accept-language"] || "en-US,en;q=0.9",
  };
  const ck = cookieHeader(jar, parsed.href);
  if (ck) headers.Cookie = ck;

  const init = { method: req.method, headers, redirect: "follow" };
  if (!["GET", "HEAD"].includes(req.method) && req.body && req.body.length) {
    init.body = req.body;
    if (req.headers["content-type"]) headers["Content-Type"] = req.headers["content-type"];
  }

  let response;
  try {
    response = await fetch(parsed.href, init);
  } catch {
    return res.status(502).send(errorPage("The site did not respond.", parsed.href));
  }

  const finalUrl = response.url || parsed.href;
  storeCookies(jar, finalUrl, response.headers);

  const type = (response.headers.get("content-type") || "application/octet-stream")
    .split(";")[0]
    .trim()
    .toLowerCase();

  const skip = new Set([
    "content-security-policy",
    "content-security-policy-report-only",
    "x-frame-options",
    "x-xss-protection",
    "clear-site-data",
    "strict-transport-security",
    "transfer-encoding",
    "content-encoding",
    "content-length",
    "set-cookie",
  ]);
  response.headers.forEach((v, k) => {
    if (!skip.has(k.toLowerCase())) {
      try {
        res.setHeader(k, v);
      } catch {}
    }
  });

  const buf = Buffer.from(await response.arrayBuffer());
  if (type.includes("html")) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(response.status).send(rewriteHtml(buf.toString("utf8"), finalUrl));
  }
  if (type.includes("css")) {
    res.setHeader("Content-Type", "text/css; charset=utf-8");
    return res.status(response.status).send(rewriteCss(buf.toString("utf8"), finalUrl));
  }
  return res.status(response.status).end(buf);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Prism running at http://localhost:${PORT}`);
});
