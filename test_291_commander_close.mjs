// card #291 / obligation #1115 — the commander's app tap closes under the
// gateway's SSO-as-commander + relay rule: answers post in-thread, friction
// yes/no sends bare, and the close evidence cites the decision DM.
// Run: node test_291_commander_close.mjs
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const src = readFileSync(new URL("./app.js", import.meta.url), "utf8");

const START = "// ---------- commander relay close (#291) ----------";
const END = "// ---------- end commander relay close (#291) ----------";
assert.ok(src.includes(START), "RED: #291 block missing in app.js");
assert.ok(src.includes(END), "RED: #291 block end marker missing in app.js");

function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `RED: ${name}() not found`);
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
const block = src.slice(src.indexOf(START), src.indexOf(END));
const apiSendSrc = src.slice(src.indexOf("const apiSend ="), src.indexOf("const apiSchedEvents"));
// CLOSE block (#983) for sendBoardDecisionAndClose + boardObligationId.
const CSTART = "// ---------- board close (#983) ----------";
const CEND = "// ---------- end board close (#983) ----------";
const closeBlock = src.slice(src.indexOf(CSTART), src.indexOf(CEND));

const ctx = {
  state: { token: "tok", base: "http://stub.invalid" },
  ssoActive: false,
  COMMANDER: "commander",
  selfNode() { return "commander"; },
  calls: [],
  fetch: async (url, opts) => {
    ctx.calls.push({ url: String(url), method: (opts && opts.method) || "GET",
      body: opts && opts.body });
    const u = String(url);
    if (u.includes("/board/obligations/") && u.endsWith("/close"))
      return { ok: true, status: 200, statusText: "OK",
        json: async () => ({ status: "closed", closed_by: "commander" }) };
    if (u.includes("/thread?"))
      return { ok: true, status: 200, statusText: "OK", json: async () => ({ messages: [
        { id: 54, from_node: "lab-ovh", to_node: "commander",
          content: "some other row's ask", obligation_id: 999 },
        { id: 55, from_node: "lab-ovh", to_node: "commander",
          content: "Redo obligation #999?", obligation_id: 291 },
      ] }) };
    if (u.includes("/board/obligations"))
      return { ok: true, status: 200, statusText: "OK", json: async () => ({ obligations: [
        { id: 291, card_id: 7, step: "build", accept: "PASS = ref lands",
          holder: "commander", status: "open" },
      ] }) };
    return { ok: true, status: 200, statusText: "OK", json: async () => ({ id: 291 }) };
  },
};
vm.createContext(ctx);
vm.runInContext(
  `async function api(path, opts = {}) {\n` +
  `  const url = state.base.replace(/\\/$/, "") + path;\n` +
  `  const headers = { Authorization: "Bearer " + state.token };\n` +
  `  if (opts.body) headers["Content-Type"] = "application/json";\n` +
  `  const res = await fetch(url, { ...opts, headers });\n` +
  `  if (!res.ok) throw new Error(res.status + " " + res.statusText);\n` +
  `  return res.json();\n}\n${apiSendSrc}\n${extract("sendBoardDecision")}\n${closeBlock}\n${block}`,
  ctx);

// 1. friction detection: bare yes/no options resolve; anything else is null.
const friction = ctx.boardFrictionReply({
  options: [{ label: "Yes", text: "yes" }, { label: "No", text: "no" }],
});
assert.equal(friction.yes, "yes");
assert.equal(friction.no, "no");
assert.equal(ctx.boardFrictionReply({
  options: [{ label: "Ship", text: "Yes, ship", rec: true }, { label: "Hold", text: "Not yet" }],
}), null, "prose options are not friction");
assert.equal(ctx.boardFrictionReply({ options: [{ label: "Go", text: "go" }] }), null);
assert.equal(ctx.boardFrictionReply(null), null);

