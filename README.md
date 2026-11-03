# Prism

A small browser-in-a-browser. Prism shows other websites inside its own window — useful on machines
or networks where you cannot install a second browser, or where a site is blocked but a plain HTTP
request still works.

Prism has **two engines**, because no single technique can load the whole web:

| Engine | How it loads a page | Good for |
| --- | --- | --- |
| **Proxy** (default) | Fetches the page server-side and re-serves it under `/https/<host>/<path>`, rewriting markup so every link, asset and form posts back through Prism. | Documents, wikis, news, GitHub, forums, anything server-rendered. Fast, no browser needed. |
| **Live** | Runs a real Chrome/Edge over the DevTools Protocol and streams the rendered page into Prism as images, forwarding your mouse and keyboard. | JavaScript apps: ChatGPT, Reddit, Spotify, Twitch, YouTube, Google search, Poki… |

The engine pill in the toolbar shows what will be used. Click it to cycle **Auto → Live → Proxy**.
In Auto mode Prism uses the proxy for ordinary pages and switches to Live for the sites that need a
real browser, and if a proxied page fails you get a one-click offer to reopen it in Live.

## Running it

```bash
npm install     # express, nothing else
npm start       # http://localhost:3000
```

Windows: double-click **`Open Prism.bat`** — it starts the server and opens the browser for you.

Requirements: Node 22+ (for the built-in `fetch`/`WebSocket` the live engine speaks CDP with).
Live mode also needs a Chromium-based browser installed. Prism reuses the Chrome or Edge you already
have; if it cannot find one, set an explicit path:

```bash
PRISM_CHROME="/usr/bin/chromium" npm start
```

If Live mode is unavailable the app says so and runs proxy-only. `GET /live/status` explains why.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind |
| `PRISM_CHROME` | auto-detected | Chromium/Chrome/Edge executable for Live mode |
| `PRISM_NO_LIVE` | unset | Set to `1` to disable the live engine entirely |
| `PRISM_ALLOW_PRIVATE` | unset | Set to `1` to allow proxying to private/local addresses |
| `PRISM_UA` | a desktop Chrome UA | User agent sent upstream |

## Deploying to Vercel (and why the hosted copy is proxy-only)

`vercel.json` routes every shape of request at a single function:

```
/api/:path*                      -> identity, so functions short-circuit the catch-all
/live/status                     -> /api/live
/https/:path*                    -> /api/proxy?__path=https/:path*
/http/:path*, /p/:path*, /r/:path*  -> same pattern
/(.*)                            -> /api/proxy?__path=$1      (safety net)
```

A serverless rewrite hands the function its *destination* path, so the target
travels in `__path`; `api/proxy.js` reassembles it **and re-appends the original
query string**, which Vercel merges in separately (dropping it would silently
break every search).

Because a deployment's rewrite rules are outside this repository's control, the
UI does not trust them. On boot it probes `/https/!invalid-host!/` and looks for
the `x-prism-proxy` response header every proxy response carries:

- **header present** → path mapping works, use `/https/<host>/<path>` (best:
  relative URLs resolve natively).
- **header missing** → fall back to query mode, where every URL Prism emits is
  `/api/proxy?url=…`. That endpoint is a real function path, so it works with no
  rewrite rules at all — the HTML rewriter, the injected shim, redirects and
  form posts all switch to it together.
- **neither answers** → Prism says so in the toolbar and a banner instead of
  framing a 404 page.

Two things the hosted copy can never do, by design:

- **Live mode** needs a long-running process to hold Chromium and a websocket,
  so `/live/status` reports it unavailable and the app stays on the proxy.
- **Cookies** have no per-site path to live in during query mode, so they are
  scoped to `/api/proxy` and may be shared between sites. Path mode (local, or a
  host where rewrites work) keeps a separate bubble per site.

If the deployment shows the host's own 404 (for example Vercel's dark
"404 NOT_FOUND" page with a region id) rather than Prism's styled error page,
then the request never reached Prism. Check that the project's **Root
Directory** is the repository root and redeploy — `vercel.json` and `api/` are
both at the top level.

## How the proxy engine works

The important change from the old version: **the target URL lives in the path, not in a query
string.**

```
https://news.ycombinator.com/item?id=1   ->   /https/news.ycombinator.com/item?id=1
```

That one decision fixes most of what used to break:

- **Relative and root-relative URLs work natively.** `/static/app.js` on the target resolves to
  `/https/news.ycombinator.com/static/app.js`, which is exactly where the proxy serves it.
- **Redirects stay real.** A 302 from the target is re-emitted as a local 302 with a mapped
  `Location`, so the address bar, history and cookie paths stay consistent.
