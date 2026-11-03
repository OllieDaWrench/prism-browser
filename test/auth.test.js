"use strict";

/**
 * Accounts: a six-digit number, a password, and the session that follows.
 *
 * These drive the real library with a throwaway store per test, so a mistake in
 * hashing, expiry, scoping or the Upstash round trip fails here rather than on
 * the deployed site.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const auth = require("../lib/auth");
const users = require("../lib/users");

const SECRET = "test-secret-that-is-long-enough";

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-auth-"));
  const file = path.join(dir, "users.json");
  process.env.PRISM_USERS_FILE = file;
  process.env.PRISM_AUTH_SECRET = SECRET;
  delete process.env.PRISM_USERS;
  delete process.env.PRISM_AUTH;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.VERCEL;
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.PRISM_USERS_FILE;
    delete process.env.PRISM_AUTH_SECRET;
  });
  return { dir, file };
}

function withSecret(t) {
  const previous = process.env.PRISM_AUTH_SECRET;
  process.env.PRISM_AUTH_SECRET = SECRET;
  t.after(() => {
    if (previous === undefined) delete process.env.PRISM_AUTH_SECRET;
    else process.env.PRISM_AUTH_SECRET = previous;
  });
}

test("the sign-in name is six digits, however it is typed", () => {
  assert.equal(auth.normaliseNumber("482913"), "482913");
  assert.equal(auth.normaliseNumber(" 482 913 "), "482913");
  assert.equal(auth.normaliseNumber("482-913"), "482913");

  // not a phone number any more, and not free text
  assert.equal(auth.normaliseNumber("0482913"), null, "seven digits");
  assert.equal(auth.normaliseNumber("48291"), null, "five digits");
  assert.equal(auth.normaliseNumber("48291a"), null);
  assert.equal(auth.normaliseNumber(""), null);
  assert.equal(auth.normaliseNumber(null), null);
});

test("passwords are stored hashed, never in the clear", async (t) => {
  const { file } = sandbox(t);
  await users.addUser({ number: "482 913", password: "letmeinplease" });

  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(stored[0].number, "482913");
  assert.ok(auth.isHashed(stored[0].password));
  assert.equal(JSON.stringify(stored).includes("letmeinplease"), false);
});

test("the right password works, the wrong one does not", async (t) => {
  sandbox(t);
  await users.addUser({ number: "482913", password: "letmeinplease" });

  assert.equal((await users.verifyCredentials("482 913", "letmeinplease")).ok, true);

  const wrong = await users.verifyCredentials("482913", "nope");
  assert.equal(wrong.ok, false);
  const unknown = await users.verifyCredentials("999999", "letmeinplease");
  assert.equal(unknown.ok, false);
  // the same wording both times, so neither half can be probed for
  assert.equal(unknown.reason, wrong.reason);
});

test("a bad number length is refused before any lookup", async (t) => {
  sandbox(t);
  const result = await users.verifyCredentials("48291", "anything");
  assert.equal(result.ok, false);
  assert.match(result.reason, /six digits/);
});

test("a switched-off account cannot sign in", async (t) => {
  sandbox(t);
  await users.addUser({ number: "482913", password: "letmeinplease" });
  await users.addUser({ number: "111222", password: "other-password", role: "admin" });
  await users.updateUser("482913", { active: false });

  const result = await users.verifyCredentials("482913", "letmeinplease");
  assert.equal(result.ok, false);
  assert.match(result.reason, /switched off/);
});

test("a session survives a round trip and stops when tampered with", (t) => {
  withSecret(t);
  const token = auth.createSession({ number: "482913", role: "admin" });
  const session = auth.readSession(token);
  assert.equal(session.number, "482913");
  assert.equal(session.role, "admin");

  const broken = token.slice(0, -1) + (token.slice(-1) === "A" ? "B" : "A");
  assert.equal(auth.readSession(broken), null);

  const other = auth.createSession({ number: "482913" }, { secret: "a-different-secret-value" });
  assert.equal(auth.readSession(other), null);
});

test("an expired session is refused", (t) => {
  withSecret(t);
  assert.equal(auth.readSession(auth.createSession({ number: "482913" }, { ttlSeconds: -1 })), null);
});

test("an install token is not a session, and a session is not an install token", (t) => {
  withSecret(t);
  const install = auth.createInstallToken({ number: "482913" });
  const session = auth.createSession({ number: "482913" });

  // a token that could also browse would defeat the point of scoping
  assert.equal(auth.readSession(install), null);
  assert.equal(auth.readInstallToken(session), null);
  assert.equal(auth.readInstallToken(install).number, "482913");
});

test("nothing is signed when no secret is configured", (t) => {
  const previous = process.env.PRISM_AUTH_SECRET;
  delete process.env.PRISM_AUTH_SECRET;
  t.after(() => {
    if (previous !== undefined) process.env.PRISM_AUTH_SECRET = previous;
  });

  assert.equal(auth.secret(), null);
  assert.throws(() => auth.createSession({ number: "482913" }), /PRISM_AUTH_SECRET/);
  assert.equal(auth.readSession("anything.atall"), null);
});

test("a secret shorter than 16 characters is treated as no secret at all", () => {
  assert.equal(auth.secret({ PRISM_AUTH_SECRET: "short" }), null);
  assert.equal(auth.secret({ PRISM_AUTH_SECRET: "0123456789abcdef" }), "0123456789abcdef");
});

test("the cookie is HttpOnly, SameSite=Lax, and Secure unless local http", () => {
  const header = auth.cookieHeader("abc.def");
  assert.match(header, /^prism_session=abc\.def/);
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Lax/);
  assert.match(header, /Secure/);
  assert.doesNotMatch(auth.cookieHeader("abc.def", { secure: false }), /Secure/);
  assert.match(auth.clearCookieHeader(), /Max-Age=0/);
});

test("the session cookie is found among others, and junk is ignored", (t) => {
  withSecret(t);
  const token = auth.createSession({ number: "482913" });
  assert.equal(auth.sessionFromCookieHeader(`a=1; prism_session=${token}; b=2`).number, "482913");
  assert.equal(auth.sessionFromCookieHeader("a=1"), null);
  assert.equal(auth.sessionFromCookieHeader(""), null);
  assert.equal(auth.sessionFromCookieHeader(undefined), null);
});

test("duplicate numbers are refused, and the last manager cannot be removed", async (t) => {
  sandbox(t);
  await users.addUser({ number: "482913", password: "first-password", role: "admin" });
  await assert.rejects(() => users.addUser({ number: "482 913", password: "another" }), /already/);

  await users.addUser({ number: "111222", password: "second-password" });
  assert.equal((await users.listUsers()).length, 2);
  await users.removeUser("111222");
  assert.equal((await users.listUsers()).length, 1);

  // and the owner cannot delete themselves out of the console
  await assert.rejects(() => users.removeUser("482913"), /last manager/);
});

test("a short password is rejected", async (t) => {
  sandbox(t);
  await assert.rejects(() => users.addUser({ number: "482913", password: "abc" }), /at least 6/);
});

test("the public view of an account never includes the password", async (t) => {
  sandbox(t);
  await users.addUser({ number: "482913", password: "letmeinplease", name: "Ollie" });
  const [account] = await users.listUsers();
  const safe = users.publicUser(account);

  assert.equal(safe.hasPassword, true);
  assert.equal("password" in safe, false);
  assert.equal(JSON.stringify(safe).includes("scrypt"), false);
});

test("a starting list in the environment seeds an empty database", async (t) => {
  sandbox(t);
  process.env.PRISM_USERS = JSON.stringify([{ number: "482913", password: "plain-text-password", role: "admin" }]);
  t.after(() => delete process.env.PRISM_USERS);

  assert.equal(users.storageMode(), "env");
  const result = await users.verifyCredentials("482913", "plain-text-password");
  assert.equal(result.ok, true);
  // an environment variable cannot be written back, and the console says so
  assert.equal(users.canWrite(), false);
  await assert.rejects(() => users.addUser({ number: "111222", password: "whatever-password" }), /nowhere permanent/);
});

test("a hosted function will not pretend to save accounts to its scratch disk", (t) => {
  sandbox(t);
  process.env.VERCEL = "1";
  t.after(() => delete process.env.VERCEL);

  assert.equal(users.storageMode(), "file");
  assert.equal(users.canWrite(), false);
});

test("needsSetup is true only while there are no accounts", async (t) => {
  sandbox(t);
  assert.equal(await users.needsSetup(), true);
  await users.addUser({ number: "482913", password: "letmeinplease", role: "admin" });
  assert.equal(await users.needsSetup(), false);
  assert.equal(await users.hasAdmin(), true);
});

/* ------------------------------------------------------------------ *
 * Upstash
 * ------------------------------------------------------------------ */