// 2. unbound question: the bare word, thread kept, no reply_to key.
ctx.calls.length = 0;
await ctx.sendBoardDecision(
  { title: "Close it?", to_node: "lab-ovh", thread: "ask-thread-uuid-1" }, "yes");
assert.equal(ctx.calls.length, 1);
assert.equal(JSON.parse(ctx.calls[0].body).content, "yes");
assert.equal(JSON.parse(ctx.calls[0].body).thread_id, "ask-thread-uuid-1",
  "RED: answer must post in the ask thread");
assert.equal(JSON.parse(ctx.calls[0].body).reply_to, undefined,
  "RED: no bound ask, no reply_to");

// 3. unthreaded question: no thread_id key (older gateway shape unchanged).
ctx.calls.length = 0;
await ctx.sendBoardDecision({ title: "Ship?", to_node: "lab-ovh" }, "Yes, ship");
assert.equal(JSON.parse(ctx.calls[0].body).thread_id, undefined);

// 4. tap close: the ask is looked up structurally, the tap sends ONLY the
// word with reply_to, and the close cites the just-sent DM.
ctx.calls.length = 0;
const r = await ctx.sendBoardDecisionAndClose(
  { id: "obl-291", title: "Close it?", to_node: "commander", card: 7,
    thread: "ask-thread-uuid-1", obligation: 291 }, "yes");
assert.equal(r.closed.status, "closed");
assert.equal(ctx.calls.length, 3, "ask lookup + send + close");
const sentBody = JSON.parse(ctx.calls[1].body);
assert.equal(sentBody.content, "yes",
  "RED: the tap sends ONLY the word — no Re: line, no row id in prose");
assert.equal(sentBody.to_node, "lab-ovh",
  "RED: the tap answers the ask sender, never 'commander'");
assert.equal(sentBody.reply_to, 55,
  "RED: reply_to names lab's ask for the row (found by obligation_id, " +
  "even though the ask prose names row #999)");
assert.equal(sentBody.thread_id, "ask-thread-uuid-1");
const closeBody = JSON.parse(ctx.calls[2].body);
assert.ok(closeBody.evidence.includes("yes"), "evidence quotes the answer");
assert.ok(!closeBody.evidence.includes("Re:"),
  "RED: evidence quotes the bare word, no Re: line");
assert.ok(closeBody.evidence.includes("ask:55"),
  "RED: evidence cites the bound ask id (the direct-close ref)");
assert.ok(closeBody.evidence.includes("relayed-from=msg:291"),
  "RED: evidence must cite the decision DM for the relay arm");

// 5. friction tap helper sends the bare word in-thread and closes citing it.
ctx.calls.length = 0;
const f = await ctx.sendFrictionReply(
  { id: "obl-291", title: "Close it?", to_node: "commander", card: 7,
    thread: "ask-thread-uuid-1", obligation: 291,
    options: [{ label: "Yes", text: "yes" }, { label: "No", text: "no" }] }, "yes");
assert.equal(JSON.parse(ctx.calls[1].body).content, "yes");
assert.equal(JSON.parse(ctx.calls[1].body).to_node, "lab-ovh",
  "RED: the friction tap answers the ask sender");
assert.equal(JSON.parse(ctx.calls[1].body).reply_to, 55);
assert.equal(JSON.parse(ctx.calls[1].body).thread_id, "ask-thread-uuid-1");
assert.ok(JSON.parse(ctx.calls[2].body).evidence.includes("relayed-from=msg:291"));

// 5b. ruling_1116_core (6): a 'no' tap closes fail, still citing the DM.
ctx.calls.length = 0;
await ctx.sendFrictionReply(
  { id: "obl-291", title: "Close it?", to_node: "commander", card: 7,
    thread: "ask-thread-uuid-1", obligation: 291,
    options: [{ label: "Yes", text: "yes" }, { label: "No", text: "no" }] }, "no");
assert.equal(JSON.parse(ctx.calls[1].body).content, "no",
  "RED: a no tap sends ONLY the word");
