// card #1007 — the board lives inside You. Fetch is stubbed; nothing is sent.
// Run: node test_you_board.mjs
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const src = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

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

const apiSendSrc = src.slice(src.indexOf("const apiSend ="), src.indexOf("const apiSchedEvents"));
const draftsDecl = src.slice(src.indexOf("const _boardDrafts"), src.indexOf("function _boardQuestion("));
const actionGroupsSrc = src.slice(src.indexOf("const ACTION_GROUPS = ["), src.indexOf("];", src.indexOf("const ACTION_GROUPS = [")) + 2);
const ctx = {
  state: { token: "tok", base: "http://stub.invalid" },
  ssoActive: false,
  selfNode() { return "commander"; },
  calls: [],
  fetch: async (url, opts) => {
    ctx.calls.push({ url, body: opts && opts.body, headers: opts && opts.headers });
    return { ok: true, status: 200, statusText: "OK", json: async () => ({ id: 1 }) };
  },
};
vm.createContext(ctx);
vm.runInContext(
  `${extract("boardEnvelope")}\n${extract("parseBoardDm")}\n${extract("newestBoardDm")}\n` +
  `${extract("visibleInbox")}\n${extract("dedupeYou")}\n${extract("questionSendControl")}\n` +
  `async function api(path, opts = {}) {\n` +
  `  const url = state.base.replace(/\\/$/, "") + path;\n` +
  `  const headers = { Authorization: "Bearer " + state.token, ...(opts.headers || {}) };\n` +
  `  if (opts.body) headers["Content-Type"] = "application/json";\n` +
  `  const res = await fetch(url, { ...opts, headers });\n` +
  `  return res.json();\n` +
  `}\n${apiSendSrc}\n${extract("sendBoardDecision")}\n`,
  ctx);

const board = {
  sessions: [{
    name: "science-claude",
    state: "Waiting on the commander.",
    where: ["Busy.", "One row is open."],
    questions: [
      {
        id: "obl-1",
        title: "Ship the gateway?",
        to_node: "science-claude",
        card: 12,
        options: [
          { label: "Ship", text: "Yes, ship", rec: true },
          { label: "Hold", text: "Not yet", rec: false },
        ],
      },
      {
        id: "obl-2",
        title: "Redeploy?",
        to_node: "science-claude",
        in_session: true,
        options: [{ label: "Go", text: "go", rec: true }],
      },
    ],
  }],
};
const body = "SWARPH-BOARD v1\n" + JSON.stringify(board);
const older = { id: 1, from_node: "lab-ovh", content: body };
const newerOther = { id: 9, from_node: "drop-on-meta-edge", content: body };
const newest = { id: 4, from_node: "lab-ovh", content: body };
const plain = { id: 3, from_node: "science-claude", kind: "question", content: "Ship the gateway?", read_at: null };

const picked = ctx.newestBoardDm([older, newerOther, newest, plain]);
assert.equal(picked.id, 4, "newest board DM is the latest one from lab-ovh");
assert.equal(ctx.parseBoardDm(picked.content).sessions[0].name, "science-claude");

const visible = ctx.visibleInbox([newest, plain, { id: 8, content: "hello" }]);
assert.deepEqual(visible.map((m) => m.id), [3, 8], "SWARPH-BOARD DMs are hidden from Inbox");

const merged = ctx.dedupeYou({
  questions: [plain, newest],
  overdue: [{ id: 12, title: "gateway" }, { id: 13, title: "other" }],
  ready: [{ id: 12, title: "gateway" }],
  assigned: [{ id: 13, title: "kept" }],
}, board);
assert.deepEqual(merged.questions.map((m) => m.id), [], "the board question is not also a You question");
assert.deepEqual(merged.overdue.map((c) => c.id), [13]);
assert.deepEqual(merged.ready.map((c) => c.id), []);
assert.deepEqual(merged.assigned.map((c) => c.id), [13], "a card that is not on the board still shows");

const openQ = ctx.questionSendControl(board.sessions[0].questions[0], "science-claude");
assert.equal(openQ.send, true);
assert.equal(openQ.reply, "Yes, ship", "Recommended is preselected");
const closedQ = ctx.questionSendControl(board.sessions[0].questions[1], "science-claude");
assert.equal(closedQ.send, false);
assert.equal(closedQ.note, "Answer in science-claude");

