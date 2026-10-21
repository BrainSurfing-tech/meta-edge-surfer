// A resume after the 1 h token expiry gets three 401s at once (the You tab's
// lists). They must share ONE /auth/identity-token request.
// Run: node test_one_token_refresh.mjs
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const src = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const start = src.indexOf("let _tokenFetch");
assert.ok(start >= 0, "RED: ssoIdentityToken has no shared in-flight request");
const end = src.indexOf("async function fetchIdentityToken(");
const ctx = { fetches: 0, release: null };
ctx.fetchIdentityToken = () => { ctx.fetches++; return new Promise((r) => { ctx.release = r; }); };
vm.createContext(ctx);
vm.runInContext(src.slice(start, end) + "\nthis.ssoIdentityToken = ssoIdentityToken;", ctx);

const calls = [ctx.ssoIdentityToken(), ctx.ssoIdentityToken(), ctx.ssoIdentityToken()];
assert.equal(ctx.fetches, 1, "RED: three 401s sent three token requests");
ctx.release("tok-1");
assert.deepEqual(await Promise.all(calls), ["tok-1", "tok-1", "tok-1"]);
ctx.ssoIdentityToken();
assert.equal(ctx.fetches, 2, "RED: a later 401 must fetch a fresh token");
ctx.release("tok-2");
console.log("ok: concurrent 401s share one token request; a later one fetches again");
