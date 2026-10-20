// Questions waiting on you: an ask whose board row is closed is not waiting.
// Run: node test_stale_questions.mjs
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const src = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const start = src.indexOf("function questionWaiting(");
assert.ok(start >= 0, "questionWaiting() not found");
const end = src.indexOf("\n}\n", start) + 2;
const ctx = {};
vm.runInNewContext(src.slice(start, end) + "\nthis.questionWaiting = questionWaiting;", ctx);
const w = (m) => ctx.questionWaiting({ kind: "question", from_node: "lab-ovh", ...m }, "commander");

assert.equal(w({}), true, "unbound unread question waits");
assert.equal(w({ row: { id: 1, status: "open" } }), true, "open row waits");
for (const status of ["closed", "withdrawn", "fallback_fired"]) {
  assert.equal(w({ row: { id: 1, status } }), false, `${status} row does not wait`);
}
assert.equal(w({ read_at: "2026-10-20T00:00:00Z" }), false, "read question does not wait");
assert.equal(w({ from_node: "commander" }), false, "own message does not wait");
assert.equal(w({ kind: "fyi" }), false, "non-question does not wait");
console.log("ok test_stale_questions");
