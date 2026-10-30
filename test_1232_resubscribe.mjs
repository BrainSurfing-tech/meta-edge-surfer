// card #1232 — an old push subscription must be dropped before the new VAPID key.
// Run: node test_1232_resubscribe.mjs
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const appSrc = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const subFn = appSrc.slice(
  appSrc.indexOf("function urlBase64ToUint8Array"),
  appSrc.indexOf("async function testConnection"),
);
assert.ok(subFn.includes("async function subscribePhonePush"), "settings subscribe is missing");

function harness(subscribeImpl, { existing = false } = {}) {
  const out = { textContent: "asking…" };
  const calls = [];
  const existingSub = existing
    ? { unsubscribe: async () => { calls.push("unsubscribe"); return true; } }
    : null;
  const Notification = { requestPermission: async () => "granted" };
  const ctx = vm.createContext({
    window: { PushManager: function PushManager() {}, Notification },
    Notification,
    navigator: {
      serviceWorker: {
        ready: Promise.resolve({
          pushManager: {
            getSubscription: async () => {
              calls.push("getSubscription");
              return existingSub;
            },
            subscribe: async (opts) => {
              calls.push("subscribe");
              return subscribeImpl(opts);
            },
          },
        }),
      },
    },
    fetch: async (url) => {
      assert.equal(url, "https://gw.example/push/vapid-public-key");
      return { ok: true, json: async () => ({ public_key: "AQAB" }) };
    },
    api: async () => { calls.push("post"); },
    state: { base: "https://gw.example" },
    $: (id) => (id === "#cfg-push-result" ? out : { textContent: "" }),
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    Uint8Array,
  });
  return { ctx, out, calls };
}

const fresh = { toJSON: () => ({ endpoint: "https://push.example/1", keys: { p256dh: "p", auth: "a" } }) };

{
  const { ctx, out, calls } = harness(() => fresh, { existing: true });
  await vm.runInContext(`${subFn}\nsubscribePhonePush()`, ctx);
  const unsubAt = calls.indexOf("unsubscribe");
  const subAt = calls.indexOf("subscribe");
  assert.ok(calls.includes("getSubscription"), "subscribe must read the current subscription");
  assert.ok(unsubAt !== -1 && subAt !== -1 && unsubAt < subAt,
    "an old subscription must be removed before subscribe");
  assert.equal(out.textContent, "phone notifications on");
}

{
  const message = "Failed to execute 'subscribe' on 'PushManager': InvalidStateError";
  const { ctx, out, calls } = harness(() => { throw new Error(message); }, { existing: true });
  let rejected = false;
  try {
    await vm.runInContext(`${subFn}\nsubscribePhonePush()`, ctx);
  } catch {
    rejected = true;
  }
  assert.equal(rejected, false, "a subscribe error must be shown, not thrown out");
  assert.equal(out.textContent, message);
  assert.equal(out.textContent.includes("asking"), false);
  assert.ok(calls.indexOf("unsubscribe") !== -1 && calls.indexOf("unsubscribe") < calls.indexOf("subscribe"));
}

console.log("test_1232_resubscribe: passed");
