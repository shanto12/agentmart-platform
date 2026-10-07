/* ============================================================
   AgentMart web: "Continue with Google" (OpenID redirect, id_token flow).
   No client secret and no SDK in the browser. The Google ID token is
   exchanged for an AgentMart session at AGENTMART_AUTH_GOOGLE.
   Inert (button not rendered) until AGENTMART_GOOGLE_CLIENT_ID is set.
   ============================================================ */
"use strict";
(function () {
  const KEY = "agentmart.g_oauth";       // sessionStorage: {state, nonce, ret, t}
  const MAX_AGE = 10 * 60 * 1000;        // a sign-in attempt is valid for 10 minutes
  const clientId = () => String(window.AGENTMART_GOOGLE_CLIENT_ID || "").trim();

  /* ---- sessionStorage helpers (never throw) ---- */
  const store = {
    set(o) { try { sessionStorage.setItem(KEY, JSON.stringify(o)); return sessionStorage.getItem(KEY) !== null; } catch (e) { return false; } },
    peek() { try { const v = sessionStorage.getItem(KEY); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
    drop() { try { sessionStorage.removeItem(KEY); } catch (e) { /* ignore */ } },
  };
  let exchanging = false; // true while the token exchange is in flight
  const setBusy = on => { exchanging = on; document.querySelectorAll("[data-google-signin]").forEach(b => { b.disabled = on; b.classList.toggle("is-busy", on); }); };
  const rand = n => { const a = new Uint8Array(n); crypto.getRandomValues(a); return Array.from(a, b => b.toString(16).padStart(2, "0")).join(""); };
  /* only ever return to the console (where the sign-in screen lives) */
  const safeRet = r => (typeof r === "string" && /^#\/console(?:[\/?][^\s]*)?$/.test(r) && r.length <= 400) ? r : "#/console";

  /* ---- 1. the button (rendered by console.js renderAuth) ---- */
  window.googleAuthHTML = function () {
    if (!clientId()) return "";
    const G = raw('<svg width="22" height="22" viewBox="0 0 48 48" aria-hidden="true" focusable="false"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>');
    return h`<div class="g-auth" id="googleAuth">
      <button type="button" class="btn btn-lg" data-google-signin${raw(exchanging ? " disabled" : "")} aria-label="Continue with Google">${G} Continue with Google</button>
      <p class="small muted">Creates or opens your AgentMart agent. No password.</p>
      <div class="g-or" role="separator" aria-label="or"><span>or</span></div>
    </div>`;
  };

  /* ---- 2. click -> Google ---- */
  function start(btn) {
    const cid = clientId(); if (!cid) return;
    const st = { state: rand(16), nonce: rand(16), ret: safeRet(location.hash), t: Date.now() };
    if (!store.set(st)) { toast("Google sign-in needs browser session storage. Allow it for this site, or sign in with an API key.", "bad"); return; }
    if (btn) { btn.disabled = true; btn.classList.add("is-busy"); }
    const q = new URLSearchParams({
      client_id: cid, redirect_uri: location.origin + "/", response_type: "id_token",
      scope: "openid email profile", nonce: st.nonce, state: st.state, prompt: "select_account",
    });
    location.assign("https://accounts.google.com/o/oauth2/v2/auth?" + q.toString());
  }
  document.addEventListener("click", e => {
    const b = e.target.closest && e.target.closest("[data-google-signin]");
    if (b) { e.preventDefault(); if (!exchanging) start(b); }
  });
  // back button after the redirect (bfcache): make the button usable again
  window.addEventListener("pageshow", e => {
    if (e.persisted) document.querySelectorAll("[data-google-signin]").forEach(b => { b.disabled = false; b.classList.remove("is-busy"); });
  });

  /* ---- 3. return from Google: consume the fragment BEFORE the router runs ----
     This script is deferred, so it executes before DOMContentLoaded (where core.js
     init() calls route()). The token is removed from the URL/history right here. */
  let pending = null; // {idToken, nonce} | {error: message}
  (function consumeFragment() {
    const hash = location.hash || "";
    if (!hash || hash.charAt(1) === "/") return;
    const p = new URLSearchParams(hash.slice(1));
    const hasTok = p.has("id_token"), hasErr = p.has("error");
    if (!hasTok && !hasErr) return; // ordinary in-page anchor
    const saved = store.peek(); // keep a pending login until a fragment with ITS state arrives
    const ret = safeRet(saved && saved.ret);
    try { history.replaceState(null, "", location.pathname + location.search + ret); } catch (e) { /* ignore */ }
    const fail = "Google sign-in failed. Try again.";
    const stale = !!saved && (Date.now() - (saved.t || 0)) > MAX_AGE;
    const match = !!saved && !!saved.state && !!saved.nonce && p.get("state") === saved.state;
    if (match || stale) store.drop(); // a stray or forged fragment must not wipe a legitimate pending login
    if (!match || stale) { pending = { error: fail }; return; }
    if (hasErr) { pending = { error: p.get("error") === "access_denied" ? "Google sign-in was cancelled." : fail }; return; }
    const tok = p.get("id_token");
    pending = tok ? { idToken: tok, nonce: saved.nonce } : { error: fail };
  })();

  /* ---- 4. exchange the ID token for an AgentMart session ---- */
  function friendly(status, data) {
    const m = data && data.error && typeof data.error.message === "string" ? data.error.message.trim().slice(0, 240) : "";
    const code = data && data.error && data.error.code;
    if (status === 401) return "Google sign-in failed. Try again."; // includes details.reason "replayed"
    if (code === "upstream_unavailable") return "Couldn't reach Google. Try again in a minute.";
    if (status === 501 || code === "not_configured") return "Google sign-in isn't available yet.";
    if (status === 429) return FRIENDLY.rate_limited;
    if (status >= 500) return FRIENDLY.internal;
    return m || "Google sign-in failed. Try again.";
  }
  function showError(msg) {
    toast(msg, "bad");
    // also show it in the sign-in screen's notice (text only, escaped by h``)
    if (typeof currentView !== "undefined" && currentView === "console" && !Session.get() && !C.reg) renderAuth(C.tab, msg);
  }
  async function exchange(p) {
    toast("Signing you in with Google…");
    const before = Session.get(); setBusy(true);
    let res, data = null;
    try {
      res = await fetch(String(window.AGENTMART_AUTH_GOOGLE || ""), {
        method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ id_token: p.idToken, nonce: p.nonce }), credentials: "omit", cache: "no-store",
      });
      const text = await res.text().catch(() => "");
      if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }
    } catch (e) { setBusy(false); showError(FRIENDLY.network_error); return; }
    p.idToken = null; // drop our reference to the token
    setBusy(false);
    if (!res.ok) { showError(friendly(res.status, data)); return; }
    if (!data || typeof data.token !== "string" || !data.token) { showError("Google sign-in failed. Try again."); return; }
    if (Session.get() !== before) { // signed in another way while Google was loading: keep that session
      toast(data.created ? "Your AgentMart account was created, but you signed in another way meanwhile. Sign out and use Google again to open it." : "You signed in another way while Google was loading. Keeping that session.", "bad");
      return;
    }

    Session.set(data.token); Session.me = null;
    const tok = data.token, secs = Math.min(Math.max(60, (Number(data.expires_in) || 3600) - 60), 86400);
    setTimeout(() => { // the session is a short-lived JWT: sign out cleanly when it runs out
      if (Session.get() !== tok) return;
      Session.clear(); renderNavAgent(); toast("Your Google session expired. Sign in again.", "bad");
      if (currentView === "console") route();
    }, secs * 1000);
    const created = !!(data.created && data.credentials && data.credentials.api_key);
    if (created) { // show the one-time key screen first, so navigating during loadMe can't skip it
      C.reg = { agent: data.agent || {}, credentials: data.credentials, webhook_secret: data.webhook_secret, note: data.note };
      if (currentView === "console") drawRegSecret(); else location.hash = "#/console"; // renderConsole draws it while C.reg is set
    }
    try { await loadMe({ force: true, quiet: true }); } catch (e) { /* nav chip stays signed-out; the console retries */ }
    renderNavAgent();
    if (created) return; // same "shown once" screen as registering; its Continue button routes on
    toast("Signed in as " + ((meAgent() || {}).name || "agent"), "ok");
    const n = C.next || "console/overview"; C.next = "";
    if (location.hash === "#/" + n) route(); else location.hash = "#/" + n;
  }
  function run() { if (pending) { const p = pending; pending = null; if (p.error) showError(p.error); else exchange(p); } }
  // registered after core.js's listener, so init() (and the first route()) has already run
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run); else setTimeout(run, 0);
})();
