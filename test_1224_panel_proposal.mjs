// card #1224 — a pane panel's proposal shows on the You tab. The panel posts one DM to the
// commander: reply_to = lab's ask for the row, content "panel: <label> on #<row>". The tab
// pre-selects that option and labels its button "confirm: <label> on #<row>". The commander still
// confirms, and the commit path (sendBoardDecisionAndClose) is byte-unchanged. A proposal counts only when it
// is to the commander, from the cell that sent the ask, after the ask, and names a real option exactly.
// Fetch is stubbed; nothing is sent.
// Run: node test_1224_panel_proposal.mjs   (exit 0 = pass)
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
const sha = (s) => createHash("sha256").update(s).digest("hex");

// ---- the commit path is byte-unchanged ----
// Hashes of the text on origin/main before this card (3a81aeca... is sendBoardDecisionAndClose alone).
const CLOSE_START = "// ---------- board close (#983) ----------";
const CLOSE_END = "// ---------- end board close (#983) ----------";
const closeBlock = src.slice(src.indexOf(CLOSE_START), src.indexOf(CLOSE_END));
assert.equal(sha(extract("sendBoardDecisionAndClose")),
  "3a81aeca7cc8ceaa8fec0096d08b972b1e8b1fdb30c30c2a0c59704ff49c7f17",
  "RED: sendBoardDecisionAndClose changed");
assert.equal(sha(closeBlock),
  "edd26b1defd02a11190468df404002b9511cf98511f2314b93ed31ea5d760ea6",
  "RED: the board close (#983) block changed");

// ---- minimal fake DOM (same shape as test_board_drafts.mjs) ----
function makeEl(tag) {
  const el = {
    tag, children: [], listeners: {},
    className: "", textContent: "", value: "", checked: false,
    type: "", rows: 0, placeholder: "", name: "",
    classList: { toggle() { return true; } },
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
const all = (row, pred) => {
  const out = [];
  (function walk(n) { for (const c of n.children || []) { if (pred(c)) out.push(c); walk(c); } })(row);
  return out;
};
const radiosOf = (row) => all(row, (c) => c.tag === "input" && c.type === "radio");
const btnOf = (row) => all(row, (c) => c.tag === "button" && (c.className || "").includes("btn-primary"))[0];
const checkedIdx = (row) => radiosOf(row).findIndex((r) => r.checked);
const pick = (row, i) => { radiosOf(row).forEach((r, j) => { r.checked = j === i; }); radiosOf(row)[i].fire("change"); };
const flush = () => new Promise((r) => setImmediate(r));

// ---- the vm: only what the You tab needs ----
const calls = [];
const ASK = { id: 55, from_node: "lab-ovh", to_node: "commander", obligation_id: 291, reply_to: null };
let threadMessages = [ASK];
const ctx = {
  document: { createElement: (tag) => makeEl(tag) },
  localStorage: { _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = v; } },
  state: { token: "tok", base: "http://stub.invalid" },
  selfNode() { return "commander"; },
  fetch: async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, method: (opts && opts.method) || "GET", body: opts && opts.body });
    const ok = (json) => ({ ok: true, status: 200, statusText: "OK", json: async () => json });
    if (u.includes("/thread?")) return ok({ messages: threadMessages });
    if (u.endsWith("/close")) return ok({ status: "closed" });
    if (u.includes("/board/obligations")) return ok({ obligations: [] });
    return ok({ id: 77 });
  },
};
vm.createContext(ctx);
const PSTART = "// ---------- panel proposal (#1224) ----------";
const PEND = "// ---------- end panel proposal (#1224) ----------";
assert.ok(src.includes(PSTART) && src.includes(PEND), "RED: the #1224 block is missing");
const draftsDecl = src.slice(src.indexOf("const _boardDrafts"), src.indexOf("function _boardQuestion("));
const apiSendSrc = src.slice(src.indexOf("const apiSend ="), src.indexOf("const apiSchedEvents"));
const frictionDecls = src.slice(src.indexOf("const _FRICTION_YES"), src.indexOf("async function boardAskMessage"));
const closeCallDecl = src.slice(src.indexOf("const apiBoardObligationClose ="),
  src.indexOf("});", src.indexOf("const apiBoardObligationClose =")) + 3);