const sent = await ctx.sendBoardDecision(
  board.sessions[0].questions[0], openQ.reply);
assert.equal(sent.id, 1);
assert.equal(ctx.calls.length, 1, "one stubbed fetch, no second send");
const req = ctx.calls[0];
assert.equal(req.url, "http://stub.invalid/messages");
const payload = JSON.parse(req.body);
assert.equal(payload.to_node, "science-claude");
assert.equal(payload.kind, "answer");
assert.equal(payload.content, "Re: Ship the gateway?\nYes, ship");
assert.deepEqual(payload.cc, ["lab-ovh"]);
assert.equal(req.headers.Authorization, "Bearer tok");

const firstTab = html.indexOf('class="tab');
const youAt = html.indexOf('data-view="actions"');
const inboxAt = html.indexOf('data-view="inbox"');
assert.ok(youAt > 0 && youAt < inboxAt, "You is the first nav item");
assert.ok(html.includes('id="view-actions" class="view active"'), "You is the default view");
assert.ok(!html.includes('id="view-inbox" class="view active"'));
assert.ok(html.includes('id="nav-toggle"'), "hamburger control is in the page");
assert.ok(css.includes("#nav-toggle") && css.includes("display: inline-flex"));
assert.ok(css.includes("#tabs.open { display: flex; }"));
assert.ok(/@media \(min-width: 768px\)/.test(css) && /#nav-bar \{ display: none; \}/.test(css),
  "hamburger at 360px; tabs inline from 768px");
assert.ok(css.includes('input:not([type="radio"]):not([type="checkbox"]), select, textarea'),
  "a radio keeps its natural box (fix 1)");
assert.ok(css.includes("main#views { max-width: 760px; margin: 0 auto; }"), "centred column (fix 7)");
assert.ok(firstTab > 0);

// card #1007 rework: sent state and the poll clamp. These fail at 40e71c0,
// which has no deliverBoardDecision and parses a stored poll of 0 as 0.
const store = {};
const clickCtx = {
  state: { token: "tok", base: "http://stub.invalid" },
  ssoActive: false,
  selfNode() { return "commander"; },
  calls: [],
  localStorage: {
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
  },
  fetch: async (url, opts) => {
    clickCtx.calls.push({ url, body: opts && opts.body });
    return { ok: true, status: 200, statusText: "OK", json: async () => ({ id: 42 }) };
  },
};
vm.createContext(clickCtx);
vm.runInContext(
  `async function api(path, opts = {}) {\n` +
  `  const url = state.base.replace(/\\/$/, "") + path;\n` +
  `  const headers = { Authorization: "Bearer " + state.token };\n` +
  `  if (opts.body) headers["Content-Type"] = "application/json";\n` +
  `  const res = await fetch(url, { ...opts, headers });\n` +
  `  if (!res.ok) throw new Error(res.status + " " + res.statusText);\n` +
  `  return res.json();\n` +
  `}\n${apiSendSrc}\n${extract("sendBoardDecision")}\n` +
  `${extract("boardSentRecord")}\n${extract("rememberBoardSent")}\n` +
  `${extract("boardQuestionOffered")}\n${extract("boardSentText")}\n${extract("fmtTime")}\n` +
  `${draftsDecl}\n${extract("boardDraftKey")}\n${extract("boardDraftSave")}\n` +
  `${extract("deliverBoardDecision")}\n${extract("clampPollSeconds")}\n` +
  `${extract("boardBuckets")}\n${extract("youCount")}\n${actionGroupsSrc}\n`,
  clickCtx);

const q = board.sessions[0].questions[0];
const err = { textContent: "" };
const button = {
  disabled: false,
  textContent: "Send decision",
  parentElement: { querySelector() { return err; } },
};
// #1007 fixes 2+3: the badge counts decidable unsent questions + the older
// groups; a send drops it by one without a refetch, and the stored record
// carries the chosen label + time, not only the message id.
const olderGroups = { questions: [plain], overdue: [{ id: 13 }], ready: [], assigned: [{ id: 14 }] };
const before = clickCtx.boardBuckets(board);
assert.deepEqual([...before.decidable.map((it) => it.q.id)], ["obl-1"]);
assert.deepEqual([...before.inSession.map((it) => it.q.id)], ["obl-2"], "in-session is shown, not counted");
assert.equal(clickCtx.youCount({ ...olderGroups, ...before }), 4, "1 decidable + 3 older items");

