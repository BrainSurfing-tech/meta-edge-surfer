// Meta-Edge Surfer — vanilla SPA for the OMEGA mesh.
// Three views: Inbox / Send / 48h Highlights. Plus a Settings tab for the
// bearer token + base URL. State lives in localStorage; all API calls go
// to mesh-gateway with bearer auth.

const LS = {
  base: "mes.base",
  token: "mes.token",
  poll: "mes.poll",
  expanded: "mes.expanded",  // session set of expanded msg ids
  pendingInvite: "mes.pendingInvite",  // invite token surviving the SSO round-trip
};

// On a public HTTPS front the gateway is reached same-origin via the /gw relay
// (the firewalled :8788 isn't publicly reachable). Dev/tailnet keeps :8788 direct.
const DEFAULT_BASE = location.protocol === "https:"
  ? `${location.origin}/gw`
  : `${location.protocol}//${location.hostname}:8788`;
const COMMANDER = "commander";
const KIND_LABELS = ["fyi", "answer", "question", "status", "unblock"];

// The node this session acts as. When signed in via Meta-Edge SSO it is STRICTLY
// the logged-in member's own canonical node (state.ssoNode, e.g. "claire-mbp#0001")
// and NEVER the "commander" literal — an under-provisioned member (issuer /auth/me
// returned no node) gets an empty node, surfaced as a clear "not provisioned" error
// before any send (the gateway also fail-closes: from_node="" != auth.node -> 403),
// rather than silently impersonating the commander. Only the legacy manual/shared
// or root-token path (no SSO session) degrades to "commander" so the commander's
// shared-token use stays byte-identical.
function selfNode() { return ssoActive ? (state.ssoNode || "") : (state.ssoNode || COMMANDER); }

// Same bounds as Settings. A stored 0 is out of range and comes up as 10,
// not as the blank-field default of 30.
function clampPollSeconds(raw) {
  const n = parseInt(raw, 10);
  if (!isFinite(n)) return 30;
  return Math.max(10, Math.min(600, n));
}

// ---------- state ----------
const state = {
  base: localStorage.getItem(LS.base) || DEFAULT_BASE,
  token: localStorage.getItem(LS.token) || "",
  pollSec: clampPollSeconds(localStorage.getItem(LS.poll) || "30"),
  pollTimer: null,
  peers: [],          // populated after first /peers fetch
  inbox: [],          // most recent first
  expanded: new Set(),
};

// True once a Meta-Edge SSO session is driving state.token (vs a manual paste).
let ssoActive = false;

// Migrate a base saved before the /gw relay existed: a public HTTPS front can't
// reach the firewalled :8788 directly, so rewrite it to the same-origin relay.
if (location.protocol === "https:" && /:8788\/?$/.test(state.base)) {
  state.base = `${location.origin}/gw`;
  localStorage.setItem(LS.base, state.base);
}

// ---------- tiny helpers ----------
function $(sel, root = document) { return root.querySelector(sel); }
function $$(sel, root = document) { return [...root.querySelectorAll(sel)]; }
function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const now = Date.now();
  const ago = (now - d.getTime()) / 1000;
  if (ago < 60) return `${Math.floor(ago)}s ago`;
  if (ago < 3600) return `${Math.floor(ago / 60)}m ago`;
  if (ago < 86400) return `${Math.floor(ago / 3600)}h ago`;
  return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
// Humanize the common cron shapes; fall back to the raw expr otherwise.
const _DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function humanizeCron(expr) {
  if (typeof expr !== "string") return "";
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return expr;
  const [min, hr, dom, mon, dow] = f;
  const time = (/^\d+$/.test(hr) && /^\d+$/.test(min))
    ? `${hr.padStart(2, "0")}:${min.padStart(2, "0")} UTC` : null;
  if (time && dom === "*" && mon === "*" && /^[0-6]$/.test(dow)) return `${_DOW[+dow]} ${time}`;
  if (time && dom === "*" && mon === "*" && dow === "*") return `daily ${time}`;
  return expr;
}

function setStatus(text, cls = "") {
  const el = $("#status");
  el.textContent = text;
  el.className = "status " + cls;
}

// ---------- API ----------
async function api(path, opts = {}) {
  if (!state.token) throw new Error("no token configured — open Settings");
  const url = state.base.replace(/\/$/, "") + path;
  const doFetch = () => {
    const headers = { "Authorization": "Bearer " + state.token, ...(opts.headers || {}) };
    if (opts.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    return fetch(url, { ...opts, headers });
  };
  let res = await doFetch();
  // SSO identity tokens are short-lived: refresh once on 401 and retry.
  if (res.status === 401 && ssoActive) {
    const tok = await ssoIdentityToken();
    if (tok) { state.token = tok; res = await doFetch(); }
  }
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).detail || ""; } catch {}
    throw new Error(`${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`);
  }
  return res.json();
}

// ---------- SSO (Meta-Edge identity) ----------
// The auth backend (meta-edge-auth) is same-origin /auth/* in production (nginx).
// Login sets an httpOnly cookie; we exchange it for a short-lived RS256 identity
// JWT held in MEMORY (never localStorage — it's a gateway-trusted bearer).
// Degrades silently to the manual token when no auth backend is present (dev).
async function ssoIdentityToken() {
  try {
    const r = await fetch("/auth/identity-token", { credentials: "include" });
    if (!r.ok) return null;
    return (await r.json()).token || null;
  } catch { return null; }
}
async function trySsoBoot() {
  try {
    const me = await fetch("/auth/me", { credentials: "include" });
    if (!me.ok) return false;
    const info = await me.json();
    if (!info.authenticated) return false;
    const tok = await ssoIdentityToken();
    if (!tok) return false;
    state.token = tok;        // in memory only — never localStorage
    state.ssoLogin = info.login || "";
    state.ssoProvider = info.provider || "";
    state.ssoNode = info.node || "";            // canonical node = from_node for all posts
    state.ssoDisplay = info.display_name || ""; // cosmetic only — zero access effect
    state.ssoRole = info.role || "member";      // advisory — gates SHOWING the admin
                                                // Invite control only; the issuer
                                                // re-checks admin server-side (INV3).
    ssoActive = true;
    return true;
  } catch { return false; }
}
async function ssoLogout() {
  try { await fetch("/auth/logout", { method: "POST", credentials: "include" }); } catch {}
  ssoActive = false;
  state.token = "";
}

