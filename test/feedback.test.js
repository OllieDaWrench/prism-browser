"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const handler = require("../api/feedback");
const feedback = require("../lib/feedback");

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    end(body) { this.body = String(body || ""); this.ended = true; },
  };
}

function request(body, overrides = {}) {
  return {
    method: "POST",
    url: "/api/feedback",
    headers: { "x-forwarded-for": `test-${Math.random()}` },
    socket: {},
    body,
    ...overrides,
  };
}

function restoreEnv(t, names) {
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  });
}

test("normalizes feedback and rejects empty or oversized messages", () => {
  assert.equal(feedback.normalizeMessage("  Hello\r\nPrism  "), "Hello\nPrism");
  assert.throws(() => feedback.normalizeMessage(" \n "), /Enter a feedback message/);
  assert.throws(() => feedback.normalizeMessage("x".repeat(2001)), /2,000 characters/);
  assert.throws(() => feedback.normalizeMessage({ message: "no" }), /Enter a feedback message/);
});

test("local feedback is appended to a private JSONL file", async (t) => {
  restoreEnv(t, ["VERCEL", "BLOB_READ_WRITE_TOKEN", "PRISM_FEEDBACK_FILE"]);
  delete process.env.VERCEL;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-feedback-"));
  const file = path.join(dir, "private", "feedback.jsonl");
  process.env.PRISM_FEEDBACK_FILE = file;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const saved = await feedback.submitFeedback("Looks good");
  assert.equal(saved.storage, "file");
  const rows = fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].message, "Looks good");
  assert.match(rows[0].id, /^[0-9a-f-]{36}$/);
  assert.ok(rows[0].createdAt);
});

test("Blob feedback is private and written as a separate object", async (t) => {
  restoreEnv(t, ["VERCEL", "BLOB_READ_WRITE_TOKEN"]);
  process.env.VERCEL = "1";
  process.env.BLOB_READ_WRITE_TOKEN = "test-blob-token";
  let received;
  feedback._setBlobSdkForTests({ put: async (pathname, payload, options) => { received = { pathname, payload, options }; } });
  t.after(() => feedback._setBlobSdkForTests(null));

  const result = await feedback.submitFeedback("A private note");
  assert.equal(result.storage, "blob");
  assert.match(received.pathname, /^prism\/feedback\/\d{4}-\d{2}\/[0-9a-f-]{36}\.json$/);
  assert.equal(JSON.parse(received.payload).message, "A private note");
  assert.equal(received.options.access, "private");
  assert.equal(received.options.token, "test-blob-token");
});

test("hosted feedback fails clearly when persistent storage is not configured", async (t) => {
  restoreEnv(t, ["VERCEL", "BLOB_READ_WRITE_TOKEN"]);
  process.env.VERCEL = "1";
  delete process.env.BLOB_READ_WRITE_TOKEN;
  await assert.rejects(feedback.submitFeedback("Not stored"), /storage is not configured/);
});

test("feedback endpoint accepts a note and never returns its contents", async (t) => {
  restoreEnv(t, ["VERCEL", "BLOB_READ_WRITE_TOKEN", "PRISM_FEEDBACK_FILE"]);
  delete process.env.VERCEL;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-feedback-api-"));
  process.env.PRISM_FEEDBACK_FILE = path.join(dir, "feedback.jsonl");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  handler._resetRateLimitForTests();
  const res = response();
  await handler(request({ message: "Private content" }), res);
  const json = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(json.ok, true);
  assert.equal(typeof json.id, "string");
  assert.doesNotMatch(res.body, /Private content/);
  assert.equal(res.headers["cache-control"], "no-store");
});

test("feedback endpoint validates input, accepts the honeypot, and limits spam", async (t) => {
  restoreEnv(t, ["VERCEL", "BLOB_READ_WRITE_TOKEN", "PRISM_FEEDBACK_FILE"]);
  delete process.env.VERCEL;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-feedback-api-"));
  process.env.PRISM_FEEDBACK_FILE = path.join(dir, "feedback.jsonl");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  handler._resetRateLimitForTests();

  const invalid = response();
  await handler(request({ message: "  " }), invalid);
  assert.equal(invalid.statusCode, 400);

  const honeypot = response();
  await handler(request({ message: "bot", website: "filled" }), honeypot);
  assert.equal(honeypot.statusCode, 200);
  assert.equal(fs.existsSync(process.env.PRISM_FEEDBACK_FILE), false);

  for (let i = 0; i < 5; i += 1) {
    const res = response();
    await handler(request({ message: `note ${i}` }, { headers: { "x-forwarded-for": "limited-client" } }), res);
    assert.equal(res.statusCode, 200);
  }
  const limited = response();
  await handler(request({ message: "sixth" }, { headers: { "x-forwarded-for": "limited-client" } }), limited);
  assert.equal(limited.statusCode, 429);
});

test("feedback endpoint only accepts POST", async () => {
  const res = response();
  await handler(request({}, { method: "GET" }), res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.allow, "POST");
});
