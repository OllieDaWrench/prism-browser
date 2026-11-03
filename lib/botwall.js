"use strict";

/**
 * Bot walls.
 *
 * A proxy fetches pages from a server, and sites behind Cloudflare (and
 * friends) answer those requests with a challenge instead of the page. Those
 * challenges cannot be solved by Prism: they require running the site's own
 * JavaScript on the real origin with a human completing a check, and the
 * request itself has to come from the user's own network. So instead of
 * rendering a dead "Just a moment…" page inside the frame, Prism recognises
 * the wall and routes the user to the engine that can actually get through:
 * the live browser, running on their machine.
 *
 * The same signatures are used by the live engine, which evaluates `PAGE_PROBE`
 * inside the page to tell the user "Cloudflare is checking this browser — click
 * the checkbox".
 */

const { downloadButtonsHtml } = require("./desktop");

/**
 * Signatures per vendor.
 *
 * `patterns` are deliberately *text safe*: they match the raw HTML as well as
 * the visible text of the page, so one list serves both the proxy (raw bytes)
 * and the in-page probe (innerText + title).
 *
 * `status`  — the wall is normally served with one of these.
 * `headers` — [name, value] pairs a bot wall sends and ordinary pages do not.
 * `strong`  — how many pattern hits make it conclusive on its own.
 */
const VENDORS = [
  {
    name: "Cloudflare",
    status: [403, 429, 503],
    headerAlone: true,
    headers: [
      [/^cf-mitigated$/i, /challenge|managed/i],
      [/^cf-chl-/i, /.*/],
    ],
    strong: 2,
    patterns: [
      /just a moment/i,
      /checking your browser before accessing/i,
      /cf-browser-verification/i,
      /cf_chl_opt|cf_chl_jschl_tk|cf_chl_prog|__cf_chl_f_tk/i,
      /cf-challenge-|challenge-platform\/h\//i,
      /attention required/i,
      /enable javascript and cookies to continue/i,
      /window\._cf_chl_opt/i,
      /managed challenge|verify you are human/i,
      /cf-turnstile/i,
      /cf-error-details|cloudflare ray id/i,
      /error(?: code)?:?\s*10(?:15|20)\b/i,
      /you have been blocked/i,
      /the owner of this website has banned your access/i,
    ],
  },
  {
    name: "Imperva",
    headerAlone: true,
    status: [403],
    headers: [[/^x-iinfo$/i, /.*/]],
    strong: 2,
    patterns: [/_incapsula_resource|incapsula incident id|pardon our interruption/i],
  },
  {
    name: "PerimeterX",
    headerAlone: true,
    status: [403, 429],
    headers: [[/^x-px/i, /.*/]],
    strong: 2,
    patterns: [/px-captcha|press (?:and|&) hold|perimeterx/i],
  },
  {
    name: "DataDome",
    headerAlone: true,
    status: [403, 429],
    headers: [[/^x-datadome/i, /.*/]],
    strong: 2,
    patterns: [/datadome|captcha-delivery\.com/i],
  },
  {
    name: "Akamai",
    status: [403],
    headers: [[/^server$/i, /akamai/i]],
    strong: 2,
    patterns: [/reference #\d+\.[0-9a-f]+\.\d+\.[0-9a-f]+/i, /access denied.*akamai/i],
  },
  {
    name: "DDoS-Guard",
    status: [403, 429, 503],
    headers: [[/^server$/i, /ddos-guard/i]],
    strong: 2,
    patterns: [/ddos-guard|__ddg\d?=/i],
  },
  {
    name: "Sucuri",
    status: [403],
    headers: [[/^server$/i, /sucuri/i]],
    strong: 2,
    patterns: [/sucuri website firewall|sucuri-cloudproxy/i],
  },
];

function headerMatch(vendor, headers) {
  const entries = Object.entries(headers || {});
  return vendor.headers.some(([nameRe, valueRe]) =>
    entries.some(([name, value]) => nameRe.test(name) && (valueRe.source === ".*" || valueRe.test(String(value ?? ""))))
  );
}

/**
 * Decide whether a response is a bot wall rather than the page the user asked
 * for. Returns the vendor name or null.
 */
function detect({ status = 0, headers = {}, text = "" } = {}) {
  const body = String(text).slice(0, 12000);
  const failing = status === 0 || status >= 400;

  for (const vendor of VENDORS) {
    if (status !== 0 && !vendor.status.includes(status)) continue;

    const hits = vendor.patterns.reduce((count, re) => count + (re.test(body) ? 1 : 0), 0);
    const hasHeader = headerMatch(vendor, headers);

    // Some headers only exist on a challenge (cf-mitigated, x-datadome…), so
    // the header alone is conclusive. A generic `server: akamai` is not.
    if (vendor.headerAlone && hasHeader) return vendor.name;
    if (hits === 0) continue;
    // Several signatures, or one signature plus either the vendor's own
    // challenge header or a failing status: conclusive.
    if (hits >= vendor.strong) return vendor.name;
    if (hasHeader) return vendor.name;
    if (failing && hits >= 1 && vendor.patterns.length <= 2) return vendor.name;
  }
  return null;
}

/**
 * JavaScript evaluated inside the live browser: returns the vendor name of a
 * challenge currently on screen, or "" when the page looks normal.
 */
const PAGE_PROBE = `(function(){
  try {
    var title = document.title || "";
    var body = (document.body && document.body.innerText ? document.body.innerText : "").slice(0, 4000);
    var text = title + "\\n" + body + "\\n" + (location.href || "");
    var pats = ${JSON.stringify(VENDORS.map((v) => [v.name, v.patterns.map((p) => p.source)]))};
    for (var i = 0; i < pats.length; i++) {
      for (var j = 0; j < pats[i][1].length; j++) {
        try {
          if (new RegExp(pats[i][1][j], "i").test(text)) return pats[i][0];
        } catch (e) {}
      }
    }
    return "";
  } catch (e) { return ""; }
})()`;

/** HTML Prism serves instead of a bot wall. */
function blockPage(vendor, url, { liveAvailable = true, liveReason = "", bundled = false } = {}) {
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  })();
  const escape = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // Say what is actually true on this machine. Telling someone "Prism is
  // switching to Live mode" when no browser was found leaves them staring at a
  // wall with no explanation.
  let detail;
  if (liveAvailable) {
    detail = `Prism is switching this page to <strong>Live mode</strong>, which drives a real browser on your machine — that is what ${escape(
      vendor
    )} is asking for. If you see a checkbox, click it.`;
  } else if (bundled) {
    detail = `The proxy engine fetches pages from a server, and ${escape(
      vendor
    )} refuses those requests. Prism could not start a browser on this machine${
      liveReason ? ` (<em>${escape(liveReason)}</em>)` : ""
    }, so Live mode is not available right now.`;
  } else {
    detail = `The proxy engine fetches pages from a server, and ${escape(
      vendor
    )} refuses those requests. <strong>Live mode</strong> gets through, because it uses a real browser on your own computer. Get the local app and this page will load:`;
  }

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(
    vendor
  )} is blocking the proxy</title><style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#101218;color:#e8e6e1;font-family:"Segoe UI",system-ui,sans-serif;padding:24px}
