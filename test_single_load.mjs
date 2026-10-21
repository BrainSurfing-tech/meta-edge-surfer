// Boot runs showView("actions") and then the poll loop's first tick: two
// refreshActions() calls overlap. They must share ONE fetch of each list.
// Run: node test_single_load.mjs
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const src = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const start = src.indexOf("let _actionsLoad");
assert.ok(start >= 0, "RED: refreshActions has no shared in-flight load");
const end = src.indexOf("async function loadActions(");
const ctx = { loads: 0, release: null };
ctx.loadActions = () => { ctx.loads++; return new Promise((r) => { ctx.release = r; }); };
vm.createContext(ctx);
vm.runInContext(src.slice(start, end) + "\nthis.refreshActions = refreshActions;", ctx);

const a = ctx.refreshActions();
const b = ctx.refreshActions();
assert.equal(ctx.loads, 1, "RED: overlapping calls fetched twice");
ctx.release();
await Promise.all([a, b]);
ctx.refreshActions();
assert.equal(ctx.loads, 2, "RED: a later call must load again once the first ended");
ctx.release();
console.log("ok: overlapping refreshActions() share one load; a later call reloads");
