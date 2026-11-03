"use strict";

/** GET /api/auth/status — what the sign-in page needs to know about this copy. */

const auth = require("../../lib/auth");
const users = require("../../lib/users");
const gate = require("../../lib/gate");

module.exports = async function handler(req, res) {
  const session = gate.sessionFrom(req);
  let needsSetup = false;
  try {
    needsSetup = await users.needsSetup();
  } catch {
    needsSetup = false;
  }

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(
    JSON.stringify({
      ok: true,
      authenticated: Boolean(session),
      number: session ? session.number : null,
      admin: session ? session.role === "admin" : false,
      needsSetup,
      configured: Boolean(auth.secret()),
      storage: users.storageMode(),
      canWrite: users.canWrite(),
    })
  );
};