assert.equal(JSON.parse(ctx.calls[1].body).reply_to, 55);
const noClose = JSON.parse(ctx.calls[2].body);
assert.equal(noClose.outcome, "fail", "RED: a no tap must close fail");
assert.ok(noClose.evidence.includes("relayed-from=msg:291"));

// 5c. ruling_1138_structured: a question with no row sends the bare word
// with no reply_to (the gateway will refuse to bind it — it answers no ask).
ctx.calls.length = 0;
await ctx.sendBoardDecision({ title: "Ship?", to_node: "lab-ovh" }, "yes");
assert.equal(JSON.parse(ctx.calls[0].body).content, "yes");
assert.equal(JSON.parse(ctx.calls[0].body).reply_to, undefined);

console.log("291 commander-close app tests: all passed");

assert.equal(typeof ctx.boardFrictionTap, "function",
  "RED: boardFrictionTap missing on base");

// 6. tap routing: the picked option's side, null off-path.
const fq = { options: [{ label: "Yes", text: "yes" }, { label: "No", text: "no" }] };
assert.equal(ctx.boardFrictionTap(fq, "yes", ""), "yes");
assert.equal(ctx.boardFrictionTap(fq, "no", ""), "no");
assert.equal(ctx.boardFrictionTap(fq, "yes", "plus a note"), null,
  "a note breaks the bare word: normal path");
assert.equal(ctx.boardFrictionTap({
  options: [{ label: "Ship", text: "Yes, ship" }, { label: "Hold", text: "nope" }],
}, "Yes, ship", ""), null, "prose pair takes the normal path");

// 7. the You tab Send for a friction tap invokes the friction helper and
// keeps the Sent bookkeeping (RED: deliverFrictionReply missing on base).
const store = {};
const fctx = {
  state: { token: "tok", base: "http://stub.invalid" },
  selfNode() { return "commander"; },
  calls: [],
  helperCalls: [],
  localStorage: {
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
  },
  fetch: async (url, opts) => {
    fctx.calls.push({ url: String(url), body: opts && opts.body });
    const u = String(url);
    if (u.includes("/board/obligations/") && u.endsWith("/close"))
      return { ok: true, status: 200, statusText: "OK",
        json: async () => ({ status: "closed" }) };
    if (u.includes("/thread?"))
      return { ok: true, status: 200, statusText: "OK", json: async () => ({ messages: [
        { id: 55, from_node: "lab-ovh", to_node: "commander",
          content: "OFFERED — build", obligation_id: 291 },
      ] }) };
    return { ok: true, status: 200, statusText: "OK", json: async () => ({ id: 291 }) };
  },
};
vm.createContext(fctx);
const apiSendSrc2 = src.slice(src.indexOf("const apiSend ="), src.indexOf("const apiSchedEvents"));
const draftsDecl = src.slice(src.indexOf("const _boardDrafts"), src.indexOf("function _boardQuestion("));
vm.runInContext(
  `async function api(path, opts = {}) {\n` +
  `  const url = state.base.replace(/\\/$/, "") + path;\n` +
  `  const headers = { Authorization: "Bearer " + state.token };\n` +
  `  if (opts.body) headers["Content-Type"] = "application/json";\n` +
  `  const res = await fetch(url, { ...opts, headers });\n` +
  `  if (!res.ok) throw new Error(res.status + " " + res.statusText);\n` +
  `  return res.json();\n}\n${apiSendSrc2}\n${extract("sendBoardDecision")}\n${closeBlock}\n${block}\n` +
  `${extract("boardSentRecord")}\n${extract("rememberBoardSent")}\n` +
  `${extract("boardSentText")}\n${extract("fmtTime")}\n` +
  `${draftsDecl}\n${extract("boardDraftKey")}\n`,
  fctx);
vm.runInContext(
  `const __origFriction = sendFrictionReply;\n` +
  `sendFrictionReply = async (...a) => { helperCalls.push(a); return __origFriction(...a); };`,
  fctx);
