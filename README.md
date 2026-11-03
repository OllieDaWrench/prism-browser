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

## Download and run it

| Platform | How to get it |
| --- | --- |
| macOS (Apple Silicon + Intel) | `curl -fsSL https://prism-browser.vercel.app/install.sh \| bash` — or [Prism-macOS.zip](https://github.com/OllieDaWrench/prism-browser/releases/latest/download/Prism-macOS.zip) |
| Windows (x64) | [Prism-Windows.zip](https://github.com/OllieDaWrench/prism-browser/releases/latest/download/Prism-Windows.zip) |

Clicking any **Download** button in the app opens one panel that shows both routes: the macOS
Terminal command (the warning-free one) and the two zip files. The zip links are same-origin —
`/download/mac` and `/download/windows` — and Prism streams the file itself with `Content-Disposition: attachment`. Clicking downloads the file; nothing
navigates to GitHub, no new tab, no "release page". (The GitHub links above are the fallback, and
they are what the hosted copy proxies from.)

**No installer, no admin rights, nothing installed system-wide.**

1. Unzip into a folder you can write to — Desktop or Documents is ideal. `Program Files` and
   `/Applications` are often read-only for normal users, and Prism does not need to live there.
2. Start it:
   - **Windows:** double-click `Open Prism.bat` (if SmartScreen appears: *More info › Run anyway*).
   - **macOS:** double-click `Open Prism.command`. If macOS says it *cannot verify* the file, use the
     Terminal install below instead — that is the route with no warning at all.
3. Prism opens at `http://localhost:3000`.

The first launch unpacks a portable Node runtime into `runtime/` **inside that folder** — a plain
download, no installer, no password. Dependencies are already vendored in `node_modules`, so there
is no `npm install`. Later launches skip straight to starting the app. Delete the folder (including
`runtime/`) to remove Prism.

### macOS: installing without the "cannot verify" warning

macOS quarantines anything a browser downloads, and Gatekeeper refuses to run it unless the developer
holds a paid Apple Developer ID certificate and has notarised the app. A `.command` file is a shell
script, so it **cannot be code-signed at all** — no packaging change makes the double-clicked zip open
without that warning. (Right-click › *Open* and System Settings › *Open Anyway* are the manual
overrides; they work, but they are still a warning.)

Files written by `curl` are never quarantined. So the warning-free route is one line in Terminal:

```bash
curl -fsSL https://prism-browser.vercel.app/install.sh | bash
```

That downloads the same bundle, installs it to `~/Prism`, keeps your `runtime/` across upgrades, and
puts a launcher on your Desktop that opens on a plain double-click from then on. No password, no
Apple account, nothing outside your home folder. `lib/installer.js` generates the script, and
`/install.sh` serves it from both the local app and the hosted copy.

### Why the zip does not carry the runtime

The zips are under 1 MB on purpose. `prism-browser.vercel.app` serves them itself, and Vercel
Functions cannot send a response body larger than 4.5 MB — a bundle with an embedded runtime is
~45 MB and would fail on exactly the download button this is meant to fix. `lib/downloads.js`
refuses to hand over anything over 4.4 MB rather than send a truncated file, and the release
workflow asserts the size before publishing.

### Building the bundles

```bash
./scripts/package.sh --platform macos --deps dist/mac       # Prism-macOS.zip
./scripts/package.sh --platform windows --deps dist/win     # Prism-Windows.zip
# already have a portable runtime to bake in (offline bundle)?
./scripts/package.sh --platform macos --runtime path/to/runtimes --deps
```

`.github/workflows/release.yml` runs on every `v*` tag: it builds both zips, checks they are under
the response cap, boots the packaged app with *only* a portable runtime (no npm, no system Node),
checks `/download/mac` returns an attachment whose bytes start with `PK`, and verifies the launcher
unpacks its runtime with an ordinary download.

From a checkout (needs Node 22+, no admin needed):

```bash
npm install     # express, nothing else
npm start       # http://localhost:3000
```

### Why downloads at all?

Prism has to run on the machine whose browser it drives. The hosted copy can proxy pages, but it cannot
start Chromium, which is why Live mode — and anything behind Cloudflare — only works in the local app.
Every place in the UI that says "run Prism locally" links to these downloads, which Prism streams
itself so the button works even on networks that block GitHub.

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
| `PRISM_HEADLESS` | unset | Set to `1` to run Live mode headless (servers/CI). Default is a real window |
| `PRISM_PROFILE_DIR` | `.chrome-profile/` | Where the live browser keeps cookies and clearance |
| `PORT` | `3000` | Port used by the launchers and the server |
| `PRISM_ALLOW_PRIVATE` | unset | Set to `1` to allow proxying to private/local addresses |
| `PRISM_UA` | the browser's own UA | Overrides the user agent (leave alone — see below) |
| `PRISM_AUTH_SECRET` | unset | 16+ random characters. Turns sign-in on; without it the site stays public |
| `PRISM_AUTH` | unset | `1` requires sign-in locally too, `0` switches the gate off |
| `PRISM_USERS` | unset | A starting list, `[{"number":"482913","password":"...","role":"admin"}]` |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | unset | Upstash REST — where accounts live once connected |
| `PRISM_USERS_FILE` | `data/users.json` | Where accounts go when there is no Upstash |

### Accounts (who is allowed in)

Prism can be a private site: a **six-digit number and a password** in front of the app and the
download. The number is only a sign-in name — nothing is ever sent to it, so there is no SMS
and no phone bill.

**Where the list lives, in order of preference:**

1. **Upstash** (`KV_REST_API_URL` + `KV_REST_API_TOKEN`). This is the real option on Vercel:
   accounts survive deploys and every request sees the same list. In Vercel, Storage →
   Marketplace → Upstash Redis adds both variables for you.
2. **`PRISM_USERS`**, a JSON variable. Read-only, useful as the very first account or as a seed
   for an empty database.
3. **`data/users.json`**. Fine on your own computer; a hosted function's disk is thrown away,
   so `/admin` refuses to save there and says why.

**Making the first account.** The console needs somebody to sign in as, so the first one comes
from a terminal (or from `PRISM_USERS`):

```bash
node scripts/add-user.js 482913 "a long password" --name You --admin
```

After that **`/admin`** adds people (number, name, password, whether they can manage access),
switches them off, changes passwords and removes them. Only a manager can change access, and the
last manager cannot be removed or switched off, so the console cannot be locked out.

**How the secrets travel.** Passwords are stored only as `scrypt` hashes with a per-account salt.
Sign-in cookies are signed (`PRISM_AUTH_SECRET`), last 30 days, and are `HttpOnly`,
`SameSite=Lax`, `Secure` on https. Install tokens last 15 minutes and unlock the download only —
a token is never a session, and a session is never a token.

**The installer** asks for the number and password on the terminal, exchanges them for that
short-lived token, and only then downloads. The password never reaches a URL, a log or the shell
history. A copy with no `PRISM_AUTH_SECRET` is not gated, and the installer skips the prompt.

**The installed app does not ask you to sign in.** It runs on your own computer.

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

## Cloudflare and other bot walls

This is the single biggest reason a "website won't load" in Prism, so it is handled explicitly.

A proxy fetches pages **from a server**, and Cloudflare (plus DataDome, Imperva, PerimeterX, Akamai and
friends) deliberately refuses requests that arrive that way. The typical response is a `403` with a
"Just a moment…" / "Verify you are human" interstitial. Nothing about Prism is broken in that case —
the site is doing exactly what it was configured to do — and a proxy can never pass it, because the
challenge needs the site's own JavaScript running on its own origin with a human present.

What Prism does instead (`lib/botwall.js`):

1. **Recognises the wall** by status code, vendor-specific headers (`cf-mitigated`, `x-datadome`,
   `x-iinfo`, …) and page signatures. Ordinary pages that merely *mention* Cloudflare are not flagged.
2. **Never renders the dead interstitial.** It serves its own explanation instead, carrying the
   `X-Prism-Blocked` header and a message to the UI.
3. **Escalates to Live mode automatically** when a browser is available — the page is reopened in
   your own Chrome, on your own network. You can then complete the challenge yourself; Prism tells
   you to click the checkbox if one appears.
4. **Explains the local escape hatch** when Live mode is not available (for example on the hosted
   copy, where serverless cannot run a browser).

The live engine gets out of the way as much as it can:

- `--disable-blink-features=AutomationControlled`, a `navigator.webdriver` shim injected before any
  page script runs, and a desktop Chrome user agent — so it does not advertise being automated.
- It watches each page it lands on; if a challenge is on screen it tells the UI, which prompts you
  to click the checkbox rather than leaving a blank frame.
- `PRISM_HEADLESS=1 npm start` runs Live mode headless instead of in a real window. Some interactive
  challenge flows are happier in a visible browser.

The proxy engine sends a self-consistent Chrome fingerprint (client hints matching its user agent,
fetch metadata describing its own request) which gets past simple WAF rules, but that is a
best-effort improvement — a genuine challenge is a hard wall for any proxy.

**Bottom line:** if a site is Cloudflare-protected, use Live mode, and run Prism locally so the
request comes from your own IP with your own browser. On a datacenter-hosted copy (Vercel) those
sites will keep challenging, because the traffic is not yours.

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

`lib/live.js` launches `chrome --remote-debugging-port=0` with a profile kept in `.chrome-profile/`
discovers the DevTools endpoint from the `DevToolsActivePort` file, and speaks CDP over Node's
built-in `WebSocket` (no puppeteer, no extra dependencies). Each Prism tab gets its own target and
flattened session:

- `Page.startScreencast` → JPEG frames → drawn into the Prism window
- mouse, wheel and keyboard → `Input.dispatchMouseEvent` / `dispatchKeyEvent` / `insertText`
- `Page.frameNavigated` → keeps the omnibox in sync

Frames are the only thing leaving the browser process; the sites' own JavaScript runs where it
expects to, which is why JavaScript-heavy sites finally work.

### Why it is a real window, and why that matters

Live mode runs a **real browser window**, parked off-screen — not a headless one. Bot protection
fingerprints headless Chrome, and it also compares the user agent against everything else the
browser reports. Prism used to force a hardcoded Windows Chrome 131 user agent, so a Mac running a
current Chrome announced itself as an out-of-date Windows machine: an instant challenge, even in a
real window. Now the browser keeps its own user agent, and only the `HeadlessChrome` token is
rewritten when you deliberately run headless (`PRISM_HEADLESS=1`).

The browser profile lives in `.chrome-profile/` instead of a throwaway temp directory, so cookies —
including the clearance cookie a site hands out after a bot check — survive restarts. Passing a bot
check is then a one-time event per site rather than every launch.

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
`test/desktop.test.js` guards the download links: the URLs in the UI, the bot-wall page and
`lib/desktop.js` must agree, the launchers must exist and be executable, and the packaging script must
produce the asset names the links point at.
`test/botwall.test.js` covers bot-wall detection (Cloudflare challenges, blocks, Turnstile, other
vendors, and false positives on ordinary pages) plus the in-page probe the live engine uses.
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
- The live engine runs whatever the page executes, inside a persistent profile under your OS
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