// ---------- invites (issuer /auth/invite*) ----------
// All invite calls go to the same-origin auth backend (cookie session), NOT the
// gateway. Admin-only mint + non-consuming preview + the post-SSO claim.
async function ssoCreateInvite(email, cells, role) {
  const r = await fetch("/auth/invite", {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, cells, role }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.detail || `${r.status}`);
  return j;   // { invite, link, email, cells, role, expires_in }
}
// A signed JWT has two dots (header.payload.sig); an opaque handle (token_urlsafe)
// has none. New links carry a handle; a legacy ?invite=<jwt> link is still honored.
// (Inlined per-function so each stays self-contained.)
async function ssoInviteInfo(val) {
  try {
    // F7: the browser holds only the opaque handle; the issuer resolves it to the
    // signed JWT server-side. No JWT ever rides in a URL (history/Referer-safe).
    const isJwt = (val.match(/\./g) || []).length === 2;
    const q = isJwt ? `invite=${encodeURIComponent(val)}`
                    : `h=${encodeURIComponent(val)}`;
    const r = await fetch(`/auth/invite/info?${q}`, { credentials: "include" });
    if (!r.ok) return null;
    return await r.json();   // { email, cells, role, fractal }
  } catch { return null; }
}
async function ssoClaimInvite(val) {
  // opaque handle (resolved server-side) | legacy raw JWT in the POST body.
  const isJwt = (val.match(/\./g) || []).length === 2;
  const r = await fetch("/auth/invite/claim", {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(isJwt ? { invite: val } : { handle: val }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    // Carry the HTTP status on the error so the caller can distinguish a
    // terminal 4xx (drop the invite) from a transient 5xx (keep it) WITHOUT
    // string-matching e.message — the body's `detail` masks the status code.
    const err = new Error(j.detail || `${r.status}`);
    err.status = r.status;
    throw err;
  }
  return j;   // { claimed, node, role, cells }
}

// Capture an invite HANDLE from the landing URL (/join?h=… ) and persist it so it
// survives the SSO redirect round-trip (which returns to "/"). F7: the link carries
// an opaque handle, not the signed JWT; the issuer resolves it server-side. A legacy
// ?invite=<jwt> link is still honored as a fallback. Strips it from the address bar
// so a manual refresh doesn't re-trigger.
function captureInviteFromUrl() {
  const params = new URLSearchParams(location.search);
  const tok = params.get("h") || params.get("invite");
  if (tok) {
    localStorage.setItem(LS.pendingInvite, tok);
    const clean = location.pathname.replace(/\/join$/, "/") || "/";
    history.replaceState(null, "", clean);
  }
}

// A brand-new (not-yet-allowlisted) invitee is authorized by the invite ITSELF, so
// the invite must ride THROUGH the SSO start: the issuer stashes it server-side and
// claims it inline on the callback (otherwise the un-allowlisted login is a 403
// before any client-side claim can run). Point each sign-in button at
// /auth/<provider>/start?h=<handle> (or ?invite=<jwt> for a legacy value) so the
// canonical /join link actually onboards a new member. Returns true if wired.
function wireInviteIntoSignIn(val) {
  const isJwt = (val.match(/\./g) || []).length === 2;
  const q = isJwt ? `invite=${encodeURIComponent(val)}` : `h=${encodeURIComponent(val)}`;
  let wired = false;
  document.querySelectorAll("a.btn-sso").forEach((a) => {
    const base = (a.getAttribute("href") || "").split("?")[0];
    if (base) { a.setAttribute("href", `${base}?${q}`); wired = true; }
  });
  return wired;
}

// Settings reflects the connection: when signed in via SSO, show "Connected as X"
// + Sign out and hide the sign-in buttons; otherwise show the buttons.
function renderAuthState() {
  const status = $("#sso-status");
  const block = document.querySelector(".sso-block");
  if (!status) return;
  if (ssoActive) {
    const esc = (s) => String(s).replace(/[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const who = esc(state.ssoLogin || "you");
    const prov = (state.ssoProvider || "sso");
    const provLabel = esc(prov.charAt(0).toUpperCase() + prov.slice(1));
    status.innerHTML =
      `<div class="sso-connected">✓ Connected as <b>${who}</b> · ${provLabel}` +
      ` <button id="sso-logout" type="button" class="btn-secondary">Sign out</button></div>`;
    status.classList.remove("hidden");
    if (block) block.style.display = "none";   // beat .sso-block's display:flex
    const tl = document.querySelector("#cfg-token")?.closest("label");
    if (tl) tl.style.display = "none";          // hide the manual token field on SSO
    const lo = $("#sso-logout");
    if (lo) lo.addEventListener("click", async () => { await ssoLogout(); location.reload(); });
  } else {
    status.classList.add("hidden");
    if (block) block.style.display = "";
    const tl = document.querySelector("#cfg-token")?.closest("label");
    if (tl) tl.style.display = "";
  }
  renderInviteUi();
  renderOperatorTabs();
}

// Show the "Invite a member" control ONLY for an admin SSO session. Server-side
// the issuer re-verifies admin on every mint (INV3), so hiding this is purely UX —
// a tampered client that POSTs /auth/invite as a member still gets 403.
function renderInviteUi() {
  const adm = $("#admin-invite");
  if (!adm) return;
  const isAdmin = ssoActive && state.ssoRole === "admin";
  adm.classList.toggle("hidden", !isAdmin);
}

// Operator-only tabs (Automations, Services) drive control-plane endpoints that
// 403 for a member server-side (the gateway _is_operator gate). Hide them for
// non-admin sessions so a member isn't shown controls they can't use. Purely UX —
// the gateway remains the real boundary. If a non-admin is somehow ON a now-hidden
// view, fall back to Inbox so they're never stranded on a blank/forbidden tab.
const OPERATOR_TABS = ["automations", "services"];
function renderOperatorTabs() {
  const isAdmin = ssoActive && state.ssoRole === "admin";
  OPERATOR_TABS.forEach((v) => {
    const tab = document.querySelector(`.tab[data-view="${v}"]`);
    if (tab) tab.classList.toggle("hidden", !isAdmin);
  });
  if (!isAdmin) {
    const activeTab = document.querySelector(".tab.active");
    if (activeTab && OPERATOR_TABS.includes(activeTab.dataset.view)) showView("inbox");
  }
}

// Render the "you've been invited" prompt for an unauthenticated landing.
async function showJoinPrompt(token) {
  const blk = $("#join-block");
  if (!blk) return;
  blk.classList.remove("hidden");
  const info = await ssoInviteInfo(token);
  const el = $("#join-info");
  if (el) {
    el.textContent = info && info.email
      ? `Invited as ${info.email}` +
        (Array.isArray(info.cells) && info.cells.length
          ? ` · cells: ${info.cells.join(", ")}` : "")
      : "Sign in with the invited account to accept.";
  }
}
const apiPeers = () => api("/peers");
const apiInbox = (limit = 50) =>
  api(`/messages?to=${encodeURIComponent(selfNode())}&limit=${limit}`);
const apiAll = (limit = 200) => api(`/messages?limit=${limit}`);
const apiSend = (to_node, kind, content, cc) =>
  api("/messages", {
    method: "POST",
    body: JSON.stringify(
      cc && cc.length
        ? { from_node: selfNode(), to_node, kind, content, cc }
        : { from_node: selfNode(), to_node, kind, content }),
  });
const apiSchedEvents = () => api("/scheduled-events");
const apiSchedToggle = (name, enable) =>
  api(`/scheduled-events/${encodeURIComponent(name)}/${enable ? "enable" : "disable"}`,
      { method: "POST" });
const apiServices = () => api("/services");
const apiServiceAction = (lane, action, model) =>
  api(`/services/${encodeURIComponent(lane)}/action`,
      { method: "POST", body: JSON.stringify(model ? { action, model } : { action }) });
const apiLanes = () => api("/lanes");
const apiCreateLane = (name, provider, model, n, context_text) =>
  api("/lanes", { method: "POST", body: JSON.stringify(
    context_text ? { name, provider, model, n, context_text } : { name, provider, model, n }) });
const apiScaleLane = (name, n) =>
  api(`/lanes/${encodeURIComponent(name)}/scale`, { method: "POST", body: JSON.stringify({ n }) });
const apiDeleteLane = (name) =>
  api(`/lanes/${encodeURIComponent(name)}`, { method: "DELETE" });
const apiGetContext = (name) => api(`/lanes/${encodeURIComponent(name)}/context`);
const apiSetContext = (name, context_text, context_files) =>
  api(`/lanes/${encodeURIComponent(name)}/context`,
      { method: "POST", body: JSON.stringify({ context_text, context_files }) });
const apiContextFiles = (name) => api(`/lanes/${encodeURIComponent(name)}/context/files`);

// ---------- views ----------
function showView(name) {
  $$(".view").forEach(v => v.classList.toggle("active", v.id === `view-${name}`));
  $$(".tab").forEach(t => t.classList.toggle("active", t.dataset.view === name));
  if (name === "inbox") refreshInbox();
  if (name === "send") populatePeers();
  if (name === "actions") refreshActions();
  if (name === "highlights") refreshHighlights();
  if (name === "automations") refreshAutomations();
  if (name === "services") { refreshServices(); refreshLanes(); }
  if (name === "read") loadReadQueue();
  if (name === "settings") populateSettings();
}

// ---------- actions (what is waiting on the commander) ----------
// Answers ONE question: what can the mesh not proceed without me?
// Deliberately NOT a status board. Cells handle their own work; this shows only
// items whose resolution requires this human, ordered by what blocks hardest.
const ACTION_GROUPS = [
  { key: "questions", label: "Questions waiting on you",  hint: "unanswered DMs addressed to you" },
  { key: "overdue",   label: "Overdue",                   hint: "past their due date" },
  { key: "ready",     label: "Ready to advance",          hint: "flagged move_ready, waiting on a call" },
  { key: "assigned",  label: "Assigned to you",           hint: "carded to you, still open" },
];

// A card is DONE-ish and should never nag. Kept as one list so the four
// groups below cannot drift apart on what "still open" means.
const _CLOSED_STAGES = new Set(["done", "parked"]);

function boardEnvelope(text) {
  return typeof text === "string" && text.startsWith("SWARPH-BOARD v1\n");
}

function parseBoardDm(content) {
  if (!boardEnvelope(content)) return null;
  try {
    const data = JSON.parse(content.slice("SWARPH-BOARD v1\n".length));
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

function newestBoardDm(messages) {
  const boards = (messages || []).filter(
    (m) => m && m.from_node === "lab-ovh" && boardEnvelope(m.content) && parseBoardDm(m.content));
  boards.sort((a, b) => (b.id || 0) - (a.id || 0));
  return boards[0] || null;
}

function visibleInbox(messages) {
  return (messages || []).filter((m) => !boardEnvelope(m && m.content));
}

function dedupeYou(groups, board) {
  const cards = new Set();
  const titles = new Set();
  for (const sess of (board && board.sessions) || []) {
    for (const q of sess.questions || []) {
      if (q.card != null) cards.add(String(q.card));
      if (q.title) titles.add(String(q.title).trim());
    }
  }
  const dropCard = (list) => (list || []).filter((c) => !cards.has(String(c.id)));
  return {
    questions: (groups.questions || []).filter((m) => {
      if (boardEnvelope(m.content)) return false;
      const text = String(m.content || "").trim();
      return !titles.has(text);
    }),
    overdue: dropCard(groups.overdue),
    ready: dropCard(groups.ready),
    assigned: dropCard(groups.assigned),
  };
}

function boardSentId(questionId) {
  if (questionId == null) return null;
  try {
    const raw = localStorage.getItem("mes.boardSent");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const key = String(questionId);
    if (!Object.prototype.hasOwnProperty.call(parsed, key)) return null;
    return parsed[key];
  } catch (e) {
    return null;
  }
}

function rememberBoardSent(questionId, messageId) {
  if (questionId == null) return;
  try {
    const raw = localStorage.getItem("mes.boardSent");
    let cur = {};
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") cur = parsed;
    }
    cur[String(questionId)] = messageId;
    localStorage.setItem("mes.boardSent", JSON.stringify(cur));
  } catch (e) {
    // A blocked store must not fail the send. The button stays on "sent".
  }
}

function boardQuestionOffered(question) {
  if (!question || question.in_session) return false;
  return boardSentId(question.id) == null;
}

function questionSendControl(question, sessionName) {
  if (question && question.in_session) {
    return { send: false, note: "Answer in " + sessionName };
  }
  const options = (question && question.options) || [];
  const picked = options.find((o) => o.rec) || options[0] || null;
  return {
    send: true,
    note: "Send decision",
    reply: picked ? (picked.text || "") : "",
    selected: picked ? picked.label : "",
  };
}

function sendBoardDecision(question, reply) {
  return apiSend(question.to_node, "answer", "Re: " + question.title + "\n" + reply, ["lab-ovh"]);
}

async function deliverBoardDecision(button, question, reply) {
  if (!button || button.disabled) return;
  button.disabled = true;
  const err = button.parentElement && button.parentElement.querySelector
    ? button.parentElement.querySelector(".board-send-err")
    : null;
  if (err) err.textContent = "";
  try {
    const r = await sendBoardDecision(question, reply);
    const id = r && r.id != null ? r.id : "";
    button.textContent = "sent " + id;
    rememberBoardSent(question && question.id, id);
  } catch (e) {
    button.disabled = false;
    const msg = e && e.message ? e.message : String(e);
    if (err) err.textContent = msg;
    else if (typeof setStatus === "function") setStatus("send: " + msg, "err");
  }
}

function _whereText(where) {
  if (Array.isArray(where)) return where.filter(Boolean).join("\n");
  return where || "";
}

function renderBoard(board) {
  const root = $("#board-sections");
  if (!root) return 0;
  root.replaceChildren();
  if (!board) return 0;
  let n = 0;
  const seen = new Set();
  for (const sess of board.sessions || []) {
    const sec = document.createElement("section");
    sec.className = "action-group";
    const h = document.createElement("h3");
    h.textContent = sess.name || "cell";
    sec.appendChild(h);
    const stateEl = document.createElement("p");
    stateEl.className = "action-primary";
    stateEl.textContent = sess.state || "";
    sec.appendChild(stateEl);
    const where = document.createElement("p");
    where.className = "muted board-where";
    where.textContent = _whereText(sess.where);
    sec.appendChild(where);
    for (const q of sess.questions || []) {
      const key = q.id != null ? String(q.id) : `${sess.name}:${q.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      n += 1;
      sec.appendChild(_boardQuestion(q, sess.name || ""));
    }
    root.appendChild(sec);
  }
  return n;
}

function _boardQuestion(question, sessionName) {
  const wrap = document.createElement("div");
  wrap.className = "board-q";
  const title = document.createElement("div");
  title.className = "action-primary";
  title.textContent = question.title || "";
  wrap.appendChild(title);
  const ctrl = questionSendControl(question, sessionName);
  const options = question.options || [];
  if (!question.in_session && !boardQuestionOffered(question)) {
    const done = document.createElement("button");
    done.type = "button";
    done.disabled = true;
    done.textContent = "sent " + boardSentId(question.id);
    wrap.appendChild(done);
  } else if (!question.in_session) {
    options.forEach((opt, i) => {
      const label = document.createElement("label");
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = `board-q-${question.id}`;
      radio.checked = !!opt.rec || (!options.some((o) => o.rec) && i === 0);
      radio.addEventListener("change", () => {
        const box = wrap.querySelector("textarea");
        if (box) box.value = opt.text || "";
      });
      label.appendChild(radio);
      label.appendChild(document.createTextNode(" " + (opt.label || "")));
      wrap.appendChild(label);
    });
    const box = document.createElement("textarea");
    box.className = "reply";
    box.rows = 3;
    box.value = ctrl.reply || "";
    wrap.appendChild(box);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-primary";
    btn.textContent = "Send decision";
    const err = document.createElement("p");
    err.className = "board-send-err";
    wrap.appendChild(err);
    btn.addEventListener("click", () => {
      deliverBoardDecision(btn, question, box.value);
    });
    wrap.appendChild(btn);
  } else {
    const note = document.createElement("p");
    note.textContent = ctrl.note;
    wrap.appendChild(note);
  }
  return wrap;
}

function toggleNav(force) {
  const nav = document.getElementById("tabs");
  const btn = document.getElementById("nav-toggle");
  if (!nav || !btn) return;
  const open = force === undefined ? !nav.classList.contains("open") : !!force;
  nav.classList.toggle("open", open);
  btn.setAttribute("aria-expanded", open ? "true" : "false");
}

async function refreshActions() {
  const me = selfNode();
  try {
    setStatus("loading actions…");
    const [msgRes, cardRes] = await Promise.all([
      api(`/messages?to_node=${encodeURIComponent(me)}&limit=200`),
      api(`/board/cards?limit=500`),
    ]);
    const msgs  = msgRes.messages || [];
    const cards = cardRes.cards || [];

    // A question is "waiting" only if unread. read_at is the gateway's own
    // consumed-flag; do NOT infer from anything else.
    const questions = msgs
      .filter(m => m.kind === "question" && !m.read_at && m.from_node !== me)
      .sort((a, b) => (b.id || 0) - (a.id || 0));

    const open = cards.filter(c => !_CLOSED_STAGES.has(c.stage));
    // due_state is computed server-side (#183a) — trust it rather than
    // re-deriving date maths in the client and drifting from the board.
    const overdue  = open.filter(c => c.due_state === "overdue" || (c.days_until != null && c.days_until < 0));
    const ready    = open.filter(c => c.move_ready && !overdue.includes(c));
    const assigned = open.filter(c => c.assignee === me && !overdue.includes(c) && !ready.includes(c));

    const boardMsg = newestBoardDm(msgs);
    const board = boardMsg ? parseBoardDm(boardMsg.content) : null;
    const grouped = dedupeYou({ questions, overdue, ready, assigned }, board);
    const boardCount = renderBoard(board);
    renderActions(grouped, boardCount);
    setStatus("");
  } catch (e) {
    setStatus("actions: " + e.message, "err");
  }
}

// >>> BUILT WITH DOM APIs, NEVER innerHTML. <<< Same rule card #198 established
// for the Read queue, and this view has the stronger case: `content` here is a DM
// body written by ANOTHER CELL, and `title` is a board card any peer can create.
// That is not the self-XSS the Read queue faces today — it is already the
// cross-cell case, rendering one cell's text in the commander's browser.
function _actionRow(primary, secondary, when) {
  const li = document.createElement("li");
  li.className = "action-row";

  const p = document.createElement("div");
  p.className = "action-primary";
  p.textContent = primary || "";
  li.appendChild(p);

  const sec = document.createElement("div");
  sec.className = "action-secondary muted";
  sec.textContent = secondary + (when ? ` · ${fmtTime(when)}` : "");
  li.appendChild(sec);

  return li;
}

function renderActions(groups, extra = 0) {
  const total = extra + ACTION_GROUPS.reduce((n, g) => n + (groups[g.key] || []).length, 0);

  const badge = $("#actions-badge");
  if (badge) {
    badge.textContent = total > 99 ? "99+" : String(total);
    badge.classList.toggle("hidden", total === 0);
  }
  $("#actions-meta").textContent = total === 0 ? "" : `${total} waiting`;
  $("#actions-empty").classList.toggle("hidden", total > 0);

  const root = $("#actions-groups");
  root.replaceChildren();

  ACTION_GROUPS.forEach((g) => {
    const items = groups[g.key] || [];
    if (!items.length) return;

    const sec = document.createElement("section");
    sec.className = "action-group";

    const h = document.createElement("h3");
    h.append(document.createTextNode(g.label + " "));
    const cnt = document.createElement("span");
    cnt.className = "count";
    cnt.textContent = String(items.length);
    h.appendChild(cnt);
    sec.appendChild(h);

    const hint = document.createElement("p");
    hint.className = "muted action-hint";
    hint.textContent = g.hint;
    sec.appendChild(hint);

    const ul = document.createElement("ul");
    ul.className = "action-list";
    items.forEach((it) => {
      if (it.kind === "question") {
        ul.appendChild(_actionRow(it.content || "", `from ${it.from_node} · #${it.id}`, it.created_at));
      } else {
        const meta = [it.stage, it.assignee ? `@${it.assignee}` : null,
                      it.priority != null ? `p${it.priority}` : null].filter(Boolean).join(" · ");
        ul.appendChild(_actionRow(`#${it.id} ${it.title || ""}`, meta, it.due_at || it.updated_at));
      }
    });
    sec.appendChild(ul);
    root.appendChild(sec);
  });
}

// ---------- inbox ----------
// Render DM content with two link patterns auto-converted to tappable anchors:
//   1. Bare URL (http/https)         → <a href=url target=_blank>url</a>
//   2. Markdown action [label](url)  → <a href=url target=_blank>label</a>
// Everything else is text-escaped (no HTML injection from peer content).
const _URL_RE = /(https?:\/\/[^\s<>"'`]+)/g;
const _MD_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s<>"'`)]+)\)/g;
function _escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}
function renderContent(text) {
  // Pass 1: extract markdown links into placeholders so URL pass doesn't double-wrap.
  const slots = [];
  let i = 0;
  let s = text.replace(_MD_LINK_RE, (_, label, url) => {
    const k = ` MDLINK${i++} `;
    slots.push(`<a href="${_escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="action">${_escapeHtml(label)}</a>`);
    return k;
  });
  // Pass 2: escape, then linkify bare URLs.
  s = _escapeHtml(s).replace(_URL_RE, url => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
  // Pass 3: restore markdown-link slots.
  return s.replace(/ MDLINK(\d+) /g, (_, k) => slots[parseInt(k, 10)]);
}
function renderMessages(rootList, msgs) {
  const tpl = $("#tpl-msg");
  rootList.innerHTML = "";
  for (const m of msgs) {
    const li = tpl.content.cloneNode(true);
    const liEl = li.querySelector(".msg");
    liEl.dataset.id = m.id;
    li.querySelector(".msg-from").textContent = m.from_node;
    li.querySelector(".msg-to").textContent = m.to_node;
    const kind = li.querySelector(".msg-kind");
    kind.textContent = m.kind;
    kind.classList.add(m.kind);
    li.querySelector(".msg-time").textContent = fmtTime(m.created_at);
    li.querySelector(".msg-time").title = m.created_at;
    // cc line: server sends a JSON array of cc'd nodes (or null). Render only
    // when present so legacy un-cc'd DMs are byte-identical.
    const ccEl = li.querySelector(".msg-cc");
    if (ccEl) {
      const cc = Array.isArray(m.cc) ? m.cc : [];
      if (cc.length) ccEl.textContent = "cc: " + cc.join(", ");
      else ccEl.remove();
    }
    const body = li.querySelector(".msg-body");
    body.innerHTML = renderContent(m.content);
    if (state.expanded.has(m.id)) body.classList.add("expanded");
    body.addEventListener("click", (ev) => {
      // Don't toggle expanded when tapping a link inside the body.
      if (ev.target.tagName === "A") return;
      body.classList.toggle("expanded");
      if (body.classList.contains("expanded")) state.expanded.add(m.id);
      else state.expanded.delete(m.id);
    });
    // Reply: jump to Send pre-filled to answer this sender. Hidden on your own
    // messages (you don't reply to yourself).
    const replyBtn = li.querySelector(".msg-reply");
    if (m.from_node === selfNode()) {
      replyBtn.remove();
    } else {
      replyBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        replyTo(m.from_node);
      });
    }
    rootList.appendChild(li);
  }
}

function renderAutomations(rootList, events) {
  const tpl = $("#tpl-automation");
  rootList.innerHTML = "";
  for (const ev of events) {
    const node = tpl.content.cloneNode(true);
    node.querySelector(".auto-name").textContent = ev.name;
    // trigger line
    let trig;
    if (ev.trigger_type === "time") trig = "⏰ " + humanizeCron(ev.cron);
    else {
      let pk = "";
      try { pk = (JSON.parse(ev.predicate || "{}").kind) || "event"; } catch { pk = "event"; }
      trig = "⚡ " + pk;
    }
    node.querySelector(".auto-trigger").textContent = trig;
    // meta line
    const meta = `→ ${ev.target_cell}` +
      (ev.out_channel ? ` · #${ev.out_channel}` : "") +
      ` · fired ${ev.fire_count}×` +
      (ev.last_fired_at ? ` · last ${fmtTime(ev.last_fired_at)}` : " · never") +
      (ev.last_status ? ` · ${ev.last_status}` : "");
    node.querySelector(".auto-meta").textContent = meta;
    // toggle
    const enabled = !!ev.enabled;
    const card = node.querySelector(".automation-card");
    card.classList.toggle("disabled", !enabled);
    const btn = node.querySelector(".auto-toggle");
    btn.textContent = enabled ? "Enabled" : "Disabled";
    btn.classList.toggle("on", enabled);
    btn.addEventListener("click", () => toggleEvent(ev.name, enabled));
    rootList.appendChild(node);
  }
}

async function refreshInbox() {
  if (ssoActive && !selfNode()) {
    setStatus("account not provisioned — contact the operator", "err");
    return;
  }
  try {
    setStatus("loading…");
    const { messages } = await apiInbox(50);
    const visible = visibleInbox(messages);
    state.inbox = visible;
    renderMessages($("#inbox-list"), visible);
    $("#inbox-count").textContent = `${visible.length} message${visible.length === 1 ? "" : "s"}`;
    $("#inbox-empty").classList.toggle("hidden", visible.length > 0);
    setStatus(`ok · ${new Date().toLocaleTimeString()}`, "ok");
  } catch (e) {
    setStatus("err: " + e.message, "err");
  }
}

async function refreshAutomations() {
  try {
    setStatus("loading…");
    const { events } = await apiSchedEvents();
    renderAutomations($("#automations-list"), events);
    $("#automations-count").textContent =
      `${events.length} automation${events.length === 1 ? "" : "s"}`;
    $("#automations-empty").classList.toggle("hidden", events.length > 0);
    setStatus(`ok · ${new Date().toLocaleTimeString()}`, "ok");
  } catch (e) {
    setStatus("err: " + e.message, "err");
  }
}

async function toggleEvent(name, currentlyEnabled) {
  try {
    setStatus(currentlyEnabled ? "disabling…" : "enabling…");
    await apiSchedToggle(name, !currentlyEnabled);
    await refreshAutomations();
  } catch (e) {
    setStatus("err: " + e.message, "err");
  }
}

// ---------- services (LLM fleet) ----------
async function refreshServices() {
  try {
    const { services } = await apiServices();
    renderServices(services);
    $("#services-meta").textContent =
      `${services.filter(s => s.state === "active").length}/${services.length} up`;
  } catch (e) { setStatus("services: " + e.message, "err"); }
}

function renderServices(services) {
  const list = $("#services-list"); list.innerHTML = "";
  const tpl = $("#tpl-service");
  for (const s of services) {
    const li = tpl.content.firstElementChild.cloneNode(true);
    $(".svc-name", li).textContent = `${s.node}  :${s.port}`;
    const dot = $(".svc-state", li);
    dot.textContent = s.state === "active" ? "● on" : "○ OFF";
    dot.className = "svc-state " + (s.state === "active" ? "on" : "off");
    $(".svc-meta", li).textContent = s.model ? `model: ${s.model}` : (s.provider);
    const sel = $(".svc-model", li);
    (s.models_available || []).forEach(m => {
      const o = document.createElement("option");
      o.value = m; o.textContent = m; if (m === s.model) o.selected = true; sel.append(o);
    });
    sel.disabled = (s.models_available || []).length <= 1;
    sel.onchange = () => serviceAction(s.lane, "set-model", sel.value);
    $(".svc-start", li).onclick = () => serviceAction(s.lane, "start");
    $(".svc-stop", li).onclick = () => serviceAction(s.lane, "stop", null, true);
    $(".svc-restart", li).onclick = () => serviceAction(s.lane, "restart", null, true);
    list.append(li);
  }
}

async function serviceAction(lane, action, model = null, disruptive = false) {
  if (disruptive && !confirm(`${action} ${lane}? This disrupts a serving lane.`)) return;
  try {
    setStatus(`${action} ${lane}…`);
    await apiServiceAction(lane, action, model);
    setStatus(`${action} ${lane} ✓`, "ok");
    setTimeout(refreshServices, 1200);   // give systemd a beat
  } catch (e) { setStatus(`${action} ${lane}: ${e.message}`, "err"); }
}

// ---------- launched lanes ----------
// Build each lane card with createElement/textContent (no innerHTML interpolation)
// so a free-form model string can't inject markup. Wiring is via .onclick (CSP-safe).
async function refreshLanes() {
  try {
    const { lanes } = await apiLanes();
    const list = $("#lanes-list");
    list.innerHTML = "";
    for (const l of lanes) {
      const li = document.createElement("li");
      li.className = "service-card";

      const row = document.createElement("div");
      row.className = "svc-row";

      const nameEl = document.createElement("span");
      nameEl.className = "svc-name";
      nameEl.textContent = `${l.name} · ${l.provider}/${l.model}`;
      row.append(nameEl);

      const ctrls = document.createElement("span");
      ctrls.className = "lane-ctrls";

      const nInput = document.createElement("input");
      nInput.className = "lane-n";
      nInput.type = "number";
      nInput.min = "0";
      nInput.max = "8";
      nInput.value = String(l.n);

      const scaleBtn = document.createElement("button");
      scaleBtn.type = "button";
      scaleBtn.className = "lane-scale";
      scaleBtn.textContent = "scale";
      scaleBtn.onclick = async () => {
        try {
          setStatus(`scaling ${l.name}…`);
          await apiScaleLane(l.name, +nInput.value);
          setStatus(`scaled ${l.name} ✓`, "ok");
          refreshLanes();
        } catch (e) { setStatus(`scale ${l.name}: ${e.message}`, "err"); }
      };

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "lane-del";
      delBtn.textContent = "✕";
      delBtn.onclick = async () => {
        if (!confirm(`delete lane ${l.name}? (stops all its workers)`)) return;
        try {
          setStatus(`deleting ${l.name}…`);
          await apiDeleteLane(l.name);
          setStatus(`deleted ${l.name} ✓`, "ok");
          refreshLanes();
        } catch (e) { setStatus(`delete ${l.name}: ${e.message}`, "err"); }
      };

      const ctxBtn = document.createElement("button");
      ctxBtn.type = "button";
      ctxBtn.className = "lane-ctx";
      ctxBtn.textContent = "ctx";

      const editor = document.createElement("div");
      editor.className = "ctx-editor hidden";

      ctxBtn.onclick = async () => {
        if (!editor.classList.contains("hidden")) { editor.classList.add("hidden"); return; }
        editor.classList.remove("hidden");
        await openContextEditor(l.name, editor);
      };

      ctrls.append("×", nInput, scaleBtn, ctxBtn, delBtn);
      row.append(ctrls);
      li.append(row);
      li.append(editor);
      list.append(li);
    }
  } catch (e) { setStatus("lanes: " + e.message, "err"); }
}

// Per-lane context editor: textarea (context_text) + checkbox list of files available
// in the lane's curated dir. createElement/textContent only (no innerHTML) so a
// filename or context string can't inject markup.
async function openContextEditor(laneName, mountEl) {
  mountEl.textContent = "loading…";
  try {
    const [ctx, avail] = await Promise.all([apiGetContext(laneName), apiContextFiles(laneName)]);
    mountEl.textContent = "";
    const ta = document.createElement("textarea");
    ta.className = "ctx-text";
    ta.placeholder = "Standing context / instructions for this lane…";
    ta.value = ctx.context_text || "";
    mountEl.append(ta);
    const chosen = new Set(ctx.context_files || []);
    const boxes = [];
    (avail.files || []).forEach((fn) => {
      const label = document.createElement("label");
      label.className = "ctx-file";
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.value = fn; cb.checked = chosen.has(fn);
      boxes.push(cb);
      label.append(cb, document.createTextNode(" " + fn));
      mountEl.append(label);
    });
    if (!(avail.files || []).length) {
      const note = document.createElement("div");
      note.className = "muted";
      note.textContent = "No files in this lane's context dir yet.";
      mountEl.append(note);
    }
    const save = document.createElement("button");
    save.type = "button";
    save.className = "ctx-save";
    save.textContent = "Save context";
    save.onclick = async () => {
      try {
        setStatus(`saving ${laneName} context…`);
        await apiSetContext(laneName, ta.value, boxes.filter((b) => b.checked).map((b) => b.value));
        setStatus(`saved ${laneName} context ✓`, "ok");
      } catch (e) { setStatus(`ctx ${laneName}: ${e.message}`, "err"); }
    };
    mountEl.append(save);
  } catch (e) {
    mountEl.textContent = "";
    const err = document.createElement("div");
    err.className = "muted";
    err.textContent = "context: " + e.message;
    mountEl.append(err);
  }
}

async function createLaneFromForm(ev) {
  ev.preventDefault();
  try {
    setStatus("launching lane…");
    await apiCreateLane(
      $("#nl-name").value.trim(),
      $("#nl-provider").value,
      $("#nl-model").value.trim(),
      +$("#nl-n").value,
      ($("#nl-context") ? $("#nl-context").value.trim() : ""),
    );
    $("#new-lane-form").classList.add("hidden");
    setStatus("lane launched ✓", "ok");
    refreshLanes();
  } catch (e) { setStatus("launch: " + e.message, "err"); }
}

// ---------- send ----------
async function populatePeers() {
  const sel = $("#send-to");
  if (sel.options.length > 0) return;  // already populated
  try {
    const { peers } = await apiPeers();
    state.peers = peers;
    sel.innerHTML = "";
    for (const p of peers) {
      if (p.name === selfNode()) continue;
      const opt = document.createElement("option");
      opt.value = p.name;
      opt.textContent = p.name;
      sel.appendChild(opt);
    }
    // No hardcoded fallback: /peers is grant-filtered server-side, so any static
    // list would leak ungranted cells. An empty dropdown means "no granted cells".
  } catch (e) {
    setStatus("peers err: " + e.message, "err");
  }
}

async function handleSend(ev) {
  ev.preventDefault();
  const to_node = $("#send-to").value;
  const kind = $("#send-kind").value;
  const content = $("#send-content").value.trim();
  const ccField = $("#send-cc");
  const cc = ccField
    ? ccField.value.split(",").map(s => s.trim()).filter(Boolean)
    : [];
  if (!content) return;
  if (!selfNode()) {
    // SSO session with no provisioned node: surface a clear message instead of
    // firing a doomed (and confusing) request that the gateway would 403.
    $("#send-result").textContent =
      "✗ your account isn't provisioned with a node yet — contact the operator";
    return;
  }
  const btn = $("#send-btn");
  btn.disabled = true;
  $("#send-result").textContent = "sending…";
  try {
    const r = await apiSend(to_node, kind, content, cc);
    $("#send-result").textContent = `✓ id=${r.id} sent at ${fmtTime(r.created_at)}`;
    $("#send-content").value = "";
    if (ccField) ccField.value = "";
  } catch (e) {
    $("#send-result").textContent = "✗ " + e.message;
  } finally {
    btn.disabled = false;
  }
}

// Jump to the Send view pre-filled to answer a specific peer's DM. Populates the
// peer list FIRST (idempotent) so showView's own populate call early-returns and
// can't wipe the selection we set here.
async function replyTo(peer) {
  await populatePeers();
  showView("send");
  const sel = $("#send-to");
  if (![...sel.options].some(o => o.value === peer)) {
    const opt = document.createElement("option");
    opt.value = peer; opt.textContent = peer;
    sel.insertBefore(opt, sel.firstChild);
  }
  sel.value = peer;
  $("#send-kind").value = "answer";
  $("#send-content").focus();
  setStatus(`replying to ${peer}`, "ok");
}

// ---------- highlights ----------
const CATEGORIES = [
  { key: "PRs",      label: "Pull Requests", test: (m) => /\bPR[\s#:_-]*\d+|\/pull\/\d+|\bnew PR\b|pull request/i.test(m.content) },
  { key: "Seeds",    label: "Seeds",         test: (m) => /\bkind=seed\b|seed_id\b|\bseed:\s/i.test(m.content) },
  { key: "UNBLOCKs", label: "UNBLOCKs",      test: (m) => /\bUNBLOCK(S|ED|ING)?\b/.test(m.content) || m.kind === "unblock" },
  { key: "Triage",   label: "Triage",        test: (m) => /\btriage\b/i.test(m.content) },
  { key: "AI²",      label: "AI²",           test: (m) => /\bAI[²2]\b|\bAI\^2\b/i.test(m.content) },
];

async function refreshHighlights() {
  try {
    setStatus("loading 48h…");
    // /messages doesn't currently filter by `since`, so pull a generous slice
    // and filter client-side. 500 is plenty for a 48h window on this mesh.
    const { messages } = await apiAll(500);
    const cutoff = Date.now() - 48 * 3600 * 1000;
    const recent = messages.filter(m => {
      const t = Date.parse(m.created_at);
      return !isNaN(t) && t >= cutoff;
    });
    const buckets = new Map(CATEGORIES.map(c => [c.key, []]));
    const other = [];
    for (const m of recent) {
      let placed = false;
      for (const c of CATEGORIES) {
        if (c.test(m)) { buckets.get(c.key).push(m); placed = true; break; }
      }
      if (!placed) other.push(m);
    }
    const tree = $("#highlights-tree");
    tree.innerHTML = "";
    let total = 0;
    for (const c of CATEGORIES) {
      const list = buckets.get(c.key);
      total += list.length;
      if (list.length === 0) continue;
      tree.appendChild(buildCat(c.label, list));
    }
    if (other.length > 0) {
      tree.appendChild(buildCat("Other", other));
    }
    $("#highlights-meta").textContent = `${total + other.length} of ${recent.length} in last 48h · ${new Date().toLocaleTimeString()}`;
    $("#highlights-empty").classList.toggle("hidden", recent.length > 0);
    setStatus("ok", "ok");
  } catch (e) {
    setStatus("err: " + e.message, "err");
  }
}

function buildCat(label, msgs) {
  const det = document.createElement("details");
  det.className = "cat";
  det.open = msgs.length <= 8;
  const sum = document.createElement("summary");
  sum.innerHTML = `<span>${label}</span><span class="cat-count">${msgs.length}</span>`;
  det.appendChild(sum);
  const list = document.createElement("ul");
  list.className = "msg-list cat-list";
  det.appendChild(list);
  renderMessages(list, msgs);
  return det;
}

// ---------- settings ----------
function populateSettings() {
  $("#cfg-base").value = state.base;
  $("#cfg-token").value = state.token;
  $("#cfg-poll").value = String(state.pollSec);
}

function saveSettings(ev) {
  ev.preventDefault();
  state.base = $("#cfg-base").value.replace(/\s+/g, "").replace(/\/$/, "");
  state.token = $("#cfg-token").value.replace(/\s+/g, "");
  state.pollSec = clampPollSeconds($("#cfg-poll").value);
  localStorage.setItem(LS.base, state.base);
  localStorage.setItem(LS.token, state.token);
  localStorage.setItem(LS.poll, String(state.pollSec));
  $("#cfg-result").textContent = "saved · restarting poll loop";
  startPollLoop();
  // re-fetch peers next time Send is opened
  $("#send-to").innerHTML = "";
}

async function testConnection() {
  $("#cfg-result").textContent = "testing…";
  // apply current form values without persisting
  const prev = { base: state.base, token: state.token };
  state.base = $("#cfg-base").value.replace(/\s+/g, "").replace(/\/$/, "");
  state.token = $("#cfg-token").value.replace(/\s+/g, "");
  try {
    const { peers } = await apiPeers();
    $("#cfg-result").textContent = `✓ ok — ${peers.length} peers (${peers.map(p => p.name).join(", ")})`;
  } catch (e) {
    $("#cfg-result").textContent = "✗ " + e.message;
    state.base = prev.base; state.token = prev.token;
  }
}

// ---------- invite handlers ----------
async function handleCreateInvite(ev) {
  ev.preventDefault();
  const email = $("#inv-email").value.trim();
  const cells = $("#inv-cells").value.split(",").map(s => s.trim()).filter(Boolean);
  const role = $("#inv-role").value;
  const result = $("#inv-result");
  if (!email) { result.textContent = "✗ email required"; return; }
  result.textContent = "creating…";
  try {
    const j = await ssoCreateInvite(email, cells, role);
    result.textContent = j.emailed
      ? `✓ invite emailed to ${j.email} — link also below as a fallback`
      : `✓ invite created for ${j.email} — copy the link below and send it`;
    const wrap = $("#inv-link-wrap"), link = $("#inv-link"), copy = $("#inv-copy");
    if (link) link.value = j.link || "";
    if (wrap) wrap.classList.remove("hidden");
    if (copy) copy.classList.remove("hidden");
    $("#invite-form").reset();
  } catch (e) {
    result.textContent = "✗ " + e.message;
  }
}

async function copyInviteLink() {
  const link = $("#inv-link");
  if (!link || !link.value) return;
  try {
    await navigator.clipboard.writeText(link.value);
    $("#inv-copy").textContent = "Copied ✓";
    setTimeout(() => { $("#inv-copy").textContent = "Copy link"; }, 1500);
  } catch {
    link.select();   // clipboard API unavailable (http/older browser) — select for manual copy
  }
}

// Post-SSO: if a pending invite is held, claim it once the session is live. On
// success the gateway membership is provisioned and the member can act as its
// node. Clears the pending token whether the claim succeeds or is permanently
// rejected (4xx) so a dead/forwarded link doesn't loop; a transient 5xx is kept.
async function claimPendingInvite() {
  const tok = localStorage.getItem(LS.pendingInvite);
  if (!tok || !ssoActive) return;
  setStatus("accepting invite…");
  try {
    const j = await ssoClaimInvite(tok);
    localStorage.removeItem(LS.pendingInvite);
    state.ssoNode = j.node || state.ssoNode;
    state.ssoRole = j.role || state.ssoRole;
    setStatus(`invite accepted · node ${j.node}`, "ok");
  } catch (e) {
    // A 5xx (gateway hiccup) leaves the invite claimable on the next boot; a 4xx
    // (used/expired/wrong account) is terminal — drop it so we don't loop. Use
    // the status carried on the error (e.status); a body `detail` would otherwise
    // hide the code (e.g. a 502 "could not provision membership; try again").
    if (!(e.status >= 500 && e.status <= 599)) localStorage.removeItem(LS.pendingInvite);
    setStatus("invite: " + e.message, "err");
  }
}

// ---------- poll loop ----------
function startPollLoop() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  if (!state.token) return;
  const tick = () => {
    if ($("#view-inbox")?.classList.contains("active")) refreshInbox();
    if ($("#view-actions")?.classList.contains("active")) refreshActions();
  };
  tick();
  state.pollTimer = setInterval(tick, state.pollSec * 1000);
}

// ---------- wire ----------
window.addEventListener("DOMContentLoaded", async () => {
  $("#nav-toggle")?.addEventListener("click", () => toggleNav());
  $$(".tab").forEach(t => t.addEventListener("click", () => {
    showView(t.dataset.view);
    toggleNav(false);
  }));
  $("#refresh-inbox").addEventListener("click", refreshInbox);
  $("#read-send")?.addEventListener("click", sendToRead);
  $("#read-refresh")?.addEventListener("click", loadReadQueue);
  $("#refresh-highlights").addEventListener("click", refreshHighlights);
  $("#refresh-services").addEventListener("click", refreshServices);
  $("#new-lane-btn").addEventListener("click", () => $("#new-lane-form").classList.toggle("hidden"));
  $("#new-lane-form").addEventListener("submit", createLaneFromForm);
  $("#send-form").addEventListener("submit", handleSend);
  $("#settings-form").addEventListener("submit", saveSettings);
  $("#cfg-test").addEventListener("click", testConnection);
  $("#invite-form")?.addEventListener("submit", handleCreateInvite);
  $("#inv-copy")?.addEventListener("click", copyInviteLink);

  // Capture an invite landing (/join?invite=…) BEFORE any SSO redirect so the
  // token survives the round-trip.
  captureInviteFromUrl();
  const pendingInvite = localStorage.getItem(LS.pendingInvite);

  // Prefer a Meta-Edge SSO session; fall back to a manually-pasted token.
  if (!state.token) await trySsoBoot();

  if (ssoActive && pendingInvite) {
    // Already signed in with a pending invite → claim it, then land on inbox.
    await claimPendingInvite();
    showView("actions");
    startPollLoop();
  } else if (pendingInvite && !ssoActive) {
    // Invited but not signed in → show the join prompt and carry the invite THROUGH
    // the SSO start so the issuer claims it inline (a new member is authorized by
    // the invite, not a pre-existing allowlist — without this the login 403s). The
    // server now owns the claim, so drop the localStorage copy to avoid a redundant
    // double-claim on the post-login boot.
    showView("settings");
    await showJoinPrompt(pendingInvite);
    if (wireInviteIntoSignIn(pendingInvite)) localStorage.removeItem(LS.pendingInvite);
    setStatus("sign in to accept your invite — Settings", "err");
  } else if (!state.token) {
    showView("settings");
    setStatus("sign in or paste a token — Settings", "err");
  } else {
    showView("actions");
    startPollLoop();
  }
  renderAuthState();   // reflect SSO connected-state in Settings

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => { /* HTTPS-only on some browsers */ });
  }
});

// ---------- READING QUEUE (card #198) ----------
// The commander curates, lab reads. An item is EITHER a url (public, lab fetches it)
// or PASTED TEXT — and the text branch is the paywall answer: he holds the browser
// session, so paid content arrives as text and no publisher credential ever enters
// the mesh. Hours went into fetching a paid article with his own cookies (measured
// inert) before that became obvious.
//
// The queue is PER-CELL server-side: `owner` comes from the bearer token, never from
// anything this page sends. There is deliberately no owner field to fill in.

function renderReadQueue(items) {
  const ul = $("#read-list");
  if (!ul) return;
  ul.replaceChildren();
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "Nothing queued — lab is caught up.";
    ul.appendChild(li);
    return;
  }
  // >>> BUILT WITH DOM APIs, NEVER innerHTML. <<< `title`, `note` and `url` are
  // caller-supplied. Today the queue is PER-CELL so this would be self-XSS — but
  // card #198 explicitly plans the fractal case where an ORCHESTRATOR QUEUES INTO A
  // CELL IT OWNS, and at that point one cell's text renders in another's browser.
  // Writing it with innerHTML would be building the cross-cell vulnerability in
  // advance, on a roadmap we have already written down.
  items.forEach((it) => {
    const li = document.createElement("li");
    const outer = document.createElement("div");

    if (it.url) {
      const a = document.createElement("a");
      // Scheme allowlist: a `javascript:` url in the queue is exploitable TODAY,
      // and a url is exactly the kind of thing that gets copied from elsewhere.
      let safe = "";
      try {
        const u = new URL(it.url);
        if (u.protocol === "http:" || u.protocol === "https:") safe = u.href;
      } catch (_) { /* unparseable -> not a link */ }
      if (safe) {
        a.href = safe;
        a.target = "_blank";
        a.rel = "noreferrer noopener";
        a.textContent = it.title || it.url;
        outer.appendChild(a);
      } else {
        // Render it as INERT TEXT rather than dropping it: the commander must see
        // what he queued, and a silently-missing row is its own defect.
        const bad = document.createElement("span");
        bad.textContent = (it.title || it.url) + " (unsupported link scheme)";
        outer.appendChild(bad);
      }
    } else {
      const strong = document.createElement("strong");
      strong.textContent = it.title || "(pasted)";
      outer.appendChild(strong);
      const chars = document.createElement("span");
      chars.className = "muted";
      chars.textContent = ` ${it.chars} chars pasted`;
      outer.appendChild(chars);
    }

    if (it.note) {
      const n = document.createElement("span");
      n.className = "muted";
      n.textContent = ` — ${it.note}`;
      outer.appendChild(n);
    }

    const meta = document.createElement("div");
    meta.className = "muted";
    meta.textContent = `#${it.id} · ${fmtTime(it.added_at)} · ${it.status}`;

    li.appendChild(outer);
    li.appendChild(meta);
    ul.appendChild(li);
  });
}

