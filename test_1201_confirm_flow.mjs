// card #1201 — the step graph and the "Confirm flow" button in the Tools tab
// card detail. The graph is GET /board/cards/{id}/graph (the derivation behind
// `swarph board cards graph`); the button POSTs /board/cards/{id}/flow/confirm.
// Fetch is stubbed; nothing is sent. The real api() from app.js runs, so a 4xx
// throws exactly as it does on the phone.
// Run: node test_1201_confirm_flow.mjs
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
function slice(from, to) {
  const a = src.indexOf(from), b = src.indexOf(to);
  assert.ok(a >= 0 && b > a, `app.js slice ${from} .. ${to} not found`);
  return src.slice(a, b);
}

// ---- minimal fake DOM: enough for openToolsCard's rows ----
function makeEl(tag) {
  const el = {
    tag, children: [], attrs: {}, listeners: {},
    className: "", textContent: "", value: "", type: "", placeholder: "",
    disabled: false, selected: false, rows: 0, onclick: null,
    set innerHTML(v) { if (v === "") el.children = []; else throw new Error("innerHTML with markup"); },
    appendChild(c) { el.children.push(c); c.parentElement = el; return c; },
    append(...cs) { for (const c of cs) el.appendChild(c); },
    replaceChildren(...cs) { el.children = []; el.append(...cs); },
    setAttribute(k, v) { el.attrs[k] = String(v); },
    addEventListener(ev, fn) { (el.listeners[ev] = el.listeners[ev] || []).push(fn); },
    fire(ev) {
      if (ev === "click" && el.onclick) el.onclick();
      (el.listeners[ev] || []).forEach((fn) => fn());
    },
  };
  return el;
}
const find = (root, pred) => {
  const out = [];
  (function walk(n) { for (const c of n.children || []) { if (pred(c)) out.push(c); walk(c); } })(root);
  return out;
};
const textOf = (n) => [n.textContent || "", ...(n.children || []).map(textOf)].join("\n");
const confirmBtn = (root) => find(root, (c) => c.tag === "button" && c.textContent === "Confirm flow")[0];
const resultOf = (root) => find(root, (c) => (c.className || "").includes("tools-flow-result"))[0];
const lines = (root) => find(root, (c) => c.tag === "li").map((c) => c.textContent);
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

// ---- fixtures in the shape _derive_step_graph returns (server.py) ----
const dflt = (holder) => ({ holder, provisional: true, derived_from: "live execute grants at as_of" });
const GRAPH_MISSING = {
  menu: { source: "project", version: 3 }, menu_version: 3, labels: [],
  steps: [
    { step: "spec", mandatory: true, state: "closed:pass", default: null, holder: "lab-ovh",
      row: { id: 501, holder: "lab-ovh", status: "closed", close_outcome: "pass" },
      eligible: null, needs: [] },
    { step: "build", mandatory: true, state: "missing", default: dflt("droplet"), holder: null,
      row: null, eligible: ["droplet", "gpu-wsl", "lab-ovh"], needs: [] },
    { step: "review", mandatory: true, state: "missing", default: dflt("gpu-wsl"), holder: null,
      row: null, eligible: ["gpu-wsl", "science-claude"], needs: [] },
    { step: "docs", mandatory: false, state: "not-taken", default: null, holder: null,
      row: null, eligible: null, needs: [] },
  ],
  unstepped: [], missing: ["build", "review"],
  flow: { confirmed: false, unconfirmed: ["build", "review"],
          defaults: { build: "droplet", review: "gpu-wsl" },
          confirm_with: "swarph board cards confirm-flow 7 (POST /board/cards/7/flow/confirm)" },
  stage_implied: "pre-build (graph unfilled)", card_id: 7, stage: "build", assignee: "lab-ovh",
};
const GRAPH_FILLED = {
  ...GRAPH_MISSING,
  steps: [
    GRAPH_MISSING.steps[0],
    { step: "build", mandatory: true, state: "offered (droplet)", default: null, holder: "droplet",
      row: { id: 9001, holder: "droplet", status: "open" }, eligible: ["droplet", "gpu-wsl", "lab-ovh"], needs: [] },
    { step: "review", mandatory: true, state: "offered (science-claude)", default: null,
      holder: "science-claude", row: { id: 9002, holder: "science-claude", status: "open" },
      eligible: ["gpu-wsl", "science-claude"], needs: [] },
    GRAPH_MISSING.steps[3],
  ],
  missing: [], flow: { confirmed: true, unconfirmed: [], defaults: {}, confirm_with: "" },
  stage_implied: "build (graph filled, work open)",
};
const DETAIL_409 = "step review: science-claude is not in the live eligible set [gpu-wsl] once " +
  "build→droplet hold their steps (distinct_from) — nothing minted; the default is derived, not chosen";

