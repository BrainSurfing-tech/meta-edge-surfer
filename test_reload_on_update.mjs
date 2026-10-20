// A new service worker takes control: the open page reloads once, never over an unsent draft.
// Run: node test_reload_on_update.mjs
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const src = readFileSync(new URL("./app.js", import.meta.url), "utf8");
function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name}() not found`);
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
}
const ctx = { _boardDrafts: new Map(), location: null, document: null };
vm.runInNewContext(`let _updatePending = false;\n${extract("hasUnsentDraft")}\n${extract("reloadIfUpdated")}\n` +
  `this.setPending = (v) => { _updatePending = v; }; this.reloadIfUpdated = reloadIfUpdated;`, ctx);

const doc = (fields) => ({ querySelectorAll: () => fields });
const loc = () => ({ n: 0, reload() { this.n++; } });
const field = (id, value, readOnly = false) => ({ id, value, readOnly });

// nothing pending: never reloads
let l = loc();
assert.equal(ctx.reloadIfUpdated(doc([]), new Map(), l), false);
assert.equal(l.n, 0);

// pending, no draft: reloads exactly once
ctx.setPending(true); l = loc();
assert.equal(ctx.reloadIfUpdated(doc([field("send-content", "")]), new Map(), l), true);
assert.equal(ctx.reloadIfUpdated(doc([]), new Map(), l), false, "only once");
assert.equal(l.n, 1);

// pending, typed reply: waits
ctx.setPending(true); l = loc();
assert.equal(ctx.reloadIfUpdated(doc([field("send-content", "half a reply")]), new Map(), l), false);
// pending, picked board option or note: waits
assert.equal(ctx.reloadIfUpdated(doc([]), new Map([["k", { opt: 1 }]]), l), false);
assert.equal(ctx.reloadIfUpdated(doc([]), new Map([["k", { note: "why" }]]), l), false);
assert.equal(l.n, 0);
// settings values, readonly links and the tools filter are not drafts
assert.equal(ctx.reloadIfUpdated(doc([field("cfg-base", "https://x"), field("inv-link", "https://y", true),
  field("tools-assignee", "lab-ovh")]), new Map([["k", { noteOpen: true }]]), l), true);
assert.equal(l.n, 1);

// wiring: controllerchange only after a page that already had a controller; send re-checks
assert.ok(src.includes('addEventListener("controllerchange"'));
assert.ok(src.includes("if (hadController) { _updatePending = true; reloadIfUpdated(); }"));
assert.ok(src.includes('document.addEventListener("visibilitychange", () => reloadIfUpdated());'));
assert.ok(src.includes("setTimeout(() => reloadIfUpdated(), 3000);"));
console.log("ok test_reload_on_update");
