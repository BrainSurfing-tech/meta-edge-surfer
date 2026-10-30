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
    tag, children: [], className: "", textContent: "", attrs: {},
    appendChild(c) { el.children.push(c); return c; },
    append(...cs) { for (const c of cs) el.appendChild(c); },
    setAttribute(k, v) { el.attrs[k] = String(v); },
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
assert.equal(ol.attrs.start, "1");
assert.deepEqual(ol.children.map((li) => li.textContent), ["accept the row", "ship the change"]);
const split = ctx.renderReadable([
  "1. first",
  "",
  "2. second",
  "3. third",
  "Intro",
  "4. fourth",
].join("\n"));
const ols = split.children.filter((n) => n.tag === "ol");
assert.deepEqual(ols.map((n) => n.attrs.start), ["1", "2", "4"]);
assert.deepEqual(ols[0].children.map((li) => li.textContent), ["first"]);
assert.deepEqual(ols[1].children.map((li) => li.textContent), ["second", "third"]);
assert.deepEqual(ols[2].children.map((li) => li.textContent), ["fourth"]);
assert.equal(split.children.find((n) => n.tag === "p").textContent, "Intro");
const fromThree = ctx.renderReadable("3. third item\n4. fourth item");
const started = fromThree.children.find((n) => n.tag === "ol");
assert.equal(started.attrs.start, "3");
assert.deepEqual(started.children.map((li) => li.textContent), ["third item", "fourth item"]);
const flat = texts(root).join(" ");
assert.ok(flat.includes("<b>not html</b>"), "markup is shown as text");
assert.equal(root.children.some((n) => n.tag === "b" || n.tag === "script"), false);
const long = "word ".repeat(80);
const post = ctx.renderReadable(long);
const shown = texts(post).join("");
assert.equal(shown.includes(long.trim()), true);
assert.ok(shown.length > 280, "a long post is not cut");
console.log("ok card text");
