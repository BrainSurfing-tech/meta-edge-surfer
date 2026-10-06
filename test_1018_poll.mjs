// card #1018 / obligation #1130 — the You tab polls on ONE timer,
// gated on visibility: nothing fires while hidden, and returning to
// foreground refreshes at once. Run: node test_1018_poll.mjs
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const src = readFileSync(new URL("./app.js", import.meta.url), "utf8");

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
assert.ok(src.includes("visibilityState"),
  "RED: the poll loop has no visibility gate");
assert.ok(src.includes("visibilitychange"),
  "RED: nothing refreshes on return to foreground");
assert.equal(
  (src.match(/setInterval\(tick/g) || []).length, 1,
  "one timer only: a second setInterval double-fires the 30 s clause");

function sandbox() {
  const listeners = {};
  const timers = new Map();
  let now = 0, seq = 1;
  const ctx = {
    state: { token: "tok", pollSec: 30, pollTimer: null },
    youActive: true,
    inboxActive: false,
    actions: 0,
    inbox: 0,
    document: {
      get visibilityState() { return ctx._visible ? "visible" : "hidden"; },
      addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    },
    _visible: true,
    $(sel) {
      const on = (sel === "#view-actions" && ctx.youActive)
        || (sel === "#view-inbox" && ctx.inboxActive);
      return { classList: { contains(c) { return on && c === "active"; } } };
    },
    refreshActions() { ctx.actions++; },
    refreshInbox() { ctx.inbox++; },
    setInterval(fn, ms) { const id = seq++; timers.set(id, { fn, ms, at: now + ms }); return id; },
    clearInterval(id) { timers.delete(id); },
    fireVisibility() { for (const fn of listeners.visibilitychange || []) fn(); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) {
          if (t.at <= end && (next === null || t.at < next[1].at)) next = [id, t];
        }
        if (next === null) break;
        now = next[1].at;
        next[1].fn();
        if (timers.get(next[0]) === next[1]) next[1].at += next[1].ms;
      }
      now = end;
    },
  };
  return ctx;
}

function load(ctx) {
  vm.createContext(ctx);
  vm.runInContext(
    `${extract("startPollLoop")}\n${extract("handleVisibilityChange")}`,
    ctx);
  // The wire block registers the visibility listener at boot; mirror it.
  ctx.document.addEventListener("visibilitychange",
    () => ctx.handleVisibilityChange());
}

// 1. visible + You active: one refresh at start, exactly one per 30 s.
{
  const ctx = sandbox();
  load(ctx);
  ctx.startPollLoop();
  assert.equal(ctx.actions, 1, "refresh at once on start");
  ctx.advance(30000);
  assert.equal(ctx.actions, 2, "exactly one refresh per 30 s");
  ctx.advance(60000);
  assert.equal(ctx.actions, 4);
}

// 2. hidden: the timer fires but nothing refreshes.
{
  const ctx = sandbox();
  load(ctx);
  ctx._visible = false;
  ctx.startPollLoop();
  assert.equal(ctx.actions, 0, "no refresh at start while hidden");
  ctx.advance(90000);
  assert.equal(ctx.actions, 0, "RED: polling while hidden");
  assert.equal(ctx.inbox, 0);
}

// 3. return to foreground: one immediate refresh, then the cadence resumes.
{
  const ctx = sandbox();
  load(ctx);
  ctx._visible = false;
  ctx.startPollLoop();
  ctx.advance(90000);
  assert.equal(ctx.actions, 0);
  ctx._visible = true;
  ctx.fireVisibility();
  assert.equal(ctx.actions, 1, "refresh at once on visible");
  ctx.advance(30000);
  assert.equal(ctx.actions, 2);
}

// 4. other views: the You refresh does not fire for the inbox tab.
{
  const ctx = sandbox();
  load(ctx);
  ctx.youActive = false;
  ctx.inboxActive = true;
  ctx.startPollLoop();
  assert.equal(ctx.actions, 0);
  assert.equal(ctx.inbox, 1);
}

// 5. fire visibilitychange while hidden: zero refreshes.
{
  const ctx = sandbox();
  load(ctx);
  ctx._visible = false;
  ctx.startPollLoop();
  ctx.advance(60000);
  ctx.fireVisibility();
  ctx.advance(60000);
  assert.equal(ctx.actions, 0, "RED: refresh on a hidden visibilitychange");
  assert.equal(ctx.inbox, 0);
}

// 6. the tick's own refresh skips an unchanged payload: wire the real
// refreshActions into the tick, so a forced refresh in the tick turns red.
{
  const payload = { messages: [], cards: [] };
  const ctx = sandbox();
  ctx.selfNode = () => "commander";
  ctx.setStatus = () => {};
  ctx.renders = 0;
  ctx.renderActions = () => { ctx.renders++; };
  ctx.api = async () => JSON.parse(JSON.stringify(payload));
  ctx.newestBoardDm = () => null;
  ctx.parseBoardDm = () => null;
  ctx.dedupeYou = (g) => g;
  ctx._CLOSED_STAGES = new Set(["done", "parked"]);
  vm.createContext(ctx);
  vm.runInContext(
    `let _you = null;\nlet _youSig = null;\n` +
    `function renderYou() { if (!_you) return; renderActions({}); }\n` +
    `${extract("attachBoundRows")}\n${extract("refreshActions")}`,
    ctx);
  // The tick resolves refreshActions to the real one above: four timer
  // firings with an identical payload must render exactly once — a forced
  // refresh in the tick would render four times and turn this red.
  load(ctx);
  ctx.startPollLoop();
  ctx.advance(90000);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ctx.renders, 1, "RED: tick re-renders an unchanged payload");
}

// 7. an unchanged payload does not re-render.
{
  const payload = { messages: [], cards: [] };
  const ctx = sandbox();
  ctx.selfNode = () => "commander";
  ctx.setStatus = () => {};
  ctx.renders = 0;
  ctx.renderActions = () => { ctx.renders++; };
  ctx.api = async () => JSON.parse(JSON.stringify(payload));
  ctx.newestBoardDm = () => null;
  ctx.parseBoardDm = () => null;
  ctx.dedupeYou = (g) => g;
  ctx._CLOSED_STAGES = new Set(["done", "parked"]);
  vm.createContext(ctx);
  vm.runInContext(
    `let _you = null;\nlet _youSig = null;\n` +
    `function renderYou() { if (!_you) return; renderActions({}); }\n` +
    `${extract("attachBoundRows")}\n${extract("refreshActions")}`,
    ctx);
  await ctx.refreshActions();
  await ctx.refreshActions();
  assert.equal(ctx.renders, 1, "RED: re-render on an unchanged payload");
}

console.log("1018 poll tests: all passed");