vm.runInContext(
  `async function api(path, opts = {}) { return (await fetch(state.base + path, opts)).json(); }\n` +
  `${apiSendSrc}\n${frictionDecls}\n${closeCallDecl}\n${draftsDecl}\n` +
  `${extract("_cellEyebrow")}\n${extract("boardDraftKey")}\n${extract("boardDraftSave")}\n` +
  `${extract("boardObligationId")}\n${extract("boardRowLabel")}\n${extract("boardTapClosable")}\n` +
  `${extract("boardFrictionReply")}\n${extract("boardFrictionTap")}\n` +
  `${extract("boardAskMessage")}\n${extract("sendBoardDecision")}\n` +
  `${extract("sendBoardDecisionAndClose")}\n${extract("sendFrictionReply")}\n` +
  `${extract("rememberBoardSent")}\n${extract("fmtTime")}\n${extract("boardSentText")}\n` +
  `${extract("deliverBoardDecision")}\n${extract("deliverFrictionReply")}\n${extract("_boardQuestion")}\n` +
  `${src.slice(src.indexOf(PSTART), src.indexOf(PEND))}\n`,
  ctx);

// ---- boardPanelProposal: which message is the proposal, and what its label is ----
const CHOICES = [
  { label: "Extend", text: "extend", rec: false, outcome: "pass" },
  { label: "Flip", text: "flip", rec: false, outcome: "pass" },
  { label: "Kill", text: "kill", rec: false, outcome: "pass" },
];
const prop = (id, content, extra = {}) => ({ id, from_node: "lab-ovh", to_node: "commander", kind: "question", reply_to: 55, content, ...extra });
{
  const P = (messages, ask = ASK, options = CHOICES) => ctx.boardPanelProposal(ask, messages, options);
  // The valid case still pre-selects.
  assert.equal(P([prop(60, "panel: Flip on #291")]), "Flip");
  assert.equal(P([prop(60, "panel: Extend on #291"), prop(62, "panel: Kill on #291"), prop(61, "panel: Flip on #291")]),
    "Kill", "the newest proposal wins, whatever the list order");
  assert.equal(P([prop(60, "panel: Flip")]), "Flip", "a proposal with no row marker still reads");
  // A message from any node but the one that asked is ignored.
  assert.equal(P([prop(60, "panel: Flip on #291", { from_node: "drop-on-meta-edge" })]), null, "RED: another from_node is ignored");
  assert.equal(P([prop(60, "panel: Flip on #291", { from_node: "commander" })]), null);
  assert.equal(P([prop(60, "panel: Flip on #291", { from_node: undefined })]), null);
  assert.equal(P([prop(61, "panel: Kill on #291", { from_node: "science-claude" }), prop(60, "panel: Flip on #291")]), "Flip",
    "a newer message from another node does not displace the asker's proposal");
  assert.equal(P([prop(60, "panel: Flip on #291", { from_node: "science-claude" })], { ...ASK, from_node: "science-claude" }), "Flip",
    "the asker is whoever sent THIS ask, not a fixed name");
  // Addressed to the commander, and posted after the ask.
  assert.equal(P([prop(60, "panel: Flip on #291", { to_node: "lab-ovh" })]), null);
  assert.equal(P([prop(60, "panel: Flip on #291", { to_node: undefined })]), null);
  assert.equal(P([prop(55, "panel: Flip on #291")]), null, "not after the ask (same id)");
  assert.equal(P([prop(54, "panel: Flip on #291")]), null, "not after the ask (older id)");
  assert.equal(P([prop("60", "panel: Flip on #291")]), null, "a non-numeric id is not after anything");
  // The label must be exactly one of the row's option labels.
  assert.equal(P([prop(60, "panel: Defer on #291")]), null, "RED: a label that is not a real option is ignored");
  assert.equal(P([prop(60, "panel: flip on #291")]), null, "exact: case matters");
  assert.equal(P([prop(60, "panel: Flip now on #291")]), null);
  assert.equal(P([prop(60, "panel: extend on #291")]), null, "an option's text is not its label");
  assert.equal(P([prop(60, "panel: Flip on #291")], ASK, []), null, "no options, no proposal");
  assert.equal(P([prop(60, "panel: Flip on #291")], ASK, null), null);
  assert.equal(P([prop(60, "panel: Flip on #291")], ASK, [{ text: "flip" }, null, { label: 7 }]), null);
  assert.equal(P([prop(60, "panel: Flip on #291"), prop(61, "panel: Defer on #291")]), "Flip",
    "a newer invalid label does not mask an older valid one");
  // Reply, prefix and shape.
  assert.equal(P([prop(60, "panel: Flip on #291", { reply_to: 99 })]), null, "a proposal for another ask is not this row's");
  assert.equal(P([prop(60, "panel: Flip on #291", { reply_to: null })]), null, "no reply_to, no proposal");
  assert.equal(P([prop(60, "Flip on #291")]), null, "no panel: prefix, no proposal");
  assert.equal(P([prop(60, "Panel: Flip on #291")]), null, "the prefix is exact");
  assert.equal(P([prop(60, "panel:  on #291")]), null, "no label, no proposal");
  assert.equal(P([prop(60, "panel: Turn on #2 later on #291")], ASK, [{ label: "Turn on #2 later" }]), "Turn on #2 later", "only the trailing row marker is cut");
  assert.equal(P(null), null);
  assert.equal(P([null, {}, prop(3, 7)]), null, "malformed entries are skipped");
  assert.equal(ctx.boardPanelProposal(null, [prop(60, "panel: Flip on #291")], CHOICES), null);
  assert.equal(ctx.boardPanelProposal({ from_node: "lab-ovh" }, [prop(60, "panel: Flip on #291")], CHOICES), null);
}
console.log("1224 proposal parse tests: passed");

