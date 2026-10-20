// card #1230 — a push shows the board row, never the payload, and never nothing.
// Run: node test_1230_push.mjs
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const swSrc = readFileSync(new URL("./sw.js", import.meta.url), "utf8");
const appSrc = readFileSync(new URL("./app.js", import.meta.url), "utf8");

function loadWorker(fetchImpl) {
  const listeners = {};
  const shown = [];
  const opened = [];
  const self = {
    location: new URL("https://app.metaedge.surf/"),
    clients: {
      openWindow: async (url) => { opened.push(url); },
      claim() {},
    },
    registration: {
      showNotification: async (title, opts = {}) => { shown.push({ title, ...opts }); },
    },
    skipWaiting() {},
    addEventListener(name, fn) { (listeners[name] ||= []).push(fn); },
  };
  const ctx = vm.createContext({
    self,
    fetch: fetchImpl,
    caches: { open: async () => ({ addAll: async () => {} }), keys: async () => [] },
    URL,
    console,
  });
  vm.runInContext(swSrc, ctx, { filename: "sw.js" });
  return { listeners, shown, opened };
}

function pushEvent(payload) {
  const waits = [];
  return {
    data: payload == null ? null : { json: () => payload },
    waitUntil(p) { waits.push(p); },
    done: () => Promise.all(waits),
  };
}

async function firePush(fetchImpl, payload) {
  const worker = loadWorker(fetchImpl);
  assert.ok(worker.listeners.push && worker.listeners.push.length,
    "sw.js has no push handler, so a push shows nothing");
  const ev = pushEvent(payload);
  for (const fn of worker.listeners.push) fn(ev);
  await ev.done();
  return worker;
}

const secret = "SECRET DM body that must never be shown";

const shownFromBoard = await firePush(async (url, opts) => {
  assert.equal(url, "/gw/push/render/7?msg=9");
  assert.equal(opts.credentials, "include");
  return {
    ok: true,
    json: async () => ({ card_id: 1230, title: "Ship or hold?", label: "Ship" }),
  };
}, { row_id: 7, msg_id: 9, title: secret, body: secret, text: secret });

assert.equal(shownFromBoard.shown.length, 1);
assert.equal(shownFromBoard.shown[0].title, "Ship or hold?");
assert.equal(shownFromBoard.shown[0].body, "Ship");
assert.equal(JSON.stringify(shownFromBoard.shown).includes(secret), false,
  "notification rendered payload text");

const failedRow = await firePush(async () => ({ ok: false, json: async () => ({}) }), {
  row_id: 7, msg_id: 9, title: secret,
});
assert.equal(failedRow.shown.length, 1, "a failed row showed nothing");
assert.equal(failedRow.shown[0].title, "board: open rows");
assert.equal(failedRow.shown[0].body, "");
assert.equal(JSON.stringify(failedRow.shown).includes(secret), false);

const thrown = await firePush(async () => { throw new Error("offline"); }, {
  row_id: 7, msg_id: 9, title: secret,
});
assert.equal(thrown.shown.length, 1, "a failed fetch showed nothing");
assert.equal(thrown.shown[0].title, "board: open rows");

const noLabel = await firePush(async () => ({
  ok: true,
  json: async () => ({ card_id: 1, title: "Ship or hold?", label: null }),
}), { row_id: 7, msg_id: 9, body: secret });
assert.equal(noLabel.shown[0].title, "Ship or hold?");
assert.equal(noLabel.shown[0].body, "");

const worker = loadWorker(async () => ({ ok: false }));
const clickWaits = [];
const click = {
  notification: {
    data: { row_id: 7, msg_id: 9 },
    close() {},
  },
  waitUntil(p) { clickWaits.push(p); },
};
for (const fn of worker.listeners.notificationclick || []) fn(click);
await Promise.all(clickWaits);
assert.equal(worker.opened.length, 1);
const opened = new URL(worker.opened[0]);
assert.equal(opened.searchParams.get("view"), "actions");
assert.equal(opened.searchParams.get("row"), "7");
assert.equal(swSrc.includes("sendBoardDecisionAndClose"), false);

const posts = [];
const subFn = appSrc.slice(appSrc.indexOf("function urlBase64ToUint8Array"), appSrc.indexOf("async function testConnection"));
assert.ok(subFn.includes("async function subscribePhonePush"), "settings subscribe is missing");
const calls = { permission: 0, subscribe: 0 };
const Notification = { requestPermission: async () => { calls.permission += 1; return "granted"; } };
const ctx = vm.createContext({
  window: { PushManager: function PushManager() {}, Notification },
  Notification,
  navigator: {
    serviceWorker: { ready: Promise.resolve({
      pushManager: { subscribe: async (opts) => {
        calls.subscribe += 1;
        assert.equal(opts.userVisibleOnly, true);
        return { toJSON: () => ({ endpoint: "https://push.example/1", keys: { p256dh: "p", auth: "a" } }) };
      } },
    }) },
  },
  fetch: async (url) => {
    assert.equal(url, "https://gw.example/push/vapid-public-key");
    return { ok: true, json: async () => ({ public_key: "AQAB" }) };
  },
  api: async (path, opts) => { posts.push({ path, opts }); },
  state: { base: "https://gw.example" },
  $: () => ({ textContent: "" }),
  atob: (s) => Buffer.from(s, "base64").toString("binary"),
  Uint8Array,
});
await vm.runInContext(`${subFn}\nsubscribePhonePush()`, ctx);
assert.equal(calls.permission, 1);
assert.equal(calls.subscribe, 1);
assert.equal(posts.length, 1);
assert.equal(posts[0].path, "/push/subscriptions");
assert.equal(posts[0].opts.method, "POST");

console.log("test_1230_push: passed");
