// card #1018 — service-worker cache guard (#993).
// The worker serves same-origin GETs cache-first, so ANY app.js change MUST
// ship with a new STATIC_CACHE name or phones keep the old app.js past the
// deploy. This test fails when app.js differs from origin/main while sw.js
// still names origin/main's cache.
// Run: node test_sw_cache_guard.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const git = (args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const cacheName = (src) => {
  const m = src.match(/STATIC_CACHE\s*=\s*"([^"]+)"/);
  assert.ok(m, "STATIC_CACHE assignment not found in sw.js");
  return m[1];
};

const base = "origin/main";
const headApp = readFileSync(new URL("./app.js", import.meta.url), "utf8").trim();
const headCache = cacheName(readFileSync(new URL("./sw.js", import.meta.url), "utf8"));
let baseApp, baseCache;
try {
  baseApp = git(["show", `${base}:app.js`]);
  baseCache = cacheName(git(["show", `${base}:sw.js`]));
} catch {
  console.log("sw cache guard: skipped (no origin/main ref)");
  process.exit(0);
}
// {cache:"reload"} precache must survive every sw.js edit.
const swSrc = readFileSync(new URL("./sw.js", import.meta.url), "utf8");
assert.ok(swSrc.includes('{ cache: "reload" }'),
  "precache must bypass the HTTP cache ({cache:\"reload\"})");

if (headApp !== baseApp) {
  assert.notEqual(headCache, baseCache,
    `app.js changed vs ${base} but sw.js still names ${headCache} — ` +
    "bump STATIC_CACHE or phones keep the old app.js");
}
console.log(`sw cache guard: passed (app.js ${headApp === baseApp ? "unchanged" : "changed"}, cache ${headCache})`);
