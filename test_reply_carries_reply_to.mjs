// Inbox Reply: the send carries reply_to (the DM replied to) and its thread_id.
// Run: node test_reply_carries_reply_to.mjs
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const src = readFileSync(new URL("./app.js", import.meta.url), "utf8");
function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name}() not found`);
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
}
const apiSendSrc = src.slice(src.indexOf("const apiSend ="), src.indexOf("// Lab's ask for a row"));
const ctx = { sent: null, selfNode: () => "commander",
  api: (path, opts) => { ctx.sent = JSON.parse(opts.body); return {}; } };
vm.runInNewContext(`${extract("replyFields")}\n${apiSendSrc}\nthis.replyFields = replyFields; this.apiSend = apiSend;`, ctx);

const reply = { peer: "lab-ovh", id: 76534, thread_id: "c68e0466" };
assert.deepEqual({ ...ctx.replyFields(reply, "lab-ovh") }, { thread_id: "c68e0466", reply_to: 76534 });
assert.deepEqual({ ...ctx.replyFields(reply, "droplet") }, { thread_id: null, reply_to: null },
  "recipient changed: no reply fields");
assert.deepEqual({ ...ctx.replyFields(null, "lab-ovh") }, { thread_id: null, reply_to: null });

const { thread_id, reply_to } = ctx.replyFields(reply, "lab-ovh");
ctx.apiSend("lab-ovh", "answer", "typed answer", [], thread_id, reply_to);
assert.equal(ctx.sent.reply_to, 76534);
assert.equal(ctx.sent.thread_id, "c68e0466");
ctx.apiSend("lab-ovh", "answer", "fresh message", [], null, null);
assert.ok(!("reply_to" in ctx.sent) && !("thread_id" in ctx.sent), "plain send unchanged");

assert.ok(src.includes("replyTo(m.from_node, m);"), "inbox Reply passes the message");
console.log("ok test_reply_carries_reply_to");