const ok = (body) => ({ ok: true, status: 200, statusText: "OK", json: async () => body });
const fail = (status, statusText, detail) =>
  ({ ok: false, status, statusText, json: async () => ({ detail }) });

// graphs: the successive GET /graph replies (the last one repeats).
// confirmReply: the POST /flow/confirm reply.
function makeCtx({ graphs = [ok(GRAPH_MISSING)], confirmReply = ok({ minted: [] }) } = {}) {
  const calls = [], statuses = [], confirms = [];
  const detail = makeEl("div");
  let g = 0;
  const ctx = {
    calls, statuses, confirms, detail,
    document: { createElement: (tag) => makeEl(tag) },
    $: (sel) => (sel === "#tools-card-detail" ? detail : makeEl("div")),
    setStatus(text, cls = "") { statuses.push({ text, cls }); },
    confirm(msg) { confirms.push(msg); return true; },
    state: { token: "tok", base: "http://stub.invalid" },
    ssoActive: false,
    selfNode() { return "commander"; },
    fetch: async (url, opts) => {
      const u = String(url);
      calls.push({ url: u, method: (opts && opts.method) || "GET", body: opts && opts.body });
      if (u.endsWith("/board/cards/7"))
        return ok({ id: 7, title: "step graph", stage: "build", assignee: "lab-ovh", thread_uuid: "thr-7" });
      if (u.includes("/board/cards/7/thread")) return ok({ messages: [] });
      if (u.endsWith("/board/cards/7/graph")) return graphs[Math.min(g++, graphs.length - 1)];
      if (u.endsWith("/board/cards/7/flow/confirm")) return confirmReply;
      return ok({});
    },
  };
  vm.createContext(ctx);
  // The real api() and the whole tools section, as app.js ships them.
  vm.runInContext(
    slice("async function api(", "// ---------- SSO (Meta-Edge identity)") + "\n" +
    slice("// ---------- tools (card #1018) ----------", "async function refreshToolsChannels(") + "\n",
    ctx);
  return ctx;
}
async function openCard(opts) {
  const ctx = makeCtx(opts);
  await ctx.openToolsCard(7);
  await flush();
  return ctx;
}
const graphGets = (ctx) => ctx.calls.filter((c) => c.method === "GET" && c.url.endsWith("/graph"));
const posts = (ctx) => ctx.calls.filter((c) => c.method === "POST" && c.url.endsWith("/flow/confirm"));

const failures = [];
async function check(name, fn) {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (e) { failures.push(name); console.log(`FAIL ${name}\n     ${e.message.split("\n")[0]}`); }
}

await check("openToolsCard fetches the graph and renders one line per step", async () => {
  const ctx = await openCard();
  assert.equal(graphGets(ctx).length, 1, "RED: GET /board/cards/7/graph is fetched once");
  assert.equal(graphGets(ctx)[0].url, "http://stub.invalid/board/cards/7/graph");
  const got = lines(ctx.detail);
  for (const want of [
    "spec · M · closed:pass · lab-ovh",
    "build · M · missing · default → droplet · eligible: droplet, gpu-wsl, lab-ovh",
    "review · M · missing · default → gpu-wsl · eligible: gpu-wsl, science-claude",
    "docs · opt · not-taken · —",
  ]) assert.ok(got.includes(want), `step line "${want}" missing; got ${JSON.stringify(got)}`);
  assert.ok(textOf(ctx.detail).includes("flow: UNCONFIRMED — missing: build, review"),
    "the flow line names what is missing");
  assert.ok(find(ctx.detail, (c) => c.tag === "button" && c.textContent === "Move").length,
    "the existing action rows still render");
});

