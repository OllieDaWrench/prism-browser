"use strict";

/**
 * GET  /api/auth/users — who has access (managers see the whole list)
 * POST /api/auth/users — add, update or remove an account (managers only)
 */

const users = require("../../lib/users");
const gate = require("../../lib/gate");
const { readBody } = require("../../lib/body");

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

module.exports = async function handler(req, res) {
  const session = gate.sessionFrom(req);
  if (!session) return json(res, 401, { ok: false, error: "Please sign in first." });

  if ((req.method || "GET") === "GET") {
    let list = [];
    try {
      list = await users.listUsers();
    } catch (err) {
      return json(res, 502, { ok: false, error: `Could not read the account list: ${err.message}` });
    }
    return json(res, 200, {
      ok: true,
      me: session.number,
      storage: users.storageMode(),
      canWrite: users.canWrite(),
      users: list.map(users.publicUser),
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return json(res, 405, { ok: false, error: "Use GET or POST." });
  }

  if (session.role !== "admin") {
    return json(res, 403, { ok: false, error: "Only the account owner can change access." });
  }
  if (!users.canWrite()) {
    return json(res, 409, {
      ok: false,
      error:
        users.storageMode() === "env"
          ? "Accounts come from the PRISM_USERS variable, which cannot be edited here."
          : "This copy has nowhere permanent to save accounts. Connect Vercel Blob first.",
    });
  }

  const body = await readBody(req);
  const action = String(body.action || "").toLowerCase();
  const number = body.number;

  try {
    if (action === "add") {
      const user = await users.addUser({
        number,
        password: body.password,
        name: body.name,
        role: body.role,
      });
      return json(res, 200, { ok: true, user });
    }
    if (action === "update") {
      const user = await users.updateUser(number, {
        password: body.password,
        active: body.active,
        name: body.name,
        role: body.role,
      });
      return json(res, 200, { ok: true, user });
    }
    if (action === "remove") {
      await users.removeUser(number);
      return json(res, 200, { ok: true });
    }
    return json(res, 400, { ok: false, error: "Unknown action." });
  } catch (err) {
    return json(res, 400, { ok: false, error: err.message });
  }
};
