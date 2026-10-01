// card #1018 / obligation #983 — answering a board question that carries an
// obligation id ALSO closes that obligation. Run: node test_board_close.mjs
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const src = readFileSync(new URL("./app.js", import.meta.url), "utf8");

const START = "// ---------- board close (#983) ----------";
const END = "// ---------- end board close (#983) ----------";
assert.ok(src.includes(START), "board-close block missing in app.js");
assert.ok(src.includes(END), "board-close block end marker missing in app.js");
const block = src.slice(src.indexOf(START), src.indexOf(END));

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
// apiSend is a const arrow — slice it whole like test_you_board does.
const apiSendSrc = src.slice(src.indexOf("const apiSend ="), src.indexOf("const apiSchedEvents"));

const ctx = {
  state: { token: "tok", base: "http://stub.invalid" },
  ssoActive: false,
  COMMANDER: "commander",
  selfNode() { return "commander"; },
  calls: [],
  failClose: false,
  fetch: async (url, opts) => {
    ctx.calls.push({ url: String(url), method: (opts && opts.method) || "GET",
      body: opts && opts.body });
    const u = String(url);
    if (u.includes("/board/obligations/") && u.endsWith("/close")) {
      if (ctx.failClose) {
        return { ok: false, status: 403, statusText: "Forbidden",
          json: async () => ({ detail: "not the holder" }) };
      }
      return { ok: true, status: 200, statusText: "OK",
        json: async () => ({ id: 983, closed_by: "commander" }) };
    }
    return { ok: true, status: 200, statusText: "OK", json: async () => ({ id: 4242 }) };
  },
};
vm.createContext(ctx);
vm.runInContext(
  `async function api(path, opts = {}) {\n` +
  `  const url = state.base.replace(/\\/$/, "") + path;\n` +
  `  const headers = { Authorization: "Bearer " + state.token, ...(opts.headers || {}) };\n` +
  `  if (opts.body) headers["Content-Type"] = "application/json";\n` +
  `  const res = await fetch(url, { ...opts, headers });\n` +
  `  if (!res.ok) {\n` +
  `    let detail = "";\n` +
  `    try { detail = (await res.json()).detail || ""; } catch {}\n` +
  `    throw new Error(res.status + " " + res.statusText + (detail ? " — " + detail : ""));\n` +
  `  }\n` +
  `  return res.json();\n}\n${apiSendSrc}\n${extract("sendBoardDecision")}\n${block}`,
  ctx);

const driver = `
var __out = [];
async function __step(label, fn) {
  calls.length = 0; failClose = label === "close-fails";
  try {
    const r = await fn();
    __out.push([label, "ok", calls.slice(), r]);
  } catch (e) {
    __out.push([label, "threw:" + e.message, calls.slice(), null]);
  }
}
async function __drive() {
  const q = { id: "obl-983", title: "Ship it?", to_node: "lab-ovh", obligation: 983,
    options: [{ label: "Yes", text: "Yes, ship", rec: true }] };
  await __step("with-id", () => sendBoardDecisionAndClose(q, "Yes, ship"));
  const plain = { id: "q-2", title: "Other?", to_node: "lab-ovh",
    options: [{ label: "No", text: "No", rec: true }] };
  await __step("without-id", () => sendBoardDecisionAndClose(plain, "No"));
  await __step("close-fails", () => sendBoardDecisionAndClose(q, "Yes, ship"));
}
`;
vm.runInContext(driver, ctx);
await vm.runInContext("__drive()", ctx);
const got = Object.fromEntries(ctx.__out.map(([k, st, calls, r]) => [k, { st, calls, r }]));

// with-id: exactly 2 requests — the DM, then the close quoting the answer.
{
  const g = got["with-id"];
  assert.ok(g.st === "ok", `with-id threw: ${g.st}`);
  assert.equal(g.calls.length, 2, `with-id: expected 2 requests, got ${g.calls.length}`);
  assert.equal(g.calls[0].url, "http://stub.invalid/messages");
  assert.equal(g.calls[1].url, "http://stub.invalid/board/obligations/983/close");
  assert.equal(g.calls[1].method, "POST");
  const body = JSON.parse(g.calls[1].body);
  assert.equal(body.outcome, "pass");
  assert.ok(body.evidence.includes("Yes, ship"),
    "evidence must quote the chosen answer verbatim");
}
// without-id: only the DM.
{
  const g = got["without-id"];
  assert.ok(g.st === "ok", `without-id threw: ${g.st}`);
  assert.equal(g.calls.length, 1, `without-id: expected 1 request, got ${g.calls.length}`);
  assert.equal(g.calls[0].url, "http://stub.invalid/messages");
}
// close-fails: error surfaces (deliverBoardDecision shows it, never marks sent).
{
  const g = got["close-fails"];
  assert.ok(g.st.startsWith("threw:"), "a failed close must throw");
  assert.ok(g.st.includes("403"), `error must carry the gateway status, got: ${g.st}`);
}

console.log("board close tests: all passed");