await check("no Confirm flow button when missing is empty", async () => {
  const ctx = await openCard({ graphs: [ok(GRAPH_FILLED)] });
  assert.ok(find(ctx.detail, (c) => c.textContent === "flow: CONFIRMED").length,
    "RED: a filled graph reads flow: CONFIRMED");
  assert.ok(lines(ctx.detail).includes("build · M · offered (droplet) · droplet · eligible: droplet, gpu-wsl, lab-ovh"),
    "a step with a row shows its holder, not a default");
  assert.equal(confirmBtn(ctx.detail), undefined, "no Confirm flow button when nothing is missing");
  assert.equal(find(ctx.detail, (c) => c.tag === "select" && (c.attrs["aria-label"] || "").startsWith("Holder")).length,
    0, "no holder selects when nothing is missing");
});

await check("a button and one select per missing step, pre-selected to its default", async () => {
  const ctx = await openCard();
  assert.ok(confirmBtn(ctx.detail), "RED: Confirm flow button shown when steps are missing");
  const sels = find(ctx.detail, (c) => c.tag === "select" && (c.attrs["aria-label"] || "").startsWith("Holder"));
  assert.deepEqual(sels.map((s) => s.attrs["aria-label"]), ["Holder for build", "Holder for review"]);
  assert.deepEqual(sels[0].children.map((o) => o.value), ["droplet", "gpu-wsl", "lab-ovh"]);
  assert.deepEqual(sels[1].children.map((o) => o.value), ["gpu-wsl", "science-claude"]);
  assert.equal(sels[0].value, "droplet", "build pre-selects its derived default");
  assert.equal(sels[1].value, "gpu-wsl", "review pre-selects its derived default");
  assert.ok(find(ctx.detail, (c) => c.tag === "input" && c.attrs["aria-label"] === "What").length,
    "an optional what input");
});

await check("the POST body carries only the overridden holders", async () => {
  const ctx = await openCard();
  const sels = find(ctx.detail, (c) => c.tag === "select" && (c.attrs["aria-label"] || "").startsWith("Holder"));
  assert.equal(sels.length, 2, "RED: two holder selects");
  sels[1].value = "science-claude";          // override review; build stays on its default
  find(ctx.detail, (c) => c.tag === "input" && c.attrs["aria-label"] === "What")[0].value = "  ship #1201  ";
  confirmBtn(ctx.detail).fire("click");
  await flush();
  assert.equal(ctx.confirms.length, 1, "the write confirm()s first");
  assert.equal(posts(ctx).length, 1, "exactly one POST");
  assert.equal(posts(ctx)[0].url, "http://stub.invalid/board/cards/7/flow/confirm");
  assert.deepEqual(JSON.parse(posts(ctx)[0].body),
    { actor: "commander", holders: { review: "science-claude" }, what: "ship #1201" },
    "holders names review only; build's default is not sent as an override");
  // Control: nothing changed -> empty holders, and a blank what is not sent.
  const ctx2 = await openCard();
  confirmBtn(ctx2.detail).fire("click");
  await flush();
  assert.deepEqual(JSON.parse(posts(ctx2)[0].body), { actor: "commander", holders: {} });
});

