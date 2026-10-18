// card #1206 — Questions waiting on you shows the offer question, not the
// row summary "obligation #N · card #C · unstepped · PASS =".
// Run: node test_1206_you_preview.mjs
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const src = readFileSync(new URL("./app.js", import.meta.url), "utf8");

function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name}() not found`);
  const open = src.indexOf("{", start);
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return src.slice(start, end);
}

const ACCEPT = "PASS = the commander picks one of the three | FAIL = no answer";
const QUESTION = "give droplet the shared token, build per-client tokens, or hold?";
const MSG = {
  id: 74184,
  kind: "question",
  from_node: "lab-ovh",
  to_node: "commander",
  created_at: "2026-10-17T11:00:00Z",
  content: `${QUESTION}\n\nACCEPT CHECK: ${ACCEPT}`,
  row: {
    id: 2103, card_id: 1205, step: null, holder: "commander", accept: ACCEPT,
  },
};

function makeEl(tag) {
  return {
    tag, children: [], className: "", textContent: "", title: "",
    appendChild(c) { this.children.push(c); return c; },
  };
}

const ctx = {
  document: { createElement: (tag) => makeEl(tag) },
};
vm.createContext(ctx);
vm.runInContext(
  `${extract("fmtTime")}\n${extract("offerQuestionText")}\n${extract("boardRowLabel")}\n` +
  `${extract("_actionRow")}\n${extract("_youRow")}\n`,
  ctx);

const shown = ctx._youRow("questions", MSG);
const primary = shown.children[0].textContent;
assert.equal(primary, QUESTION, "the preview is the question");
assert.ok(!primary.includes("obligation #2103"), "not the row summary");
assert.ok(!primary.includes("unstepped"), "not the step summary");
assert.ok(!primary.includes("PASS ="), "not the accept");

const plain = {
  id: 7, kind: "question", from_node: "lab-ovh", content: "plain question",
  created_at: "2026-10-17T11:00:00Z",
  row: { id: 9, card_id: 3, step: "build", holder: "commander", accept: "PASS = x" },
};
const fallback = ctx._youRow("questions", plain);
assert.ok(fallback.children[0].textContent.includes("obligation #9"),
  "a message with no offer marker keeps the row summary");
assert.ok(!fallback.children[0].textContent.includes("plain question"));

console.log("card #1206 you-preview: 2 passed");