// ---- boardProposedLabel: lab's ask by the commit path's own lookup, then the inbox ----
const inbox = [prop(60, "panel: Flip on #291"), prop(40, "panel: Kill on #7", { reply_to: 12 })];
{
  calls.length = 0;
  const q = { id: "obl-291", card: 7, obligation: 291, options: CHOICES };
  assert.equal(await ctx.boardProposedLabel(q, inbox), "Flip");
  assert.equal(calls.length, 1, "one read: the card thread (the inbox is already in hand)");
  assert.ok(calls[0].url.includes("/board/cards/7/thread?") && calls[0].method === "GET");

  calls.length = 0;
  assert.equal(await ctx.boardProposedLabel({ id: "obl-x", card: 7, options: CHOICES }, inbox), null, "no obligation id, no fetch");
  assert.equal(await ctx.boardProposedLabel({ id: "obl-x", obligation: 291, options: CHOICES }, inbox), null, "no card, no fetch");
  assert.equal(calls.length, 0);
  assert.equal(await ctx.boardProposedLabel({ ...q, options: [{ label: "Hold" }] }, inbox), null, "Flip is no option of this row");
  assert.equal(await ctx.boardProposedLabel(q, [prop(60, "panel: Flip on #291", { from_node: "drop-on-meta-edge" })]), null,
    "the lookup applies the asker rule: a proposal from another node is ignored");

  threadMessages = [];
  assert.equal(await ctx.boardProposedLabel(q, inbox), null, "no ask on the card thread, no proposal");
  threadMessages = [ASK];
}
console.log("1224 proposal lookup tests: passed");

// ---- the You tab card ----
const buildRow = { id: 291, card_id: 7, step: "build", accept: "PASS = the commander picks one", holder: "commander" };
const labSess = { name: "lab-ovh" };
let n = 0;
const card = (extra = {}, options = CHOICES) => ctx._boardQuestion({
  id: `obl-1224-${++n}`, title: "Extend, flip, or kill?", to_node: "commander", card: 7,
  obligation: 291, row: buildRow, options, ...extra,
}, labSess);

