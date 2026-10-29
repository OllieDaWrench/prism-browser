"use strict";

/**
 * Runtime shim injected at the top of every proxied HTML document.
 *
 * Prism maps a target URL onto a *path* on its own origin:
 *
 *     https://example.com/a/b?x=1   ->   /https/example.com/a/b?x=1
 *
 * That mapping already makes relative URLs, root-relative URLs, redirects and
 * cookies work without touching the markup. What it cannot do on its own is
 * tell page scripts which URL they "really" live at, so this shim maps the
 * handful of runtime APIs that hand back origin-absolute URLs (fetch, XHR,
 * WebSocket, history, forms, link clicks).
 *
 * `boot` is serialised with Function#toString and executed in the page, so it
 * must not reference anything outside its own body.
 */
function boot(cfg) {
  if (window.__prismShim) return;
  window.__prismShim = true;

  var PAGE = cfg.page;
  var PREFIX = cfg.prefix; // e.g. "/https/example.com"
  var INTERNAL = /^\/(live|proxy|p|r|ws)(\/|$)/;

  var pageUrl;
  try {
    pageUrl = new URL(PAGE);
  } catch (e) {
    pageUrl = null;
  }
  if (!pageUrl) return;

  function abs(value) {
    try {
      return new URL(value, PAGE).href;
    } catch (e) {
      return null;
    }
  }

  /** Map a target URL onto the local proxy path, or return it untouched. */
  function map(url) {
    if (url == null) return url;
    var s = String(url);
    if (!s || /^(data:|blob:|javascript:|mailto:|tel:|about:|#)/i.test(s)) return url;
    var u = abs(s);
    if (!u) return url;
    var target;
    try {
      target = new URL(u);
    } catch (e) {
      return url;
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") return url;

    // already proxied
    if (target.origin === location.origin && /^\/(https|http)\//.test(target.pathname)) return url;

    var sameOrigin = target.origin === pageUrl.origin;
    // Pages believe they live on our origin, so absolute URLs they build from
    // location.origin/relative paths must be folded into our prefix again.
    var looksLocal =
      target.origin === location.origin && !INTERNAL.test(target.pathname);

    if (sameOrigin) return PREFIX + target.pathname + target.search + target.hash;
    if (looksLocal) return PREFIX + target.pathname + target.search + target.hash;
    return url;
  }

  function notify() {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(
          { type: "prism-url", url: PAGE, current: location.href },
          "*"
        );
      }
    } catch (e) {}
  }

  function isAnchorHref(href) {
    return href != null && !/^(javascript:|data:|mailto:|tel:|blob:)/i.test(String(href));
  }

  /* ---------- fetch / XHR / EventSource ---------- */
  var nativeFetch = window.fetch;
  if (typeof nativeFetch === "function") {
    window.fetch = function (input, init) {
      if (typeof input === "string") {
        input = map(input);
      } else if (input && input.url) {
        var mapped = map(input.url);
        if (mapped !== input.url) {
          try {
            input = new Request(mapped, input);
          } catch (e) {}
        }
      }
      return nativeFetch.call(this, input, init);
    };
  }

  var nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var args = Array.prototype.slice.call(arguments);
    if (typeof url === "string") args[1] = map(url);
    return nativeOpen.apply(this, args);
  };

  if (window.EventSource) {
    var NativeEventSource = window.EventSource;
    window.EventSource = function (url, opts) {
      return new NativeEventSource(map(url), opts);
    };
    window.EventSource.prototype = NativeEventSource.prototype;
  }

  if (navigator.sendBeacon) {
    var nativeBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      return nativeBeacon(map(url), data);
    };
  }

  /* ---------- WebSocket (tunnelled websockets) ---------- */
  if (window.WebSocket) {
    var NativeWS = window.WebSocket;
    var scheme = location.protocol === "https:" ? "wss:" : "ws:";
    function MappedWebSocket(url, protocols) {
      var target = abs(url);
      if (target) {
        var u = new URL(target);
        var host = u.host;
        var kind = u.protocol === "wss:" ? "https" : u.protocol === "ws:" ? "http" : u.protocol.replace(":", "");
        var tunnel = scheme + "//" + location.host + "/ws/" + kind + "/" + host + u.pathname + u.search;
        return protocols === undefined
          ? new NativeWS(tunnel)
          : new NativeWS(tunnel, protocols);
      }
      return protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
    }
    MappedWebSocket.prototype = NativeWS.prototype;
    ["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach(function (k) {
      MappedWebSocket[k] = NativeWS[k];
    });
    window.WebSocket = MappedWebSocket;
  }

  /* ---------- cookies: keep each target host in its own path bubble ------ */
  try {
    var cookieDesc = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
    if (cookieDesc && cookieDesc.set) {
      Object.defineProperty(Document.prototype, "cookie", {
        configurable: true,
        get: function () {
          return cookieDesc.get.call(this);
        },
        set: function (value) {
          var v = String(value);
          if (/;\s*path=/i.test(v)) v = v.replace(/;\s*path=[^;]*/i, "; path=" + PREFIX);
          else v = v + "; path=" + PREFIX;
          // SameSite=None requires Secure; local http proxies cannot set that.
          v = v.replace(/;\s*Secure/gi, "").replace(/;\s*SameSite=None/gi, "");
          return cookieDesc.set.call(this, v);
        },
      });
    }
  } catch (e) {}

  /* ---------- navigation APIs ---------- */
  ["pushState", "replaceState"].forEach(function (name) {
    var original = history[name];
    if (typeof original !== "function") return;
    history[name] = function (state, title, url) {
      var args = Array.prototype.slice.call(arguments);
      if (url !== undefined && url !== null) args[2] = map(url);
      var result = original.apply(this, args);
      notify();
      return result;
    };
  });

  document.addEventListener(
    "click",
    function (event) {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      var el = event.target;
      while (el && el !== document && !(el.closest && el.closest("a"))) el = el.parentNode;
      var a = el && el.closest ? el.closest("a") : null;
      if (!a) return;
      var href = a.getAttribute("href");
      if (!isAnchorHref(href)) return;
      var resolved = abs(href);
      if (!resolved) return;
      var target = new URL(resolved);
      var mapped = map(href);
      var sameOrigin = target.origin === pageUrl.origin;

      if (!sameOrigin && !mapped.startsWith("/https/") && !mapped.startsWith("/http/")) {
        // A link to another site: ask Prism to open it through the proxy rather
        // than letting the frame jump onto the real origin (where it would
        // escape the proxy and leave the address bar stale).
        if (window.top !== window) {
          try {
            window.top.postMessage({ type: "prism-go", url: resolved }, "*");
            event.preventDefault();
            return;
          } catch (e) {}
        }
        return;
      }

      event.preventDefault();
      if (a.target && a.target !== "_self") {
        window.open(mapped, a.target);
        return;
      }
      location.assign(mapped);
    },
    true
  );

  document.addEventListener(
    "submit",
    function (event) {
      var form = event.target;
      if (!form || form.tagName !== "FORM") return;
      var action = form.getAttribute("action");
      if (action === null || action === "") {
        form.setAttribute("action", location.href);
        return;
      }
      var mapped = map(action);
      if (mapped !== action) form.setAttribute("action", mapped);
      else if (/^\//.test(action)) form.setAttribute("action", PREFIX + action);
    },
    true
  );

  /* Some sites call window.open on their own origin (auth popups). */
  var nativeWindowOpen = window.open;
  if (typeof nativeWindowOpen === "function") {
    window.open = function (url, name, features) {
      return nativeWindowOpen.call(window, url == null ? url : map(url), name, features);
    };
  }

  /* Service workers would register against our origin with the wrong scope. */
  if (navigator.serviceWorker && navigator.serviceWorker.register) {
    navigator.serviceWorker.register = function () {
      return Promise.reject(new Error("service workers are disabled inside Prism"));
    };
  }

  /* Keep the browser chrome in sync. */
  if (window.top !== window) {
    notify();
    window.addEventListener("load", notify);
    window.addEventListener("popstate", notify);
    document.addEventListener("DOMContentLoaded", notify);
  }

  /* Frame busters: a proxied page must not reload itself out of the frame. */
  try {
    if (window.top !== window && window.top.location.href) {
      /* touching top.location may throw; ignore */
    }
  } catch (e) {}
}

function scriptTag(pageUrl, prefix) {
  const cfg = JSON.stringify({ page: pageUrl, prefix });
  return (
    '<script data-prism="shim">(' +
    boot.toString() +
    ")(" +
    cfg +
    ");</script>"
  );
}

module.exports = { scriptTag, boot };
