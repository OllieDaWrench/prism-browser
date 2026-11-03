"use strict";

/** Store short feedback notes privately in Vercel Blob, or in a local data file. */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DEFAULT_FILE = path.join(__dirname, "..", "data", "feedback.jsonl");
const BLOB_PREFIX = "prism/feedback";
let blobSdkOverride = null;

function blobConfig(env = process.env) {
  const token = env.BLOB_READ_WRITE_TOKEN || "";
  return token ? { token } : null;
}

function storageMode(env = process.env) {
  if (blobConfig(env)) return "blob";
  if (env.VERCEL) return "unavailable";
  return "file";
}

function blobSdk() {
  return blobSdkOverride || require("@vercel/blob");
}

function normalizeMessage(input) {
  if (typeof input !== "string") throw new Error("Enter a feedback message.");
  const message = input.replace(/\r\n?/g, "\n").replace(/\u0000/g, "").trim();
  if (!message) throw new Error("Enter a feedback message.");
  if (message.length > 2000) throw new Error("Keep feedback under 2,000 characters.");
  return message;
}

async function submitFeedback(input, env = process.env) {
  const message = normalizeMessage(input);
  const entry = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), message };
  const mode = storageMode(env);

  if (mode === "blob") {
    const config = blobConfig(env);
    const pathname = `${BLOB_PREFIX}/${entry.createdAt.slice(0, 7)}/${entry.id}.json`;
    await blobSdk().put(pathname, JSON.stringify(entry), {
      access: "private",
      token: config.token,
      addRandomSuffix: false,
      contentType: "application/json; charset=utf-8",
      abortSignal: AbortSignal.timeout(8000),
    });
  } else if (mode === "file") {
    const file = env.PRISM_FEEDBACK_FILE || DEFAULT_FILE;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, JSON.stringify(entry) + "\n", { encoding: "utf8", mode: 0o600 });
  } else {
    throw new Error("Private feedback storage is not configured.");
  }

  return { id: entry.id, createdAt: entry.createdAt, storage: mode };
}

function _setBlobSdkForTests(sdk) {
  blobSdkOverride = sdk;
}

module.exports = { submitFeedback, normalizeMessage, storageMode, _setBlobSdkForTests };
