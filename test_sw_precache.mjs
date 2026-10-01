// Card #1007, obligation #861 (1): the precache must bypass the HTTP cache.
// A plain cache.addAll consults it, so an asset pinned stale by a long
// max-age would be precached stale. Tripwire: the install path must fetch
// through `new Request(u, {cache:"reload"})` and the cache name must carry a
// version (v16+) so an installed PWA drops the old cache on activate.
// Run: node test_sw_precache.mjs   (exit 0 = pass)
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const sw = readFileSync(new URL("./sw.js", import.meta.url), "utf8");

const cacheName = sw.match(/const STATIC_CACHE = "([^"]+)";/);
assert.ok(cacheName, "STATIC_CACHE declared");
assert.match(cacheName[1], /^mes-static-v\d+$/, "cache name carries a version");

const assets = sw.slice(sw.indexOf("const STATIC_ASSETS = ["));
for (const asset of ["./", "./index.html", "./styles.css", "./app.js",
                     "./manifest.webmanifest", "./icons/icon-192.png",
                     "./icons/icon-512.png"]) {
  assert.ok(assets.includes(`"${asset}"`), `precache lists ${asset}`);
}

assert.ok(!/cache\.addAll\(STATIC_ASSETS\)/.test(sw),
  "no plain addAll(STATIC_ASSETS): it would consult the HTTP cache");
assert.match(sw, /new Request\(\w+, \{ ?cache: ?["']reload["'] ?\}\)/,
  "precache fetches bypass the HTTP cache ({cache:'reload'})");

console.log("sw precache tests: 3 passed");