// A proposal pre-selects its option and relabels the button.
{
  const c = card({ proposed: "Flip" });
  assert.equal(checkedIdx(c), 1, "RED: the proposed option is pre-selected");
  assert.equal(btnOf(c).textContent, "confirm: Flip on #291", "RED: the button names the proposal and the row");
  // Picking another option makes the button an ordinary send; picking the proposal again restores it.
  pick(c, 2);
  assert.equal(btnOf(c).textContent, "Send decision");
  pick(c, 1);
  assert.equal(btnOf(c).textContent, "confirm: Flip on #291");
}
// The match is the exact option label: not its text, not another case, not padded.
assert.equal(checkedIdx(card({ proposed: "Kill" })), 2);
for (const near of ["KILL", "kill", " Kill", "Kill ", "go"]) {
  const c = card({ proposed: near }, [CHOICES[0], CHOICES[1], { label: "Kill", text: "go", outcome: "pass" }]);
  assert.equal(checkedIdx(c), 0, `${JSON.stringify(near)} is not the label of any option`);
  assert.equal(btnOf(c).textContent, "Send decision");
}
// A recommended option is displaced by the proposal, not the other way round.
{
  const c = card({ proposed: "Kill" }, [{ ...CHOICES[0], rec: true }, CHOICES[1], CHOICES[2]]);
  assert.equal(checkedIdx(c), 2);
}
// The commander's own draft pick outranks the proposal (a re-render must not undo a pick).
{
  const q = { id: "obl-1224-draft", title: "t?", to_node: "commander", card: 7, obligation: 291, row: buildRow, options: CHOICES, proposed: "Flip" };
  ctx.boardDraftSave(q, labSess, { opt: 2 });
  const c = ctx._boardQuestion(q, labSess);
  assert.equal(checkedIdx(c), 2);
  assert.equal(btnOf(c).textContent, "Send decision");
  ctx.boardDraftSave(q, labSess, { opt: 1 });
  assert.equal(btnOf(ctx._boardQuestion(q, labSess)).textContent, "confirm: Flip on #291", "a draft that picks the proposal keeps the label");
}
// Nothing proposed, or a label that names no option: the tab is what it was.
for (const proposed of [undefined, null, "", "Defer", "ship on #291", "Flip on #291"]) {
  const c = card({ proposed });
  assert.equal(checkedIdx(c), 0, `no option is pre-selected for ${JSON.stringify(proposed)}: the first stays the default`);
  assert.equal(btnOf(c).textContent, "Send decision");
}
{
  const c = card({ proposed: "Defer" }, [CHOICES[0], { ...CHOICES[1], rec: true }, CHOICES[2]]);
  assert.equal(checkedIdx(c), 1, "the recommended option stays the default");
}
// A question bound to no obligation ignores a proposal.
{
  const c = ctx._boardQuestion({
    id: "obl-1224-plain", title: "Ship?", to_node: "commander", proposed: "Flip", options: CHOICES,
  }, labSess);
  assert.equal(checkedIdx(c), 0);
  assert.equal(btnOf(c).textContent, "Send decision");
}
// A proposed label never reaches the DOM except through an option the commander already sees.
{
  const c = card({ proposed: "<img src=x onerror=alert(1)>" });
  assert.equal(btnOf(c).textContent, "Send decision");
  assert.ok(!all(c, (x) => String(x.textContent).includes("<img")).length);
}
console.log("1224 you-tab card tests: passed");

// ---- the commander's confirm is the same send + close a plain pick makes ----
async function commit(c) {
  calls.length = 0;
  btnOf(c).fire("click");
  await flush();
  await flush();
  return calls.filter((x) => x.method === "POST").map((x) => ({ url: x.url, body: JSON.parse(x.body) }));
}
{
  const confirmed = await commit(card({ proposed: "Flip" }));
  const plain = card();
  pick(plain, 1);
  const manual = await commit(plain);
  assert.deepEqual(confirmed, manual, "RED: confirm and a plain pick of the same option commit identically");
  const [send, close] = confirmed;
  assert.ok(send.url.endsWith("/messages") && close.url.endsWith("/board/obligations/291/close"));
  assert.equal(send.body.content, "flip");
  assert.equal(send.body.to_node, "lab-ovh");
  assert.equal(send.body.reply_to, 55, "the commander's answer cites lab's ask, as ever");
  assert.equal(close.body.outcome, "pass");
  assert.ok(close.body.evidence.includes("ask:55"));
  assert.equal(confirmed.length, 2, "one DM and one close, nothing else");
}
// The proposal alone commits nothing: building the card sends no request.
{
  calls.length = 0;
  card({ proposed: "Flip" });
  assert.deepEqual(calls, []);
}
console.log("1224 confirm tests: passed");

