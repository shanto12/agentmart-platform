/* ============================================================
   AgentMart web — Agent Console (the human window into an agent)
   ============================================================ */
"use strict";

const CON_TABS = [["overview", "Overview"], ["wallet", "Wallet"], ["store", "My store"], ["orders", "Orders"], ["keys", "API keys"], ["events", "Events"], ["settings", "Settings"]];
const C = {
  tab: "overview", next: "",
  reg: null,               // register response (secret shown once)
  tx: { items: [], next: null, loading: false },
  orders: { role: "buyer", status: "", items: [], next: null, loading: false, open: new Set(), detail: {}, openForm: {} },
  keys: { items: null, secret: null },
  events: { items: [], since: null, timer: null, loading: false },
  store: { listings: null, local: {}, showForm: false, editing: null, editStore: false },
  webhookSecret: null, token: null,
  depositIdem: null,
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const meAgent = () => { const m = Session.me; return m ? (m.agent || m) : null; };
const meWallet = () => (Session.me && Session.me.wallet) || null;
const meStore = () => (Session.me && (Session.me.store || (Session.me.agent && Session.me.agent.store))) || null;

function onLeaveView(prev) { if (prev === "console") stopEventPoll(); }
function stopEventPoll() { if (C.events.timer) { clearInterval(C.events.timer); C.events.timer = null; } }

/* ---------- Entry ---------- */
async function renderConsole(sub, query) {
  const root = $("#consoleRoot");
  const want = sub && sub[0] && CON_TABS.some(t => t[0] === sub[0]) ? sub[0] : "overview";
  if (query && query.get("next")) C.next = query.get("next");
  if (!Session.get()) { stopEventPoll(); C.tab = want; renderAuth(want); return; }
  if (C.reg) { drawRegSecret(); return; } // the one-time key screen stays until "Continue"
  if (!Session.me) {
    setHTML(root, h`<div class="con-head"><div class="con-id"><span class="avatar skel" style="width:52px;height:52px"></span><div><div class="skel" style="height:40px;width:260px"></div></div></div></div><div class="kpis">${[1, 2, 3].map(() => h`<div class="card kpi"><div class="skel skel-line w40"></div><div class="skel mt4" style="height:38px;width:60%"></div></div>`)}</div>`);
    try { await loadMe({ force: true, quiet: true }); }
    catch (e) {
      if (e.code === "unauthorized") { Session.clear(); renderNavAgent(); renderAuth(want, "Your session key was rejected. Sign in again."); return; }
      setHTML(root, h`<div class="section-tight">${errorState(e, { title: "Couldn't load your agent." })}</div>`); return;
    }
  }
  if (C.next) { const n = C.next; C.next = ""; location.hash = "#/" + n; return; }
  if (want !== C.tab) stopEventPoll();
  C.tab = want;
  drawShell(query);
}
function drawShell(query) {
  const a = meAgent() || {}, root = $("#consoleRoot");
  setHTML(root, h`
    <div class="con-head">
      <div class="con-id"><span class="avatar">${robotMini(34)}</span><div style="min-width:0"><span class="eyebrow"><span class="dot"></span>Agent console</span><h1 class="mt3">${a.name || "Your agent"}</h1>
        <div class="row gap2 wrapx mt2"><code class="small break">${a.id || ""}</code><button type="button" class="btn btn-sm btn-ghost" data-copy data-copy-text="${a.id || ""}" aria-label="Copy agent ID">Copy ID</button>${a.is_demo ? h`<span class="badge b-warn">Example agent</span>` : ""}<span class="badge b-info">sandbox</span></div></div></div>
      <button type="button" class="btn btn-sm" data-signout>${icon("out", 18)} Sign out</button>
    </div>
    <nav class="con-tabs" aria-label="Console sections">${CON_TABS.map(([k, label]) => h`<a href="#/console/${k}"${raw(C.tab === k ? ' aria-current="page"' : "")}>${label}</a>`)}</nav>
    <div class="con-body" id="conBody"></div>`);
  document.title = (CON_TABS.find(t => t[0] === C.tab) || [0, "Console"])[1] + " · " + (a.name || "Agent") + " — AgentMart";
  const fn = { overview: tabOverview, wallet: tabWallet, store: tabStore, orders: tabOrders, keys: tabKeys, events: tabEvents, settings: tabSettings }[C.tab];
  fn(query);
}
const body = () => $("#conBody");

/* ---------- Auth: register / sign in ---------- */
function renderAuth(want, msg) {
  const root = $("#consoleRoot");
  if (C.reg) { drawRegSecret(); return; }
  const why = want === "store" ? "Sign in or register an agent to open a store. Stores belong to agents." : want === "wallet" ? "Sign in or register an agent to get sandbox credits." : "";
  setHTML(root, h`
    <div class="page-head"><span class="eyebrow"><span class="dot"></span>Agent console</span><h1 class="h-lg mt4">Your window into an agent.</h1>
      <p class="lede mt4">Register a new agent, or sign in with an existing agent's API key. The console calls the same API your agent uses.</p>
      ${why || msg ? h`<div class="notice mt5">${icon("key")}<div>${msg || why}</div></div>` : ""}</div>
    ${typeof googleAuthHTML === "function" ? googleAuthHTML() : ""}
    <div class="auth-grid">
      <form class="card" id="regForm" novalidate aria-labelledby="regTitle">
        <h2 class="h-sm" id="regTitle">Register a new agent</h2>
        <p class="small muted mt2">Creates the agent and a sandbox wallet with a $0 balance. <code>POST /v1/agents/register</code></p>
        <div class="fgrid mt5">
          ${field("rName", "Agent name", h`<input class="input" id="rName" name="name" required maxlength="80" autocomplete="off" placeholder="e.g. procure-bot-7" aria-describedby="rName-err">`, { name: "name" })}
          ${field("rDesc", "What does it do?", h`<textarea class="textarea" id="rDesc" name="description" maxlength="500" rows="2" placeholder="Buys office supplies for a 12-person studio"></textarea>`, { optional: true, name: "description" })}
          <div class="two">
            ${field("rEmail", "Agent email", h`<input class="input" id="rEmail" name="email" type="email" maxlength="254" autocomplete="email" placeholder="agent@company.com">`, { optional: true, name: "email", hint: "Never shown publicly. It must be unique across agents." })}
            ${field("rContact", "Operator contact", h`<input class="input" id="rContact" name="operator_contact" maxlength="200" placeholder="you@company.com">`, { optional: true, name: "operator_contact", hint: "The human accountable for this agent." })}
          </div>
          ${field("rHook", "Webhook URL", h`<input class="input" id="rHook" name="webhook_url" type="url" maxlength="500" placeholder="https://…" inputmode="url">`, { optional: true, name: "webhook_url", hint: "Must be https. You can set it later." })}
        </div>
        <p class="inline-err mt4" data-form-err role="alert"></p>
        <button class="btn btn-primary btn-lg btn-block mt4" type="submit">${icon("bot")} Register agent</button>
      </form>
      <form class="card" id="signinForm" novalidate aria-labelledby="signTitle" style="background:var(--lemon-soft)">
        <h2 class="h-sm" id="signTitle">Sign in with an API key</h2>
        <p class="small muted mt2">Paste the <code>am_live_…</code> key your agent received. We check it with <code>GET /v1/me</code>.</p>
        <div class="fgrid mt5">
          ${field("sKey", "API key", h`<input class="input mono" id="sKey" name="api_key" type="password" required autocomplete="off" spellcheck="false" placeholder="am_live_…" aria-describedby="sKey-hint sKey-err">`, { name: "api_key", hint: "Kept only in this tab's session storage and cleared when you sign out or close the tab." })}
          <label class="check"><input type="checkbox" id="sShow"> Show key</label>
        </div>
        <p class="inline-err mt4" data-form-err role="alert"></p>
        <button class="btn btn-ink btn-lg btn-block mt4" type="submit">${icon("key")} Sign in</button>
        <div class="notice mt5" style="background:var(--paper)">${icon("shield")}<div class="small">Anyone with this key can spend the agent's wallet. Don't paste it into a shared or public computer.</div></div>
      </form>
    </div>
    <div class="card dcard" style="margin-bottom:var(--s9)"><h2>Need a hand?</h2><p class="small muted mt2">Lost a key, stuck on setup, or want to list an existing catalog? We read every message.</p><div class="mt4">${contactListHTML()}</div></div>`);
}
async function submitRegister(form) {
  clearErrs(form);
  const v = k => (form.elements.namedItem(k).value || "").trim();
  const b = { name: v("name") };
  let bad = false;
  if (!b.name) { fieldErr(form, "name", "Give your agent a name."); bad = true; }
  else if (b.name.length > 80) { fieldErr(form, "name", "80 characters max."); bad = true; }
  if (v("description")) b.description = v("description");
  if (v("email")) {
    if (!EMAIL_RE.test(v("email")) || v("email").length > 254) { fieldErr(form, "email", "That email doesn't look right."); bad = true; }
    else b.email = v("email").toLowerCase();
  }
  if (v("operator_contact")) b.operator_contact = v("operator_contact");
  if (v("webhook_url")) {
    if (!/^https:\/\/[^\s]+$/i.test(v("webhook_url"))) { fieldErr(form, "webhook_url", "Webhook URLs must start with https://"); bad = true; }
    else b.webhook_url = v("webhook_url");
  }
  if (bad) { focusFirstError(form); return; }
  await busy(form.querySelector('[type="submit"]'), async () => {
    try {
      const r = await api("/v1/agents/register", { method: "POST", body: b, quiet: true });
      const key = r && r.credentials && r.credentials.api_key;
      if (!key) throw new ApiError({ code: "bad_response", message: "Registration succeeded but no API key came back. Contact support with the request ID." });
      C.reg = r;
      Session.set(key);
      Session.me = null;
      drawRegSecret();
      loadMe({ force: true }).catch(() => {});
    } catch (e) {
      if (e.code === "conflict" && /email/i.test(e.message)) { fieldErr(form, "email", "Another agent already uses this email."); focusFirstError(form); formErr(form, ""); return; }
      applyApiError(form, e, ["name", "description", "email", "operator_contact", "webhook_url"]);
    }
  });
}
function drawRegSecret() {
  const r = C.reg, cr = r.credentials || {}, a = r.agent || {};
  const kid = uid("key");
  setHTML($("#consoleRoot"), h`
    <div class="page-head"><span class="eyebrow"><span class="dot"></span>Agent registered</span><h1 class="h-lg mt4">Meet ${a.name || "your agent"}.</h1></div>
    <div style="max-width:820px;padding-bottom:var(--s9)">
      <div class="secret" role="alert" aria-labelledby="secretTitle">
        <h2 class="h-sm" id="secretTitle" style="color:var(--lemon)">${icon("key")} Your API key: shown once</h2>
        <div class="key" id="${kid}"><code>${cr.api_key}</code><button type="button" class="copy" data-copy="${kid}" data-copy-text="${cr.api_key}">Copy</button></div>
        <div class="warn">Store this key now, in your agent's secret store or a password manager. AgentMart keeps only a hash of it and <u>can't show it again</u>. If you lose it, sign in with another key and create a new one, or register again.</div>
        <table class="kv mt4" style="color:var(--ink)"><tbody>
          <tr><th scope="row">agent_id</th><td class="mono break">${cr.agent_id || a.id || ""}</td></tr>
          <tr><th scope="row">key_id</th><td class="mono break">${cr.key_id || ""}</td></tr>
          ${r.webhook_secret ? h`<tr><th scope="row">webhook_secret</th><td class="mono break">${r.webhook_secret}<br><span class="small muted">Also shown once. Use it to verify the <code>AgentMart-Signature</code> header.</span></td></tr>` : ""}
        </tbody></table>
        <label class="check mt4"><input type="checkbox" id="storedKey"> I've stored my API key somewhere safe</label>
        <button type="button" class="btn btn-lemon btn-lg mt4" id="regContinue" disabled>Continue to the console <span class="arr">→</span></button>
      </div>
      ${r.note ? h`<p class="small muted mt4">${r.note}</p>` : ""}
    </div>`);
}

/* ---------- Overview ---------- */
function kpiHTML(w) {
  return h`<div class="kpis">
    <div class="card kpi hl"><div class="lab">Available</div><div class="val">${w ? money2(w.available_cents) : "—"}</div></div>
    <div class="card kpi"><div class="lab">Held in escrow</div><div class="val">${w ? money2(w.held_cents) : "—"}</div></div>
    <div class="card kpi"><div class="lab">Mode</div><div class="val" style="font-size:30px">${(w && w.mode) || "sandbox"}</div><p class="tiny muted mt2">${w && w.mode === "live" ? "Real money · funded with Stripe Checkout" : "Sandbox credits · live payments on the roadmap"}</p></div>
  </div>`;
}
function tabOverview() {
  const a = meAgent() || {}, w = meWallet(), m = (Session.me && Session.me.mandate) || {};
  const kinds = Array.isArray(m.allowed_kinds) ? m.allowed_kinds : Object.keys(KINDS);
  const st = meStore();
  setHTML(body(), h`
    ${kpiHTML(w)}
    <div class="con-grid mt4">
      <div class="card dcard">
        <h2>Profile</h2>
        <table class="kv mt4"><tbody>
          <tr><th scope="row">Name</th><td>${a.name || ""}</td></tr>
          <tr><th scope="row">Agent ID</th><td class="mono break">${a.id || ""}</td></tr>
          ${a.description ? h`<tr><th scope="row">Description</th><td>${a.description}</td></tr>` : ""}
          <tr><th scope="row">Email</th><td class="break">${a.email || h`<span class="muted">not set</span>`}</td></tr>
          ${a.operator_contact ? h`<tr><th scope="row">Operator</th><td class="break">${a.operator_contact}</td></tr>` : ""}
          <tr><th scope="row">Webhook</th><td class="break">${a.webhook_url || h`<span class="muted">not set</span>`}</td></tr>
          <tr><th scope="row">Store</th><td>${st ? h`<a class="link" href="#/store/${encodeURIComponent(st.slug)}">${st.name}</a>` : h`<a class="link" href="#/console/store">Open a store →</a>`}</td></tr>
          ${a.created_at ? h`<tr><th scope="row">Registered</th><td>${fullTime(a.created_at)}</td></tr>` : ""}
        </tbody></table>
        <div class="row gap3 mt4 wrapx"><a class="btn btn-sm" href="#/console/settings">Edit profile</a><a class="btn btn-sm" href="#/console/wallet">Add credits</a><a class="btn btn-sm btn-primary" href="#/market">Go shopping</a></div>
      </div>
      <form class="card dcard" id="mandateForm" novalidate aria-labelledby="mandTitle">
        <h2 id="mandTitle">Mandate <span class="badge b-ok">enforced by the server</span></h2>
        <p class="small muted mt2">Spending guardrails for this agent. Any order that would break them is refused with <code>403 mandate_exceeded</code>.</p>
        <div class="fgrid mt4">
          <div class="two">
            ${field("mMax", "Max per order", h`<div class="money"><input class="input" id="mMax" name="max_order_cents" type="number" min="0" step="0.01" inputmode="decimal" value="${centsToDollars(m.max_order_cents)}" required></div>`, { name: "max_order_cents" })}
            ${field("mDaily", "Rolling 24 h limit", h`<div class="money"><input class="input" id="mDaily" name="daily_limit_cents" type="number" min="0" step="0.01" inputmode="decimal" value="${centsToDollars(m.daily_limit_cents)}" required></div>`, { name: "daily_limit_cents" })}
          </div>
          <fieldset class="field"><legend class="flabel">Allowed kinds</legend><div class="checks-row">${Object.entries(KINDS).map(([k, v]) => h`<label class="check"><input type="checkbox" name="allowed_kinds" value="${k}"${raw(kinds.includes(k) ? " checked" : "")}>${v.label}</label>`)}</div><p class="err" data-err-for="allowed_kinds"></p></fieldset>
        </div>
        <p class="inline-err mt3" data-form-err role="alert"></p>
        <button class="btn btn-ink mt4" type="submit">Save mandate</button>
      </form>
    </div>`);
}
async function submitMandate(form) {
  clearErrs(form);
  const mx = dollarsToCents(form.elements.namedItem("max_order_cents").value);
  const dl = dollarsToCents(form.elements.namedItem("daily_limit_cents").value);
  const kinds = $$('input[name="allowed_kinds"]:checked', form).map(i => i.value);
  let bad = false;
  if (mx === null || isNaN(mx) || mx < 0) { fieldErr(form, "max_order_cents", "Enter an amount of $0 or more."); bad = true; }
  if (dl === null || isNaN(dl) || dl < 0) { fieldErr(form, "daily_limit_cents", "Enter an amount of $0 or more."); bad = true; }
  if (!bad && mx > dl) { fieldErr(form, "max_order_cents", "Per-order max can't be higher than the 24 h limit."); bad = true; }
  if (bad) { focusFirstError(form); return; }
  await busy(form.querySelector('[type="submit"]'), async () => {
    try {
      const r = await api("/v1/me/mandate", { method: "PUT", auth: true, body: { max_order_cents: mx, daily_limit_cents: dl, allowed_kinds: kinds }, quiet: true });
      if (Session.me) Session.me.mandate = (r && r.mandate) || r || { max_order_cents: mx, daily_limit_cents: dl, allowed_kinds: kinds };
      toast("Mandate saved", "ok");
    } catch (e) { applyApiError(form, e, ["max_order_cents", "daily_limit_cents", "allowed_kinds"]); }
  });
}

/* ---------- Wallet ---------- */
const isLive = () => { const w = meWallet(); return !!(w && w.mode === "live"); };
function tabWallet() {
  const w = meWallet(), live = isLive();
  const faucetLeft = w && w.faucet_remaining_cents !== undefined ? w.faucet_remaining_cents : null;
  setHTML(body(), h`
    ${kpiHTML(w)}
    <div class="con-grid mt4">
      <form class="card dcard" id="depositForm" novalidate aria-labelledby="depTitle">
        <h2 id="depTitle">${live ? "Add funds" : "Add sandbox credits"} <span class="badge ${live ? "b-ok" : "b-info"}">mode: ${live ? "live" : "sandbox"}</span></h2>
        ${live
          ? h`<div class="notice mint mt3">${icon("lock")}<div class="small"><b>Live mode.</b> Deposits open a secure Stripe Checkout page. Your wallet is credited automatically when the payment clears, usually within seconds. Nothing is charged until you finish checkout.</div></div>`
          : h`<div class="notice mt3">${icon("coin")}<div class="small"><b>Sandbox faucet.</b> Sandbox credits aren't real money. Up to $1,000 per deposit and $5,000 in total per agent${faucetLeft !== null ? h`, and <b>${money2(faucetLeft)}</b> is left for this agent` : ""}. Live payments are on the roadmap.</div></div>`}
        <div class="fgrid mt4">
          ${field("depAmt", "Amount", h`<div class="money"><input class="input" id="depAmt" name="amount_cents" type="number" min="0.5" max="1000" step="0.01" inputmode="decimal" value="100" required></div>`, { name: "amount_cents" })}
          <div class="row gap2 wrapx" role="group" aria-label="Quick amounts">${[25, 100, 500, 1000].map(v => h`<button type="button" class="chip" data-amt="${v}">$${v}</button>`)}</div>
        </div>
        <div id="checkoutBox"></div>
        <p class="inline-err mt3" data-form-err role="alert"></p>
        <button class="btn btn-mint btn-lg mt4" type="submit">${icon(live ? "lock" : "plus")} ${live ? "Continue to secure checkout" : "Deposit sandbox credits"}</button>
      </form>
      <form class="card dcard" id="withdrawForm" novalidate aria-labelledby="wdTitle">
        <h2 id="wdTitle">Withdraw</h2>
        <p class="small muted mt2">Move your available balance out of AgentMart. <code>POST /v1/wallet/withdraw</code>. ${live ? "Live payouts open once Stripe Connect is switched on." : "In sandbox mode, withdrawn credits go back to the sandbox treasury."}</p>
        <div class="fgrid mt4">${field("wdAmt", "Amount", h`<div class="money"><input class="input" id="wdAmt" name="amount_cents" type="number" min="0.01" step="0.01" inputmode="decimal" placeholder="${w ? centsToDollars(w.available_cents) : ""}" required></div>`, { name: "amount_cents", hint: w ? h`Available: ${money2(w.available_cents)}. Funds held in escrow can't be withdrawn.` : "" })}</div>
        <p class="inline-err mt3" data-form-err role="alert"></p>
        <button class="btn btn-lg mt4" type="submit"${raw(live ? " disabled" : "")}>${icon("out")} Withdraw</button>
      </form>
      <div class="card dcard full">
        <h2>Payment methods</h2>
        <div class="pm-note mt3">
          <p class="small">Today agents pay from their AgentMart wallet. The wallet is funded by ${live ? "Stripe Checkout" : "the sandbox faucet"}, and escrow makes checkout instant.</p>
          <div class="notice ink">${icon("key")}<div class="small"><b>On the roadmap, agent payment tokens:</b> Stripe Link and Shared Payment Tokens, and Visa and Mastercard agent tokens. With these, agents can pay with a scoped, revocable token instead of topping up first. The endpoint is live today and answers <code>501 not_implemented</code> until tokens launch.</div></div>
          <div class="row gap3 wrapx"><button type="button" class="btn btn-sm" data-pm-check>Check token support</button><span class="small muted" id="pmResult" role="status"></span></div>
        </div>
      </div>
      <div class="card dcard full">
        <h2>Ledger <button type="button" class="btn btn-sm" data-tx-refresh>${icon("refresh", 16)} Refresh</button></h2>
        <p class="small muted mt2">Double-entry. Every transfer moves money between accounts: <code>available</code> and <code>held</code> (escrow).</p>
        <div id="txBox" class="mt4"></div>
      </div>
    </div>`);
  loadTx(true);
}
async function loadTx(reset) {
  const box = $("#txBox"); if (!box) return;
  if (reset) { C.tx = { items: [], next: null, loading: false }; setHTML(box, h`<div class="stack gap2">${[1, 2, 3, 4].map(() => h`<div class="skel" style="height:40px"></div>`)}</div>`); }
  C.tx.loading = true;
  try {
    const r = await api("/v1/wallet/transactions", { auth: true, quiet: true, query: { limit: 25, cursor: reset ? undefined : C.tx.next } });
    C.tx.items = C.tx.items.concat((r && r.data) || []); C.tx.next = (r && r.next_cursor) || null;
    drawTx();
  } catch (e) { setHTML(box, errorState(e, { title: "Couldn't load transactions." })); }
  finally { C.tx.loading = false; }
}
function drawTx() {
  const box = $("#txBox"); if (!box) return;
  if (!C.tx.items.length) { setHTML(box, h`<div class="state"><div class="emoji" aria-hidden="true">🪙</div><h3 class="h-sm mt3">No transactions yet.</h3><p class="muted">Add funds to get started.</p></div>`); return; }
  setHTML(box, h`<div class="table-wrap"><table class="table"><thead><tr><th scope="col">When</th><th scope="col">Type</th><th scope="col">Account</th><th scope="col">Detail</th><th scope="col" class="right">Amount</th><th scope="col" class="right">Balance</th></tr></thead><tbody>
    ${C.tx.items.map(t => h`<tr><td class="nowrap" title="${fullTime(t.created_at)}">${when(t.created_at)}</td><td><code>${t.type}</code></td><td>${t.account ? h`<span class="badge ${t.account === "held" ? "b-warn" : ""}">${t.account}</span>` : ""}</td><td class="small">${t.order_id ? h`<a class="link mono" href="#/console/orders?order=${encodeURIComponent(t.order_id)}">${t.order_id}</a>` : ""}${t.memo ? h`${t.order_id ? " · " : ""}<span class="muted">${t.memo}</span>` : ""}${!t.order_id && !t.memo ? h`<span class="muted">—</span>` : ""}${t.transfer_id ? h`<br><span class="tiny muted mono" title="transfer id">${t.transfer_id}</span>` : ""}</td><td class="num ${Number(t.amount_cents) < 0 ? "neg" : "pos"}">${Number(t.amount_cents) > 0 ? "+" : ""}${money2(t.amount_cents)}</td><td class="num">${t.balance_after_cents !== undefined && t.balance_after_cents !== null ? money2(t.balance_after_cents) : ""}</td></tr>`)}
  </tbody></table></div>${C.tx.next ? h`<div class="load-more"><button type="button" class="btn btn-sm" data-tx-more>Load more</button></div>` : ""}`);
}
function mergeWallet(r) {
  if (!r || !Session.me) return false;
  const w = r.wallet || (r.available_cents !== undefined ? r : null);
  if (!w) return false;
  const copy = {}; ["agent_id", "available_cents", "held_cents", "currency", "mode", "lifetime_deposits_cents", "faucet_remaining_cents"].forEach(k => { if (w[k] !== undefined) copy[k] = w[k]; });
  Session.me.wallet = Object.assign({}, Session.me.wallet, copy); return true;
}
async function submitDeposit(form) {
  clearErrs(form);
  const c = dollarsToCents(form.elements.namedItem("amount_cents").value);
  if (c === null || isNaN(c) || c < 1) { fieldErr(form, "amount_cents", "Enter an amount greater than $0."); focusFirstError(form); return; }
  if (!isLive() && c > 100000) { fieldErr(form, "amount_cents", "The sandbox faucet allows up to $1,000 per deposit."); focusFirstError(form); return; }
  if (!C.depositIdem || C.depositAmt !== c) { C.depositIdem = idemKey(); C.depositAmt = c; }
  await busy(form.querySelector('[type="submit"]'), async () => {
    try {
      const r = await api("/v1/wallet/deposit", { method: "POST", auth: true, body: { amount_cents: c }, idempotencyKey: C.depositIdem, quiet: true });
      C.depositIdem = null;
      if (r && r.checkout_url) {
        const url = safeUrl(r.checkout_url, true);
        if (Session.me && Session.me.wallet) Session.me.wallet.mode = "live";
        setHTML($("#checkoutBox"), h`<div class="notice mint mt4" role="status">${icon("lock")}<div><b>Checkout ready: ${money2(r.amount_cents || c)}</b><br><span class="small">Complete payment on Stripe. Your wallet is credited automatically when payment clears.</span>${url ? h`<div class="mt2"><a class="btn btn-sm btn-ink" href="${url}" target="_blank" rel="noopener noreferrer">Open secure checkout →</a></div>` : ""}</div></div>`);
        if (url) { try { window.open(url, "_blank", "noopener"); } catch (e) { /* popup blocked: link above */ } }
        toast("Checkout opened in a new tab", "ok");
        return;
      }
      if (!mergeWallet(r)) await loadMe({ force: true });
      const amt = (r && r.deposit && r.deposit.amount_cents) || c;
      toast(`Added ${money2(amt)} in sandbox credits`, "ok");
      tabWallet();
    } catch (e) {
      if (e.code !== "network_error") C.depositIdem = null;
      applyApiError(form, e, ["amount_cents"]);
    }
  });
}
async function submitWithdraw(form) {
  clearErrs(form);
  const c = dollarsToCents(form.elements.namedItem("amount_cents").value);
  const w = meWallet();
  if (c === null || isNaN(c) || c < 1) { fieldErr(form, "amount_cents", "Enter an amount greater than $0."); focusFirstError(form); return; }
  if (w && c > Number(w.available_cents)) { fieldErr(form, "amount_cents", `You only have ${money2(w.available_cents)} available.`); focusFirstError(form); return; }
  if (!(await confirmDialog({ title: `Withdraw ${money2(c)}?`, body: isLive() ? "This pays out to your connected account." : "Sandbox credits go back to the sandbox treasury. You can't undo this, but you can use the faucet again (within its lifetime limit).", confirm: "Withdraw" }))) return;
  if (!C.withdrawIdem || C.withdrawAmt !== c) { C.withdrawIdem = idemKey(); C.withdrawAmt = c; }
  await busy(form.querySelector('[type="submit"]'), async () => {
    try {
      const r = await api("/v1/wallet/withdraw", { method: "POST", auth: true, body: { amount_cents: c }, idempotencyKey: C.withdrawIdem, quiet: true });
      C.withdrawIdem = null;
      if (!mergeWallet(r)) await loadMe({ force: true });
      toast(`Withdrew ${money2(c)}`, "ok"); tabWallet();
    } catch (e) { if (e.code !== "network_error") C.withdrawIdem = null; applyApiError(form, e, ["amount_cents"]); }
  });
}

/* ---------- My store ---------- */
async function tabStore() {
  setHTML(body(), h`<div class="skel" style="height:160px;border-radius:var(--r-lg)"></div>`);
  // GET /v1/me tells us whether a store exists; only then ask /v1/stores/me (avoids a 404)
  if (!meStore()) { await loadMe({ force: true }).catch(() => {}); if (!meStore()) { drawCreateStore(); return; } }
  await loadStoreListings();
  if (!meStore()) { drawCreateStore(); return; }
  drawStore();
}
function slugify(s) { return (s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40); }
function drawCreateStore(existingErr) {
  setHTML(body(), h`<div class="con-grid">
    <form class="card dcard" id="storeForm" novalidate aria-labelledby="stTitle">
      <h2 id="stTitle">Open your store</h2>
      <p class="small muted mt2">One store per agent. After it's open, you can list physical goods, digital goods and services. <code>POST /v1/stores</code></p>
      ${storeFields({})}
      <p class="inline-err mt3" data-form-err role="alert">${existingErr || ""}</p>
      <button class="btn btn-primary btn-lg mt4" type="submit">${icon("store")} Open store</button>
    </form>
    <div class="card dcard" style="background:var(--lemon)">
      <h2>What sellers get</h2>
      <ul class="teaser-list" style="font-size:16px">
        <li><span class="tick">1</span><span>A public storefront at <code>#/store/your-slug</code> and in <code>GET /v1/stores/{slug}</code>.</span></li>
        <li><span class="tick">2</span><span>Listings agents can find with <code>search_listings</code>, each with an Agent Readiness Score.</span></li>
        <li><span class="tick">3</span><span>Escrowed orders. You're paid when the buyer confirms, minus 5%.</span></li>
      </ul>
      <p class="small mt4"><b>Public beta.</b> Sales settle in sandbox credits while live payments roll out.</p>
      <p class="small mt3">Moving an Amazon or Shopify catalog over, or have questions about selling? Email <a class="link" href="mailto:support@agentmart.us">support@agentmart.us</a> or the founder at <a class="link" href="mailto:shanto@agentmart.us">shanto@agentmart.us</a>.</p>
    </div></div>`);
}
function storeFields(s) {
  return h`<div class="fgrid mt4">
    ${field("stName", "Store name", h`<input class="input" id="stName" name="name" required maxlength="80" value="${s.name || ""}" autocomplete="organization">`, { name: "name" })}
    ${s.slug ? h`<div class="field"><span class="flabel">Slug</span><code>${s.slug}</code><p class="hint">The slug is permanent.</p></div>` : field("stSlug", "Slug", h`<input class="input mono" id="stSlug" name="slug" required maxlength="40" pattern="[a-z0-9-]+" autocomplete="off" spellcheck="false" placeholder="my-store">`, { name: "slug", hint: "Lowercase letters, numbers and hyphens. It becomes your storefront URL." })}
    ${field("stDesc", "Description", h`<textarea class="textarea" id="stDesc" name="description" maxlength="1000" rows="2">${s.description || ""}</textarea>`, { optional: true, name: "description" })}
    <div class="two">
      ${field("stFrom", "Ships from", h`<input class="input" id="stFrom" name="ships_from" maxlength="80" value="${s.ships_from || ""}" placeholder="e.g. US, Austin TX">`, { optional: true, name: "ships_from" })}
      ${field("stRet", "Return policy", h`<input class="input" id="stRet" name="return_policy" maxlength="300" value="${s.return_policy || ""}" placeholder="e.g. 30-day returns, unused">`, { optional: true, name: "return_policy" })}
    </div>
  </div>`;
}
function readStoreForm(form, create) {
  const v = k => { const el = form.elements.namedItem(k); return el ? el.value.trim() : ""; };
  const b = { name: v("name") }; let bad = false;
  if (!b.name) { fieldErr(form, "name", "Your store needs a name."); bad = true; }
  if (create) {
    b.slug = v("slug");
    if (!b.slug) { fieldErr(form, "slug", "Choose a slug."); bad = true; }
    else if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(b.slug) || b.slug.length < 3) { fieldErr(form, "slug", "Use 3–40 lowercase letters, numbers or hyphens. It can't start or end with a hyphen."); bad = true; }
  }
  ["description", "ships_from", "return_policy"].forEach(k => { const x = v(k); if (x || !create) b[k] = x || null; });
  return bad ? null : b;
}
async function submitStore(form) {
  clearErrs(form);
  const b = readStoreForm(form, true); if (!b) { focusFirstError(form); return; }
  await busy(form.querySelector('[type="submit"]'), async () => {
    try {
      const r = await api("/v1/stores", { method: "POST", auth: true, body: b, quiet: true });
      const s = (r && r.store) || r;
      if (Session.me) Session.me.store = s;
      toast("Store opened: " + s.name, "ok");
      C.store.showForm = true; C.store.listings = []; C.store.reviews = null;
      tabStore();
    } catch (e) {
      if (e.code === "conflict" && /slug/i.test(e.message)) { fieldErr(form, "slug", e.message); formErr(form, ""); focusFirstError(form); return; }
      applyApiError(form, e, ["name", "slug", "description", "ships_from", "return_policy"]);
      if (e.code === "conflict") { await loadMe({ force: true }).catch(() => {}); if (meStore()) tabStore(); }
    }
  });
}
async function submitStoreEdit(form) {
  clearErrs(form);
  const b = readStoreForm(form, false); if (!b) { focusFirstError(form); return; }
  await busy(form.querySelector('[type="submit"]'), async () => {
    try {
      const r = await api("/v1/stores/me", { method: "PATCH", auth: true, body: b, quiet: true });
      if (Session.me) Session.me.store = Object.assign({}, meStore(), (r && r.store) || r || b);
      C.store.editStore = false; toast("Store updated", "ok"); drawStore();
    } catch (e) { applyApiError(form, e, ["name", "description", "ships_from", "return_policy"]); }
  });
}
async function loadStoreListings() {
  // GET /v1/stores/me → own store (flat) + every non-archived listing, incl. paused and sold_out
  try {
    const r = await api("/v1/stores/me", { auth: true, quiet: true });
    const ls = (r && r.listings) || [];
    if (Session.me && r && r.slug) { const st = Object.assign({}, r); delete st.listings; Session.me.store = st; }
    C.store.listings = ls.slice().sort((x, y) => String(y.created_at || "").localeCompare(String(x.created_at || "")));
    C.store.error = null;
  } catch (e) {
    if (e.code === "not_found") { if (Session.me) Session.me.store = null; C.store.listings = []; C.store.error = null; return; }
    C.store.error = e; C.store.listings = C.store.listings || [];
  }
}
async function loadStoreReviews() {
  const st = meStore(); const box = $("#myRevBox"); if (!st || !box) return;
  try {
    const r = await api("/v1/stores/" + encodeURIComponent(st.slug) + "/reviews", { quiet: true, query: { limit: 50 } });
    C.store.reviews = (r && r.data) || []; C.store.rating = (r && r.rating) || null;
    drawStoreReviews();
  } catch (e) { setHTML(box, errorState(e, { title: "Couldn't load reviews.", retry: false })); }
}
function drawStoreReviews() {
  const box = $("#myRevBox"); if (!box) return;
  const rs = C.store.reviews || [];
  const pending = rs.filter(r => !r.seller_reply).length;
  setHTML(box, h`${ratingSummaryHTML(C.store.rating)}${pending ? h`<p class="small mt3"><b>${plural(pending, "review")}</b> waiting for your reply.</p>` : ""}
    <div class="rev-list mt4">${rs.length ? rs.map(r => reviewHTML(r, { extra: r.seller_reply ? "" : (C.store.replying === r.id
      ? h`<form class="act-form mt3" data-reply-form="${r.id}" novalidate aria-label="Reply to review">${field("rp_" + r.id, "Your public reply", h`<textarea class="textarea" id="rp_${r.id}" name="body" maxlength="2000" rows="3" required></textarea>`, { name: "body", hint: "You can reply once, and the reply is shown under the review." })}<p class="inline-err mt2" data-form-err role="alert"></p><div class="actions mt3"><button class="btn btn-sm btn-ink" type="submit">Post reply</button><button class="btn btn-sm" type="button" data-reply="${r.id}">Cancel</button></div></form>`
      : h`<div class="actions mt3"><button type="button" class="btn btn-sm" data-reply="${r.id}">Reply</button></div>`) })) : h`<p class="muted">No reviews yet. Buyers can review orders once they're fulfilled.</p>`}</div>`);
}
function drawStore() {
  const st = meStore(), ls = C.store.listings || [];
  setHTML(body(), h`
    <div class="card dcard" style="background:var(--lemon)">
      ${C.store.editStore ? h`<form id="storeEditForm" novalidate aria-label="Edit store"><h2>Edit store</h2>${storeFields(st)}<p class="inline-err mt3" data-form-err role="alert"></p><div class="actions mt4"><button class="btn btn-ink" type="submit">Save</button><button class="btn" type="button" data-store-edit="0">Cancel</button></div></form>` : h`
      <div class="row between wrapx gap4" style="align-items:flex-start"><div style="min-width:0"><span class="eyebrow"><span class="dot"></span>Your store</span><h2 class="h-md mt3" style="display:block">${st.name}</h2>
        ${st.description ? h`<p class="mt2">${st.description}</p>` : ""}
        <div class="row gap2 wrapx mt3"><span class="badge">/${st.slug}</span>${st.ships_from ? h`<span class="badge">Ships from ${st.ships_from}</span>` : ""}${st.return_policy ? h`<span class="badge">${st.return_policy}</span>` : ""}</div></div>
        <div class="actions"><a class="btn btn-sm" href="#/store/${encodeURIComponent(st.slug)}">View public page</a><button type="button" class="btn btn-sm" data-store-edit="1">Edit store</button></div></div>`}
    </div>
    <div class="sec-head mt6" style="margin-bottom:var(--s4)"><h2 class="h-md">Listings</h2><button type="button" class="btn btn-primary" data-new-listing aria-expanded="${String(C.store.showForm)}">${icon("plus")} New listing</button></div>
    <div id="newListing">${C.store.showForm ? listingFormHTML() : ""}</div>
    ${C.store.error ? h`<div class="notice bad mt4">${icon("x")}<div>Couldn't refresh listings: ${C.store.error.message}</div></div>` : ""}
    <div class="stack gap3 mt4" id="myListings">${ls.length ? ls.map(listingRowHTML) : h`<div class="state"><div class="emoji" aria-hidden="true">📦</div><h3 class="h-sm mt3">No listings yet.</h3><p class="muted">Create your first listing and it goes live right away.</p></div>`}</div>
    <p class="tiny muted mt4">From <code>GET /v1/stores/me</code>. It includes paused and sold-out listings, which buyers can't see or buy.</p>
    <section class="mt7" aria-labelledby="myRevTitle"><div class="row between wrapx gap3" style="margin-bottom:var(--s4)"><h2 class="h-md" id="myRevTitle">Reviews ${st.rating && st.rating.count ? h`<span class="rating-line" style="font-size:16px">${starsHTML(st.rating.average)} <b>${Number(st.rating.average).toFixed(1)}</b></span>` : ""}</h2></div><div id="myRevBox"><div class="skel" style="height:100px"></div></div></section>`);
  if (C.store.showForm) { bindListingForm(); updateMeter(true); }
  if (C.store.reviews) drawStoreReviews(); else loadStoreReviews();
}
function listingRowHTML(l) {
  const status = l.status || "active";
  const editing = C.store.editing === l.id;
  return h`<div class="lrow" data-lid="${l.id}">
    <span class="thumb">${listingMedia(l)}</span>
    <div style="min-width:0"><b>${cleanCopy(l.title)}</b><div class="row gap2 wrapx mt1"><span class="badge ${(KINDS[l.kind] || {}).cls || ""}">${(KINDS[l.kind] || {}).short || l.kind}</span><span class="badge st-${status}">${status}</span><span class="small mono">${money2(l.price_cents)}</span><span class="small muted">${l.inventory === null || l.inventory === undefined ? "unlimited" : num(l.inventory) + " in stock"}${status === "sold_out" ? " · edit inventory to restock" : ""}</span>${ratingOf(l).count ? h`<span class="small">★ ${Number(ratingOf(l).average).toFixed(1)} (${ratingOf(l).count})</span>` : ""}${l.agent_readiness !== undefined ? h`<span class="small muted">readiness ${l.agent_readiness}</span>` : ""}</div></div>
    <div class="actions"><a class="btn btn-sm btn-ghost" href="#/listing/${encodeURIComponent(l.id)}">View</a><button type="button" class="btn btn-sm" data-l-edit="${l.id}" aria-expanded="${String(editing)}">Edit</button>${status === "active" || status === "sold_out" ? h`<button type="button" class="btn btn-sm" data-l-status="paused" data-id="${l.id}">Pause</button>` : status === "paused" ? h`<button type="button" class="btn btn-sm btn-mint" data-l-status="active" data-id="${l.id}">Activate</button>` : ""}<button type="button" class="btn btn-sm btn-danger" data-l-archive="${l.id}">Archive</button></div>
    ${editing ? h`<form class="edit act-form" data-edit-form="${l.id}" novalidate aria-label="Edit ${l.title}">
      <div class="fgrid">
        ${field("e_title_" + l.id, "Title", h`<input class="input" id="e_title_${l.id}" name="title" maxlength="140" required value="${l.title}">`, { name: "title" })}
        <div class="two">
          ${field("e_price_" + l.id, "Price", h`<div class="money"><input class="input" id="e_price_${l.id}" name="price" type="number" min="0.5" step="0.01" inputmode="decimal" required value="${centsToDollars(l.price_cents)}"></div>`, { name: "price" })}
          ${field("e_inv_" + l.id, "Inventory", h`<input class="input" id="e_inv_${l.id}" name="inventory" type="number" min="0" step="1" inputmode="numeric" value="${l.inventory === null || l.inventory === undefined ? "" : l.inventory}" placeholder="${l.kind === "physical" ? "required" : "blank = unlimited"}">`, { name: "inventory" })}
        </div>
        ${field("e_desc_" + l.id, "Description", h`<textarea class="textarea" id="e_desc_${l.id}" name="description" maxlength="5000" rows="3">${l.description || ""}</textarea>`, { name: "description" })}
      </div>
      <p class="inline-err mt3" data-form-err role="alert"></p>
      <div class="actions mt4"><button class="btn btn-sm btn-ink" type="submit">Save changes</button><button class="btn btn-sm" type="button" data-l-edit="${l.id}">Cancel</button></div>
    </form>` : ""}
  </div>`;
}
function upsertLocalListing(l) {
  C.store.local[l.id] = l;
  if (C.store.listings) { const i = C.store.listings.findIndex(x => x.id === l.id); if (i >= 0) C.store.listings[i] = Object.assign({}, C.store.listings[i], l); else C.store.listings.unshift(l); }
}
async function patchListing(id, patch, btn, form) {
  return busy(btn, async () => {
    try {
      const r = await api("/v1/listings/" + encodeURIComponent(id), { method: "PATCH", auth: true, body: patch, quiet: !!form });
      const cur = (C.store.listings || []).find(x => x.id === id) || {};
      upsertLocalListing(Object.assign({}, cur, patch, (r && r.listing) || r || {}));
      return true;
    } catch (e) { if (form) applyApiError(form, e, Object.keys(patch)); return false; }
  });
}

/* listing creation form with live Agent Readiness meter */
const blankLF = () => ({ kind: "physical", title: "", description: "", price: "", inventory: "", unlimited: false, category: "", tags: "", image_url: "", attrs: [["", ""], ["", ""], ["", ""]], handling_days: "2", ships_to: "US", shipping: "", dd_type: "text", dd_payload: "", turnaround_days: "", deliverable: "" });
let LF = blankLF(), lastScore = 0;
function listingFormHTML() {
  const L = LF;
  const kindSpecific = L.kind === "physical" ? h`<div class="sub-card"><h4>Shipping (physical)</h4><div class="three">
        ${field("lfHand", "Handling days", h`<input class="input" id="lfHand" name="handling_days" data-lf="handling_days" type="number" min="0" max="60" step="1" inputmode="numeric" value="${L.handling_days}">`, { name: "handling_days" })}
        ${field("lfShip", "Shipping price", h`<div class="money"><input class="input" id="lfShip" name="shipping_cents" data-lf="shipping" type="number" min="0" step="0.01" inputmode="decimal" value="${L.shipping}" placeholder="0 = free"></div>`, { name: "shipping_cents" })}
        ${field("lfTo", "Ships to", h`<input class="input" id="lfTo" name="ships_to" data-lf="ships_to" value="${L.ships_to}" placeholder="US, CA" maxlength="120">`, { name: "ships_to", hint: "Comma-separated country codes" })}
      </div></div>`
    : L.kind === "digital" ? h`<div class="sub-card"><h4>Delivery (digital, kept private until paid)</h4><div class="fgrid">
        ${field("lfDdType", "Delivery type", h`<select class="select" id="lfDdType" name="dd_type" data-lf="dd_type">${[["text", "Text"], ["url", "URL (https)"], ["license_key", "License key"]].map(o => h`<option value="${o[0]}"${raw(L.dd_type === o[0] ? " selected" : "")}>${o[1]}</option>`)}</select>`, { name: "dd_type" })}
        ${field("lfDd", "Payload revealed to the buyer after payment", h`<textarea class="textarea mono" id="lfDd" name="digital_delivery" data-lf="dd_payload" maxlength="5000" rows="3" placeholder="${L.dd_type === "url" ? "https://…" : L.dd_type === "license_key" ? "XXXX-XXXX-XXXX" : "The content the buyer receives"}">${L.dd_payload}</textarea>`, { name: "digital_delivery", hint: "Never shown in public listing data. Only the buyer's order response includes it." })}
      </div></div>`
    : h`<div class="sub-card"><h4>Service terms</h4><div class="fgrid">
        ${field("lfTurn", "Turnaround (days)", h`<input class="input" id="lfTurn" name="turnaround_days" data-lf="turnaround_days" type="number" min="0" max="365" step="1" inputmode="numeric" value="${L.turnaround_days}">`, { name: "turnaround_days" })}
        ${field("lfDeliv", "Deliverable", h`<input class="input" id="lfDeliv" name="deliverable" data-lf="deliverable" maxlength="300" value="${L.deliverable}" placeholder="e.g. 2,000-word report as a PDF link">`, { name: "deliverable" })}
      </div></div>`;
  return h`<div class="con-grid" style="align-items:start">
    <form class="card dcard" id="listingForm" novalidate aria-labelledby="lfTitleH">
      <h2 id="lfTitleH">New listing</h2>
      <div class="fgrid mt4">
        <div class="field"><span class="flabel" id="lfKindLbl">Kind</span><div class="kindseg" role="group" aria-labelledby="lfKindLbl">${[["physical", "Physical", "you ship it"], ["digital", "Digital", "instant delivery"], ["service", "Service", "work delivered"]].map(o => h`<button type="button" data-lfkind="${o[0]}" aria-pressed="${String(L.kind === o[0])}">${o[1]}<span>${o[2]}</span></button>`)}</div></div>
        ${field("lfTitle", "Title", h`<input class="input" id="lfTitle" name="title" data-lf="title" required maxlength="140" value="${L.title}" placeholder="Say what it is: the variant, size, format">`, { name: "title", hint: "Agents match on specifics. 140 characters max." })}
        ${field("lfDesc", "Description", h`<textarea class="textarea" id="lfDesc" name="description" data-lf="description" required maxlength="5000" rows="4" placeholder="What's included, who it's for, specs, terms…">${L.description}</textarea>`, { name: "description", hint: raw(`<span id="lfDescCount">${L.description.trim().length}</span>/5000 · 80+ helps readiness`) })}
        <div class="two">
          ${field("lfPrice", "Price (USD)", h`<div class="money"><input class="input" id="lfPrice" name="price_cents" data-lf="price" type="number" min="0.5" max="100000" step="0.01" inputmode="decimal" required value="${L.price}" placeholder="0.00"></div>`, { name: "price_cents", hint: "Minimum $0.50" })}
          <div>${field("lfInv", "Inventory", h`<input class="input" id="lfInv" name="inventory" data-lf="inventory" type="number" min="0" step="1" inputmode="numeric" value="${L.inventory}"${raw(L.unlimited && L.kind !== "physical" ? " disabled" : "")} placeholder="${L.kind === "physical" ? "e.g. 40" : "count"}">`, { name: "inventory" })}
            ${L.kind !== "physical" ? h`<label class="check"><input type="checkbox" id="lfUnl" data-lf="unlimited"${raw(L.unlimited ? " checked" : "")}> Unlimited</label>` : ""}</div>
        </div>
        <div class="two">
          ${field("lfCat", "Category", h`<input class="input" id="lfCat" name="category" data-lf="category" maxlength="60" value="${L.category}" placeholder="e.g. coffee">`, { optional: true, name: "category" })}
          ${field("lfTags", "Tags", h`<input class="input" id="lfTags" name="tags" data-lf="tags" maxlength="400" value="${L.tags}" placeholder="comma, separated">`, { optional: true, name: "tags", hint: "Up to 10" })}
        </div>
        ${field("lfImg", "Image URL", h`<input class="input" id="lfImg" name="image_url" data-lf="image_url" type="url" inputmode="url" maxlength="1000" value="${L.image_url}" placeholder="https://…">`, { optional: true, name: "image_url", hint: "https only. Without one, we draw an illustration." })}
        <div class="field"><span class="flabel" id="lfAttrLbl">Attributes <span class="opt">(structured specs)</span></span><div class="kv-rows" id="lfAttrs" role="group" aria-labelledby="lfAttrLbl">${L.attrs.map((r, i) => h`<div class="kv-row"><input class="input" aria-label="Attribute ${i + 1} name" data-attr="${i}" data-part="0" value="${r[0]}" maxlength="60" placeholder="${["Material", "Size", "Weight", "Format"][i] || "Name"}"><input class="input" aria-label="Attribute ${i + 1} value" data-attr="${i}" data-part="1" value="${r[1]}" maxlength="200" placeholder="${["Stoneware", "12 oz", "410 g", "PDF"][i] || "Value"}"><button type="button" class="icon-btn" data-delattr="${i}" aria-label="Remove attribute ${i + 1}">${icon("x", 16)}</button></div>`)}</div><button type="button" class="link-btn mt2" data-addattr>+ Add attribute</button><p class="err" data-err-for="attributes"></p></div>
        ${kindSpecific}
      </div>
      <p class="inline-err mt4" data-form-err role="alert"></p>
      <div class="actions mt4"><button class="btn btn-primary btn-lg" type="submit">${icon("bolt")} Publish listing</button><button class="btn" type="button" data-new-listing>Cancel</button></div>
    </form>
    <div class="stack gap4" style="position:sticky;top:92px">
      <div class="card meter-card" id="meterCard" aria-live="polite">${meterShell()}</div>
      <div class="notice small">${icon("spark")}<div>This is an <b>estimate</b> made in your browser. The API computes the official <code>agent_readiness</code> score when you publish.</div></div>
    </div>
  </div>`;
}
function meterShell() {
  const Cc = 2 * Math.PI * 62;
  return raw(`<div class="gauge" role="img" aria-label="Estimated Agent Readiness Score" id="gRole"><svg viewBox="0 0 150 150" aria-hidden="true"><circle class="ring" cx="75" cy="75" r="73"/><circle class="trk" cx="75" cy="75" r="62"/><circle class="val" id="gVal" cx="75" cy="75" r="62" stroke-dasharray="${Cc}" stroke-dashoffset="${Cc}"/><circle class="ring" cx="75" cy="75" r="53"/></svg><div class="num"><div><b id="gNum">0</b><span>readiness</span></div></div></div><div><span class="tiny mono muted" style="text-transform:uppercase;letter-spacing:.06em">Agent Readiness Score</span><div class="level mt1" id="gLvl"></div><div class="levels" id="gLvls"><i></i><i></i><i></i><i></i><i></i></div><ul class="checklist" id="gList"></ul></div><span class="pts" id="gPts" aria-hidden="true"></span>`);
}
const splitTags = s => (s || "").split(",").map(x => x.trim()).filter(Boolean);
function readinessEstimate(L) {
  const attrs = L.attrs.filter(r => r[0].trim() && r[1].trim()).length;
  const tags = splitTags(L.tags).length;
  const cents = dollarsToCents(L.price);
  const items = [
    ["Specific title (12+ chars)", 10, L.title.trim().length >= 12],
    ["Description (80+ chars)", 15, L.description.trim().length >= 80],
    ["Price set (≥ $0.50)", 10, cents !== null && cents >= 50],
    ["Category", 5, !!L.category.trim()],
    ["2+ tags", 10, tags >= 2],
    [`3+ attributes (${Math.min(attrs, 3)}/3)`, 20, attrs >= 3, Math.min(attrs, 3) * 20 / 3],
    ["Image (https)", 5, /^https:\/\/\S+$/i.test(L.image_url.trim())],
  ];
  if (L.kind === "physical") {
    items.push(["Inventory count", 10, /^\d+$/.test(String(L.inventory).trim()) && +L.inventory > 0]);
    items.push(["Handling days + ships-to", 15, String(L.handling_days).trim() !== "" && splitTags(L.ships_to).length > 0]);
  } else if (L.kind === "digital") {
    items.push(["Delivery payload", 25, L.dd_payload.trim().length > 0]);
  } else {
    items.push(["Turnaround days", 10, String(L.turnaround_days).trim() !== ""]);
    items.push(["Deliverable described", 15, L.deliverable.trim().length >= 8]);
  }
  let score = 0; items.forEach(i => { score += i[2] ? i[1] : (i[3] || 0); });
  return { score: Math.round(score), items };
}
function levelOf(s) {
  if (s >= 100) return ["Perfect 100", 5];
  if (s >= 90) return ["Agent favourite", 4];
  if (s >= 70) return ["Agent-ready", 3];
  if (s >= 40) return ["Getting found", 2];
  return ["Invisible to agents", 1];
}
function animateNum(el, to) {
  const from = +el.textContent || 0;
  if (REDUCED || from === to) { el.textContent = to; return; }
  const t0 = performance.now(), d = 450;
  cancelAnimationFrame(el._raf);
  const tick = t => { const k = Math.min(1, (t - t0) / d); el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3))); if (k < 1) el._raf = requestAnimationFrame(tick); };
  el._raf = requestAnimationFrame(tick);
}
function updateMeter(initial = false) {
  if (!$("#gVal")) return;
  const r = readinessEstimate(LF), [lvl, lvn] = levelOf(r.score);
  const Cc = 2 * Math.PI * 62;
  const col = r.score >= 100 ? "#4FE3A1" : r.score >= 70 ? "#2F5BFF" : r.score >= 40 ? "#FF5B1F" : "#E5383B";
  $("#gVal").style.strokeDashoffset = Cc * (1 - r.score / 100); $("#gVal").style.stroke = col;
  animateNum($("#gNum"), r.score);
  $("#gRole").setAttribute("aria-label", `Estimated Agent Readiness Score: ${r.score} out of 100, ${lvl}`);
  $("#gLvl").textContent = lvl;
  $$("#gLvls i").forEach((i, k) => i.classList.toggle("on", k < lvn));
  setHTML($("#gList"), r.items.map(i => h`<li class="${i[2] ? "ok" : ""}"><i aria-hidden="true">${i[2] ? "✓" : ""}</i><span>${i[0]}</span><b>+${i[1]}</b></li>`));
  if (!initial && r.score > lastScore && !REDUCED) { const p = $("#gPts"); p.textContent = "+" + (r.score - lastScore); p.classList.remove("go"); void p.offsetWidth; p.classList.add("go"); }
  lastScore = r.score;
}
function bindListingForm() { lastScore = readinessEstimate(LF).score; }
function redrawListingForm() {
  setHTML($("#newListing"), listingFormHTML()); updateMeter(true);
}
function buildListingBody(form) {
  const L = LF; clearErrs(form); let bad = false;
  const b = { kind: L.kind, title: L.title.trim(), description: L.description.trim(), currency: "USD" };
  if (!b.title) { fieldErr(form, "title", "Add a title."); bad = true; } else if (b.title.length > 140) { fieldErr(form, "title", "140 characters max."); bad = true; }
  if (!b.description) { fieldErr(form, "description", "Add a description."); bad = true; }
  const pc = dollarsToCents(L.price);
  if (pc === null || isNaN(pc)) { fieldErr(form, "price_cents", "Enter a price."); bad = true; }
  else if (pc < 50) { fieldErr(form, "price_cents", "Minimum price is $0.50."); bad = true; }
  else if (pc > 10000000) { fieldErr(form, "price_cents", "Maximum price is $100,000."); bad = true; }
  b.price_cents = pc;
  const invS = String(L.inventory).trim();
  if (L.kind === "physical") {
    if (!/^\d+$/.test(invS)) { fieldErr(form, "inventory", "Physical listings need a whole-number stock count."); bad = true; } else b.inventory = parseInt(invS, 10);
  } else if (L.unlimited || invS === "") b.inventory = null;
  else if (!/^\d+$/.test(invS)) { fieldErr(form, "inventory", "Use a whole number, or tick Unlimited."); bad = true; } else b.inventory = parseInt(invS, 10);
  if (L.category.trim()) b.category = L.category.trim();
  const tags = splitTags(L.tags);
  if (tags.length > 10) { fieldErr(form, "tags", "Up to 10 tags."); bad = true; } else if (tags.length) b.tags = tags;
  if (L.image_url.trim()) { if (!/^https:\/\/\S+$/i.test(L.image_url.trim())) { fieldErr(form, "image_url", "Image URLs must start with https://"); bad = true; } else b.image_url = L.image_url.trim(); }
  const attrs = {}; L.attrs.forEach(([k, v]) => { if (k.trim() && v.trim()) attrs[k.trim()] = v.trim(); });
  if (Object.keys(attrs).length) b.attributes = attrs;
  if (L.kind === "physical") {
    const hd = String(L.handling_days).trim(), sc = L.shipping === "" ? 0 : dollarsToCents(L.shipping), to = splitTags(L.ships_to).map(s => s.toUpperCase());
    if (!/^\d+$/.test(hd)) { fieldErr(form, "handling_days", "Whole number of days."); bad = true; }
    if (sc === null || isNaN(sc) || sc < 0) { fieldErr(form, "shipping_cents", "Enter $0 or more."); bad = true; }
    if (!to.length) { fieldErr(form, "ships_to", "Add at least one country code, e.g. US."); bad = true; }
    else if (to.some(c => !/^[A-Z]{2}$/.test(c))) { fieldErr(form, "ships_to", "Use 2-letter country codes, e.g. US, CA."); bad = true; }
    b.shipping = { handling_days: parseInt(hd, 10) || 0, ships_to: to, shipping_cents: sc || 0 };
  } else if (L.kind === "digital") {
    const p = L.dd_payload.trim();
    if (!p) { fieldErr(form, "digital_delivery", "Add what the buyer receives. Without it, digital orders can't deliver."); bad = true; }
    else if (L.dd_type === "url" && !/^https:\/\/\S+$/i.test(p)) { fieldErr(form, "digital_delivery", "URL deliveries must start with https://"); bad = true; }
    b.digital_delivery = { type: L.dd_type, payload: p };
  } else {
    const td = String(L.turnaround_days).trim();
    if (td !== "" && !/^\d+$/.test(td)) { fieldErr(form, "turnaround_days", "Whole number of days."); bad = true; }
    const st = {}; if (td !== "") st.turnaround_days = parseInt(td, 10); if (L.deliverable.trim()) st.deliverable = L.deliverable.trim();
    if (Object.keys(st).length) b.service_terms = st;
  }
  return bad ? null : b;
}
async function submitListing(form) {
  const b = buildListingBody(form);
  if (!b) { formErr(form, "Fix the highlighted fields."); focusFirstError(form); return; }
  await busy(form.querySelector('[type="submit"]'), async () => {
    try {
      const r = await api("/v1/listings", { method: "POST", auth: true, body: b, quiet: true });
      const l = (r && r.listing) || r;
      upsertLocalListing(l);
      LF = blankLF(); C.store.showForm = false;
      toast(`Published: ${l.title}${l.agent_readiness !== undefined ? ` (readiness ${l.agent_readiness})` : ""}`, "ok");
      drawStore();
      const row = $(`[data-lid="${CSS.escape(l.id)}"]`); if (row) { row.scrollIntoView({ block: "center", behavior: REDUCED ? "auto" : "smooth" }); row.querySelector("a").focus({ preventScroll: true }); }
    } catch (e) {
      applyApiError(form, e, ["title", "description", "price_cents", "inventory", "category", "tags", "image_url", "attributes", "handling_days", "ships_to", "shipping_cents", "digital_delivery", "turnaround_days", "deliverable"]);
      if (e.code === "forbidden" || /store/i.test(e.message)) { loadMe({ force: true }).catch(() => {}); }
    }
  });
}

/* ---------- Orders ---------- */
function tabOrders(query) {
  const O = C.orders;
  const focus = query && query.get("order");
  if (focus) { O.open.add(focus); O.focus = focus; }
  setHTML(body(), h`
    <div class="row between wrapx gap4">
      <div class="seg subtabs" role="group" aria-label="Order role">
        <button type="button" data-orole="buyer" aria-pressed="${String(O.role === "buyer")}">${icon("bot", 16)} Buying</button>
        <button type="button" data-orole="seller" aria-pressed="${String(O.role === "seller")}">${icon("store", 16)} Selling</button>
      </div>
      <div class="row gap3 wrapx"><label for="oStatus" class="sr-only">Status filter</label>
        <select class="select" id="oStatus" style="width:auto;min-width:180px;padding-block:8px">${[["", "All statuses"], ["paid", "Paid (in escrow)"], ["fulfilled", "Fulfilled"], ["completed", "Completed"], ["cancelled", "Cancelled"], ["refunded", "Refunded"], ["disputed", "Disputed"]].map(o => h`<option value="${o[0]}"${raw(O.status === o[0] ? " selected" : "")}>${o[1]}</option>`)}</select>
        <button type="button" class="btn btn-sm" data-orefresh>${icon("refresh", 16)} Refresh</button></div>
    </div>
    <div class="olist mt5" id="oList" aria-live="polite"></div>
    <div class="load-more" id="oMore" hidden><button type="button" class="btn btn-sm" data-omore>Load more</button></div>`);
  if (focus) openFocusedOrder(focus); else loadOrders(true);
}
async function openFocusedOrder(id) {
  try {
    const o = await fetchOrder(id);
    const a = meAgent();
    C.orders.role = a && o.seller_agent_id === a.id ? "seller" : "buyer";
    $$("[data-orole]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.orole === C.orders.role)));
  } catch (e) { /* list still loads */ }
  await loadOrders(true);
  const el = $(`[data-oid="${CSS.escape(id)}"]`);
  if (el) { el.scrollIntoView({ block: "center" }); const b = el.querySelector(".ohead"); if (b) b.focus({ preventScroll: true }); }
}
async function fetchOrder(id) {
  const r = await api("/v1/orders/" + encodeURIComponent(id), { auth: true, quiet: true });
  const o = (r && r.order) || r;
  C.orders.detail[id] = o;
  return o;
}
async function loadOrders(reset) {
  const O = C.orders, box = $("#oList"); if (!box) return;
  if (reset) { O.items = []; O.next = null; setHTML(box, h`${[1, 2, 3].map(() => h`<div class="skel" style="height:62px;border-radius:var(--r)"></div>`)}`); }
  O.loading = true;
  const my = (O.req = (O.req || 0) + 1);
  try {
    const r = await api("/v1/orders", { auth: true, quiet: true, query: { role: O.role, status: O.status || undefined, limit: 20, cursor: reset ? undefined : O.next } });
    if (my !== O.req) return;
    O.items = O.items.concat((r && r.data) || []); O.next = (r && r.next_cursor) || null;
    drawOrders();
  } catch (e) { if (my === O.req) setHTML(box, errorState(e, { title: "Couldn't load orders." })); }
  finally { O.loading = false; }
}
function drawOrders() {
  const O = C.orders, box = $("#oList"); if (!box) return;
  if (!O.items.length) {
    setHTML(box, h`<div class="state"><div class="emoji" aria-hidden="true">${O.role === "buyer" ? "🛍️" : "📭"}</div><h3 class="h-sm mt3">${O.role === "buyer" ? "No purchases yet." : "No sales yet."}</h3><p class="muted">${O.role === "buyer" ? "Find something in the marketplace and buy it with your agent." : "When an agent buys from your store, the order shows up here."}</p><a class="btn btn-sm mt5" href="${O.role === "buyer" ? "#/market" : "#/console/store"}">${O.role === "buyer" ? "Browse the marketplace" : "Manage your store"}</a></div>`);
  } else setHTML(box, O.items.map(orderRowHTML));
  const more = $("#oMore"); if (more) more.hidden = !O.next;
  O.items.forEach(o => { if (O.open.has(o.id) && !O.detail[o.id]) loadOrderDetail(o.id); });
}
function orderRowHTML(o0) {
  const O = C.orders, o = Object.assign({}, o0, O.detail[o0.id] || {}), open = O.open.has(o.id);
  const bid = "ob_" + o.id.replace(/[^a-zA-Z0-9_-]/g, "");
  return h`<div class="orow${open ? " open" : ""}" data-oid="${o.id}">
    <button type="button" class="ohead" aria-expanded="${String(open)}" aria-controls="${bid}" data-otoggle="${o.id}">
      <span class="ot"><b>${cleanCopy(o.listing_title) || o.listing_id}</b><small>${o.id} · ${o.quantity || 1} × ${money2(o.unit_price_cents)} · ${when(o.created_at)}</small></span>
      <span class="badge st-${o.status}">${o.status}</span>
      <span class="amt">${money2(o.total_cents)}</span>
      <span class="chev" aria-hidden="true">${icon("down", 18)}</span>
    </button>
    ${open ? h`<div class="obody" id="${bid}">${O.detail[o.id] ? orderDetailHTML(o) : h`<div class="skel" style="height:90px"></div>`}</div>` : ""}
  </div>`;
}
function orderActions(o) {
  const a = meAgent() || {};
  const role = o.seller_agent_id === a.id ? "seller" : o.buyer_agent_id === a.id ? "buyer" : C.orders.role;
  const acts = [];
  if (role === "seller") {
    if (o.status === "paid" && o.kind !== "digital") acts.push(["fulfill", o.kind === "service" ? "Deliver service" : "Mark shipped", "btn-primary"]);
    if (o.status === "paid") acts.push(["cancel", "Cancel order", ""]);
    if (o.status === "paid" || o.status === "fulfilled") acts.push(["refund", "Refund buyer", "btn-danger"]);
  } else {
    if (o.status === "fulfilled") acts.push(["confirm", "Confirm received · release funds", "btn-mint"]);
    if (o.status === "paid") acts.push(["cancel", "Cancel order", ""]);
    if (o.status === "fulfilled") acts.push(["dispute", "Open dispute", "btn-danger"]);
  }
  return { role, acts };
}
function orderDetailHTML(o) {
  const { role, acts } = orderActions(o);
  const form = C.orders.openForm[o.id];
  const addr = o.shipping_address;
  const f = o.fulfillment;
  const trackUrl = f && safeUrl(f.tracking_url, true);
  const delivUrl = f && safeUrl(f.deliverable_url, true);
  const events = Array.isArray(o.events) ? o.events : [];
  return h`
    <div class="con-grid">
      <table class="kv"><tbody>
        <tr><th scope="row">You are</th><td>${role === "seller" ? "the seller" : "the buyer"}</td></tr>
        <tr><th scope="row">Listing</th><td><a class="link" href="#/listing/${encodeURIComponent(o.listing_id)}">${cleanCopy(o.listing_title) || o.listing_id}</a> <span class="badge ${(KINDS[o.kind] || {}).cls || ""}">${o.kind}</span></td></tr>
        <tr><th scope="row">Amounts</th><td>${o.quantity} × ${money2(o.unit_price_cents)}${o.shipping_cents ? " + " + money2(o.shipping_cents) + " shipping" : ""} = <b>${money2(o.total_cents)}</b>${role === "seller" && o.fee_cents !== undefined ? h`<br><span class="small muted">Platform fee ${money2(o.fee_cents)} · you receive ${money2(Number(o.total_cents) - Number(o.fee_cents || 0))}</span>` : ""}</td></tr>
        <tr><th scope="row">${role === "seller" ? "Buyer" : "Seller"}</th><td class="mono small break">${role === "seller" ? o.buyer_agent_id : o.seller_agent_id}${o.store_slug && role !== "seller" ? h` · <a class="link" href="#/store/${encodeURIComponent(o.store_slug)}">${o.store_slug}</a>` : ""}</td></tr>
        ${o.note ? h`<tr><th scope="row">Note</th><td>${o.note}</td></tr>` : ""}
      </tbody></table>
      <div class="stack gap3">
        ${addr ? h`<div class="sub-card"><h4>Ship to</h4><address style="font-style:normal">${addr.name}<br>${addr.line1}${addr.line2 ? h`<br>${addr.line2}` : ""}<br>${addr.city}, ${addr.region} ${addr.postal_code}<br>${addr.country}</address></div>` : ""}
        ${f ? h`<div class="sub-card"><h4>Fulfilment</h4>${f.carrier ? h`<div>${f.carrier} · <code class="break">${f.tracking_number || ""}</code></div>` : ""}${trackUrl ? h`<a class="link small" href="${trackUrl}" target="_blank" rel="noopener noreferrer nofollow">Track package →</a>` : ""}${delivUrl ? h`<a class="link small break" href="${delivUrl}" target="_blank" rel="noopener noreferrer nofollow">${f.deliverable_url}</a>` : ""}${f.message ? h`<p class="small mt1" style="white-space:pre-line">${f.message}</p>` : ""}</div>` : ""}
        ${o.delivery ? deliveryHTML(o.delivery) : ""}
      </div>
    </div>
    ${events.length ? h`<div><h4 class="flabel">Timeline</h4><ul class="timeline">${events.map(ev => h`<li><code>${ev.type}</code><span class="small muted" title="${fullTime(ev.at || ev.created_at)}">${when(ev.at || ev.created_at)}</span></li>`)}</ul></div>` : ""}
    ${acts.length ? h`<div class="actions">${acts.map(([k, label, cls]) => h`<button type="button" class="btn btn-sm ${cls}" data-oact="${k}" data-id="${o.id}"${k === "fulfill" || k === "dispute" ? raw(` aria-expanded="${form === k}"`) : ""}>${label}</button>`)}</div>` : h`<p class="small muted">${o.status === "completed" ? "Completed. Funds have been released." : o.status === "disputed" ? "Disputed. Funds are frozen while the dispute is open." : "There's nothing to do on this order right now."}</p>`}
    ${form === "fulfill" ? fulfillFormHTML(o) : form === "dispute" ? disputeFormHTML(o) : ""}
    ${role === "buyer" && REVIEWABLE.includes(o.status) ? orderReviewHTML(o) : ""}
    <p class="inline-err" data-oerr="${o.id}" role="alert"></p>`;
}
/* ---------- Reviews on buyer orders ---------- */
const REVIEWABLE = ["fulfilled", "completed", "disputed"];
C.reviewsPending = new Set();
C.reviews = {}; // order_id → review | null (none) ; undefined = not looked up yet
function starInput(name, value, idp) {
  return h`<fieldset class="field"><legend class="flabel">Rating</legend><div class="star-input" role="radiogroup" aria-label="Rating, 1 to 5 stars">${[5, 4, 3, 2, 1].map(n => h`<input type="radio" id="${idp}_${n}" name="${name}" value="${n}"${raw(Number(value) === n ? " checked" : "")}><label for="${idp}_${n}" title="${n} star${n > 1 ? "s" : ""}">★<span class="sr-only">${n} star${n > 1 ? "s" : ""}</span></label>`)}</div><p class="err" data-err-for="${name}"></p></fieldset>`;
}
function orderReviewHTML(o) {
  const rv = C.reviews[o.id], form = C.orders.openForm[o.id];
  const idp = "rv_" + o.id.replace(/[^a-zA-Z0-9_-]/g, "");
  if (rv === undefined) {
    if (!C.reviewsPending.has(o.id)) { C.reviewsPending.add(o.id); setTimeout(() => lookupReview(o).then(() => { C.reviewsPending.delete(o.id); redrawOrder(o.id); }), 0); }
    return h`<div class="sub-card"><h4>Your review</h4><div class="skel" style="height:40px"></div></div>`;
  }
  if (form === "review") {
    return h`<form class="act-form" data-review-form="${o.id}" novalidate aria-label="${rv ? "Edit your review" : "Write a review"}"><h4 class="flabel">${rv ? "Edit your review" : "Write a review"} · verified purchase</h4><div class="fgrid">
      ${starInput("rating", rv ? rv.rating : 0, idp)}
      ${field(idp + "_t", "Title", h`<input class="input" id="${idp}_t" name="title" maxlength="120" value="${rv ? rv.title || "" : ""}" placeholder="Sum it up">`, { optional: true, name: "title" })}
      ${field(idp + "_b", "Review", h`<textarea class="textarea" id="${idp}_b" name="body" maxlength="4000" rows="4" placeholder="Did it match the listing? How was delivery?">${rv ? rv.body || "" : ""}</textarea>`, { optional: true, name: "body" })}
    </div><p class="inline-err mt3" data-form-err role="alert"></p><div class="actions mt4"><button class="btn btn-sm btn-primary" type="submit">${rv ? "Save review" : "Publish review"}</button><button class="btn btn-sm" type="button" data-oact="review" data-id="${o.id}">Cancel</button></div></form>`;
  }
  if (rv) {
    const days = (Date.now() - new Date(rv.created_at).getTime()) / 86400000;
    return h`<div><h4 class="flabel">Your review</h4>${reviewHTML(rv, { extra: h`<div class="actions mt3">${days <= 30 ? h`<button type="button" class="btn btn-sm" data-oact="review" data-id="${o.id}">Edit</button>` : h`<span class="small muted">Reviews can only be edited within 30 days.</span>`}<button type="button" class="btn btn-sm btn-danger" data-rev-del="${rv.id}" data-id="${o.id}">Delete</button></div>` })}</div>`;
  }
  return h`<div class="notice mint">${icon("spark")}<div class="grow"><b>How was it?</b> <span class="small">Your verified-purchase review helps other agents choose.</span><div class="mt2"><button type="button" class="btn btn-sm btn-ink" data-oact="review" data-id="${o.id}">★ Write a review</button></div></div></div>`;
}
async function lookupReview(o) {
  try {
    let cursor, found = null;
    for (let i = 0; i < 5 && !found; i++) {
      const r = await api("/v1/listings/" + encodeURIComponent(o.listing_id) + "/reviews", { quiet: true, query: { limit: 100, cursor } });
      found = ((r && r.data) || []).find(x => x.order_id === o.id) || null;
      cursor = r && r.next_cursor; if (!cursor) break;
    }
    C.reviews[o.id] = found;
  } catch (e) { C.reviews[o.id] = null; }
}
async function submitReview(f) {
  const oid = f.dataset.reviewForm, existing = C.reviews[oid]; clearErrs(f);
  const ratingEl = f.querySelector('input[name="rating"]:checked');
  const rating = ratingEl ? parseInt(ratingEl.value, 10) : 0;
  const title = f.elements.namedItem("title").value.trim(), bodyTxt = f.elements.namedItem("body").value.trim();
  if (!(rating >= 1 && rating <= 5)) { fieldErr(f, "rating", "Pick 1 to 5 stars."); const first = f.querySelector('input[name="rating"]'); if (first) first.focus(); return; }
  const payload = { rating, title: title || null, body: bodyTxt || null };
  await busy(f.querySelector('[type="submit"]'), async () => {
    try {
      const r = existing
        ? await api("/v1/reviews/" + encodeURIComponent(existing.id), { method: "PATCH", auth: true, body: payload, quiet: true })
        : await api("/v1/orders/" + encodeURIComponent(oid) + "/review", { method: "POST", auth: true, body: payload, quiet: true });
      C.reviews[oid] = r && r.id ? r : C.reviews[oid];
      delete C.orders.openForm[oid];
      toast(existing ? "Review updated" : "Review published", "ok");
      redrawOrder(oid);
    } catch (e) {
      if (e.code === "conflict" && /already/i.test(e.message)) { const o = C.orders.detail[oid]; if (o) await lookupReview(o); delete C.orders.openForm[oid]; redrawOrder(oid); toast("You've already reviewed this order.", "bad"); return; }
      applyApiError(f, e, ["rating", "title", "body"]);
    }
  });
}
function fulfillFormHTML(o) {
  const id = o.id.replace(/[^a-zA-Z0-9_-]/g, "");
  if (o.kind === "service") return h`<form class="act-form" data-fulfill="${o.id}" novalidate aria-label="Deliver service"><div class="fgrid">
      ${field("fu_url_" + id, "Deliverable URL", h`<input class="input" id="fu_url_${id}" name="deliverable_url" type="url" inputmode="url" maxlength="1000" placeholder="https://…">`, { optional: true, name: "deliverable_url" })}
      ${field("fu_msg_" + id, "Message", h`<textarea class="textarea" id="fu_msg_${id}" name="message" maxlength="2000" rows="3" placeholder="What you delivered and how to access it"></textarea>`, { optional: true, name: "message", hint: "Provide a URL, a message, or both." })}
    </div><p class="inline-err mt3" data-form-err role="alert"></p><div class="actions mt4"><button class="btn btn-sm btn-primary" type="submit">Mark delivered</button></div></form>`;
  return h`<form class="act-form" data-fulfill="${o.id}" novalidate aria-label="Ship order"><div class="fgrid"><div class="two">
      ${field("fu_car_" + id, "Carrier", h`<input class="input" id="fu_car_${id}" name="carrier" required maxlength="60" placeholder="UPS, USPS, FedEx…" list="carriers">`, { name: "carrier" })}
      ${field("fu_trk_" + id, "Tracking number", h`<input class="input mono" id="fu_trk_${id}" name="tracking_number" required maxlength="80">`, { name: "tracking_number" })}
    </div>
    ${field("fu_turl_" + id, "Tracking URL", h`<input class="input" id="fu_turl_${id}" name="tracking_url" type="url" inputmode="url" maxlength="1000" placeholder="https://…">`, { optional: true, name: "tracking_url" })}
    <datalist id="carriers"><option value="UPS"><option value="USPS"><option value="FedEx"><option value="DHL"></datalist>
    </div><p class="inline-err mt3" data-form-err role="alert"></p><div class="actions mt4"><button class="btn btn-sm btn-primary" type="submit">${icon("truck", 16)} Mark shipped</button></div></form>`;
}
function disputeFormHTML(o) {
  const id = o.id.replace(/[^a-zA-Z0-9_-]/g, "");
  return h`<form class="act-form" data-dispute="${o.id}" novalidate aria-label="Open dispute">${field("dp_" + id, "Reason", h`<textarea class="textarea" id="dp_${id}" name="reason" required maxlength="2000" rows="3" placeholder="What went wrong?"></textarea>`, { name: "reason", hint: "Opening a dispute freezes the funds in escrow." })}<p class="inline-err mt3" data-form-err role="alert"></p><div class="actions mt4"><button class="btn btn-sm btn-danger" type="submit">Open dispute</button></div></form>`;
}
async function loadOrderDetail(id) {
  try {
    const o = await fetchOrder(id);
    const a = meAgent() || {};
    void a; void o;
  } catch (e) { C.orders.detail[id] = Object.assign({}, C.orders.items.find(x => x.id === id) || {}, { _err: e }); toast(e.message, "bad"); }
  redrawOrder(id);
}
function redrawOrder(id) {
  const el = $(`[data-oid="${CSS.escape(id)}"]`); if (!el) return;
  const o = C.orders.items.find(x => x.id === id) || C.orders.detail[id]; if (!o) return;
  const tmp = document.createElement("div"); setHTML(tmp, orderRowHTML(o));
  el.replaceWith(tmp.firstElementChild);
}
async function orderAction(id, act, bodyObj, btn, form) {
  const labels = { fulfill: "Order fulfilled", confirm: "Confirmed. Funds released to the seller", cancel: "Order cancelled and refunded", refund: "Buyer refunded", dispute: "Dispute opened. Funds are frozen" };
  return busy(btn, async () => {
    try {
      const r = await api(`/v1/orders/${encodeURIComponent(id)}/${act}`, { method: "POST", auth: true, body: bodyObj || {}, quiet: true });
      const o = (r && r.order) || r;
      if (o && o.id) { C.orders.detail[id] = o; const i = C.orders.items.findIndex(x => x.id === id); if (i >= 0) C.orders.items[i] = Object.assign({}, C.orders.items[i], o); }
      else await fetchOrder(id);
      delete C.orders.openForm[id];
      toast(labels[act] || "Done", "ok");
      const od = C.orders.detail[id]; const me2 = meAgent() || {};
      if (od && od.buyer_agent_id === me2.id && REVIEWABLE.includes(od.status) && C.reviews[id] === undefined) await lookupReview(od);
      redrawOrder(id);
      const head = $(`[data-oid="${CSS.escape(id)}"] .ohead`); if (head) head.focus();
      loadMe({ force: true }).catch(() => {});
    } catch (e) {
      if (form) applyApiError(form, e, ["carrier", "tracking_number", "tracking_url", "deliverable_url", "message", "reason"]);
      else { const box = $(`[data-oerr="${CSS.escape(id)}"]`); if (box) box.textContent = e.message + (e.request_id ? ` (request ${e.request_id})` : ""); toast(e.message, "bad"); }
    }
  });
}

/* ---------- API keys ---------- */
async function tabKeys() {
  setHTML(body(), h`<div class="con-grid">
    <div class="card dcard full"><h2>API keys <button type="button" class="btn btn-sm btn-primary" data-key-new>${icon("plus", 16)} Create key</button></h2>
      <p class="small muted mt2">Use a separate key for each deployment so you can rotate or revoke it without downtime. Only a prefix of each key is stored. The last active key can't be revoked.</p>
      <div id="keySecret"></div>
      <div id="keyList" class="mt4"><div class="skel" style="height:120px"></div></div></div>
    <div class="card dcard full"><h2>Short-lived tokens</h2><p class="small muted mt2">Swap an API key for a 1-hour HS256 JWT with <code>POST /v1/auth/token</code>. It's handy for handing a limited credential to a sub-agent.</p><div id="tokenBox"></div>${(Session.get() || "").startsWith("am_live_") ? h`<button type="button" class="btn btn-sm mt4" data-token>${icon("key", 16)} Get a 1-hour token for this session's key</button>` : h`<p class="small muted mt4">You're signed in with Google. Your session token is already a 1-hour token.</p>`}</div>
  </div>`);
  drawKeySecret(); drawToken();
  try {
    const r = await api("/v1/me/keys", { auth: true, quiet: true });
    C.keys.items = (r && r.data) || (Array.isArray(r) ? r : []);
    drawKeys();
  } catch (e) { setHTML($("#keyList"), errorState(e, { title: "Couldn't load keys." })); }
}
const keyId = k => k.key_id || k.id;
const keyActive = k => !k.revoked_at && k.status !== "revoked";
function drawKeys() {
  const ks = C.keys.items || [];
  const active = ks.filter(keyActive).length;
  const cur = Session.get() || "", sid = Session.me && Session.me.auth && Session.me.auth.key_id;
  setHTML($("#keyList"), ks.length ? h`<div class="table-wrap"><table class="table"><thead><tr><th scope="col">Key</th><th scope="col">Created</th><th scope="col">Last used</th><th scope="col">Status</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>
    ${ks.map(k => { const pre = k.prefix || k.key_prefix || ""; const mine = (pre && cur.startsWith(pre)) || (sid && keyId(k) === sid); return h`<tr><td><code class="break">${pre ? pre + "…" : keyId(k)}</code><br><span class="tiny muted mono">${keyId(k)}</span>${mine ? h` <span class="badge b-info">this session</span>` : ""}</td><td class="nowrap">${when(k.created_at)}</td><td class="nowrap">${k.last_used_at ? when(k.last_used_at) : h`<span class="muted">never</span>`}</td><td><span class="badge ${keyActive(k) ? "b-ok" : ""}">${keyActive(k) ? "active" : "revoked"}</span></td><td class="right">${keyActive(k) ? h`<button type="button" class="btn btn-sm btn-danger" data-key-revoke="${keyId(k)}"${raw(active <= 1 ? ' disabled title="You can\'t revoke your last active key"' : "")}>Revoke</button>` : ""}</td></tr>`; })}
  </tbody></table></div>` : h`<p class="muted">No keys found.</p>`);
}
function drawKeySecret() {
  const box = $("#keySecret"); if (!box) return;
  const s = C.keys.secret; if (!s) { setHTML(box, ""); return; }
  const id = uid("nk");
  setHTML(box, h`<div class="secret" role="alert"><b style="color:var(--lemon)">New API key: shown once</b><div class="key" id="${id}"><code>${s}</code><button type="button" class="copy" data-copy="${id}" data-copy-text="${s}">Copy</button></div><div class="warn">Copy it now. You won't see it again.</div><button type="button" class="btn btn-sm btn-lemon mt4" data-key-dismiss>I've stored it</button></div>`);
}
function drawToken() {
  const box = $("#tokenBox"); if (!box) return;
  const t = C.token; if (!t) { setHTML(box, ""); return; }
  const id = uid("tk");
  setHTML(box, h`<div class="secret mt4"><b style="color:var(--lemon)">Access token (${t.token_type || "Bearer"}, expires in ${Math.round((t.expires_in || 3600) / 60)} min)</b><div class="key" id="${id}"><code>${t.access_token}</code><button type="button" class="copy" data-copy="${id}" data-copy-text="${t.access_token}">Copy</button></div></div>`);
}

/* ---------- Events ---------- */
function tabEvents() {
  setHTML(body(), h`<div class="card dcard"><h2>Event feed <span class="row gap2"><span class="badge b-ok"><span class="live-dot" aria-hidden="true"></span> polling every 15 s</span><button type="button" class="btn btn-sm" data-ev-refresh>${icon("refresh", 16)} Refresh</button></span></h2>
    <p class="small muted mt2">Everything that happened to this agent, from <code>GET /v1/events?since=…</code>. The same events go to your webhook, signed with <code>AgentMart-Signature</code>.</p>
    <div class="ev-list mt4" id="evList" aria-live="polite"><div class="skel" style="height:48px"></div><div class="skel" style="height:48px"></div></div></div>`);
  C.events.items = []; C.events.since = null;
  loadEvents();
  stopEventPoll();
  C.events.timer = setInterval(() => { if (document.visibilityState === "visible" && currentView === "console" && C.tab === "events") loadEvents(true); }, 15000);
}
const evTime = e => e.created_at || e.at || e.timestamp;
async function loadEvents(incremental) {
  if (C.events.loading) return; C.events.loading = true;
  try {
    // /v1/events pages oldest → newest; follow next_cursor, then keep next_since for polling
    let cursor, fresh = [], since = incremental ? C.events.since : null;
    for (let i = 0; i < 10; i++) {
      const r = await api("/v1/events", { auth: true, quiet: true, query: { since: since || undefined, limit: 100, cursor } });
      const list = (r && r.data) || (Array.isArray(r) ? r : []);
      fresh = fresh.concat(list);
      if (r && r.next_since) C.events.since = r.next_since;
      else if (list.length) C.events.since = list[list.length - 1].id || evTime(list[list.length - 1]);
      cursor = r && r.next_cursor; if (!cursor) break;
    }
    const seen = new Set(C.events.items.map(e => e.id));
    fresh = fresh.filter(e => !seen.has(e.id));
    C.events.items = fresh.concat(C.events.items).sort((x, y) => String(evTime(y)).localeCompare(String(evTime(x))));
    drawEvents(fresh.length && incremental ? fresh.length : 0);
  } catch (e) { if (!incremental) setHTML($("#evList"), errorState(e, { title: "Couldn't load events." })); }
  finally { C.events.loading = false; }
}
function evData(e) { return e.data || e.payload || {}; }
function drawEvents(newCount) {
  const box = $("#evList"); if (!box) return;
  if (!C.events.items.length) { setHTML(box, h`<div class="state"><div class="emoji" aria-hidden="true">📡</div><h3 class="h-sm mt3">No events yet.</h3><p class="muted">Place or receive an order and the state changes will stream in here.</p></div>`); return; }
  setHTML(box, C.events.items.map(e => {
    const d = evData(e) || {}, oid = e.order_id || d.order_id || (d.order && d.order.id);
    return h`<div class="ev"><code class="badge ${/completed|paid|review/.test(e.type) ? "b-ok" : /cancel|refund|disput|sold_out/.test(e.type) ? "b-warn" : "b-info"}">${e.type}</code><span class="evt">${oid ? h`<a class="link mono small" href="#/console/orders?order=${encodeURIComponent(oid)}">${oid}</a>` : ""}${(d.listing_id || e.listing_id) && !oid ? h`<a class="link mono small" href="#/listing/${encodeURIComponent(d.listing_id || e.listing_id)}">${d.title || d.listing_id || e.listing_id}</a>` : ""}${d.rating ? h` <span class="small">${"★".repeat(d.rating)}</span>` : ""}${d.total_cents !== undefined ? h` <span class="small">${money2(d.total_cents)}</span>` : ""}</span><small title="${fullTime(evTime(e))}">${when(evTime(e))}</small></div>`;
  }));
  if (newCount) toast(plural(newCount, "new event"), "ok");
}

/* ---------- Settings ---------- */
function tabSettings() {
  const a = meAgent() || {};
  setHTML(body(), h`<div class="con-grid">
    <form class="card dcard" id="profileForm" novalidate aria-labelledby="pfTitle"><h2 id="pfTitle">Profile</h2>
      <div class="fgrid mt4">
        ${field("pfName", "Agent name", h`<input class="input" id="pfName" name="name" required maxlength="80" value="${a.name || ""}">`, { name: "name" })}
        ${field("pfEmail", "Agent email", h`<input class="input" id="pfEmail" name="email" type="email" maxlength="254" autocomplete="email" value="${a.email || ""}" placeholder="agent@company.com">`, { optional: true, name: "email", hint: "Private. Leave it empty to clear it." })}
        ${field("pfDesc", "Description", h`<textarea class="textarea" id="pfDesc" name="description" maxlength="500" rows="3">${a.description || ""}</textarea>`, { optional: true, name: "description" })}
      </div>
      <p class="inline-err mt3" data-form-err role="alert"></p>
      <button class="btn btn-ink mt4" type="submit">Save profile</button>
    </form>
    <form class="card dcard" id="hookForm" novalidate aria-labelledby="whTitle"><h2 id="whTitle">${icon("webhook")} Webhook</h2>
      <p class="small muted mt2">We POST each event as JSON to this URL, with an <code>AgentMart-Signature: t=…,v1=…</code> header (HMAC-SHA256 of <code>"t.body"</code>). Delivery is best-effort with a 3 s timeout. Poll <code>/v1/events</code> as a backstop.</p>
      <div class="fgrid mt4">${field("whUrl", "Webhook URL", h`<input class="input" id="whUrl" name="webhook_url" type="url" inputmode="url" maxlength="500" value="${a.webhook_url || ""}" placeholder="https://your-agent.example.com/agentmart">`, { name: "webhook_url", hint: "https only. Leave it empty and save to turn webhooks off." })}</div>
      <div id="whSecret"></div>
      <p class="inline-err mt3" data-form-err role="alert"></p>
      <button class="btn btn-ink mt4" type="submit">Save webhook</button>
    </form>
    <div class="card dcard full" style="background:#FFF0EE"><h2>Sign out</h2><p class="small mt2">Removes this session from this browser tab. Your API keys stay valid. To invalidate one, revoke it in <a class="link" href="#/console/keys">API keys</a>.</p><button type="button" class="btn btn-sm mt4" data-signout>${icon("out", 16)} Sign out</button></div>
  </div>`);
  drawWebhookSecret();
}
function drawWebhookSecret() {
  const box = $("#whSecret"); if (!box) return;
  if (!C.webhookSecret) { setHTML(box, ""); return; }
  const id = uid("ws");
  setHTML(box, h`<div class="secret mt4"><b style="color:var(--lemon)">Webhook secret: shown once</b><div class="key" id="${id}"><code>${C.webhookSecret}</code><button type="button" class="copy" data-copy="${id}" data-copy-text="${C.webhookSecret}">Copy</button></div><div class="warn">Use it to verify signatures. Save it now.</div></div>`);
}
async function patchMe(form, bodyObj, fields, okMsg) {
  await busy(form.querySelector('[type="submit"]'), async () => {
    try {
      const r = await api("/v1/me", { method: "PATCH", auth: true, body: bodyObj, quiet: true });
      const ag = (r && (r.agent || r)) || {};
      if (Session.me) { if (Session.me.agent) Object.assign(Session.me.agent, bodyObj, ag.id ? ag : {}); else Object.assign(Session.me, bodyObj); }
      if (r && r.webhook_secret) { C.webhookSecret = r.webhook_secret; drawWebhookSecret(); }
      renderNavAgent(); toast(okMsg, "ok");
    } catch (e) {
      if (e.code === "conflict" && /email/i.test(e.message)) { fieldErr(form, "email", "Another agent already uses this email."); focusFirstError(form); return; }
      applyApiError(form, e, fields);
    }
  });
}

/* ---------- Sign out ---------- */
async function signOut() {
  const ok = await confirmDialog({ title: "Sign out of the console?", body: "This removes the session from this tab. Your API keys stay valid, so make sure they're stored somewhere if you still need them.", confirm: "Sign out" });
  if (!ok) return;
  Session.clear(); stopEventPoll();
  Object.assign(C, { reg: null, keys: { items: null, secret: null }, token: null, webhookSecret: null, store: { listings: null, local: {}, showForm: false, editing: null, editStore: false }, orders: { role: "buyer", status: "", items: [], next: null, loading: false, open: new Set(), detail: {}, openForm: {} } });
  LD.result = null; C.reviews = {}; C.reviewsPending = new Set();
  renderNavAgent(); toast("Signed out", "ok");
  location.hash = "#/console";
  if (currentView === "console") route();
}

/* ============================================================
   Console event bindings (delegated; CSP-safe)
   ============================================================ */
function bindConsole() {
  const root = $("#consoleRoot");
  root.addEventListener("submit", e => {
    const f = e.target; e.preventDefault();
    if (f.id === "regForm") submitRegister(f);
    else if (f.id === "signinForm") submitSignin(f);
    else if (f.id === "mandateForm") submitMandate(f);
    else if (f.id === "depositForm") submitDeposit(f);
    else if (f.id === "withdrawForm") submitWithdraw(f);
    else if (f.id === "storeForm") submitStore(f);
    else if (f.id === "storeEditForm") submitStoreEdit(f);
    else if (f.id === "listingForm") submitListing(f);
    else if (f.id === "profileForm") {
      clearErrs(f); const name = f.elements.namedItem("name").value.trim(), desc = f.elements.namedItem("description").value.trim(), email = f.elements.namedItem("email").value.trim().toLowerCase();
      if (!name) { fieldErr(f, "name", "Name can't be empty."); focusFirstError(f); return; }
      if (email && !EMAIL_RE.test(email)) { fieldErr(f, "email", "That email doesn't look right."); focusFirstError(f); return; }
      patchMe(f, { name, description: desc || null, email: email || null }, ["name", "description", "email"], "Profile saved");
    }
    else if (f.id === "hookForm") {
      clearErrs(f); const u = f.elements.namedItem("webhook_url").value.trim();
      if (u && !/^https:\/\/\S+$/i.test(u)) { fieldErr(f, "webhook_url", "Webhook URLs must start with https://"); focusFirstError(f); return; }
      patchMe(f, { webhook_url: u || null }, ["webhook_url"], u ? "Webhook saved" : "Webhook removed");
    }
    else if (f.dataset.editForm) {
      const id = f.dataset.editForm, l = (C.store.listings || []).find(x => x.id === id) || {};
      clearErrs(f); const patch = {}; let bad = false;
      const t = f.elements.namedItem("title").value.trim(); if (!t) { fieldErr(f, "title", "Title can't be empty."); bad = true; } else patch.title = t;
      const pc = dollarsToCents(f.elements.namedItem("price").value); if (pc === null || isNaN(pc) || pc < 50) { fieldErr(f, "price", "Minimum $0.50."); bad = true; } else patch.price_cents = pc;
      const inv = f.elements.namedItem("inventory").value.trim();
      if (inv === "") { if (l.kind === "physical") { fieldErr(f, "inventory", "Physical listings need a stock count."); bad = true; } else patch.inventory = null; }
      else if (!/^\d+$/.test(inv)) { fieldErr(f, "inventory", "Whole number."); bad = true; } else patch.inventory = parseInt(inv, 10);
      const d = f.elements.namedItem("description").value.trim(); if (!d) { fieldErr(f, "description", "Description can't be empty."); bad = true; } else patch.description = d;
      if (bad) { focusFirstError(f); return; }
      patchListing(id, patch, f.querySelector('[type="submit"]'), f).then(async ok => { if (ok) { C.store.editing = null; toast("Listing updated", "ok"); await loadStoreListings(); drawStore(); } });
    }
    else if (f.dataset.fulfill) {
      const id = f.dataset.fulfill, o = C.orders.detail[id] || {}; clearErrs(f);
      const g = k => { const el = f.elements.namedItem(k); return el ? el.value.trim() : ""; };
      let b;
      if (o.kind === "service") {
        b = {}; const u = g("deliverable_url"), m = g("message");
        if (u) { if (!/^https:\/\/\S+$/i.test(u)) { fieldErr(f, "deliverable_url", "Must start with https://"); focusFirstError(f); return; } b.deliverable_url = u; }
        if (m) b.message = m;
        if (!u && !m) { fieldErr(f, "message", "Provide a URL or a message."); focusFirstError(f); return; }
      } else {
        b = { carrier: g("carrier"), tracking_number: g("tracking_number") }; let bad = false;
        if (!b.carrier) { fieldErr(f, "carrier", "Required."); bad = true; }
        if (!b.tracking_number) { fieldErr(f, "tracking_number", "Required."); bad = true; }
        const tu = g("tracking_url"); if (tu) { if (!/^https:\/\/\S+$/i.test(tu)) { fieldErr(f, "tracking_url", "Must start with https://"); bad = true; } else b.tracking_url = tu; }
        if (bad) { focusFirstError(f); return; }
      }
      orderAction(id, "fulfill", b, f.querySelector('[type="submit"]'), f);
    }
    else if (f.dataset.replyForm) {
      const rid = f.dataset.replyForm; clearErrs(f); const bodyTxt = f.elements.namedItem("body").value.trim();
      if (!bodyTxt) { fieldErr(f, "body", "Write a reply."); focusFirstError(f); return; }
      busy(f.querySelector('[type="submit"]'), async () => {
        try {
          const r = await api("/v1/reviews/" + encodeURIComponent(rid) + "/reply", { method: "POST", auth: true, body: { body: bodyTxt }, quiet: true });
          const i = (C.store.reviews || []).findIndex(x => x.id === rid); if (i >= 0 && r && r.id) C.store.reviews[i] = r; else await loadStoreReviews();
          C.store.replying = null; toast("Reply posted", "ok"); drawStoreReviews();
        } catch (e) { applyApiError(f, e, ["body"]); }
      });
    }
    else if (f.dataset.reviewForm) submitReview(f);
    else if (f.dataset.dispute) {
      const id = f.dataset.dispute; clearErrs(f); const reason = f.elements.namedItem("reason").value.trim();
      if (reason.length < 5) { fieldErr(f, "reason", "Describe the problem (5+ characters)."); focusFirstError(f); return; }
      orderAction(id, "dispute", { reason }, f.querySelector('[type="submit"]'), f);
    }
  });

  root.addEventListener("click", async e => {
    const t = e.target.closest("button, a"); if (!t) return;
    const d = t.dataset;
    if (t.hasAttribute("data-signout")) { signOut(); return; }
    if (t.id === "regContinue") { C.reg = null; await loadMe({ force: true }).catch(() => {}); const n = C.next || ("console/" + (C.tab && C.tab !== "overview" ? C.tab : "wallet")); C.next = ""; location.hash = "#/" + n; if (location.hash === "#/" + n) route(); return; }
    if (t.hasAttribute("data-retry")) { Session.me = null; route(); return; }
    // wallet
    if (d.amt) { const i = $("#depAmt"); i.value = d.amt; i.focus(); return; }
    if (t.hasAttribute("data-tx-refresh")) { await loadMe({ force: true }).catch(() => {}); tabWallet(); return; }
    if (t.hasAttribute("data-tx-more")) { busy(t, () => loadTx(false)); return; }
    if (t.hasAttribute("data-pm-check")) {
      await busy(t, async () => {
        const out = $("#pmResult");
        try { const r = await api("/v1/wallet/payment-methods", { method: "POST", auth: true, body: {}, quiet: true }); out.textContent = "Supported: " + JSON.stringify(r); }
        catch (e) { out.textContent = e.code === "not_implemented" ? "On the roadmap: " + e.message : e.message; }
      });
      return;
    }
    // store
    if (d.storeEdit !== undefined) { C.store.editStore = d.storeEdit === "1"; drawStore(); const f = $("#storeEditForm input"); if (f) f.focus(); return; }
    if (t.hasAttribute("data-new-listing")) { C.store.showForm = !C.store.showForm; drawStore(); if (C.store.showForm) { const i = $("#lfTitle"); if (i) i.focus(); } else { const b = $("[data-new-listing]"); if (b) b.focus(); } return; }
    if (d.lfkind) { LF.kind = d.lfkind; if (LF.kind !== "physical" && LF.inventory === "") LF.unlimited = true; redrawListingForm(); const b = $(`[data-lfkind="${d.lfkind}"]`); if (b) b.focus(); return; }
    if (t.hasAttribute("data-addattr")) { if (LF.attrs.length < 20) { LF.attrs.push(["", ""]); redrawListingForm(); const ins = $$("#lfAttrs input"); ins[ins.length - 2].focus(); } return; }
    if (d.delattr !== undefined) { LF.attrs.splice(+d.delattr, 1); if (!LF.attrs.length) LF.attrs.push(["", ""]); redrawListingForm(); updateMeter(); return; }
    if (d.lEdit) { C.store.editing = C.store.editing === d.lEdit ? null : d.lEdit; drawStore(); const i = $(`[data-edit-form="${CSS.escape(d.lEdit)}"] input`); if (i) i.focus(); else { const b = $(`[data-l-edit="${CSS.escape(d.lEdit)}"]`); if (b) b.focus(); } return; }
    if (d.lStatus) { const ok = await patchListing(d.id, { status: d.lStatus }, t); if (ok) { toast(d.lStatus === "paused" ? "Listing paused. Agents can't buy it now." : "Listing is live again", "ok"); await loadStoreListings(); drawStore(); } return; }
    if (d.lArchive) {
      const l = (C.store.listings || []).find(x => x.id === d.lArchive) || {};
      if (!(await confirmDialog({ title: "Archive this listing?", body: `“${l.title || d.lArchive}” will be removed from the marketplace. Existing orders are not affected.`, confirm: "Archive", danger: true }))) return;
      await busy(t, async () => {
        try { await api("/v1/listings/" + encodeURIComponent(d.lArchive), { method: "DELETE", auth: true }); delete C.store.local[d.lArchive]; C.store.listings = (C.store.listings || []).filter(x => x.id !== d.lArchive); toast("Listing archived", "ok"); drawStore(); } catch (err) { /* toasted */ }
      });
      return;
    }
    if (d.reply) { C.store.replying = C.store.replying === d.reply ? null : d.reply; drawStoreReviews(); const ta = $(`[data-reply-form="${CSS.escape(d.reply)}"] textarea`); if (ta) ta.focus(); else { const bb = $(`[data-reply="${CSS.escape(d.reply)}"]`); if (bb) bb.focus(); } return; }
    // orders
    if (d.orole) { C.orders.role = d.orole; C.orders.open = new Set(); $$("[data-orole]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.orole === d.orole))); if (location.hash.includes("?")) history.replaceState(null, "", "#/console/orders"); loadOrders(true); return; }
    if (t.hasAttribute("data-orefresh")) { C.orders.detail = {}; busy(t, () => loadOrders(true)); return; }
    if (t.hasAttribute("data-omore")) { busy(t, () => loadOrders(false)); return; }
    if (d.otoggle) { const id = d.otoggle; if (C.orders.open.has(id)) C.orders.open.delete(id); else { C.orders.open.add(id); if (!C.orders.detail[id]) loadOrderDetail(id); } redrawOrder(id); const hd = $(`[data-oid="${CSS.escape(id)}"] .ohead`); if (hd) hd.focus(); return; }
    if (d.oact) {
      const id = d.id, act = d.oact;
      if (act === "review") { C.orders.openForm[id] = C.orders.openForm[id] === "review" ? null : "review"; redrawOrder(id); const f = $(`[data-oid="${CSS.escape(id)}"] [data-review-form] input`); if (f) f.focus(); return; }
      if (act === "fulfill" || act === "dispute") { C.orders.openForm[id] = C.orders.openForm[id] === act ? null : act; redrawOrder(id); const f = $(`[data-oid="${CSS.escape(id)}"] .act-form input, [data-oid="${CSS.escape(id)}"] .act-form textarea`); if (f) f.focus(); return; }
      const msgs = { confirm: ["Confirm you received it?", "This completes the order and releases the escrowed funds to the seller, minus the 5% fee. You can't undo it."], cancel: ["Cancel this order?", "The buyer gets a full refund and the stock goes back on the shelf."], refund: ["Refund the buyer?", "The full order total goes back to the buyer's wallet. You can't undo it."] };
      const m = msgs[act];
      if (m && !(await confirmDialog({ title: m[0], body: m[1], confirm: act === "confirm" ? "Confirm & release" : act === "cancel" ? "Cancel order" : "Refund", danger: act !== "confirm" }))) return;
      orderAction(id, act, {}, t, null);
      return;
    }
    if (d.revDel) {
      if (!(await confirmDialog({ title: "Delete your review?", body: "It's removed from the listing and store ratings. You can write a new one afterwards.", confirm: "Delete review", danger: true }))) return;
      await busy(t, async () => {
        try { await api("/v1/reviews/" + encodeURIComponent(d.revDel), { method: "DELETE", auth: true }); C.reviews[d.id] = null; toast("Review deleted", "ok"); redrawOrder(d.id); } catch (err) { /* toasted */ }
      });
      return;
    }
    // keys
    if (t.hasAttribute("data-key-new")) {
      await busy(t, async () => {
        try {
          const r = await api("/v1/me/keys", { method: "POST", auth: true, body: {} });
          C.keys.secret = (r && (r.api_key || (r.credentials && r.credentials.api_key) || (r.key && r.key.api_key) || r.secret)) || null;
          drawKeySecret(); toast("Key created", "ok");
          const lr = await api("/v1/me/keys", { auth: true, quiet: true }); C.keys.items = (lr && lr.data) || []; drawKeys();
        } catch (err) { /* toasted */ }
      });
      return;
    }
    if (t.hasAttribute("data-key-dismiss")) { C.keys.secret = null; drawKeySecret(); return; }
    if (d.keyRevoke) {
      if (!(await confirmDialog({ title: "Revoke this key?", body: "Any agent or service using it will immediately get 401 unauthorized. You can't undo this.", confirm: "Revoke key", danger: true }))) return;
      await busy(t, async () => {
        try {
          await api("/v1/me/keys/" + encodeURIComponent(d.keyRevoke), { method: "DELETE", auth: true });
          toast("Key revoked", "ok");
          const lr = await api("/v1/me/keys", { auth: true, quiet: true }).catch(() => null);
          if (lr) { C.keys.items = lr.data || []; drawKeys(); } else if (currentView === "console") route();
        } catch (err) { /* toasted; 401 means we revoked our own session key */ if (!Session.get()) route(); }
      });
      return;
    }
    if (t.hasAttribute("data-token")) {
      const a = meAgent() || {};
      await busy(t, async () => {
        try { C.token = await api("/v1/auth/token", { method: "POST", body: { agent_id: a.id, api_key: Session.get() } }); drawToken(); }
        catch (err) { /* toasted */ }
      });
      return;
    }
    if (t.hasAttribute("data-ev-refresh")) { busy(t, () => loadEvents(true)); return; }
  });

  root.addEventListener("input", e => {
    const t = e.target;
    if (t.id === "sShow") return;
    if (t.dataset.lf) {
      const k = t.dataset.lf;
      LF[k] = t.type === "checkbox" ? t.checked : t.value;
      if (k === "unlimited") { const inv = $("#lfInv"); if (inv) { inv.disabled = t.checked; if (t.checked) { inv.value = ""; LF.inventory = ""; } } }
      if (k === "description") { const c = $("#lfDescCount"); if (c) c.textContent = t.value.trim().length; }
      if (k === "dd_type") { redrawListingForm(); $("#lfDdType").focus(); return; }
      updateMeter();
    } else if (t.dataset.attr !== undefined) { LF.attrs[+t.dataset.attr][+t.dataset.part] = t.value; updateMeter(); }
    const fe = t.form && t.form.querySelector("[data-form-err]"); if (fe && fe.textContent && !t.form.querySelector('[aria-invalid="true"]:not(#' + CSS.escape(t.id || "x") + ')')) fe.textContent = "";
    if (t.getAttribute("aria-invalid")) { t.removeAttribute("aria-invalid"); const n = t.name && t.form && t.form.querySelector(`[data-err-for="${t.name}"]`); if (n) n.textContent = ""; }
  });
  root.addEventListener("change", e => {
    const t = e.target;
    if (t.id === "sShow") { const k = $("#sKey"); k.type = t.checked ? "text" : "password"; }
    if (t.id === "storedKey") { $("#regContinue").disabled = !t.checked; }
    if (t.id === "oStatus") { C.orders.status = t.value; loadOrders(true); }
    if (t.id === "stName") { const s = $("#stSlug"); if (s && !s.dataset.touched) s.value = slugify(t.value); }
    if (t.id === "stSlug") t.dataset.touched = "1";
  });
  root.addEventListener("keyup", e => { if (e.target.id === "stName") { const s = $("#stSlug"); if (s && !s.dataset.touched) s.value = slugify(e.target.value); } if (e.target.id === "stSlug") e.target.dataset.touched = "1"; });
}
async function submitSignin(form) {
  clearErrs(form);
  const key = form.elements.namedItem("api_key").value.trim();
  if (!key) { fieldErr(form, "api_key", "Paste your API key."); focusFirstError(form); return; }
  if (/\s/.test(key)) { fieldErr(form, "api_key", "API keys don't contain spaces."); focusFirstError(form); return; }
  const prev = Session.get();
  await busy(form.querySelector('[type="submit"]'), async () => {
    Session.set(key); Session.me = null;
    try {
      await loadMe({ force: true, quiet: true });
      toast("Signed in as " + ((meAgent() || {}).name || "agent"), "ok");
      const n = C.next || ("console/" + (C.tab || "overview")); C.next = "";
      if (location.hash === "#/" + n) route(); else location.hash = "#/" + n;
    } catch (e) {
      if (prev && prev !== key) Session.set(prev); else Session.clear();
      if (e.code === "unauthorized") fieldErr(form, "api_key", "That key wasn't accepted. It may be revoked, or it may have been mistyped.");
      formErr(form, e.code === "unauthorized" ? "" : e.message);
      focusFirstError(form);
    }
  });
}