- **Cookies get their own bubble per site.** `Set-Cookie` is re-scoped to `Path=/https/<host>`, so
  every target site keeps its own cookies without collisions (and `Secure`/`SameSite=None` are
  relaxed only when Prism itself runs over plain http).
- **POSTs work.** Request bodies, content types and `Origin`/`Referer` (mapped back to the real site,
  so CSRF checks pass) are forwarded.
- **WebSockets are tunnelled.** Absolute `ws://`/`wss://` URLs and same-origin socket paths are
  routed through `/ws/<scheme>/<host>/<path>`.
- **Framing policy is re-implemented.** The target's `X-Frame-Options`, `CSP` and
  `Cross-Origin-*` headers are dropped so the page can be displayed at all; `integrity`/`nonce`
  attributes are removed because the bytes no longer match.

A tiny script (`lib/shim.js`) is injected at the top of each page. It maps the runtime APIs that hand
back origin-absolute URLs — `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`,
`history.pushState`, `window.open`, link clicks, form actions and `document.cookie` — into the local
path space, and blocks service-worker registration.

### What the proxy engine cannot do

Anything that assumes it is running on its real origin in ways a shim cannot patch: canvas/WebGL
fingerprinting, DRM video, tunneled binary protocols, sites that hard-block datacenter IPs, and the
big SPAs listed above. That is exactly what the live engine is for.

## How the live engine works

`lib/live.js` launches `chrome --headless=new --remote-debugging-port=0` with a throwaway profile,
discovers the DevTools endpoint from the `DevToolsActivePort` file, and speaks CDP over Node's
built-in `WebSocket` (no puppeteer, no extra dependencies). Each Prism tab gets its own target and
flattened session:

- `Page.startScreencast` → JPEG frames → drawn into the Prism window
- mouse, wheel and keyboard → `Input.dispatchMouseEvent` / `dispatchKeyEvent` / `insertText`
- `Page.frameNavigated` → keeps the omnibox in sync

Frames are the only thing leaving the browser process; the sites' own JavaScript runs where it
expects to, which is why JavaScript-heavy sites finally work.

## API surface

| Route | Purpose |
| --- | --- |
| `/` | Prism UI |
| `/https/<host>/<path>`, `/http/<host>/<path>` | Proxy engine page/asset mapping |
| `/api/proxy?url=…` | Rewrite-free endpoint used by hosted deploys (query mode) |
| `/proxy?url=…`, `/p/<base64url>` | Older query-style entry points, still supported |
| `/ws/<scheme>/<host>/<path>` | WebSocket tunnel for proxied pages |
| `/live/status` | Live engine availability, browser name and reason |
| `/live/ws?url=…` | Live engine screen stream + input channel |
| `/healthz` | Liveness probe |

## Tests

```bash
npm test
```

`test/proxy.test.js` covers URL mapping, markup/CSS rewriting and the SSRF guard.
`test/shim.test.js` runs the injected shim against a fake DOM.
`test/integration.test.js` boots the real server against a throwaway origin and checks rewriting,
cookie scoping, redirects, POSTs, binary streaming, error codes and WebSocket tunnelling.
`test/vercel.test.js` covers the hosted build: the rewrite config, reassembling
`__path` with its merged query string, and both URL modes end to end through the
Vercel adapter.
`test/live.test.js` drives a scripted mock browser over CDP to verify sessions, screencast frames,
navigation reporting and input translation on machines with no Chromium.
`test/ui.test.js` loads the real UI in jsdom and checks engine choice, navigation, the live stream and
the failure fallbacks. It needs jsdom, which is not a runtime dependency:

```bash
npm i --no-save jsdom && npm test
```

## Security notes

- The proxy refuses private/link-local destinations (SSRF guard) unless `PRISM_ALLOW_PRIVATE=1`.
- Proxied pages are rendered in an iframe on Prism's own origin, so a hostile page could in principle
  reach the UI's JavaScript. Run Prism on localhost, and do not expose it to the internet as-is.
- Cookies live in your browser (scoped per target path); Prism itself stores no credentials.
- The live engine runs whatever the page executes, inside a fresh headless profile under your OS
  user. Treat it like running a browser.

## Layout

```
server.js            http server, routes, websocket upgrade handling
lib/proxy.js         proxy engine: path mapping, query mode, rewriting, cookies
lib/shim.js          script injected into proxied pages
lib/live.js          DevTools-Protocol browser engine
lib/ws.js            dependency-free websocket server + tunnel codec
public/              the browser UI (index.html, app.js, styles.css)
api/proxy.js         Vercel adapter: rebuilds __path + merged query, picks a mode
api/live.js          Vercel adapter: live engine is unavailable when hosted
test/                unit, integration, mock-CDP, Vercel and UI (jsdom) tests
```