const ferr = { textContent: "" };
const fbutton = {
  disabled: false,
  textContent: "Send decision",
  parentElement: { querySelector() { return ferr; } },
};
await vm.runInContext(
  `deliverFrictionReply(${JSON.stringify(null)}, null, null, null).catch(() => {})`,
  fctx).catch(() => {});
await fctx.deliverFrictionReply(fbutton, {
  id: "obl-291", title: "Close it?", to_node: "commander", card: 7,
  thread: "ask-thread-uuid-1", obligation: 291,
  options: [{ label: "Yes", text: "yes" }, { label: "No", text: "no" }],
}, "yes", "Yes");
assert.equal(fctx.helperCalls.length, 1, "RED: the tab must call the friction helper");
assert.deepEqual(fctx.helperCalls[0][1], "yes");
assert.equal(fbutton.disabled, true);
assert.match(fbutton.textContent, /^Sent: Yes · \d+s ago$/);
assert.ok(JSON.parse(fctx.calls[2].body).evidence.includes("ask:55"),
  "RED: the tab close cites the bound ask");
assert.equal(JSON.parse(fctx.calls[1].body).content, "yes",
  "RED: the tab tap sends ONLY the word");
assert.equal(JSON.parse(fctx.calls[1].body).reply_to, 55,
  "RED: the tab tap sets reply_to to lab's ask");
assert.equal(JSON.parse(fctx.calls[1].body).thread_id, "ask-thread-uuid-1");
assert.ok(JSON.parse(fctx.calls[2].body).evidence.includes("relayed-from=msg:291"));

console.log("291 friction tap tests: all passed");

// 8. ruling_1138_structured (6): the You tab shows the bound row's board
// fields — never the ask prose.
assert.equal(typeof ctx.boardRowLabel, "function",
  "RED: boardRowLabel missing");
assert.equal(typeof ctx.boardBoundRow, "function", "RED: boardBoundRow missing");
assert.equal(typeof ctx.attachBoundRows, "function",
  "RED: attachBoundRows missing");
const rowLabel = ctx.boardRowLabel({
  id: 291, card_id: 7, step: "build", accept: "PASS = ref lands",
  holder: "commander" });
assert.ok(rowLabel.includes("obligation #291"), "row id shown");
assert.ok(rowLabel.includes("card #7"), "card shown");
assert.ok(rowLabel.includes("build"), "step shown");
assert.ok(rowLabel.includes("PASS = ref lands"), "accept shown");
assert.ok(rowLabel.includes("@commander"), "holder shown");
assert.equal(ctx.boardRowLabel(null), "");

// boardBoundRow resolves the row structurally by obligation id.
const boundRow = await ctx.boardBoundRow({ card: 7, obligation: 291 });
assert.equal(boundRow.id, 291);
assert.equal(boundRow.step, "build");
assert.equal(await ctx.boardBoundRow({ card: 7, obligation: 12345 }), null,
  "no row for an unknown obligation");
assert.equal(await ctx.boardBoundRow({ title: "Ship?" }), null,
  "no fetch without an obligation");

// attachBoundRows pins each ask to its row; other messages pass through.
const askMsg = { id: 55, kind: "question", from_node: "lab-ovh",
  content: "OFFERED — build on card 7, obligation #291",
  obligation_id: 291 };
const otherMsg = { id: 56, kind: "question", from_node: "lab-ovh",
  content: "plain question" };
ctx.attachBoundRows([askMsg, otherMsg], [
  { id: 291, card_id: 7, step: "build", accept: "PASS = ref lands",
    holder: "commander" }]);
assert.equal(askMsg.row.id, 291, "RED: the ask carries its bound row");
assert.equal(otherMsg.row, undefined, "a prose question binds to no row");
assert.ok(!JSON.stringify(askMsg.row).includes("OFFERED"),
  "the bound row is board fields, never the ask prose");

console.log("291 bound-row app tests: all passed");

