"use strict";

/**
 * Who is allowed in.
 *
 * Accounts are kept in a private Vercel Blob, so they survive a deploy and are
 * the same for every request. Two fallbacks exist for people who have not
 * connected storage yet, and both say so rather than pretending:
 *
 *   blob   Vercel Blob private object — real storage, the admin page can change it
 *   env    PRISM_USERS JSON — read-only, an environment variable cannot be edited
 *   file   data/users.json — fine on your own computer, thrown away when hosted
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const auth = require("./auth");

const FILE = path.join(__dirname, "..", "data", "users.json");
const BLOB_PATH = "prism/accounts.json";
const MIN_PASSWORD = 6;

/* ------------------------------------------------------------------ *
 * where the list lives
 * ------------------------------------------------------------------ */

function blobConfig(env = process.env) {
  const token = env.BLOB_READ_WRITE_TOKEN || "";
  return token ? { token } : null;
}

function storageMode(env = process.env) {
  if (blobConfig(env)) return "blob";
  if (env.PRISM_USERS) return "env";
  return "file";
}

// Kept injectable so tests can exercise Blob semantics without a Vercel account.
let blobSdkOverride = null;
function blobSdk() {
  return blobSdkOverride || require("@vercel/blob");
}

async function readBlob(env = process.env) {
  const config = blobConfig(env);
  if (!config) throw new Error("No Vercel Blob store is configured.");
  const found = await blobSdk().get(BLOB_PATH, {
    access: "private",
    token: config.token,
    useCache: false,
    abortSignal: AbortSignal.timeout(8000),
  });
  if (!found) return [];
  const text = await new Response(found.stream).text();
  return cleanUsers(JSON.parse(text));
}

function hashPlainPasswords(users) {
  return users.map((user) => ({
    ...user,
    password: auth.isHashed(user.password) ? user.password : auth.hashPassword(user.password),
  }));
}

async function writeBlob(users, env = process.env) {
  const config = blobConfig(env);
  if (!config) throw new Error("No Vercel Blob store is configured.");
  await blobSdk().put(BLOB_PATH, JSON.stringify(hashPlainPasswords(users)), {
    access: "private",
    token: config.token,
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json; charset=utf-8",
    abortSignal: AbortSignal.timeout(8000),
  });
  return users;
}

/* ------------------------------------------------------------------ *
 * normalising entries
 * ------------------------------------------------------------------ */

function cleanUsers(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const clean = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const number = auth.normaliseNumber(entry.number);
    const password = typeof entry.password === "string" ? entry.password : "";
    if (!number || !password || seen.has(number)) continue;
    seen.add(number);
    clean.push({
      number,
      password,
      role: entry.role === "admin" ? "admin" : "user",
      active: entry.active === false ? false : true,
      name: typeof entry.name === "string" ? entry.name.slice(0, 60) : "",
    });
  }
  return clean;
}

function publicUser(user) {
  return {
    number: user.number,
    role: user.role,
    active: user.active !== false,
    name: user.name || "",
    hasPassword: Boolean(user.password),
  };
}

function readFromEnv(env = process.env) {
  if (!env.PRISM_USERS) return [];
  try {
    return cleanUsers(JSON.parse(env.PRISM_USERS));
  } catch {
    // a malformed variable must not lock the owner out of their own site
    return [];
  }
}

