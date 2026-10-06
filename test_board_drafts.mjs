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
  let from = start;
  if (src.slice(Math.max(0, start - 6), start) === "async ") from = start - 6;
  return src.slice(from, end);
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
const apiSendSrc = src.slice(src.indexOf("const apiSend ="), src.indexOf("const apiSchedEvents"));
const frictionDecls = src.slice(src.indexOf("const _FRICTION_YES"), src.indexOf("async function boardAskMessage"));
const closeCallDecl = src.slice(src.indexOf("const apiBoardObligationClose ="),
  src.indexOf("});", src.indexOf("const apiBoardObligationClose =")) + 3);
// Fail-first shim: on a base without boardTapClosable every bound row reads
// tap-closable, so the branch tests below RUN there and fail on their RED
// assertions (buttons shown, prose sent) instead of failing at load.
const tapClosableDecl = src.includes("function boardTapClosable(")
  ? extract("boardTapClosable")
  : "function boardTapClosable(row) { return !!row; }";
const calls = [];
const ctx = {
  document: { createElement: (tag) => makeEl(tag) },
  localStorage: { _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = v; } },
  state: { token: "tok", base: "http://stub.invalid" },
  selfNode() { return "commander"; },
  fetch: async (url, opts) => {
    calls.push({ url: String(url), method: (opts && opts.method) || "GET",
      body: opts && opts.body });
    const u = String(url);
    if (u.includes("/board/obligations/") && u.endsWith("/close"))
      return { ok: true, status: 200, statusText: "OK",
        json: async () => ({ status: "closed" }) };
    if (u.includes("/thread?"))
      return { ok: true, status: 200, statusText: "OK", json: async () => ({ messages: [
        { id: 55, from_node: "lab-ovh", to_node: "commander",
          content: "OFFERED", obligation_id: 291 },
      ] }) };
    if (u.includes("/board/obligations"))
      return { ok: true, status: 200, statusText: "OK",
        json: async () => ({ obligations: [] }) };
    return { ok: true, status: 200, statusText: "OK", json: async () => ({ id: 77 }) };
  },
};
vm.createContext(ctx);
vm.runInContext(
  `async function api(path, opts = {}) { return (await fetch(state.base + path, opts)).json(); }\n` +
  `${apiSendSrc}\n${frictionDecls}\n${closeCallDecl}\n${draftsDecl}\n` +
  `${extract("_cellEyebrow")}\n${extract("boardDraftKey")}\n` +
  `${extract("boardDraftSave")}\n${extract("boardObligationId")}\n` +
  `${extract("boardRowLabel")}\n${tapClosableDecl}\n` +
  `${extract("boardFrictionReply")}\n${extract("boardFrictionTap")}\n` +
  `${extract("boardAskMessage")}\n${extract("sendBoardDecision")}\n` +
  `${extract("sendBoardDecisionAndClose")}\n${extract("sendFrictionReply")}\n` +
  `${extract("rememberBoardSent")}\n${extract("fmtTime")}\n` +
  `${extract("boardSentText")}\n${extract("deliverBoardDecision")}\n` +
  `${extract("deliverFrictionReply")}\n${extract("_boardQuestion")}\n`,
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

// ---- ruling_1157 (1): tap-closable card branches ----
const textsOf = (row) => {
  const out = [];
  (function walk(n) {
    for (const c of n.children || []) {
      if (c.textContent) out.push(c.textContent);
      walk(c);
    }
  })(row);
  return out;
};
const hasClass = (row, cls) => {
  let found = false;
  (function walk(n) {
    for (const c of n.children || []) {
      if ((c.className || "").split(/\s+/).includes(cls)) found = true;
      walk(c);
    }
  })(row);
  return found;
};
const btnOf = (row) => {
  let found = null;
  (function walk(n) {
    for (const c of n.children || []) {
      if (c.tag === "button" && (c.className || "").includes("btn-primary")) found = c;
      walk(c);
    }
  })(row);
  return found;
};
const inputsOf = (row) => {
  const out = [];
  (function walk(n) {
    for (const c of n.children || []) {
      if (c.tag === "input") out.push(c);
      walk(c);
    }
  })(row);
  return out;
};
const flush = () => new Promise((r) => setImmediate(r));
const labSess = { name: "lab-ovh" };
const buildRow = { id: 291, card_id: 7, step: "build", accept: "PASS = ref",
  holder: "commander" };
const yesNo = [{ label: "Yes", text: "yes" }, { label: "No", text: "no" }];

// Bound build row: row fields shown, buttons present.
const boundCard = ctx._boardQuestion(
  { id: "obl-291b", title: "OFFERED prose", to_node: "commander", card: 7,
    obligation: 291, row: buildRow, options: yesNo }, labSess);
assert.ok(textsOf(boundCard).some((t) => t.includes("obligation #291")),
  "RED: the tap card shows the bound row's board fields");
assert.ok(!textsOf(boundCard).some((t) => t.includes("OFFERED prose")),
  "RED: no ask prose on the tap card");
assert.ok(hasClass(boundCard, "board-act"), "tap-closable row keeps buttons");

// Validate row: fields + full-form note, NO buttons, options display-only.
const valCard = ctx._boardQuestion(
  { id: "obl-292", title: "Validate?", to_node: "commander", card: 7,
    obligation: 292,
    row: { id: 292, card_id: 7, step: "validate", accept: "a", holder: "commander" },
    options: yesNo }, labSess);
assert.ok(textsOf(valCard).some((t) => t.includes("obligation #292")));
assert.ok(textsOf(valCard).some((t) => t.includes("answer with the full close form")),
  "RED: non-tap-closable rows point at the full close form");
assert.ok(!hasClass(valCard, "board-act"), "RED: no buttons off tap-closable steps");
assert.equal(inputsOf(valCard).length, 0, "RED: options display-only, no inputs");

// Missing row: unavailable, no buttons.
const ghostCard = ctx._boardQuestion(
  { id: "obl-999", title: "Ghost?", to_node: "commander", card: 7,
    obligation: 999, row: null, options: yesNo }, labSess);
assert.ok(textsOf(ghostCard).some((t) => t.includes("row unavailable")));
assert.ok(!hasClass(ghostCard, "board-act"), "RED: no buttons without a row");

console.log("tap card branch tests: 6 passed");

// ---- ruling_1157 (1): explicit outcome mapping, no prose-default pass ----
const notedCard = ctx._boardQuestion(
  { id: "obl-291c", title: "Close it?", to_node: "commander", card: 7,
    obligation: 291, row: buildRow, options: yesNo }, labSess);
const notedInputs = inputsOf(notedCard);
notedInputs[1].checked = true;
notedInputs[0].checked = false;
notedInputs[1].fire("change");
boxOf(notedCard).value = "after hours";
calls.length = 0;
btnOf(notedCard).fire("click");
await flush();
const notedSend = calls.find((c) => String(c.url).endsWith("/messages"));
const notedClose = calls.find((c) => String(c.url).endsWith("/close"));
assert.ok(notedSend, "the noted tap sends");
assert.equal(JSON.parse(notedSend.body).content, "no\nafter hours");
assert.equal(JSON.parse(notedSend.body).to_node, "lab-ovh");
assert.ok(notedClose, "the noted tap closes");
assert.equal(JSON.parse(notedClose.body).outcome, "fail",
  "RED: No + note closes FAIL (the side decides, not the prose default)");
assert.ok(JSON.parse(notedClose.body).evidence.includes("ask:55"));

// Bare Yes tap: friction path, pass.
const bareCard = ctx._boardQuestion(
  { id: "obl-291d", title: "Close it?", to_node: "commander", card: 7,
    obligation: 291, row: buildRow, options: yesNo }, labSess);
calls.length = 0;
btnOf(bareCard).fire("click");
await flush();
const bareSend = calls.find((c) => String(c.url).endsWith("/messages"));
assert.equal(JSON.parse(bareSend.body).content, "yes");
const bareClose = JSON.parse(calls.find((c) => String(c.url).endsWith("/close")).body);
assert.equal(bareClose.outcome, "pass", "RED: Yes closes PASS");

// Prose option on an obligation row: display-only, closes nothing.
const proseCard = ctx._boardQuestion(
  { id: "obl-291e", title: "Close it?", to_node: "commander", card: 7,
    obligation: 291, row: buildRow,
    options: [{ label: "Discuss", text: "let us talk" }] }, labSess);
calls.length = 0;
btnOf(proseCard).fire("click");
await flush();
assert.equal(calls.length, 0, "RED: a prose option closes nothing");
assert.ok(proseCard.querySelector(".board-send-err").textContent.includes("display-only"));

console.log("tap outcome mapping tests: 3 passed");

// Publisher-stamped outcomes (yes=pass, no=fail) map the same way.
const stampedCard = ctx._boardQuestion(
  { id: "obl-291f", title: "Close it?", to_node: "commander", card: 7,
    obligation: 291, row: buildRow,
    options: [{ label: "Yes", text: "yes", outcome: "pass" },
              { label: "No", text: "no", outcome: "fail" }] }, labSess);
const stampedInputs = inputsOf(stampedCard);
stampedInputs[1].checked = true;
stampedInputs[0].checked = false;
stampedInputs[1].fire("change");
calls.length = 0;
btnOf(stampedCard).fire("click");
await flush();
const stampedClose = JSON.parse(calls.find((c) => String(c.url).endsWith("/close")).body);
assert.equal(stampedClose.outcome, "fail",
  "RED: the stamped option maps to its outcome explicitly");

console.log("stamped outcome tests: passed");