const first = clickCtx.deliverBoardDecision(button, q, "Yes, ship", "Ship");
const second = clickCtx.deliverBoardDecision(button, q, "Yes, ship", "Ship");
await first;
await second;
assert.equal(clickCtx.calls.length, 1, "two clicks, one POST");
assert.equal(button.disabled, true);
assert.match(button.textContent, /^Sent: Ship · \d+s ago$/, "the row names the decision, not the id");
assert.equal(clickCtx.boardQuestionOffered(q), false, "a reload does not re-offer a sent question");
const after = clickCtx.boardBuckets(board);
assert.equal(after.decidable.length, 0);
assert.deepEqual([...after.sent.map((it) => it.q.id)], ["obl-1"], "the sent question moves to Sent");
assert.equal(clickCtx.youCount({ ...olderGroups, ...after }), 3, "the count drops by one on send");

const reloaded = {};
vm.createContext(reloaded);
reloaded.localStorage = clickCtx.localStorage;
reloaded.Date = Date;
vm.runInContext(
  `${extract("boardSentRecord")}\n${extract("boardQuestionOffered")}\n${extract("boardSentText")}\n${extract("fmtTime")}\n`,
  reloaded);
assert.equal(reloaded.boardQuestionOffered(q), false);
const rec = reloaded.boardSentRecord(q.id);
assert.equal(rec.id, 42, "the message id is kept (title attribute)");
assert.equal(rec.label, "Ship");
assert.match(reloaded.boardSentText(rec), /^Sent: Ship · \d+s ago$/, "after a reload the row still shows the label + relative time");
reloaded.localStorage.setItem("mes.boardSent", JSON.stringify({ "obl-legacy": 4343 }));
assert.equal(JSON.stringify(reloaded.boardSentRecord("obl-legacy")), '{"id":4343}', "a pre-#1007 bare id still reads as sent");
assert.equal(reloaded.boardSentText(reloaded.boardSentRecord("obl-legacy")), "Sent");

clickCtx.calls = [];
clickCtx.fetch = async (url, opts) => {
  clickCtx.calls.push({ url, body: opts && opts.body });
  return { ok: false, status: 502, statusText: "Bad Gateway", json: async () => ({}) };
};
const err2 = { textContent: "" };
const button2 = {
  disabled: false,
  textContent: "Send decision",
  parentElement: { querySelector() { return err2; } },
};
await clickCtx.deliverBoardDecision(button2, { id: "obl-9", title: "Hold?", to_node: "science-claude" }, "wait");
assert.equal(button2.disabled, false, "a non-2xx leaves the control enabled");
assert.ok(err2.textContent.includes("502"), "the error is shown");
assert.equal(clickCtx.calls.length, 1);

const err3 = { textContent: "" };
const button3 = {
  disabled: false,
  textContent: "Send decision",
  parentElement: { querySelector() { return err3; } },
};
clickCtx.fetch = async () => ({ ok: true, status: 200, statusText: "OK", json: async () => ({ id: 7 }) });
clickCtx.localStorage.setItem = () => { throw new Error("quota"); };
await clickCtx.deliverBoardDecision(button3, { id: "obl-3", title: "Ship?", to_node: "science-claude" }, "yes");
assert.equal(button3.disabled, true);
assert.match(button3.textContent, /^Sent: · \d+s ago$|^Sent · \d+s ago$/);

assert.equal(clickCtx.clampPollSeconds("0"), 10);
assert.equal(clickCtx.clampPollSeconds("3"), 10);
assert.equal(clickCtx.clampPollSeconds("30"), 30);
assert.equal(clickCtx.clampPollSeconds("9999"), 600);
assert.ok(
  src.includes('pollSec: clampPollSeconds(localStorage.getItem(LS.poll) || "30")'),
  "startup clamps the stored poll");

console.log("you board tests: passed");
