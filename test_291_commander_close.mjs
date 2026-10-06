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
  return src.slice(start, end);
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

// 2. threaded question: the answer DM carries thread_id.
ctx.calls.length = 0;
await ctx.sendBoardDecision(
  { title: "Close it?", to_node: "lab-ovh", thread: "ask-thread-uuid-1" }, "yes");
assert.equal(ctx.calls.length, 1);
assert.equal(JSON.parse(ctx.calls[0].body).thread_id, "ask-thread-uuid-1",
  "RED: answer must post in the ask thread");

// 3. unthreaded question: no thread_id key (older gateway shape unchanged).
ctx.calls.length = 0;
await ctx.sendBoardDecision({ title: "Ship?", to_node: "lab-ovh" }, "Yes, ship");
assert.equal(JSON.parse(ctx.calls[0].body).thread_id, undefined);

// 4. tap close: evidence cites the just-sent DM as relayed-from.
ctx.calls.length = 0;
const r = await ctx.sendBoardDecisionAndClose(
  { id: "obl-291", title: "Close it?", to_node: "lab-ovh",
    thread: "ask-thread-uuid-1", obligation: 291 }, "yes");
assert.equal(r.closed.status, "closed");
assert.equal(ctx.calls.length, 2);
const closeBody = JSON.parse(ctx.calls[1].body);
assert.ok(closeBody.evidence.includes("yes"), "evidence quotes the answer");
assert.ok(closeBody.evidence.includes("relayed-from=msg:291"),
  "RED: evidence must cite the decision DM for the relay arm");

// 5. friction tap helper sends the bare word in-thread and closes citing it.
ctx.calls.length = 0;
const f = await ctx.sendFrictionReply(
  { id: "obl-291", title: "Close it?", to_node: "lab-ovh",
    thread: "ask-thread-uuid-1", obligation: 291,
    options: [{ label: "Yes", text: "yes" }, { label: "No", text: "no" }] }, "yes");
assert.equal(JSON.parse(ctx.calls[0].body).content, "Re: Close it? (obligation #291)\nyes");
assert.equal(JSON.parse(ctx.calls[0].body).thread_id, "ask-thread-uuid-1");
assert.ok(JSON.parse(ctx.calls[1].body).evidence.includes("relayed-from=msg:291"));

// 5b. ruling_1116_core (6): a 'no' tap closes fail, still citing the DM.
ctx.calls.length = 0;
await ctx.sendFrictionReply(
  { id: "obl-291", title: "Close it?", to_node: "lab-ovh",
    thread: "ask-thread-uuid-1", obligation: 291,
    options: [{ label: "Yes", text: "yes" }, { label: "No", text: "no" }] }, "no");
assert.equal(JSON.parse(ctx.calls[0].body).content, "Re: Close it? (obligation #291)\nno");
const noClose = JSON.parse(ctx.calls[1].body);
assert.equal(noClose.outcome, "fail", "RED: a no tap must close fail");
assert.ok(noClose.evidence.includes("relayed-from=msg:291"));

// 5c. ruling_1135_binding: a question with no row id sends the bare Re:
// line (the gateway will refuse to bind it — it names nothing).
ctx.calls.length = 0;
await ctx.sendBoardDecision({ title: "Ship?", to_node: "lab-ovh" }, "yes");
assert.equal(JSON.parse(ctx.calls[0].body).content, "Re: Ship?\nyes");

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
  id: "obl-291", title: "Close it?", to_node: "lab-ovh",
  thread: "ask-thread-uuid-1", obligation: 291,
  options: [{ label: "Yes", text: "yes" }, { label: "No", text: "no" }],
}, "yes", "Yes");
assert.equal(fctx.helperCalls.length, 1, "RED: the tab must call the friction helper");
assert.deepEqual(fctx.helperCalls[0][1], "yes");
assert.equal(fbutton.disabled, true);
assert.match(fbutton.textContent, /^Sent: Yes · \d+s ago$/);
assert.equal(JSON.parse(fctx.calls[0].body).content, "Re: Close it? (obligation #291)\nyes");
assert.equal(JSON.parse(fctx.calls[0].body).thread_id, "ask-thread-uuid-1");
assert.ok(JSON.parse(fctx.calls[1].body).evidence.includes("relayed-from=msg:291"));

console.log("291 friction tap tests: all passed");
