// Card #1367: a card body with newlines and a "- " list renders as separate
// lines and list items. A thread post is not sliced. Markup stays text.
// Run: node test_1367_card_text.mjs
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const src = readFileSync(new URL("./app.js", import.meta.url), "utf8");
assert.equal(src.includes(".slice(0, 280)"), false, "a thread post is still cut at 280 characters");

function makeEl(tag) {
  const el = {
    tag, children: [], className: "", textContent: "",
    appendChild(c) { el.children.push(c); return c; },
    append(...cs) { for (const c of cs) el.appendChild(c); },
  };
  return el;
}
function textNode(text) {
  return { tag: "#text", children: [], textContent: text };
}
const ctx = { document: {
  createElement: (tag) => makeEl(tag),
  createTextNode: (text) => textNode(text),
}};
vm.createContext(ctx);
const start = src.indexOf("function renderReadable(");
assert.ok(start >= 0, "renderReadable() not found");
const open = src.indexOf("{", start);
let depth = 0, end = -1;
for (let i = open; i < src.length; i++) {
  if (src[i] === "{") depth++;
  else if (src[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
}
vm.runInContext(src.slice(start, end), ctx);

const body = [
  "Gate one stays its own line",
  "- first item",
  "- second item",
  "1. accept the row",
  "2. ship the change",
  "see `code` and <b>not html</b>",
].join("\n");
const root = ctx.renderReadable(body);
const texts = (n) => [n.textContent || "", ...(n.children || []).flatMap(texts)];
assert.equal(root.children[0].tag, "p");
assert.equal(root.children[0].textContent, "Gate one stays its own line");
const ul = root.children.find((n) => n.tag === "ul");
assert.ok(ul, "a '- ' list is a ul");
assert.deepEqual(ul.children.map((li) => li.textContent), ["first item", "second item"]);
const ol = root.children.find((n) => n.tag === "ol");
assert.ok(ol, "a '1.' list is an ol");
assert.deepEqual(ol.children.map((li) => li.textContent), ["accept the row", "ship the change"]);
const flat = texts(root).join(" ");
assert.ok(flat.includes("<b>not html</b>"), "markup is shown as text");
assert.equal(root.children.some((n) => n.tag === "b" || n.tag === "script"), false);
const long = "word ".repeat(80);
const post = ctx.renderReadable(long);
const shown = texts(post).join("");
assert.equal(shown.includes(long.trim()), true);
assert.ok(shown.length > 280, "a long post is not cut");
console.log("ok card text");
