"use strict";

/**
 * Read a request body that may be JSON or form-encoded.
 *
 * The site posts JSON; the installer posts a form, because `curl --data-urlencode`
 * escapes a password properly where building JSON by hand in a shell does not.
 */

function readBody(req, limit = 8192) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return resolve(req.body);

    let raw = "";
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };

    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > limit) {
        finish({});
        req.destroy();
      }
    });
    req.on("end", () => {
      const type = String((req.headers && req.headers["content-type"]) || "").toLowerCase();
      if (type.includes("application/x-www-form-urlencoded")) {
        try {
          return finish(Object.fromEntries(new URLSearchParams(raw)));
        } catch {
          return finish({});
        }
      }
      try {
        finish(JSON.parse(raw || "{}"));
      } catch {
        // a form posted without the header still works
        try {
          finish(Object.fromEntries(new URLSearchParams(raw)));
        } catch {
          finish({});
        }
      }
    });
    req.on("error", () => finish({}));
  });
}

module.exports = { readBody };
