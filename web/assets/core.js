/* ============================================================
   AgentMart web — core: utilities, safe HTML, API client,
   session, toasts, dialogs, icons, product art, router.
   ============================================================ */
"use strict";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const REDUCED = (() => { try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; } })();
let _uid = 0; const uid = p => (p || "u") + (++_uid);

/* ---------- Safe HTML ----------
   All markup is built with the `h` tagged template. Every interpolated
   value is HTML-escaped unless it is a Raw (produced by h/raw). Arrays
   are flattened with the same rule. Never concatenate untrusted strings
   into markup by hand. */
const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };
const esc = s => String(s).replace(/[&<>"'`]/g, c => ESC_MAP[c]);
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
const raw = s => new Raw(String(s));
function fmtVal(v) {
  if (v === null || v === undefined || v === false) return "";
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(fmtVal).join("");
  return esc(String(v));
}
function h(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += fmtVal(vals[i]) + strings[i + 1];
  return new Raw(out);
}
function setHTML(el, markup) { if (el) el.innerHTML = markup instanceof Raw ? markup.s : fmtVal(markup); }
/* only allow http(s) URLs into href/src attributes */
function safeUrl(u, httpsOnly = false) {
  if (typeof u !== "string" || !u) return "";
  try {
    const url = new URL(u, location.href);
    if (url.protocol === "https:" || (!httpsOnly && url.protocol === "http:")) return url.href;
  } catch (e) { /* invalid */ }
  return "";
}

/* ---------- Formatting ---------- */
const money = (cents, opts = {}) => {
  const n = Number(cents || 0) / 100;
  const whole = Math.abs(n % 1) < 1e-9;
  return (n < 0 ? "−" : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: whole && !opts.fixed ? 0 : 2, maximumFractionDigits: 2 });
};
const money2 = cents => money(cents, { fixed: true });
const num = n => Number(n || 0).toLocaleString("en-US");
const plural = (n, w, p) => `${num(n)} ${n === 1 ? w : (p || w + "s")}`;
function when(iso) {
  if (!iso) return "";
  const d = new Date(iso); if (isNaN(d)) return String(iso);
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 45) return "just now";
  if (s < 3600) return Math.round(s / 60) + " min ago";
  if (s < 86400) return Math.round(s / 3600) + " h ago";
  if (s < 86400 * 7) return Math.round(s / 86400) + " d ago";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
const fullTime = iso => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleString("en-US"); };
function dollarsToCents(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  if (!isFinite(n)) return NaN;
  return Math.round(n * 100);
}
const centsToDollars = c => (c === null || c === undefined) ? "" : (Number(c) / 100).toFixed(2).replace(/\.00$/, "");
function idemKey() {
  try { if (crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) { /* fall through */ }
  let s = ""; const a = new Uint8Array(16);
  try { crypto.getRandomValues(a); } catch (e) { for (let i = 0; i < 16; i++) a[i] = Math.floor(Math.random() * 256); }
  a.forEach(b => { s += b.toString(16).padStart(2, "0"); });
  return s;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- Session (API key lives in sessionStorage only) ---------- */
const Session = {
  _mem: null,
  _k: "agentmart.api_key",
  get() {
    try { const v = sessionStorage.getItem(this._k); if (v) return v; } catch (e) { /* storage blocked */ }
    return this._mem;
  },
  set(key) {
    this._mem = key;
    try { sessionStorage.setItem(this._k, key); } catch (e) { /* storage blocked: keep in memory */ }
  },
  clear() {
    this._mem = null;
    try { sessionStorage.removeItem(this._k); } catch (e) { /* ignore */ }
    Session.me = null;
  },
  me: null, // cached GET /v1/me
};

/* ---------- API client ---------- */
const API_BASE = () => String(window.AGENTMART_API || "").replace(/\/+$/, "");
class ApiError extends Error {
  constructor({ status = 0, code = "network_error", message = "Something went wrong.", request_id = null, details = null } = {}) {
    super(message); this.status = status; this.code = code; this.request_id = request_id; this.details = details;
  }
}
const FRIENDLY = {
  network_error: "Can't reach the AgentMart API. Check your connection and try again.",
  unauthorized: "That API key wasn't accepted. Sign in again.",
  rate_limited: "Too many requests. Wait a moment and try again.",
  internal: "The API had a problem on its side. Try again shortly.",
  not_implemented: "This feature isn't switched on for AgentMart right now.",
};
/**
 * api(path, {method, body, auth, idempotencyKey, query, quiet})
 *  - path: "/v1/..." relative to the API base
 *  - auth: true → send the session API key (throws unauthorized if none)
 *  - quiet: true → don't toast errors (caller renders them inline)
 * Resolves to parsed JSON (or null for empty bodies). Rejects with ApiError.
 */
async function api(path, { method = "GET", body, auth = false, idempotencyKey, query, quiet = false, signal } = {}) {
  let url = API_BASE() + path;
  if (query) {
    const qs = new URLSearchParams();
    Object.entries(query).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== "") qs.set(k, String(v)); });
    const s = qs.toString(); if (s) url += (url.includes("?") ? "&" : "?") + s;
  }
  const headers = { "Accept": "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const key = Session.get();
  if (auth) {
    if (!key) {
      const err = new ApiError({ status: 401, code: "unauthorized", message: "Sign in with an API key first." });
      if (!quiet) toast(err.message, "bad");
      throw err;
    }
    headers["Authorization"] = "Bearer " + key;
  } else if (auth === null && key) {
    headers["Authorization"] = "Bearer " + key; // optional auth
  }
  let res;
  try {
    res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal, credentials: "omit", cache: "no-store" });
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    const err = new ApiError({ code: "network_error", message: FRIENDLY.network_error });
    if (!quiet) toast(err.message, "bad");
    throw err;
  }
  const rid = res.headers.get("X-Request-Id");
  let data = null;
  const text = await res.text().catch(() => "");
  if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }
  if (!res.ok) {
    const e = (data && data.error) || {};
    const code = e.code || ({ 400: "invalid_request", 401: "unauthorized", 402: "insufficient_funds", 403: "forbidden", 404: "not_found", 409: "conflict", 429: "rate_limited", 501: "not_implemented" }[res.status]) || (res.status >= 500 ? "internal" : "http_" + res.status);
    const message = e.message || FRIENDLY[code] || `Request failed (${res.status}).`;
    const err = new ApiError({ status: res.status, code, message, request_id: e.request_id || rid, details: e.details || null });
    if (res.status === 401 && auth && Session.get()) { Session.clear(); renderNavAgent(); }
    if (!quiet) toast(message, "bad");
    throw err;
  }
  if (!text && res.status !== 204 && !data) return null;
  if (data === null && text) throw new ApiError({ status: res.status, code: "bad_response", message: "The API returned something that isn't JSON." });
  return data;
}
/* Error markup for inline error states */
function errorState(err, { retry = true, title = "Couldn't load this." } = {}) {
  const e = err || {};
  return h`<div class="state err" role="alert"><div class="emoji" aria-hidden="true">⚠️</div><h3 class="h-sm mt3">${title}</h3><p class="muted">${e.message || "Unknown error."}</p>${e.code ? h`<p class="rid">${e.code}${e.request_id ? " · request " + e.request_id : ""}</p>` : ""}${retry ? h`<button type="button" class="btn btn-sm mt5" data-retry>Try again</button>` : ""}</div>`;
}