.card{max-width:560px;padding:28px 30px;border:1px solid #2c3340;border-radius:18px;background:#181c24;box-shadow:0 24px 60px rgba(0,0,0,.45)}
.badge{display:inline-block;margin-bottom:14px;padding:4px 10px;border-radius:999px;background:rgba(226,182,87,.14);color:#e2b657;font-size:11px;letter-spacing:.14em;text-transform:uppercase}
h1{margin:0 0 12px;font-size:20px;color:#e2b657}
p{margin:0 0 12px;color:#9aa3b2;line-height:1.65}
code{background:#0d1016;border:1px solid #232a36;border-radius:6px;padding:1px 6px;font-size:13px}
.url{margin-top:14px;padding:10px 12px;border-radius:10px;background:#0d1016;border:1px solid #232a36;font:12px/1.5 ui-monospace,Menlo,monospace;color:#8d96a6;word-break:break-all}
.status{margin-top:16px;font-size:13px;color:#7d8798}
.reason{margin:0 0 12px;padding:9px 12px;border-radius:10px;background:#221a12;border:1px solid #4a3a1e;color:#d8b877;font-size:13px}
.downloads{display:flex;flex-wrap:wrap;gap:10px;margin:18px 0 10px}
.download{display:inline-flex;align-items:center;padding:11px 16px;border-radius:12px;background:#e2b657;color:#1a1408;font-weight:700;font-size:14px;text-decoration:none}
.download:hover{background:#f0c96a}
.requires{margin:0;font-size:12.5px;color:#7d8798;line-height:1.6}
.requires a{color:#e2b657}
.requires code{background:#0d1016;border:1px solid #232a36;border-radius:5px;padding:1px 5px;font-size:12px;color:#cfd6e4}
</style></head><body><div class="card"><span class="badge">${escape(
    vendor
  )} bot protection</span><h1>${escape(vendor)} is blocking the proxy for ${escape(host)}</h1><p>${detail}</p>${
    // Only worth offering to someone who is not already running the app.
    !liveAvailable && !bundled ? downloadButtonsHtml() : ""
  }${
    !liveAvailable && liveReason
      ? `<p class="reason">Live mode: ${escape(liveReason)}</p>`
      : ""
  }<div class="url">${escape(
    url
  )}</div><p class="status">Nothing is broken — this is bot protection doing its job on the proxy's server-side request.</p></div><script>try{if(window.top!==window)window.top.postMessage({type:"prism-blocked",vendor:${JSON.stringify(
    vendor
  )},url:${JSON.stringify(url)}},"*")}catch(e){}</script></body></html>`;
}

module.exports = { detect, blockPage, PAGE_PROBE, VENDORS };
