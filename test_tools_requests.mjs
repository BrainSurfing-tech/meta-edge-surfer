// card #1018 — Tools tab request shapes mirror swarph-me exactly.
// Every helper must send EXACTLY ONE fetch to the same route swarph-me uses.
// Run: node test_tools_requests.mjs
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const src = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

const START = "// ---------- tools (card #1018) ----------";
const END = "// ---------- end tools (card #1018) ----------";
assert.ok(src.includes(START), "tools block missing in app.js");
assert.ok(src.includes(END), "tools block end marker missing in app.js");
const block = src.slice(src.indexOf(START), src.indexOf(END));

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
    if (/\/board\/cards\/7$/.test(u)) {
      return { ok: true, status: 200, statusText: "OK",
        json: async () => ({ id: 7, thread_uuid: "thr-1", assignee: "lab-ovh" }) };
    }
    return { ok: true, status: 200, statusText: "OK", json: async () => ({ id: 1 }) };
  },
};
vm.createContext(ctx);
const driver = `
var __out = [];
async function __step(label, fn) {
  calls.length = 0;
  await fn();
  __out.push([label, calls[0], calls.length]);
}
async function __drive() {
  await __step("cards-ready", () => apiToolsCards());
  await __step("cards-stage", () => apiToolsCards({ stage: "build" }));
  await __step("cards-assignee", () => apiToolsCards({ assignee: "lab-ovh" }));
  await __step("card-show", () => apiToolsCard(7));
  await __step("card-thread", () => apiToolsThread(7, 15));
  await __step("move", () => apiToolsMove(7, "test"));
  await __step("assign", () => apiToolsAssign(7, "lab-ovh"));
  await __step("ready", () => apiToolsReady(7, true));
  await __step("ready-clear", () => apiToolsReady(7, false));
  await __step("due", () => apiToolsDue(7, "2026-10-05T14:00:00+00:00"));
  await __step("due-clear", () => apiToolsDue(7, ""));
  await __step("comment", () => apiToolsComment({ id: 7, thread_uuid: "thr-1", assignee: "lab-ovh" }, "hi"));
  await __step("channels", () => apiToolsChannels());
  await __step("join", () => apiToolsJoin("ops", "all"));
  await __step("leave", () => apiToolsLeave("ops"));
  await __step("chan-read", () => apiToolsChannelRead("ops", 15));
  await __step("say", () => apiToolsSay("ops", "hello"));
}
`;
vm.runInContext(
  `async function api(path, opts = {}) {\n` +
  `  const url = state.base.replace(/\\/$/, "") + path;\n` +
  `  const headers = { Authorization: "Bearer " + state.token, ...(opts.headers || {}) };\n` +
  `  if (opts.body) headers["Content-Type"] = "application/json";\n` +
  `  const res = await fetch(url, { ...opts, headers });\n` +
  `  return res.json();\n}\n${block}\n${driver}`,
  ctx);
await vm.runInContext("__drive()", ctx);
const got = Object.fromEntries(ctx.__out.map(([k, call, n]) => [k, { call, n }]));
const eq = (label, url, method, body) => {
  const g = got[label];
  assert.ok(g, `${label}: no call recorded`);
  assert.equal(g.n, 1, `${label}: expected exactly 1 request, got ${g.n}`);
  assert.equal(g.call.url, url, `${label}: url`);
  assert.equal(g.call.method, method || "GET", `${label}: method`);
  if (body !== undefined) assert.deepEqual(JSON.parse(g.call.body), body, `${label}: body`);
};

eq("cards-ready", "http://stub.invalid/board/cards");
eq("cards-stage", "http://stub.invalid/board/cards?stage=build");
eq("cards-assignee", "http://stub.invalid/board/cards?assignee=lab-ovh");
eq("card-show", "http://stub.invalid/board/cards/7");
eq("card-thread", "http://stub.invalid/board/cards/7/thread?limit=15");
eq("move", "http://stub.invalid/board/cards/7", "PATCH",
  { actor: "commander", stage: "test" });
eq("assign", "http://stub.invalid/board/cards/7", "PATCH",
  { actor: "commander", assignee: "lab-ovh" });
eq("ready", "http://stub.invalid/board/cards/7", "PATCH",
  { actor: "commander", move_ready: true });
eq("ready-clear", "http://stub.invalid/board/cards/7", "PATCH",
  { actor: "commander", move_ready: false });
eq("due", "http://stub.invalid/board/cards/7", "PATCH",
  { actor: "commander", due_at: "2026-10-05T14:00:00+00:00" });
eq("due-clear", "http://stub.invalid/board/cards/7", "PATCH",
  { actor: "commander", due_at: "" });
eq("comment", "http://stub.invalid/messages", "POST",
  { from_node: "commander", to_node: "lab-ovh", kind: "status",
    content: "hi", thread_uuid: "thr-1" });
eq("channels", "http://stub.invalid/channels");
eq("join", "http://stub.invalid/channels/ops/join", "POST",
  { peer: "commander", wake_policy: "all" });
eq("leave", "http://stub.invalid/channels/ops/leave", "POST",
  { peer: "commander" });
eq("chan-read", "http://stub.invalid/messages?channel=ops&limit=15");
eq("say", "http://stub.invalid/messages", "POST",
  { from_node: "commander", channel: "ops", kind: "fyi", content: "hello" });

// ---- schedule reuses the existing events helper ----
assert.ok(src.includes("apiSchedEvents"), "schedule must reuse apiSchedEvents");

// ---- DOM: Tools tab + view exist ----
assert.ok(html.includes('data-view="tools"'), "Tools tab button missing");
assert.ok(html.includes('id="view-tools"'), "view-tools section missing");
assert.ok(html.includes("Cards") && html.includes("Channels") && html.includes("Schedule"),
  "three panels missing");

// ---- CSS: 44px-equivalent tap targets ----
assert.ok(/min-height:\s*(44px|var\(--tap\))/.test(css), "44px tap-target rule missing");

// ---- every UI write confirm()s first (move/assign/ready/due-set/due-clear/
// ---- comment/join/leave/say = 9 guards in the tools UI section) ----
const uiSection = src.slice(src.indexOf(END));
const confirms = (uiSection.match(/if\s*\(\s*!confirm\(/g) || []).length;
assert.equal(confirms, 9, `expected 9 confirm guards in tools UI, got ${confirms}`);

// ---- #974: gateway thread shape {card_id, thread_uuid, messages:[...]} ----
function extract2(name) {
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
vm.runInContext(`${extract2("toolsThreadPosts")}\n${extract2("toolsReadyRows")}`, ctx);
const posts = ctx.toolsThreadPosts({ card_id: 1006, thread_uuid: "thread-1006",
  messages: [{ content: "one" }, { content: "two" }] });
assert.equal(posts.length, 2, "gateway {messages:[...]} shape must render 2 posts");
assert.equal(ctx.toolsThreadPosts({ posts: [{ content: "x" }] }).length, 1,
  "legacy {posts:[...]} keeps working");
assert.equal(ctx.toolsThreadPosts([{ content: "y" }]).length, 1, "bare array keeps working");
// ---- #974: default ready list keeps only move_ready rows (fmt.py cards-ready) ----
const ready = ctx.toolsReadyRows(
  [{ id: 1, move_ready: true }, { id: 2, move_ready: false }, { id: 3 }]);
assert.deepEqual(ready.map((c) => c.id), [1], "default list shows only move_ready cards");

console.log("tools request-shape tests: all passed");