function readFromFile(env = process.env) {
  const file = env.PRISM_USERS_FILE || FILE;
  try {
    return cleanUsers(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * reading and writing
 * ------------------------------------------------------------------ */

async function listUsers(env = process.env) {
  const mode = storageMode(env);
  if (mode === "blob") {
    try {
      const stored = await readBlob(env);
      // A fresh store and a starting list in the environment: the variable is
      // the seed, so the first account can be made without a local script.
      if (!stored.length) return readFromEnv(env);
      return stored;
    } catch {
      // An unavailable store must not become an open door. A seed can still
      // allow the owner to sign in and see that storage needs attention.
      return readFromEnv(env);
    }
  }
  if (mode === "env") return readFromEnv(env);
  return readFromFile(env);
}

async function saveUsers(users, env = process.env) {
  const mode = storageMode(env);
  if (mode === "blob") return writeBlob(users, env);
  if (mode === "env") throw new Error("PRISM_USERS is read-only: change the environment variable instead.");
  const file = env.PRISM_USERS_FILE || FILE;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(hashPlainPasswords(users), null, 2) + "\n", { mode: 0o600 });
  return users;
}

/** Can the admin page actually change the list here? */
function canWrite(env = process.env) {
  if (storageMode(env) === "blob") return true;
  if (storageMode(env) === "env") return false;
  // A hosted function's disk is scratch space that disappears, so saving there
  // would look like it worked and then lose the account.
  if (env.VERCEL) return false;
  try {
    const file = env.PRISM_USERS_FILE || FILE;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.accessSync(path.dirname(file), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * lookups
 * ------------------------------------------------------------------ */

async function findUser(number, env = process.env) {
  const wanted = auth.normaliseNumber(number);
  if (!wanted) return null;
  return (await listUsers(env)).find((user) => user.number === wanted) || null;
}

/**
 * Check a number and password. The same message comes back for an unknown
 * number and a wrong password, so neither can be probed for.
 */
async function verifyCredentials(number, password, env = process.env) {
  const wrong = { ok: false, reason: "Those details do not match an account." };
  const wanted = auth.normaliseNumber(number);
  if (!wanted) return { ok: false, reason: "The number must be six digits." };

  const user = await findUser(wanted, env);
  if (!user) return wrong;
  if (!auth.verifyPassword(password, user.password)) return wrong;
  if (user.active === false) return { ok: false, reason: "That account is switched off." };
  return { ok: true, user };
}

/* ------------------------------------------------------------------ *
 * changes
 * ------------------------------------------------------------------ */

function checkPassword(password) {
  const value = String(password == null ? "" : password);
  if (value.length < MIN_PASSWORD) throw new Error(`Use a password of at least ${MIN_PASSWORD} characters.`);
  if (value.length > 200) throw new Error("That password is too long.");
  return value;
}

async function addUser(entry, env = process.env) {
  if (!canWrite(env)) throw new Error("This copy has nowhere permanent to save accounts.");
  const number = auth.normaliseNumber(entry.number);
  if (!number) throw new Error("The number must be six digits.");

  const password = checkPassword(entry.password);
  const users = await listUsers(env);
  if (users.some((user) => user.number === number)) throw new Error("That number already has an account.");

  const user = {
    number,
    password: auth.hashPassword(password),
    role: entry.role === "admin" ? "admin" : "user",
    active: true,
    name: typeof entry.name === "string" ? entry.name.trim().slice(0, 60) : "",
  };
  users.push(user);
  await saveUsers(users, env);
  return publicUser(user);
}

async function updateUser(number, changes, env = process.env) {
  if (!canWrite(env)) throw new Error("This copy has nowhere permanent to save accounts.");
  const wanted = auth.normaliseNumber(number);
  if (!wanted) throw new Error("The number must be six digits.");

  const users = await listUsers(env);
  const user = users.find((entry) => entry.number === wanted);
  if (!user) throw new Error("No account with that number.");

  if (changes.password != null && changes.password !== "") {
    user.password = auth.hashPassword(checkPassword(changes.password));
  }
  if (changes.active != null) {
    if (user.role === "admin" && changes.active === false) {
      const others = users.filter((entry) => entry.role === "admin" && entry.active !== false && entry.number !== wanted);
      if (!others.length) throw new Error("That is the last manager; switch on another first.");
    }
    user.active = changes.active !== false;
  }
  if (changes.name != null) user.name = String(changes.name).trim().slice(0, 60);
  if (changes.role != null) {
    const role = changes.role === "admin" ? "admin" : "user";
    if (role === "user" && user.role === "admin") {
      const others = users.filter((entry) => entry.role === "admin" && entry.active !== false && entry.number !== wanted);
      if (!others.length) throw new Error("That is the last manager; make another one first.");
    }
    user.role = role;
  }
  await saveUsers(users, env);
  return publicUser(user);
}

async function removeUser(number, env = process.env) {
  if (!canWrite(env)) throw new Error("This copy has nowhere permanent to save accounts.");
  const wanted = auth.normaliseNumber(number);
  if (!wanted) throw new Error("The number must be six digits.");

  const users = await listUsers(env);
  const user = users.find((entry) => entry.number === wanted);
  if (!user) throw new Error("No account with that number.");

  if (user.role === "admin" && user.active !== false) {
    const others = users.filter((entry) => entry.role === "admin" && entry.active !== false && entry.number !== wanted);
    // Removing the last manager would leave the console unreachable for good.
    if (!others.length) throw new Error("That is the last manager; make another one first.");
  }
  await saveUsers(
    users.filter((entry) => entry.number !== wanted),
    env
  );
}

async function needsSetup(env = process.env) {
  return (await listUsers(env)).length === 0;
}

async function hasAdmin(env = process.env) {
  return (await listUsers(env)).some((user) => user.role === "admin" && user.active !== false);
}

module.exports = {
  MIN_PASSWORD,
  BLOB_PATH,
  blobConfig,
  storageMode,
  cleanUsers,
  publicUser,
  listUsers,
  saveUsers,
  canWrite,
  findUser,
  verifyCredentials,
  addUser,
  updateUser,
  removeUser,
  needsSetup,
  hasAdmin,
  // Dependency injection for isolated storage tests; not needed by the app.
  _setBlobSdkForTests(value) { blobSdkOverride = value; },
};