async function loadReadQueue() {
  try {
    const data = await api("/read?status=queued");
    renderReadQueue(data.items || []);
    $("#read-status").textContent = `${(data.items || []).length} waiting · queue of ${data.owner}`;
  } catch (e) {
    // LOUD, never a silent empty list: an unreachable queue and an empty queue must
    // not look the same.
    // textContent, not innerHTML: an error string must not be able to inject markup.
    const ul = $("#read-list");
    ul.replaceChildren();
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "could not load queue: " + e.message;
    ul.appendChild(li);
  }
}

async function sendToRead() {
  const url = $("#read-url").value.trim();
  const text = $("#read-text").value.trim();
  if (!url && !text) { $("#read-status").textContent = "give a URL or paste the text"; return; }
  const btn = $("#read-send");
  btn.disabled = true;
  $("#read-status").textContent = "sending…";
  try {
    const body = JSON.stringify({ url, text, title: $("#read-title").value.trim(),
                                  note: $("#read-note").value.trim() });
    const res = await api("/read", { method: "POST", body });
    // Clear only on CONFIRMED success — losing a long paste to a failed send is the
    // one unacceptable outcome for a thing whose job is "don't lose what I gave you".
    $("#read-url").value = ""; $("#read-text").value = "";
    $("#read-title").value = ""; $("#read-note").value = "";
    $("#read-status").textContent = res.requeued
      ? `re-queued #${res.id}` : `queued #${res.id} (${res.kind || "url"})`;
    loadReadQueue();
  } catch (e) {
    $("#read-status").textContent = "failed: " + e.message + " — your text is still here";
  } finally {
    btn.disabled = false;
  }
}
