"use strict";

/**
 * Same-origin downloads.
 *
 * The desktop bundles live on a GitHub release, but a download link must not
 * send anyone *to* GitHub: that page can be blocked, it bounces through
 * redirects, and it makes the button feel like a hyperlink instead of a file.
 *
 * Instead Prism serves the file itself:
 *
 *     GET /download/mac       ->  Prism-macOS.zip   (Content-Disposition: attachment)
 *     GET /download/windows   ->  Prism-Windows.zip
 *
 * The server fetches the release asset and streams it through, so the browser
 * only ever talks to Prism. If that fetch fails, the error page links to the
 * GitHub asset directly so the download is never a dead end.
 *
 * A local `dist/` directory wins when present: that is where
 * `scripts/package.sh` puts freshly built bundles, which makes the endpoint
 * testable and lets a local Prism hand out its own build without any network.
 */

const fs = require("fs");
const path = require("path");

const REPO = "OllieDaWrench/prism-browser";

const ASSETS = {
  mac: {
    platform: "mac",
    file: "Prism-macOS.zip",
    filename: "Prism-macOS.zip",
    label: "Download for Mac",
    note: "Unzip it, then double-click Open Prism.command",
  },
  windows: {
    platform: "windows",
    file: "Prism-Windows.zip",
    filename: "Prism-Windows.zip",
    label: "Download for Windows",
    note: "Unzip it, then double-click Open Prism.bat",
  },
};

// `PRISM_DIST` lets a test (or anyone) point the endpoint somewhere else; the
// normal location is the directory scripts/package.sh writes to.
const LOCAL_DIR = process.env.PRISM_DIST
  ? path.resolve(process.env.PRISM_DIST)
  : path.join(__dirname, "..", "dist");

/**
 * Vercel caps a Function's response body at 4.5 MB, and this endpoint is a
 * Function when Prism is hosted. The bundles are built to stay far below that
 * (the launchers fetch their own Node runtime on first launch), and the release
 * workflow asserts it. If an oversized asset ever slips through, say so instead
 * of handing the browser a truncated zip.
 */
const MAX_RESPONSE_BYTES = 4.4 * 1024 * 1024;

function assetFor(platform) {
  const key = String(platform || "").toLowerCase();
  if (["mac", "macos", "darwin", "osx", "apple"].includes(key)) return ASSETS.mac;
  if (["windows", "win", "win32", "win64", "pc"].includes(key)) return ASSETS.windows;
  return null;
}

function releaseUrl(asset) {
  return `https://github.com/${REPO}/releases/latest/download/${asset.file}`;
}

/** A bundle built locally by scripts/package.sh takes precedence. */
function localFile(asset) {
  const file = path.join(LOCAL_DIR, asset.file);
  try {
    const stat = fs.statSync(file);
    if (stat.isFile() && stat.size > 0) return { file, size: stat.size };
  } catch {}
  return null;
}