// 9. ruling_1142 (2): the ask resolves with its sender; an unbound tap
// cites no ask.
const tapAsk = await ctx.boardAskMessage(7, 291);
assert.equal(tapAsk.id, 55, "RED: boardAskMessage resolves the ask");
assert.equal(tapAsk.from_node, "lab-ovh", "RED: the tap answers this sender");
assert.equal(await ctx.boardAskMessage(7, 12345), null);
assert.equal(await ctx.boardAskMessage(null, 291), null);
ctx.calls.length = 0;
const unbound = await ctx.sendBoardDecisionAndClose(
  { id: "obl-9", title: "Hold?", to_node: "commander",
    thread: "ask-thread-uuid-9", obligation: 999 }, "yes");
assert.equal(unbound.closed.status, "closed");
assert.equal(ctx.calls.length, 2, "no ask lookup without a card: send + close");
assert.equal(JSON.parse(ctx.calls[0].body).reply_to, undefined);
assert.ok(!JSON.parse(ctx.calls[1].body).evidence.includes("ask:"),
  "RED: an unbound tap cites no ask");
assert.equal(JSON.parse(ctx.calls[0].body).to_node, "commander",
  "no ask sender known: the older address shape is untouched");

// 10. ruling_1142 (4): refreshActions resolves each tap card's row via
// boardBoundRow on the single poll fetch.
{
  const board = { sessions: [{ name: "lab-ovh", questions: [
    { id: "obl-291", title: "Close it?", to_node: "commander", card: 7,
      obligation: 291,
      options: [{ label: "Yes", text: "yes" }, { label: "No", text: "no" }] },
    { id: "obl-999", title: "Ghost?", to_node: "commander", card: 7,
      obligation: 999,
      options: [{ label: "Yes", text: "yes" }, { label: "No", text: "no" }] },
  ] }] };
  const rctx = {
    state: { token: "tok", base: "http://stub.invalid" },
    selfNode() { return "commander"; },
    setStatus() {},
    renders: 0,
    renderActions() { rctx.renders++; },
    newestBoardDm: () => ({ content: "board" }),
    parseBoardDm: () => board,
    dedupeYou: (g) => g,
    _CLOSED_STAGES: new Set(["done", "parked"]),
    fetch: async (url, opts) => {
      const u = String(url);
      if (u.includes("/board/obligations"))
        return { ok: true, status: 200, statusText: "OK",
          json: async () => ({ obligations: [
            { id: 291, card_id: 7, step: "build", accept: "PASS = ref lands",
              holder: "commander", status: "open" },
          ] }) };
      if (u.includes("/thread?"))
        return { ok: true, status: 200, statusText: "OK",
          json: async () => ({ messages: [
            { id: 55, from_node: "lab-ovh", to_node: "commander",
              content: "OFFERED", obligation_id: 291 },
          ] }) };
      return { ok: true, status: 200, statusText: "OK",
        json: async () => ({ messages: [], cards: [] }) };
    },
  };
  vm.createContext(rctx);
  vm.runInContext(
    `async function api(path, opts = {}) { return (await fetch(state.base + path, opts)).json(); }
` +
    `let _you = null;\nlet _youSig = null;\n` +
    `function renderYou() { if (!_you) return; renderActions({}); }\n` +
    `${apiSendSrc}\n${extract("boardObligationId")}\n` +
    `${extract("boardAskMessage")}\n` +
    `${extract("boardBoundRow")}\n${extract("attachBoundRows")}\n` +
    `${extract("refreshActions")}`,
    rctx);
  await rctx.refreshActions(true);
  const qs = board.sessions[0].questions;
  assert.ok(qs[0].row,
    "RED: the tap card carries its bound row (boardBoundRow used)");
  assert.equal(qs[0].row.id, 291);
  assert.equal(qs[0].row.step, "build");
  assert.equal(qs[1].row, null,
    "RED: a row that cannot be fetched leaves no row (no buttons, never prose)");
}

console.log("291 tap-card app tests: all passed");
