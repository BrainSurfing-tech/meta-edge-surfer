// Card #1007, obligation #861 (2): a send re-renders EVERY row, and the
// 30 s poll re-renders on new data. Drafts (picked option, typed note, open
// note) in other questions must survive. Fetch is stubbed; nothing is sent.
// Run: node test_board_drafts.mjs   (exit 0 = pass)
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

// ---- minimal fake DOM: createElement + tree + three query shapes ----
function makeEl(tag, doc) {
  const el = {
    tag, children: [], listeners: {},
    className: "", textContent: "", value: "", checked: false,
    type: "", rows: 0, placeholder: "", name: "", _hidden: false,
    classList: {
      toggle(c) {
        const has = el.className.split(/\s+/).includes(c);
        el.className = has
          ? el.className.split(/\s+/).filter((x) => x !== c).join(" ")
          : (el.className + " " + c).trim();
        return !has;
      },
    },
    appendChild(c) { el.children.push(c); return c; },
    append(...cs) { el.children.push(...cs); },
    addEventListener(ev, fn) { (el.listeners[ev] = el.listeners[ev] || []).push(fn); },
    fire(ev) { (el.listeners[ev] || []).forEach((fn) => fn()); },
    focus() {},
    querySelector(sel) {
      const walk = (n) => {
        for (const c of n.children || []) {
          if (sel === "input:checked" && c.tag === "input" && c.checked) return c;
          if (sel === ".board-send-err" && (c.className || "").includes("board-send-err")) return c;
          const f = walk(c);
          if (f) return f;
        }
        return null;
      };
      return walk(el);
    },
  };
  return el;
}

const sess = { name: "science-claude" };
const q1 = {
  id: "obl-1", title: "Ship?", to_node: "science-claude",
  options: [
    { label: "Ship", text: "Yes, ship", rec: true },
    { label: "Hold", text: "Not yet", rec: false },
  ],
};
const q2 = {
  id: "obl-2", title: "Deploy?", to_node: "science-claude",
  options: [{ label: "Go", text: "go", rec: true }],
};

const draftsDecl = src.slice(src.indexOf("const _boardDrafts"), src.indexOf("function _boardQuestion("));
const ctx = {
  document: { createElement: (tag) => makeEl(tag) },
  localStorage: { _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = v; } },
};
vm.createContext(ctx);
vm.runInContext(
  `${draftsDecl}\n${extract("_cellEyebrow")}\n${extract("boardDraftKey")}\n` +
  `${extract("boardDraftSave")}\n${extract("_boardQuestion")}\n`,
  ctx);

// First render: defaults (rec Ship checked, note hidden+empty).
const row1 = ctx._boardQuestion(q1, sess);
const checked1 = row1.querySelector("input:checked");
assert.ok(checked1, "a radio is checked by default");
assert.equal(checked1.value, "0", "Recommended Ship checked by default");

// User picks Hold, types a note, opens the note box.
const hold = [];
(function collect(n) {
  for (const c of n.children || []) {
    if (c.tag === "input") hold.push(c);
    collect(c);
  }
})(row1);
hold[1].checked = true;
hold[0].checked = false;
hold[1].fire("change");
const boxOf = (row) => {
  let found = null;
  (function walk(n) {
    for (const c of n.children || []) {
      if (c.tag === "textarea") found = c;
      walk(c);
    }
  })(row);
  return found;
};
const noteBtnOf = (row) => {
  let found = null;
  (function walk(n) {
    for (const c of n.children || []) {
      if (c.tag === "button" && (c.className || "").includes("btn-link")) found = c;
      walk(c);
    }
  })(row);
  return found;
};
const box1 = boxOf(row1);
box1.value = "after freeze";
box1.fire("input");
noteBtnOf(row1).fire("click");

// Re-render (what deliverBoardDecision -> renderYou does to every row).
const row1b = ctx._boardQuestion(q1, sess);
assert.equal(row1b.querySelector("input:checked").value, "1", "picked Hold survives re-render");
assert.equal(boxOf(row1b).value, "after freeze", "typed note survives re-render");
assert.ok(!boxOf(row1b).className.split(/\s+/).includes("hidden"), "open note stays open");
assert.equal(noteBtnOf(row1b).textContent, "Hide note", "note button follows draft");

// Untouched question keeps defaults.
const row2 = ctx._boardQuestion(q2, sess);
assert.equal(row2.querySelector("input:checked").value, "0", "other question unaffected");

console.log("board drafts tests: 4 passed");