/* ---------- Toasts ---------- */
function toast(msg, kind = "") {
  const t = $("#toast"); if (!t) return;
  t.textContent = (kind === "bad" ? "⚠ " : kind === "ok" ? "✓ " : "") + msg;
  t.style.boxShadow = kind === "bad" ? "4px 4px 0 #E5383B" : "";
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), kind === "bad" ? 5200 : 2800);
}

/* ---------- Dialog (confirm / small forms) ---------- */
function confirmDialog({ title, body = "", confirm = "Confirm", danger = false }) {
  const d = $("#dlg");
  return new Promise(resolve => {
    setHTML(d, h`<form method="dialog" class="dlg-in"><h2 id="dlgTitle">${title}</h2>${body ? h`<p>${body}</p>` : ""}<div class="actions"><button class="btn btn-sm" value="cancel" type="submit">Cancel</button><button class="btn btn-sm ${danger ? "btn-danger" : "btn-primary"}" value="ok" type="submit">${confirm}</button></div></form>`);
    const done = () => { d.removeEventListener("close", done); resolve(d.returnValue === "ok"); };
    d.addEventListener("close", done);
    d.returnValue = "";
    if (typeof d.showModal === "function") d.showModal();
    else resolve(window.confirm(title));
  });
}

/* ---------- Clipboard ---------- */
async function copyText(text, btn) {
  let ok = false;
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); ok = true; }
  } catch (e) { /* fall back */ }
  if (!ok) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select(); ok = document.execCommand("copy"); ta.remove();
    } catch (e) { ok = false; }
  }
  if (btn) {
    const old = btn.textContent;
    btn.textContent = ok ? "Copied ✓" : "Select & copy";
    btn.classList.add("done");
    setTimeout(() => { btn.textContent = old; btn.classList.remove("done"); }, 1600);
  }
  toast(ok ? "Copied to clipboard" : "Couldn't access the clipboard. Select the text and copy it manually.", ok ? "ok" : "bad");
}

/* ---------- Busy buttons ---------- */
async function busy(btn, fn) {
  if (!btn) return fn();
  if (btn.classList.contains("is-busy")) return;
  const html = btn.innerHTML;
  btn.classList.add("is-busy"); btn.setAttribute("aria-busy", "true"); btn.disabled = true;
  btn.insertAdjacentHTML("afterbegin", '<span class="spin" aria-hidden="true"></span>');
  try { return await fn(); }
  finally { btn.classList.remove("is-busy"); btn.removeAttribute("aria-busy"); btn.disabled = false; btn.innerHTML = html; }
}

/* ---------- Form helpers ---------- */
function fieldErr(form, name, msg) {
  const input = form.querySelector(`[name="${name}"]`);
  const box = form.querySelector(`[data-err-for="${name}"]`);
  if (input) { if (msg) { input.setAttribute("aria-invalid", "true"); } else input.removeAttribute("aria-invalid"); }
  if (box) box.textContent = msg || "";
}
function clearErrs(form) {
  $$("[aria-invalid]", form).forEach(i => i.removeAttribute("aria-invalid"));
  $$("[data-err-for]", form).forEach(b => { b.textContent = ""; });
  const g = form.querySelector("[data-form-err]"); if (g) g.textContent = "";
}
function formErr(form, msg) { const g = form.querySelector("[data-form-err]"); if (g) g.textContent = msg || ""; }
function focusFirstError(form) { const f = form.querySelector('[aria-invalid="true"]'); if (f) f.focus(); }
/* map API validation errors (details / message mentioning a field) onto inputs */
function applyApiError(form, err, fields = []) {
  let placed = false;
  const det = err && err.details;
  if (det && typeof det === "object") {
    // backend shape: details.field = "email" | "shipping_address.city" …
    if (typeof det.field === "string") {
      const cands = [det.field, det.field.split(".").pop()];
      const hit = cands.find(n => form.querySelector(`[name="${CSS.escape(n)}"]`));
      if (hit) { fieldErr(form, hit, err.message); placed = true; }
    }
    if (!placed) Object.entries(det).forEach(([k, v]) => { if (k !== "field" && form.querySelector(`[name="${CSS.escape(k)}"]`)) { fieldErr(form, k, String(v)); placed = true; } });
  }
  if (!placed && err && err.message) {
    const f = fields.find(n => new RegExp("\\b" + n.replace(/_/g, "[_ ]") + "\\b", "i").test(err.message));
    if (f && form.querySelector(`[name="${f}"]`)) { fieldErr(form, f, err.message); placed = true; }
  }
  formErr(form, (placed ? "Fix the highlighted field. " : "") + (err ? err.message : "") + (err && err.request_id ? ` (request ${err.request_id})` : ""));
  focusFirstError(form);
}
/* field markup */
function field(id, label, control, { hint = "", optional = false, name } = {}) {
  return h`<div class="field"><label for="${id}">${label}${optional ? h` <span class="opt">(optional)</span>` : ""}</label>${control}${hint ? h`<p class="hint" id="${id}-hint">${hint}</p>` : ""}<p class="err" data-err-for="${name || id}" id="${id}-err" aria-live="polite"></p></div>`;
}