/** A stand-in for the Upstash REST API: one key, commands as a JSON array. */
function fakeUpstash(t, initial) {
  const store = new Map();
  if (initial !== undefined) store.set(users.KV_KEY, initial);
  const calls = [];

  const original = global.fetch;
  global.fetch = async (url, options) => {
    const command = JSON.parse(options.body);
    calls.push({ url, command });
    if (options.headers.Authorization !== "Bearer good-token") {
      return { ok: false, status: 401, json: async () => ({ error: "unauthorised" }) };
    }
    const [verb] = command;
    if (verb === "GET") return { ok: true, status: 200, json: async () => ({ result: store.get(command[1]) || null }) };
    if (verb === "SET") {
      store.set(command[1], command[2]);
      return { ok: true, status: 200, json: async () => ({ result: "OK" }) };
    }
    return { ok: true, status: 200, json: async () => ({ result: null }) };
  };

  process.env.KV_REST_API_URL = "https://fake-upstash.example";
  process.env.KV_REST_API_TOKEN = "good-token";

  t.after(() => {
    global.fetch = original;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
  });
  return { store, calls };
}

test("accounts are kept in Upstash when it is configured", async (t) => {
  sandbox(t);
  const { store, calls } = fakeUpstash(t);

  assert.equal(users.storageMode(), "kv");
  assert.equal(users.canWrite(), true);

  await users.addUser({ number: "482913", password: "letmeinplease", role: "admin" });

  // what was written is a JSON list, hashed, and readable straight back
  const saved = JSON.parse(store.get(users.KV_KEY));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].number, "482913");
  assert.ok(auth.isHashed(saved[0].password));
  assert.equal(calls.some((c) => c.command[0] === "SET"), true);

  const back = await users.verifyCredentials("482913", "letmeinplease");
  assert.equal(back.ok, true, "the account survives the round trip to the store");
});

