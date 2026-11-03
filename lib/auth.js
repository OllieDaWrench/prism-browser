"use strict";

/**
 * Passwords, sign-in cookies and the short-lived install token.
 *
 * Passwords are never stored, only a scrypt hash with a per-account salt.
 * Everything a browser carries is signed with PRISM_AUTH_SECRET, and each token
 * says what it is for: a sign-in cookie cannot be used to fetch a download, and
 * an install token cannot browse the site.
 */

const crypto = require("crypto");

const COOKIE_NAME = "prism_session";
const SESSION_TTL = 30 * 24 * 60 * 60; // 30 days, in seconds
const INSTALL_TTL = 15 * 60; // long enough to download ~10 MB
const KEY_LENGTH = 32;
const SCRYPT = { N: 16384, r: 8, p: 1 };

/* ------------------------------------------------------------------ *
 * numbers and passwords
 * ------------------------------------------------------------------ */

/**
 * The sign-in name is a six-digit number, not a phone number: nothing is ever
 * sent to it, so there is no SMS bill and no way for it to change hands.
 * Spaces and dashes are allowed when typing, but the stored form is six digits.
 */
function normaliseNumber(value) {
  const digits = String(value == null ? "" : value).replace(/[^0-9]/g, "");
  return /^[0-9]{6}$/.test(digits) ? digits : null;
}

function isHashed(value) {
  return typeof value === "string" && /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/.test(value);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const key = crypto.scryptSync(String(password), salt, KEY_LENGTH, SCRYPT);
  return `scrypt$${salt}$${key.toString("hex")}`;
}

/** Constant-time compare that never throws on a length mismatch. */
function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) {
    // still burn the comparison, so a wrong length is not faster to reject
    crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  if (!isHashed(stored)) return safeEqual(password, stored); // a plain value from PRISM_USERS
  const [, salt, expected] = stored.split("$");
  try {
    const key = crypto.scryptSync(String(password), salt, KEY_LENGTH, SCRYPT);
    return safeEqual(key.toString("hex"), expected);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * signed tokens
 * ------------------------------------------------------------------ */

function secret(env = process.env) {
  const value = String(env.PRISM_AUTH_SECRET || "");
  // A short secret is worse than none: it invites a guessable signature.
  return value.length >= 16 ? value : null;
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function sign(body, key) {
  return crypto.createHmac("sha256", key).update(body).digest("base64url");
}

function issue(payload, ttlSeconds, key) {
  if (!key) throw new Error("PRISM_AUTH_SECRET is not set");
  const body = encode({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds });
  return `${body}.${sign(body, key)}`;
}

function readToken(value, scope, env = process.env) {
  const key = secret(env);
  if (!key || typeof value !== "string" || value.length > 2048) return null;

  const dot = value.indexOf(".");
  if (dot <= 0) return null;
  const body = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  if (!safeEqual(signature, sign(body, key))) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || payload.scope !== scope) return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) return null;
  return payload;
}

function createSession(user, options = {}) {
  return issue(
    { number: user.number, role: user.role === "admin" ? "admin" : "user", scope: "session" },
    options.ttlSeconds == null ? SESSION_TTL : options.ttlSeconds,
    options.secret || secret()
  );
}

function readSession(value, env) {
  return readToken(value, "session", env);
}

function createInstallToken(user, options = {}) {
  return issue(
    { number: user.number, scope: "install" },
    options.ttlSeconds == null ? INSTALL_TTL : options.ttlSeconds,
    options.secret || secret()
  );
}

function readInstallToken(value, env) {
  return readToken(value, "install", env);
}

/* ------------------------------------------------------------------ *
 * the cookie
 * ------------------------------------------------------------------ */

function cookieHeader(token, options = {}) {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${options.maxAge == null ? SESSION_TTL : options.maxAge}`,
  ];
  if (options.secure !== false) parts.push("Secure");
  return parts.join("; ");
}

function clearCookieHeader() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function sessionFromCookieHeader(header, env) {
  const raw = String(header || "");
  for (const piece of raw.split(";")) {
    const [name, ...rest] = piece.trim().split("=");
    if (name === COOKIE_NAME) return readSession(rest.join("="), env);
  }
  return null;
}

module.exports = {
  COOKIE_NAME,
  SESSION_TTL,
  INSTALL_TTL,
  normaliseNumber,
  isHashed,
  hashPassword,
  verifyPassword,
  safeEqual,
  secret,
  createSession,
  readSession,
  createInstallToken,
  readInstallToken,
  cookieHeader,
  clearCookieHeader,
  sessionFromCookieHeader,
};