/* ---------- Code blocks ---------- */
function hlJSON(obj) {
  const json = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
  return raw(esc(json).replace(/(&quot;(?:\\.|[^&]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (m, str, colon, bool, n) => {
      if (str) return colon ? `<span class="j-k">${str}</span><span class="j-p">${colon}</span>` : `<span class="j-s">${str}</span>`;
      if (bool) return `<span class="j-b">${bool}</span>`;
      if (n) return `<span class="j-n">${n}</span>`;
      return m;
    }));
}
function hlCode(src) {
  let out = esc(src);
  out = out.replace(/(^|\n)(\s*)(#[^\n]*|\/\/[^\n]*)/g, (m, a, sp, c) => `${a}${sp}<span class="j-c">${c}</span>`);
  out = out.replace(/(&quot;[^\n]*?&quot;|&#39;[^\n]*?&#39;)/g, '<span class="j-s">$1</span>');
  out = out.replace(/\b(curl|import|from|const|await|async|return|def|print|export|new|let)\b/g, '<span class="j-m">$1</span>');
  out = out.replace(/(\s)(-[A-Za-z]|--[a-z-]+)\b/g, '$1<span class="j-b">$2</span>');
  out = out.replace(/\b(GET|POST|PUT|PATCH|DELETE)\b/g, '<span class="j-n">$1</span>');
  return raw(out);
}
const CODE_TABS = {};
function codeBlock({ title = "", tabs = null, code = "", lang = "json", id = uid("cb") }) {
  if (tabs) { CODE_TABS[id] = tabs; code = tabs[0].code; lang = tabs[0].lang || "code"; }
  const body = lang === "json" ? hlJSON(code) : hlCode(code);
  const head = tabs
    ? h`<div class="code-tabs" role="tablist" aria-label="Code language">${tabs.map((t, i) => h`<button type="button" role="tab" aria-selected="${String(i === 0)}" data-cb="${id}" data-i="${i}">${t.label}</button>`)}</div>`
    : h`<span>${title}</span>`;
  return h`<div class="code" id="${id}"><div class="code-h"><div class="row gap3" style="min-width:0"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>${head}</div><button type="button" class="copy" data-copy="${id}">Copy</button></div><pre tabindex="0"><code>${body}</code></pre></div>`;
}

/* ---------- Icons ---------- */
const IC = {
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.8-3.8"/>',
  check: '<path d="M4.5 12.5l5 5 10-11"/>',
  shield: '<path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3M14 9l2 2"/>',
  store: '<path d="M4 10v10h16V10"/><path d="M3 10l2-6h14l2 6c0 1.7-1.3 3-3 3s-3-1.3-3-3c0 1.7-1.3 3-3 3s-3-1.3-3-3c0 1.7-1.3 3-3 3s-3-1.3-3-3z"/><path d="M10 20v-5h4v5"/>',
  bot: '<rect x="4" y="8" width="16" height="12" rx="4"/><path d="M12 8V4"/><circle cx="12" cy="3" r="1"/><circle cx="9" cy="14" r="1.3" fill="currentColor"/><circle cx="15" cy="14" r="1.3" fill="currentColor"/>',
  code: '<path d="M8 7l-5 5 5 5M16 7l5 5-5 5"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  filter: '<path d="M3 5h18M7 12h10M10 19h4"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  box: '<path d="M3 7.5L12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5l9 4.5 9-4.5M12 12v9"/>',
  truck: '<path d="M2 6h11v10H2zM13 10h4l4 4v2h-8"/><circle cx="6" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="3"/><path d="M8 10V7a4 4 0 018 0v3"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
  coin: '<circle cx="12" cy="12" r="9"/><path d="M14.5 9.5c-.5-1-1.5-1.5-2.5-1.5-1.5 0-2.5.8-2.5 2 0 2.8 5 1.5 5 4 0 1.2-1 2-2.5 2-1 0-2-.5-2.5-1.5M12 6.5V8M12 16v1.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6"/>',
  plug: '<path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 01-12 0zM12 17v5"/>',
  webhook: '<circle cx="6" cy="17" r="3"/><circle cx="18" cy="17" r="3"/><circle cx="12" cy="6" r="3"/><path d="M10.5 8.5L7.5 14.5M13.5 8.5l3 6M9 17h6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  refresh: '<path d="M20 11a8 8 0 10-2.3 5.7M20 4v7h-7"/>',
  out: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9S9.5 5.5 12 3z"/>',
  ret: '<path d="M9 14l-5-5 5-5"/><path d="M4 9h11a5 5 0 010 10h-3"/>',
};
const icon = (n, size = 20, sw = 2.2) => raw(`<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${IC[n] || ""}</svg>`);

/* ---------- Kinds ---------- */
const KINDS = {
  physical: { label: "Physical products", short: "Physical", cls: "b-physical", color: "#FF5B1F", blurb: "Home & kitchen, electronics accessories, office, pet, outdoor and beauty. Live stock, real shipping, and tracking posted back to the buying agent." },
  digital: { label: "Digital products", short: "Digital", cls: "b-digital", color: "#C9B8FF", blurb: "Software licenses, eBooks, datasets and templates, delivered in the order response the moment payment clears." },
  service: { label: "Services", short: "Service", cls: "b-service", color: "#FFB8D9", blurb: "Also supported: scoped work with a stated turnaround and deliverable, paid out after delivery." },
};

/* ---------- Product art (original geometric SVG) ---------- */
const INK = "#141210", PAPER = "#FFFDF8";
const S = `stroke="${INK}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"`;
function starPath(cx, cy, r1, r2, n = 5) {
  let d = "";
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 ? r2 : r1, a = Math.PI / n * i - Math.PI / 2;
    d += (i ? "L" : "M") + (cx + r * Math.cos(a)).toFixed(1) + " " + (cy + r * Math.sin(a)).toFixed(1);
  }
  return d + "Z";
}
const ART = {
  mug: (c1, c2, mark) => `<path d="M150 58q-12 14 0 26t0 26M185 50q-12 14 0 26t0 26M220 58q-12 14 0 26t0 26" fill="none" ${S} opacity=".55"/><path d="M250 128q52 0 52 40t-52 40" fill="none" stroke="${INK}" stroke-width="22" stroke-linecap="round"/><path d="M250 128q52 0 52 40t-52 40" fill="none" stroke="${c1}" stroke-width="12" stroke-linecap="round"/><rect x="128" y="112" width="124" height="132" rx="18" fill="${c1}" ${S}/><path d="M128 130a18 18 0 0118-18h88a18 18 0 0118 18v18q-11 12-22 0q-11 16-22 0q-12 13-24 0q-11 18-22 0q-12 11-24 0z" fill="${c2}" ${S}/><rect x="160" y="182" width="60" height="30" rx="8" fill="${PAPER}" ${S}/><text x="190" y="203" text-anchor="middle" font-family="Bricolage Grotesque,system-ui,sans-serif" font-weight="800" font-size="15" fill="${INK}">${esc(mark)}</text>`,
  beans: (c1, c2) => `<path d="M142 96h116l14 144H128z" fill="${c1}" ${S}/><rect x="136" y="72" width="128" height="30" rx="6" fill="${c2}" ${S}/><path d="M150 87h100" ${S} stroke-dasharray="6 8"/><rect x="160" y="132" width="80" height="74" rx="12" fill="${PAPER}" ${S}/><ellipse cx="200" cy="162" rx="16" ry="21" fill="#7A4A2A" ${S} transform="rotate(20 200 162)"/><ellipse cx="96" cy="236" rx="11" ry="15" fill="#7A4A2A" ${S} transform="rotate(-30 96 236)"/><ellipse cx="302" cy="232" rx="11" ry="15" fill="#7A4A2A" ${S} transform="rotate(40 302 232)"/>`,
  pack: (c1, c2) => `<path d="M176 78q0-24 24-24t24 24" fill="none" stroke="${INK}" stroke-width="10" stroke-linecap="round"/><rect x="132" y="74" width="136" height="172" rx="38" fill="${c1}" ${S}/><path d="M132 128q0-54 68-54t68 54v26H132z" fill="${c2}" ${S}/><rect x="188" y="142" width="24" height="20" rx="5" fill="#FFE14D" ${S}/><rect x="160" y="182" width="80" height="48" rx="14" fill="${c2}" ${S}/><path d="M172 196h56" ${S}/>`,
  plant: (c1, c2) => `<g fill="#2FBF71" ${S}><path d="M200 176q-26-60 0-126q26 66 0 126z"/><path d="M196 178q-60-30-72-96q54 30 72 96z"/><path d="M204 178q60-30 72-96q-54 30-72 96z"/></g><path d="M150 186h100l-14 64h-72z" fill="${c1}" ${S}/><rect x="140" y="172" width="120" height="24" rx="8" fill="${c2}" ${S}/>`,
  candle: (c1, c2) => `<path d="M200 58q20 22 0 44q-20-22 0-44z" fill="#FFE14D" ${S}/><path d="M200 102v18" ${S}/><rect x="146" y="112" width="108" height="136" rx="22" fill="${c1}" ${S}/><rect x="156" y="132" width="88" height="104" rx="14" fill="${PAPER}" ${S}/><rect x="164" y="170" width="72" height="36" rx="8" fill="${c2}" ${S}/>`,
  headphones: (c1, c2) => `<path d="M128 186v-36a72 72 0 01144 0v36" fill="none" stroke="${INK}" stroke-width="24" stroke-linecap="round"/><path d="M128 186v-36a72 72 0 01144 0v36" fill="none" stroke="${c1}" stroke-width="14" stroke-linecap="round"/><rect x="102" y="164" width="52" height="82" rx="22" fill="${c2}" ${S}/><rect x="246" y="164" width="52" height="82" rx="22" fill="${c2}" ${S}/><rect x="114" y="178" width="28" height="54" rx="12" fill="${c1}" ${S}/><rect x="258" y="178" width="28" height="54" rx="12" fill="${c1}" ${S}/>`,
  stickers: (c1, c2) => `<path d="${starPath(140, 120, 62, 30, 6)}" fill="${c1}" ${S}/><circle cx="260" cy="118" r="54" fill="${c2}" ${S}/><text x="260" y="128" text-anchor="middle" font-family="Bricolage Grotesque,system-ui,sans-serif" font-weight="800" font-size="30" fill="${INK}">hi!</text><rect x="160" y="178" width="120" height="66" rx="33" fill="#4FE3A1" ${S} transform="rotate(-6 220 211)"/><text x="220" y="220" text-anchor="middle" font-family="Bricolage Grotesque,system-ui,sans-serif" font-weight="800" font-size="22" fill="${INK}" transform="rotate(-6 220 211)">ship it</text>`,
  font: (c1, c2) => `<path d="M70 218h260M70 110h260" stroke="${INK}" stroke-width="2" stroke-dasharray="6 6" opacity=".5"/><text x="200" y="218" text-anchor="middle" font-family="Bricolage Grotesque,Georgia,serif" font-weight="800" font-size="170" letter-spacing="-8" fill="${c1}" stroke="${INK}" stroke-width="5" paint-order="stroke">Aa</text><rect x="252" y="236" width="104" height="30" rx="15" fill="${c2}" ${S}/>`,
  template: (c1, c2) => `<rect x="170" y="62" width="130" height="176" rx="14" fill="${c2}" ${S} transform="rotate(8 235 150)"/><rect x="110" y="56" width="140" height="186" rx="14" fill="${PAPER}" ${S}/><path d="M110 70a14 14 0 0114-14h112a14 14 0 0114 14v24H110z" fill="${c1}" ${S}/><g ${S} fill="${PAPER}"><rect x="128" y="114" width="18" height="18" rx="5" fill="#4FE3A1"/><path d="M156 123h74"/><rect x="128" y="146" width="18" height="18" rx="5" fill="#4FE3A1"/><path d="M156 155h60"/><rect x="128" y="178" width="18" height="18" rx="5"/><path d="M156 187h70"/><rect x="128" y="210" width="18" height="18" rx="5"/><path d="M156 219h48"/></g>`,
  dataset: (c1, c2) => `<path d="M118 88v120c0 14 30 26 66 26s66-12 66-26V88" fill="${c1}" ${S}/><path d="M118 128c0 14 30 26 66 26s66-12 66-26M118 168c0 14 30 26 66 26s66-12 66-26" fill="none" ${S}/><ellipse cx="184" cy="88" rx="66" ry="26" fill="${c2}" ${S}/><g ${S}><rect x="270" y="170" width="18" height="60" rx="4" fill="#FFE14D"/><rect x="296" y="140" width="18" height="90" rx="4" fill="#FF5B1F"/><rect x="322" y="116" width="18" height="114" rx="4" fill="#4FE3A1"/></g>`,
  api: (c1, c2) => `<rect x="118" y="62" width="164" height="164" rx="36" fill="${c1}" ${S}/><text x="200" y="176" text-anchor="middle" font-family="JetBrains Mono,monospace" font-weight="700" font-size="84" fill="${PAPER}" stroke="${INK}" stroke-width="4" paint-order="stroke">{ }</text><rect x="236" y="196" width="96" height="40" rx="20" fill="${c2}" ${S}/><text x="284" y="222" text-anchor="middle" font-family="JetBrains Mono,monospace" font-weight="700" font-size="14" fill="${INK}">200 OK</text>`,
  cassette: (c1, c2) => `<rect x="108" y="74" width="184" height="126" rx="16" fill="${c1}" ${S}/><rect x="130" y="92" width="140" height="56" rx="8" fill="${PAPER}" ${S}/><circle cx="166" cy="120" r="14" fill="${c2}" ${S}/><circle cx="234" cy="120" r="14" fill="${c2}" ${S}/><path d="M180 120h40" ${S}/><path d="M146 200l14-26h80l14 26" fill="${c2}" ${S}/>`,
  translate: (c1, c2) => `<path d="M100 74h140a22 22 0 0122 22v48a22 22 0 01-22 22h-86l-30 26v-26h-24a22 22 0 01-22-22V96a22 22 0 0122-22z" fill="${c1}" ${S}/><text x="170" y="132" text-anchor="middle" font-family="Bricolage Grotesque,system-ui,sans-serif" font-weight="800" font-size="36" fill="${INK}">¡Hola!</text><path d="M300 144H178a22 22 0 00-22 22v40a22 22 0 0022 22h74l30 24v-24h18a22 22 0 0022-22v-40a22 22 0 00-22-22z" fill="${c2}" ${S}/><text x="240" y="198" text-anchor="middle" font-family="Bricolage Grotesque,system-ui,sans-serif" font-weight="800" font-size="34" fill="${INK}">Hello!</text>`,
  design: (c1, c2) => `<circle cx="112" cy="206" r="36" fill="#FFE14D" ${S}/><rect x="266" y="168" width="68" height="68" rx="10" fill="#4FE3A1" ${S} transform="rotate(12 300 202)"/><path d="M300 64l30 52h-60z" fill="${c2}" ${S}/><path d="M200 50l54 92-54 104-54-104z" fill="${c1}" ${S}/><path d="M200 150v96" ${S}/><circle cx="200" cy="140" r="12" fill="${PAPER}" ${S}/>`,
  server: (c1, c2) => [0, 1, 2].map(i => `<rect x="120" y="${66 + i * 58}" width="160" height="48" rx="12" fill="${i === 1 ? c2 : c1}" ${S}/><circle cx="146" cy="${90 + i * 58}" r="7" fill="#4FE3A1" ${S}/><circle cx="170" cy="${90 + i * 58}" r="7" fill="#FFE14D" ${S}/><path d="M204 ${90 + i * 58}h54" ${S} stroke-dasharray="4 7"/>`).join(""),
};
const ART_BY_KIND = { physical: ["mug", "beans", "pack", "plant", "candle", "headphones", "stickers"], digital: ["font", "template", "dataset", "api", "cassette"], service: ["translate", "design", "server"] };
const ART_WORDS = [[/mug|cup|ceramic/, "mug"], [/coffee|bean|tea|grocer/, "beans"], [/bag|pack|tote|backpack/, "pack"], [/plant|garden|seed/, "plant"], [/candle|scent|soap|lantern|lamp|light/, "candle"], [/headphone|audio|speaker|mic|usb|hub|cable|charger|electronic/, "headphones"], [/leash|dog|cat|pet|organizer|desk/, "pack"], [/sticker|print|label|poster/, "stickers"], [/font|type/, "font"], [/template|doc|notion|pdf|e-?book|guide/, "template"], [/data|dataset|csv|index/, "dataset"], [/api|key|license|credit/, "api"], [/music|loop|sound|audio pack/, "cassette"], [/translat|language|locali/, "translate"], [/design|logo|brand|illustr/, "design"], [/host|server|compute|gpu|deploy|code|dev/, "server"]];
const BGS = ["#FFE14D", "#FFD6C4", "#D4DDFF", "#CFF7E4", "#FFB8D9", "#FFF3B0", "#C9B8FF", "#FFFDF8"];
const C1S = ["#FF5B1F", "#2F5BFF", "#141210", "#4FE3A1", "#C9B8FF", "#FFE14D"];
function hashStr(s) { let x = 2166136261; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); } return x >>> 0; }
function artFor(l) {
  const id = String(l.id || l.title || "x");
  const hs = hashStr(id);
  const text = ((l.title || "") + " " + (l.category || "") + " " + (Array.isArray(l.tags) ? l.tags.join(" ") : "")).toLowerCase();
  const pool = ART_BY_KIND[l.kind] || ART_BY_KIND.digital;
  let kind = null;
  for (const [re, k] of ART_WORDS) if (re.test(text) && pool.includes(k)) { kind = k; break; }
  if (!kind) kind = pool[hs % pool.length];
  const bg = BGS[hs % BGS.length];
  let c1 = C1S[(hs >> 3) % C1S.length]; if (c1 === bg) c1 = "#FF5B1F";
  if (c1 === INK && (kind === "translate" || kind === "font" || kind === "api")) c1 = "#FFE14D"; // keep text legible
  let c2 = BGS[(hs >> 6) % BGS.length]; if (c2 === bg) c2 = PAPER;
  const mark = (l.title || "AM").split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("");
  return { kind, bg, c1, c2, mark };
}
function artSVG(l) {
  const a = artFor(l), id = uid("f");
  return raw(`<svg viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice" role="img" aria-label="${esc(cleanCopy(l.title || "Listing") + " illustration")}"><defs><pattern id="${id}p" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.6" fill="${INK}" opacity=".13"/></pattern><filter id="${id}" x="-20%" y="-20%" width="150%" height="150%"><feFlood flood-color="${INK}"/><feComposite in2="SourceAlpha" operator="in"/><feOffset dx="7" dy="7" result="s"/><feMerge><feMergeNode in="s"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><rect width="400" height="300" fill="${a.bg}"/><rect width="400" height="300" fill="url(#${id}p)"/><ellipse cx="200" cy="262" rx="120" ry="10" fill="${INK}" opacity=".12"/><g filter="url(#${id})">${ART[a.kind](a.c1, a.c2, a.mark)}</g></svg>`);
}
/* listing image: https image_url if present, else generated art */
function listingMedia(l) {
  const src = safeUrl(l.image_url, true);
  if (src) return h`<img src="${src}" alt="${cleanCopy(l.title) || "Listing image"}" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-fallback="1">`;
  return artSVG(l);
}
/* swap broken remote images for generated art (CSP-safe: no inline handlers) */
document.addEventListener("error", e => {
  const t = e.target;
  if (t && t.tagName === "IMG" && t.dataset.fallback && !t.dataset.failed) {
    t.dataset.failed = "1";
    const holder = document.createElement("span");
    holder.style.display = "contents";
    holder.innerHTML = artSVG({ id: t.src, title: t.alt, kind: "digital" }).s;
    t.replaceWith(holder);
  }
}, true);

/* ---------- Robot mini ---------- */
function robotMini(size = 30) {
  return raw(`<svg viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true"><rect x="5" y="9" width="22" height="17" rx="6" fill="#FFFDF8" stroke="#141210" stroke-width="2"/><rect x="8" y="13" width="16" height="8" rx="4" fill="#141210"/><circle cx="12.5" cy="17" r="1.8" fill="#4FE3A1"/><circle cx="19.5" cy="17" r="1.8" fill="#4FE3A1"/><path d="M16 9V4" stroke="#141210" stroke-width="2"/><circle cx="16" cy="4" r="2" fill="#FFE14D" stroke="#141210" stroke-width="1.5"/></svg>`);
}

/* ---------- Shared listing accessors (tolerant of API shape) ---------- */
function lStore(l) {
  const st = (l && typeof l.store === "object" && l.store) || {};
  const se = (l && typeof l.seller === "object" && l.seller) || {};
  const ss = (se && typeof se.store === "object" && se.store) || {};
  return {
    slug: st.slug || l.store_slug || ss.slug || se.store_slug || (typeof l.store === "string" ? l.store : ""),
    name: st.name || l.store_name || ss.name || se.store_name || "",
    ships_from: st.ships_from || se.ships_from || "",
    agent_id: se.agent_id || l.seller_agent_id || st.owner_agent_id || "",
    agent_name: se.name || "",
    return_policy: st.return_policy || ss.return_policy || se.return_policy || "",
    completed_sales: se.completed_sales,
    member_since: se.member_since,
    seed: !!(st.is_demo || se.is_demo),
  };
}
/* Seed data flag from the API (field name is_demo). During the public beta every listing is
   presented as an illustrative example regardless, see EXAMPLE_LABEL below. */
const isSeedData = l => !!(l && (l.is_demo || (l.store && l.store.is_demo) || (l.seller && l.seller.is_demo)));
const EXAMPLE_LABEL = "Example listing";
const BETA_NOTICE = "Listings shown during the beta are illustrative examples. Purchases use sandbox credits and nothing ships.";
/* Strip a leading "[Demo]" / "[Test]" token from catalog copy for display. */
function cleanCopy(s) { return String(s == null ? "" : s).replace(/^\s*\[(?:demo|test)\][\s:·—–-]*/i, ""); }
function betaNoticeHTML() { return h`<div class="beta-notice" role="note">${icon("spark", 18)}<span>${BETA_NOTICE}</span></div>`; }

/* ---------- Contact ---------- */
const CONTACTS = [
  ["General", "hello@agentmart.us", "Questions, partnerships and press"],
  ["Support", "support@agentmart.us", "Help with agents, stores and orders"],
  ["Founder", "shanto@agentmart.us", "Talk to the founder directly"],
];
function contactListHTML({ compact = false } = {}) {
  return h`<ul class="contact-list${compact ? " compact" : ""}">${CONTACTS.map(([label, email, blurb]) => h`<li><span class="c-lab">${label}</span><a class="c-mail" href="mailto:${email}">${email}</a>${compact ? "" : h`<span class="c-blurb">${blurb}</span>`}<button type="button" class="btn btn-sm btn-ghost c-copy" data-copy data-copy-text="${email}" aria-label="Copy ${email}">Copy</button></li>`)}</ul>`;
}
function stockLabel(l) {
  if (l.status === "sold_out" || l.in_stock === false) return "Sold out";
  if (l.inventory === null || l.inventory === undefined) return l.kind === "physical" ? "" : "Unlimited";
  const n = Number(l.inventory);
  if (n <= 0) return "Sold out";
  return `${num(n)} in stock`;
}
function deliveryLabel(l) {
  if (l.kind === "digital") return "Instant delivery";
  if (l.kind === "service") {
    const d = l.service_terms && l.service_terms.turnaround_days;
    return d ? `Delivered in ${plural(d, "day")}` : "Service";
  }
  const hd = l.shipping && l.shipping.handling_days;
  return hd !== undefined && hd !== null ? (Number(hd) === 0 ? "Ships same day" : `Ships in ${plural(hd, "day")}`) : "Seller-shipped";
}

/* ---------- Ratings ---------- */
function ratingOf(x) { const r = x && x.rating; return r && typeof r === "object" ? r : { average: null, count: 0 }; }
function starsHTML(avg, { size = "" } = {}) {
  const v = Math.max(0, Math.min(5, Number(avg) || 0));
  const pct = (v / 5) * 100;
  return h`<span class="stars-g ${size}" role="img" aria-label="${v ? v.toFixed(1) + " out of 5 stars" : "No ratings yet"}"><span class="stars-bg" aria-hidden="true">★★★★★</span><span class="stars-fg" aria-hidden="true" style="width:${pct}%">★★★★★</span></span>`;
}
function ratingLine(x, { size = "", link = "" } = {}) {
  const r = ratingOf(x);
  if (!r.count) return h`<span class="rating-line muted">${starsHTML(0, { size })}<span class="small">No reviews yet</span></span>`;
  return h`<span class="rating-line">${starsHTML(r.average, { size })}<b>${Number(r.average).toFixed(1)}</b>${link ? h`<a class="small link" href="${link}">(${plural(r.count, "review")})</a>` : h`<span class="small muted">(${num(r.count)})</span>`}</span>`;
}

function cardHTML(l) {
  const k = KINDS[l.kind] || { short: l.kind || "Listing", cls: "" };
  const st = lStore(l);
  const ready = l.agent_readiness;
  const ship = l.kind === "physical" && l.shipping && l.shipping.shipping_cents !== undefined ? (Number(l.shipping.shipping_cents) ? "+ " + money(l.shipping.shipping_cents) + " shipping" : "Free shipping") : "";
  return h`<a class="pcard" href="#/listing/${encodeURIComponent(l.id)}">
    <div class="art">${listingMedia(l)}<span class="badge ${k.cls}">${k.short}</span>${ready !== undefined && ready !== null ? h`<span class="score" title="Agent Readiness Score"><i>${Math.round(ready)}</i>ready</span>` : ""}<span class="sticker example-stk">${EXAMPLE_LABEL}</span></div>
    <div class="body">
      <h3>${cleanCopy(l.title)}</h3>
      <span class="seller">${st.name || st.slug || "AgentMart seller"}</span>
      ${ratingLine(l)}
      ${stockLabel(l) ? h`<span class="stock">${stockLabel(l)}</span>` : ""}
      <div class="meta"><span class="pr">${money(l.price_cents)}</span><span class="ship">${deliveryLabel(l)}${ship ? h`<br>${ship}` : ""}</span></div>
    </div></a>`;
}
function skeletonCards(n = 6) {
  return raw(Array.from({ length: n }, () => `<div class="skel-card" aria-hidden="true"><div class="skel skel-art"></div><div class="skel-body"><div class="skel skel-line big w80"></div><div class="skel skel-line w60"></div><div class="skel skel-line w40"></div></div></div>`).join(""));
}
/* strip private fields before showing JSON to humans (payload is never public anyway) */
function publicJSON(l) { const o = Object.assign({}, l); delete o.digital_delivery; return o; }

/* ---------- Nav agent chip ---------- */
function renderNavAgent() {
  const box = $("#navAgent"); if (!box) return;
  const me = Session.me, a = me && (me.agent || me);
  if (Session.get() && a) {
    setHTML(box, h`<a class="nav-agent" href="#/console" title="Signed in as ${a.name || a.id}"><span class="live-dot" aria-hidden="true"></span><span>${a.name || a.id}</span></a>`);
  } else setHTML(box, "");
  $$("[data-hide-authed]").forEach(el => { el.hidden = !!(Session.get() && a); });
}
async function loadMe({ force = false, quiet = true } = {}) {
  if (!Session.get()) { Session.me = null; renderNavAgent(); return null; }
  if (Session.me && !force) return Session.me;
  const me = await api("/v1/me", { auth: true, quiet });
  Session.me = me; renderNavAgent();
  return me;
}

/* ---------- Router ---------- */
const VIEWS = ["home", "market", "listing", "store", "console", "developers"];
let currentView = null;
function parseHash() {
  const raw0 = location.hash.replace(/^#\/?/, "");
  const [pathPart, qs] = raw0.split("?");
  const parts = pathPart.split("/").filter(Boolean).map(p => { try { return decodeURIComponent(p); } catch (e) { return p; } });
  return { parts, query: new URLSearchParams(qs || "") };
}
function route() {
  const { parts, query } = parseHash();
  let v = parts[0] || "home";
  const sub = parts.slice(1);
  if (location.hash && !location.hash.startsWith("#/") && location.hash.length > 1) {
    // in-page anchor (e.g. #main from the skip link) — leave the current view alone
    const el = document.getElementById(location.hash.slice(1));
    if (el && currentView) { return; }
    v = "home";
  }
  if (!VIEWS.includes(v)) v = "notfound";
  const prev = currentView; currentView = v;
  $$(".view").forEach(s => s.classList.toggle("active", s.id === "view-" + v));
  const navKey = v === "home" && sub[0] === "pricing" ? "pricing" : (v === "listing" || v === "store") ? "market" : v;
  $$("[data-nav]").forEach(a => { if (a.dataset.nav === navKey) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  closeMenu();
  const view = $("#view-" + v);
  document.title = view.dataset.title;
  if (typeof onLeaveView === "function" && prev && prev !== v) onLeaveView(prev);
  try {
    if (v === "home") renderHome();
    if (v === "market") renderMarket(sub, query);
    if (v === "listing") renderListing(sub[0]);
    if (v === "store") renderStore(sub[0]);
    if (v === "console") renderConsole(sub, query);
    if (v === "developers") renderDevelopers(sub[0]);
  } catch (e) {
    console.warn("render failed", e);
  }
  const targetId = v === "home" ? sub[0] : v === "developers" && sub[0] ? "dev-" + sub[0] : "";
  requestAnimationFrame(() => {
    const el = targetId && document.getElementById(targetId);
    if (el) { const y = el.getBoundingClientRect().top + window.scrollY - 84; window.scrollTo({ top: y, behavior: "auto" }); }
    else if (!(v === "console" && prev === "console") && !(v === "market" && prev === "market")) window.scrollTo({ top: 0, behavior: "auto" });
  });
}
function closeMenu() {
  const m = $("#mobileMenu"); if (!m) return;
  m.classList.remove("open"); $("#menuBtn").setAttribute("aria-expanded", "false"); setHTML($("#menuBtn"), icon("menu"));
}

/* ---------- Global bindings ---------- */
function bindGlobal() {
  $("#menuBtn").addEventListener("click", () => {
    const o = $("#mobileMenu").classList.toggle("open");
    $("#menuBtn").setAttribute("aria-expanded", String(o));
    $("#menuBtn").setAttribute("aria-label", o ? "Close menu" : "Open menu");
    setHTML($("#menuBtn"), icon(o ? "x" : "menu"));
  });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && $("#mobileMenu").classList.contains("open")) { closeMenu(); $("#menuBtn").focus(); } });
  $("[data-skip]").addEventListener("click", e => { e.preventDefault(); const m = $("#main"); m.focus(); m.scrollIntoView(); });
  document.addEventListener("click", e => {
    const c = e.target.closest("[data-copy]");
    if (c) {
      const target = document.getElementById(c.dataset.copy);
      const text = c.dataset.copyText !== undefined ? c.dataset.copyText : (target ? (target.querySelector("pre") || target).innerText : "");
      copyText(text, c); return;
    }
    const tb = e.target.closest("[data-cb]");
    if (tb) {
      const tabs = CODE_TABS[tb.dataset.cb]; if (!tabs) return;
      const t = tabs[+tb.dataset.i], box = document.getElementById(tb.dataset.cb);
      setHTML(box.querySelector("pre code"), t.lang === "json" ? hlJSON(t.code) : hlCode(t.code));
      $$("[data-cb]", box).forEach(b => b.setAttribute("aria-selected", String(b === tb)));
    }
  });
  // code tab arrow-key support
  document.addEventListener("keydown", e => {
    const tb = e.target.closest && e.target.closest("[data-cb]");
    if (!tb || (e.key !== "ArrowRight" && e.key !== "ArrowLeft")) return;
    const sib = $$(`[data-cb="${tb.dataset.cb}"]`); const i = sib.indexOf(tb);
    const n = sib[(i + (e.key === "ArrowRight" ? 1 : -1) + sib.length) % sib.length];
    n.focus(); n.click();
  });
  $$("[data-api-link]").forEach(a => { a.href = API_BASE() + a.dataset.apiLink; a.target = "_blank"; });
  window.addEventListener("hashchange", route);
}

function init() {
  $$("[data-ic]").forEach(s => setHTML(s, icon(s.dataset.ic)));
  bindGlobal();
  if (typeof bindViews === "function") bindViews();
  if (typeof bindConsole === "function") bindConsole();
  route();
  if (Session.get()) loadMe().catch(() => { /* handled: nav stays signed-out */ });
}
document.addEventListener("DOMContentLoaded", init);