test("an unreachable Upstash falls back to the environment instead of opening the door", async (t) => {
  sandbox(t);
  process.env.KV_REST_API_URL = "https://fake-upstash.example";
  process.env.KV_REST_API_TOKEN = "wrong-token";
  process.env.PRISM_USERS = JSON.stringify([{ number: "482913", password: "seed-password", role: "admin" }]);
  const original = global.fetch;
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: "unauthorised" }) });
  t.after(() => {
    global.fetch = original;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    delete process.env.PRISM_USERS;
  });

  // the fallback is the seed list, never "everybody in"
  assert.equal((await users.listUsers()).length, 1);
  assert.equal((await users.verifyCredentials("482913", "seed-password")).ok, true);
  assert.equal((await users.verifyCredentials("111222", "anything")).ok, false);
});

test("the first account written to an empty Upstash keeps the environment seed", async (t) => {
  sandbox(t);
  const { store } = fakeUpstash(t, "");
  process.env.PRISM_USERS = JSON.stringify([{ number: "482913", password: "seed-password", role: "admin" }]);
  t.after(() => delete process.env.PRISM_USERS);

  await users.addUser({ number: "111222", password: "second-password" });

  const saved = JSON.parse(store.get(users.KV_KEY));
  assert.equal(saved.length, 2, "the seed is not dropped when the first real account is added");
  assert.deepEqual(saved.map((u) => u.number).sort(), ["111222", "482913"]);
});