// ---- refreshActions pins the proposal on each bound question ----
{
  const board = { sessions: [{ name: "lab-ovh", questions: [
    { id: "obl-291", title: "Extend, flip, or kill?", card: 7, obligation: 291, options: CHOICES },
    { id: "obl-292", title: "Plain?", options: CHOICES },
  ] }] };
  let wiredInbox = [prop(60, "panel: Flip on #291")];
  const rctx = {
    state: { token: "tok", base: "http://stub.invalid" },
    selfNode: () => "commander",
    setStatus() {},
    renderActions() {},
    newestBoardDm: () => ({ content: "board" }),
    parseBoardDm: () => board,
    dedupeYou: (g) => g,
    _CLOSED_STAGES: new Set(["done", "parked"]),
    fetch: async (url) => {
      const u = String(url);
      const ok = (json) => ({ ok: true, status: 200, statusText: "OK", json: async () => json });
      if (u.includes("/messages?")) return ok({ messages: wiredInbox });
      if (u.includes("/thread?")) return ok({ messages: [ASK] });
      if (u.includes("/board/obligations")) return ok({ obligations: [{ id: 291, card_id: 7, step: "build", accept: "a", holder: "commander", status: "open" }] });
      return ok({ cards: [] });
    },
  };
  vm.createContext(rctx);
  vm.runInContext(
    `async function api(path, opts = {}) { return (await fetch(state.base + path, opts)).json(); }\n` +
    `let _you = null;\nlet _youSig = null;\n` +
    `function renderYou() { if (!_you) return; renderActions({}); }\n` +
    `${apiSendSrc}\n${extract("boardObligationId")}\n${extract("boardAskMessage")}\n` +
    `${extract("boardBoundRow")}\n${extract("attachBoundRows")}\n${extract("questionWaiting")}\n` +
    `${src.slice(src.indexOf(PSTART), src.indexOf(PEND))}\nlet _actionsLoad = null;\n${extract("refreshActions")}\n${extract("loadActions")}`,
    rctx);
  await rctx.refreshActions(true);
  assert.equal(board.sessions[0].questions[0].proposed, "Flip", "RED: refreshActions pins the proposal on the bound question");
  assert.equal(board.sessions[0].questions[1].proposed, undefined, "an unbound question is not looked up");
  assert.equal(board.sessions[0].questions[0].row.id, 291);

  // The same proposal from a node that did not send the ask pins nothing.
  wiredInbox = [prop(60, "panel: Flip on #291", { from_node: "drop-on-meta-edge" })];
  board.sessions[0].questions[0].proposed = undefined;
  board.sessions[0].questions[0].row = undefined;
  await rctx.refreshActions(true);
  assert.equal(board.sessions[0].questions[0].proposed, null, "RED: a proposal from another node is not pinned");
  assert.equal(board.sessions[0].questions[0].row.id, 291);
  wiredInbox = [prop(60, "panel: Flip on #291")];

  // A lookup that throws must not cost the question its row.
  board.sessions[0].questions[0].proposed = undefined;
  board.sessions[0].questions[0].row = undefined;
  rctx.boardProposedLabel = async () => { throw new Error("boom"); };
  await rctx.refreshActions(true);
  assert.equal(board.sessions[0].questions[0].row.id, 291, "the row survives a failed proposal lookup");
  assert.equal(board.sessions[0].questions[0].proposed, null);
}
console.log("1224 refresh wiring tests: passed");
