#!/usr/bin/env node
"use strict";

/**
 * Add an account from a terminal.
 *
 *   node scripts/add-user.js 482913 "a good password" --name Ollie --admin
 *
 * This is how the *first* manager gets made, because the console at /admin needs
 * somebody to sign in as. It writes to whatever store the app reads — Upstash
 * when KV_REST_API_URL/KV_REST_API_TOKEN are set, otherwise data/users.json.
 */

const users = require("../lib/users");
const auth = require("../lib/auth");

async function main() {
  const args = process.argv.slice(2);
  const nameIndex = args.indexOf("--name");
  const positional = args.filter((a) => !a.startsWith("--"));
  const number = positional[0];
  const password = positional[1];

  if (!number || !password) {
    console.error('Usage: node scripts/add-user.js <six-digit number> <password> [--name Name] [--admin]');
    process.exit(2);
  }

  try {
    const user = await users.addUser({
      number,
      password,
      name: nameIndex >= 0 ? args[nameIndex + 1] : "",
      role: args.includes("--admin") ? "admin" : "user",
    });

    console.log(`Added ${user.number}${user.role === "admin" ? " (manager)" : ""}.`);
    const mode = users.storageMode();
    const where = mode === "kv" ? "Upstash" : mode === "env" ? "PRISM_USERS (read-only)" : process.env.PRISM_USERS_FILE || "data/users.json";
    console.log(`Stored in: ${where}`);
    if (!auth.secret()) console.log("\nSet PRISM_AUTH_SECRET (16+ characters), or nobody can sign in.");
  } catch (err) {
    console.error(`Could not add that account: ${err.message}`);
    process.exit(1);
  }
}

main();
