// card #1197 — the commander's board taps. Measured 2026-10-16: five
// "extend, flip, or kill?" rows closed PASS on a fixed yes with no choice,
// and each answer went commander -> commander with no reply_to.
// Fetch is stubbed; nothing is sent. Run: node test_1197_commander_taps.mjs
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

// ---- minimal fake DOM (same shape as test_board_drafts) ----
function makeEl(tag) {
  const el = {
    tag, children: [], listeners: {},
    className: "", textContent: "", value: "", checked: false,
    type: "", rows: 0, placeholder: "", name: "",
    classList: {
      toggle(c) {
        const has = el.className.split(/\s+/).includes(c);
        el.className = has
          ? el.className.split(/\s+/).filter((x) => x !== c).join(" ")
          : (el.className + " " + c).trim();
        return !has;
      },
    },
    appendChild(c) { el.children.push(c); c.parentElement = el; return c; },
    append(...cs) { for (const c of cs) el.appendChild(c); },
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
const find = (row, pred) => {
  const out = [];
  (function walk(n) {
    for (const c of n.children || []) { if (pred(c)) out.push(c); walk(c); }
  })(row);
  return out;
};
const inputsOf = (row) => find(row, (c) => c.tag === "input");
const btnOf = (row) => find(row, (c) => c.tag === "button" && (c.className || "").includes("btn-primary"))[0];
const errOf = (row) => row.querySelector(".board-send-err");
const flush = () => new Promise((r) => setImmediate(r));

const apiSendSrc = src.slice(src.indexOf("const apiSend ="), src.indexOf("const apiSchedEvents"));
const draftsDecl = src.slice(src.indexOf("const _boardDrafts"), src.indexOf("function _boardQuestion("));
const frictionDecls = src.slice(src.indexOf("const _FRICTION_YES"), src.indexOf("async function boardAskMessage"));
const closeCallDecl = src.slice(src.indexOf("const apiBoardObligationClose ="),
  src.indexOf("});", src.indexOf("const apiBoardObligationClose =")) + 3);

// askFor: obligation id -> lab's bound ask in the card thread (or absent).
function makeCtx({ askFor = {} } = {}) {
  const calls = [];
  const ctx = {
    calls,
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
        return { ok: true, status: 200, statusText: "OK", json: async () => ({
          messages: Object.entries(askFor).map(([oid, id]) => ({
            id, from_node: "lab-ovh", to_node: "commander",
            content: "OFFERED", obligation_id: Number(oid) })) }) };
      return { ok: true, status: 200, statusText: "OK", json: async () => ({ id: 77 }) };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(
    `async function api(path, opts = {}) { return (await fetch(state.base + path, opts)).json(); }\n` +
    `${apiSendSrc}\n${frictionDecls}\n${closeCallDecl}\n${draftsDecl}\n` +
    `${extract("_cellEyebrow")}\n${extract("boardDraftKey")}\n` +
    `${extract("boardDraftSave")}\n${extract("boardObligationId")}\n` +
    `${extract("boardRowLabel")}\n${extract("boardTapClosable")}\n` +
    `${extract("boardFrictionReply")}\n${extract("boardFrictionTap")}\n` +
    `${extract("boardAskMessage")}\n${extract("sendBoardDecision")}\n` +
    `${extract("sendBoardDecisionAndClose")}\n${extract("sendFrictionReply")}\n` +
    `${extract("rememberBoardSent")}\n${extract("fmtTime")}\n` +
    `${extract("boardSentText")}\n${extract("deliverBoardDecision")}\n` +
    `${extract("deliverFrictionReply")}\n${extract("_boardQuestion")}\n`,
    ctx);
  return ctx;
}

const sess = { name: "science-claude" };
// A commander-held, step-less row as the board API returns it.
const row897 = { id: 897, card_id: 897, step: null, holder: "commander",
  created_by: "science-claude", accept: "[commander] trial #897 ...: extend, flip, or kill?" };
// What publish_board now emits for it (card #1197): one option per choice,
// addressed to the row's creator.
const choiceQ = (extra = {}) => ({
  id: "obl-897", title: "trial #897 extended past its first due: extend, flip, or kill?",
  to: "science-claude", to_node: "science-claude", card: 897, obligation: 897,
  row: row897,
  options: [
    { label: "Extend", text: "extend", rec: false, outcome: "pass" },
    { label: "Flip", text: "flip", rec: false, outcome: "pass" },
    { label: "Kill", text: "kill", rec: false, outcome: "pass" },
  ],
  ...extra,
});

const failures = [];
async function check(name, fn) {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (e) { failures.push(name); console.log(`FAIL ${name}\n     ${e.message.split("\n")[0]}`); }
}

await check("a choice tap closes its row PASS and the evidence quotes the choice", async () => {
  const ctx = makeCtx();
  const card = ctx._boardQuestion(choiceQ(), sess);
  const inputs = inputsOf(card);
  assert.equal(inputs.length, 3, "one radio per choice");
  inputs[0].checked = false; inputs[1].checked = true; inputs[1].fire("change");
  ctx.calls.length = 0;
  btnOf(card).fire("click");
  await flush(); await flush();
  assert.equal(errOf(card).textContent, "",
    `RED: a stamped choice must not be display-only (got "${errOf(card).textContent}")`);
  const send = ctx.calls.find((c) => c.url.endsWith("/messages"));
  const close = ctx.calls.find((c) => c.url.endsWith("/close"));
  assert.ok(send, "RED: the choice is sent");
  assert.equal(JSON.parse(send.body).content, "flip");
  assert.equal(JSON.parse(send.body).to_node, "science-claude", "answers the asking cell");
  assert.ok(close, "RED: the choice closes the bound row");
  assert.equal(close.url, "http://stub.invalid/board/obligations/897/close");
  const body = JSON.parse(close.body);
  assert.equal(body.outcome, "pass");
  assert.ok(body.evidence.includes("flip"), "the close evidence quotes the chosen option");
  assert.ok(!body.evidence.includes("yes"), "no yes stands in for the choice");
});

await check("a choice tap with a note keeps the choice first and still closes", async () => {
  const ctx = makeCtx();
  const card = ctx._boardQuestion(choiceQ({ id: "obl-897n" }), sess);
  find(card, (c) => c.tag === "textarea")[0].value = "two more weeks";
  ctx.calls.length = 0;
  btnOf(card).fire("click");
  await flush(); await flush();
  const close = ctx.calls.find((c) => c.url.endsWith("/close"));
  assert.ok(close, "RED: a choice with a note closes too");
  const ev = JSON.parse(close.body).evidence;
  assert.ok(ev.includes("extend\ntwo more weeks"), `evidence quotes the choice and note: ${ev}`);
});

await check("a self-addressed answer is refused with a visible error; the bound relay is unchanged", async () => {
  const ctx = makeCtx({ askFor: { 291: 55 } });
  // What the defect shipped: a commander-held row addressed to the commander.
  const selfQ = { id: "obl-290", title: "Close it?", to_node: "commander", card: 7,
    obligation: 290, row: { id: 290, card_id: 7, step: "build", holder: "commander" },
    options: [{ label: "Yes", text: "yes", outcome: "pass" }, { label: "No", text: "no", outcome: "fail" }] };
  const card = ctx._boardQuestion(selfQ, { name: "lab-ovh" });
  ctx.calls.length = 0;
  btnOf(card).fire("click");
  await flush(); await flush();
  assert.equal(ctx.calls.filter((c) => c.method === "POST").length, 0,
    "RED: nothing is sent or closed when the answer would go to the viewer");
  assert.match(errOf(card).textContent, /would go to you/, "the refusal is shown on the row");
  assert.equal(btnOf(card).disabled, false, "the row stays answerable");
  // Control: lab's bound ask for the row still wins the address (reply_to kept).
  const boundQ = { ...selfQ, id: "obl-291", obligation: 291,
    row: { id: 291, card_id: 7, step: "build", holder: "commander" } };
  const bound = ctx._boardQuestion(boundQ, { name: "lab-ovh" });
  ctx.calls.length = 0;
  btnOf(bound).fire("click");
  await flush(); await flush();
  const send = JSON.parse(ctx.calls.find((c) => c.url.endsWith("/messages")).body);
  assert.equal(send.to_node, "lab-ovh");
  assert.equal(send.reply_to, 55);
  assert.equal(send.content, "yes");
});

await check("an empty recipient is refused before any send", async () => {
  const ctx = makeCtx();
  ctx.calls.length = 0;
  await assert.rejects(ctx.sendBoardDecision({ title: "Ship?", to_node: "" }, "yes"),
    /no recipient/, "RED: an empty to_node must refuse");
  await assert.rejects(ctx.sendBoardDecision({ title: "Ship?" }, "yes"), /no recipient/);
  assert.equal(ctx.calls.length, 0, "nothing was posted");
});

if (failures.length) {
  console.log(`1197 commander tap tests: ${failures.length} failed`);
  process.exit(1);
}
console.log("1197 commander tap tests: all passed");