function downloadPage(title, body, status) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#101218;color:#e8e6e1;font-family:"Segoe UI",system-ui,sans-serif;padding:24px}
.card{max-width:520px;padding:28px 30px;border:1px solid #2c3340;border-radius:18px;background:#181c24}
h1{margin:0 0 12px;font-size:19px;color:#e2b657}
p{margin:0 0 10px;color:#9aa3b2;line-height:1.65}
a{color:#e2b657}
</style></head><body><div class="card"><h1>${title}</h1>${body}</div></body></html>`;
}

async function streamFromDisk(res, asset, file, size) {
  res.status(200);
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Length", String(size));
  res.setHeader("Content-Disposition", `attachment; filename="${asset.filename}"`);
  res.setHeader("Cache-Control", "no-store");
  await new Promise((resolve) => {
    const stream = fs.createReadStream(file);
    stream.on("error", () => {
      try {
        res.end();
      } catch {}
      resolve();
    });
    res.on("close", () => stream.destroy());
    stream.pipe(res);
    stream.on("end", resolve);
  });
}

/**
 * Stream the platform bundle to the browser. `fetchImpl` is injectable so the
 * tests can run without a network.
 */
async function handleDownload(req, res, platform, options = {}) {
  const asset = assetFor(platform);
  if (!asset) {
    res.status(404);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      downloadPage(
        "Unknown download",
        `<p>Prism ships bundles for <a href="/download/mac">macOS</a> and <a href="/download/windows">Windows</a>.</p>`
      )
    );
    return;
  }

  const local = localFile(asset);
  if (local) {
    if (req.method === "HEAD") {
      res.status(200);
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Length", String(local.size));
      res.setHeader("Content-Disposition", `attachment; filename="${asset.filename}"`);
      res.end();
      return;
    }
    return streamFromDisk(res, asset, local.file, local.size);
  }

  const fetchImpl = options.fetch || globalThis.fetch;
  const url = releaseUrl(asset);
  let upstream;
  try {
    upstream = await fetchImpl(url, {
      redirect: "follow",
      headers: { accept: "application/octet-stream", "user-agent": "Prism-downloads" },
    });
  } catch (err) {
    upstream = null;
  }

  if (!upstream || !upstream.ok || !upstream.body) {
    res.status(502);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(
      downloadPage(
        "Couldn't fetch the download",
        `<p>Prism could not reach its release download just now. Use the direct link:</p>
         <p><a href="${url}" rel="noreferrer noopener">${asset.file}</a></p>
         <p>${asset.note}, after unzipping.</p>`
      )
    );
    return;
  }

  const type = upstream.headers.get("content-type") || "application/zip";
  // GitHub serves release assets as octet-stream; keep that, but never let an
  // HTML error page be saved as a .zip.
  if (/text\/html/i.test(type)) {
    try {
      await upstream.body.cancel();
    } catch {}
    res.status(502);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      downloadPage(
        "Couldn't fetch the download",
        `<p>Prism could not reach its release download just now. Use the direct link:</p>
         <p><a href="${url}" rel="noreferrer noopener">${asset.file}</a></p>`
      )
    );
    return;
  }

  const length = upstream.headers.get("content-length");
  if (length && Number(length) > MAX_RESPONSE_BYTES) {
    // Never buffer something the host could not send anyway.
    try {
      await upstream.body.cancel();
    } catch {}
    res.status(502);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(
      downloadPage(
        "This download is too large to serve",
        `<p>That release asset is bigger than the ${Math.round(MAX_RESPONSE_BYTES / 1024 / 1024)} MB this page can hand over in one response, so Prism stopped rather than give you a broken file.</p>
         <p>Use the direct link instead: <a href="${url}" rel="noreferrer noopener">${asset.file}</a></p>`
      )
    );
    return;
  }

  let body;
  if (req.method === "HEAD") {
    try {
      await upstream.body.cancel();
    } catch {}
    res.status(200);
    res.setHeader("Content-Type", "application/zip");
    if (length) res.setHeader("Content-Length", length);
    res.setHeader("Content-Disposition", `attachment; filename="${asset.filename}"`);
    res.end();
    return;
  }

  // Buffered, not streamed. The bundles are small by design (the launchers fetch
  // their own Node runtime), and a serverless host is much happier with one
  // complete response than with a pipe it can cut in half: a stream that dies
  // midway looks like a corrupt zip to the user and a 500 to the platform.
  try {
    body = Buffer.from(await upstream.arrayBuffer());
  } catch {
    body = null;
  }

  if (!body || body.length === 0 || body.length > MAX_RESPONSE_BYTES) {
    res.status(502);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(
      downloadPage(
        "Couldn't fetch the download",
        `<p>Prism reached the release but could not read the file properly just now. Use the direct link:</p>
         <p><a href="${url}" rel="noreferrer noopener">${asset.file}</a></p>
         <p>${asset.note}, after unzipping.</p>`
      )
    );
    return;
  }

  res.status(200);
  res.setHeader("Content-Type", /zip|octet-stream/i.test(type) ? type : "application/zip");
  res.setHeader("Content-Length", String(body.length));
  res.setHeader("Content-Disposition", `attachment; filename="${asset.filename}"`);
  res.setHeader("Cache-Control", "public, max-age=300");
  res.end(body);
}

module.exports = {
  handleDownload,
  ASSETS,
  assetFor,
  releaseUrl,
  REPO,
  LOCAL_DIR,
  MAX_RESPONSE_BYTES,
};