await check("a 409 renders its detail in full and nothing reads as success", async () => {
  const ctx = await openCard({ confirmReply: fail(409, "Conflict", DETAIL_409) });
  const btn = confirmBtn(ctx.detail);
  assert.ok(btn, "RED: Confirm flow button shown");
  btn.fire("click");
  await flush();
  const res = resultOf(ctx.detail);
  const err = find(res, (c) => (c.className || "").includes("tools-err"))[0];
  assert.ok(err, "the refusal renders as an error");
  assert.ok(err.textContent.includes(`409 Conflict — ${DETAIL_409}`),
    `the gateway detail is shown in full; got "${err.textContent}"`);
  assert.ok(!/→ #\d/.test(textOf(res)), "no minted row is shown");
  assert.ok(!find(ctx.detail, (c) => c.textContent === "flow: CONFIRMED").length, "no CONFIRMED line");
  assert.ok(!ctx.statuses.some((s) => s.cls === "ok"), "no ok status");
  assert.equal(ctx.statuses.at(-1).cls, "err", "the status bar reads err");
  assert.equal(graphGets(ctx).length, 1, "a refused confirm does not re-render the graph");
  assert.equal(confirmBtn(ctx.detail), btn, "the same button is still there");
  assert.equal(btn.disabled, false, "and usable");
  btn.fire("click");
  await flush();
  assert.equal(posts(ctx).length, 2, "a second tap sends again");
});

await check("minted ids are rendered and the graph is re-fetched", async () => {
  const minted = [
    { step: "build", id: 9001, holder: "droplet", state: "offered (droplet)", accept: "a PR url" },
    { step: "review", id: 9002, holder: "science-claude", state: "offered (science-claude)", accept: "a review" },
  ];
  const ctx = await openCard({
    graphs: [ok(GRAPH_MISSING), ok(GRAPH_FILLED)],
    confirmReply: ok({ card_id: 7, by: "commander", at: "2026-10-17T00:00:00+00:00", minted,
      plan: [{ step: "build", holder: "droplet" }, { step: "review", holder: "science-claude" }],
      flow: GRAPH_FILLED.flow, stage: "build" }),
  });
  assert.ok(confirmBtn(ctx.detail), "RED: Confirm flow button shown");
  confirmBtn(ctx.detail).fire("click");
  await flush();
  const res = textOf(resultOf(ctx.detail));
  assert.ok(res.includes("build → #9001 droplet"), `minted build row listed; got ${JSON.stringify(res)}`);
  assert.ok(res.includes("review → #9002 science-claude"), "minted review row listed");
  assert.equal(graphGets(ctx).length, 2, "the graph is fetched again after the confirm");
  assert.ok(find(ctx.detail, (c) => c.textContent === "flow: CONFIRMED").length,
    "the re-rendered graph reads CONFIRMED");
  assert.equal(confirmBtn(ctx.detail), undefined, "the button is gone once nothing is missing");
  assert.ok(lines(ctx.detail).includes("review · M · offered (science-claude) · science-claude · eligible: gpu-wsl, science-claude"));
  assert.equal(ctx.statuses.at(-1).text, "flow #7: 2 minted");
});

await check("minted: [] says so and never reads as confirmed", async () => {
  const ctx = await openCard({ confirmReply: ok({ card_id: 7, minted: [], plan: [], flow: GRAPH_MISSING.flow }) });
  assert.ok(confirmBtn(ctx.detail), "RED: Confirm flow button shown");
  confirmBtn(ctx.detail).fire("click");
  await flush();
  const res = textOf(resultOf(ctx.detail));
  assert.match(res, /nothing minted/, "an empty minted[] is stated");
  assert.ok(!/confirmed/i.test(res), `no "confirmed" without ids; got ${JSON.stringify(res)}`);
  assert.ok(!ctx.statuses.some((s) => s.cls === "ok"), "no ok status for zero rows");
});

await check("a graph fetch failure reads graph unavailable: <detail>, never blank", async () => {
  const ctx = await openCard({ graphs: [fail(500, "Internal Server Error", "database is locked")] });
  assert.ok(textOf(ctx.detail).includes("graph unavailable: 500 Internal Server Error — database is locked"),
    "RED: the failure is shown with its detail");
  assert.ok(find(ctx.detail, (c) => c.tag === "button" && c.textContent === "Move").length,
    "the action rows still render");
  const ctx2 = await openCard({ graphs: [ok({ card_id: 7 })] });
  assert.ok(textOf(ctx2.detail).includes("graph unavailable: response has no steps[] or missing[]"),
    "a body without steps[]/missing[] is not rendered as an empty graph");
});

await check("the graph section is built with DOM APIs, never innerHTML", async () => {
  assert.ok(extract("openToolsCard").includes("toolsGraphSection("), "RED: openToolsCard mounts the graph section");
  const section = slice("// ---------- step graph + Confirm flow (card #1201) ----------",
    "// ---------- end step graph + Confirm flow (card #1201) ----------");
  assert.ok(!/\.(innerHTML|outerHTML|insertAdjacentHTML)\b/.test(section),
    "no markup sink in the graph section");
});

if (failures.length) {
  console.log(`1201 confirm flow tests: ${failures.length} failed`);
  process.exit(1);
}
console.log("1201 confirm flow tests: all passed");
