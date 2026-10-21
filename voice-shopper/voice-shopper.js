/* AgentMart Voice Shopper — a simulated Alexa+ experience.
 *
 * Honest by construction: every result on this page comes from a live call
 * to AgentMart's public REST API (the same operations exposed as MCP tools:
 * search_listings, get_listing, get_reviews, list_categories). There are no
 * canned results. If the catalogue has no match, the shopper says so, and
 * every relaxation it applies is disclosed in the conversation and visible
 * in the tool-call trace.
 */
(function () {
  "use strict";

  var API = (window.AGENTMART_API || "https://spauxptabyipnhjgboxm.supabase.co/functions/v1/api").replace(/\/+$/, "");

  var state = {
    goal: "", budget: null, kind: "", category: "", minRating: null, sort: "rating",
    results: [], byId: {}, shortlist: [], categories: []
  };

  var $ = function (id) { return document.getElementById(id); };
  var chatEl, traceEl, resultsEl, resMeta, compareEl, apiStatus;

  /* ---------------- utilities ---------------- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function money(cents) {
    if (cents == null) return "—";
    var v = cents / 100;
    return "$" + v.toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 });
  }
  function starsHTML(avg) {
    if (avg == null) return '<span class="stars" title="No ratings yet">☆☆☆☆☆</span>';
    var full = Math.round(avg), out = "";
    for (var i = 0; i < 5; i++) out += i < full ? "★" : '<span class="off">★</span>';
    return '<span class="stars" title="' + esc(avg) + ' out of 5">' + out + "</span>";
  }
  function ratingText(l) {
    var r = l.rating || {};
    if (!r.count) return "No ratings yet";
    return r.average + " ★ · " + r.count + (r.count === 1 ? " review" : " reviews");
  }
  function kindEmoji(k) { return k === "physical" ? "📦" : k === "service" ? "🛎️" : "💾"; }

  /* ---------------- chat ---------------- */
  function addMsg(cls, who, html) {
    var d = document.createElement("div");
    d.className = "msg " + cls;
    d.innerHTML = '<span class="who">' + esc(who) + "</span>" + html;
    chatEl.appendChild(d);
    chatEl.scrollTop = chatEl.scrollHeight;
    return d;
  }
  function say(html) { return addMsg("msg-bot", "Voice Shopper · simulation", html); }
  function userSay(text) { addMsg("msg-user", "You", esc(text)); }

  /* ---------------- traced API calls ---------------- */
  function callTool(tool, path, params) {
    var qs = new URLSearchParams();
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
    });
    var suffix = qs.toString() ? "?" + qs.toString() : "";
    var li = document.createElement("li");
    li.innerHTML = '<span class="t-tool">' + esc(tool) + '</span> <span class="t-meta">GET ' +
      esc(path + suffix) + "</span> …";
    traceEl.appendChild(li);
    traceEl.scrollTop = traceEl.scrollHeight;
    var started = performance.now();
    return fetch(API + path + suffix, { headers: { "Accept": "application/json" }, credentials: "omit", cache: "no-store" })
      .then(function (res) {
        return res.json().then(function (body) { return { res: res, body: body }; });
      })
      .then(function (out) {
        var ms = Math.round(performance.now() - started);
        if (!out.res.ok) {
          var m = (out.body && (out.body.message || out.body.error)) || ("HTTP " + out.res.status);
          throw new Error(m);
        }
        var n = out.body && Array.isArray(out.body.data) ? out.body.data.length : null;
        li.innerHTML = '<span class="t-tool">' + esc(tool) + '</span> <span class="t-meta">GET ' +
          esc(path + suffix) + '</span> <span class="t-ok">→ 200' +
          (n !== null ? " · " + n + " item" + (n === 1 ? "" : "s") : "") + " · " + ms + " ms</span>";
        return out.body;
      })
      .catch(function (e) {
        li.innerHTML = '<span class="t-tool">' + esc(tool) + '</span> <span class="t-meta">GET ' +
          esc(path + suffix) + '</span> <span class="t-err">→ failed: ' + esc(e.message || e) + "</span>";
        throw e;
      });
  }

  /* ---------------- results rendering ---------------- */
  function cardHTML(l, i) {
    var inShort = state.shortlist.indexOf(l.id) >= 0;
    var img = l.image_url
      ? '<img src="' + esc(l.image_url) + '" alt="" loading="lazy">'
      : '<span aria-hidden="true">' + kindEmoji(l.kind) + "</span>";
    var badges = '<span class="badge b-' + esc(l.kind) + '">' + esc(l.kind) + "</span>" +
      (l.category ? '<span class="badge">' + esc(l.category) + "</span>" : "") +
      (l.is_demo ? '<span class="badge b-warn">demo listing</span>' : "") +
      (l.in_stock === false ? '<span class="badge b-bad">out of stock</span>' : "");
    return '<article class="lcard">' +
      '<div class="lcard-img">' + img + '<span class="lcard-num">#' + (i + 1) + "</span></div>" +
      '<div class="lcard-body">' +
      '<div class="lcard-title">' + esc(l.title) + "</div>" +
      "<div>" + starsHTML(l.rating && l.rating.average) + ' <span class="small muted">' + esc(ratingText(l)) + "</span></div>" +
      (l.description ? '<p class="lcard-desc">' + esc(l.description) + "</p>" : "") +
      '<div class="lcard-meta">' + badges + "</div>" +
      '<div class="small muted">Sold by <b>' + esc((l.store && l.store.name) || "unknown store") + "</b></div>" +
      '<div class="lcard-foot"><span class="lcard-price">' + money(l.price_cents) + "</span></div>" +
      '<div class="lcard-actions">' +
      '<button type="button" class="btn" data-act="details" data-idx="' + i + '">Details</button>' +
      '<button type="button" class="btn" data-act="reviews" data-idx="' + i + '">Reviews</button>' +
      '<button type="button" class="btn ' + (inShort ? "btn-mint" : "") + '" data-act="shortlist" data-idx="' + i + '">' +
      (inShort ? "✓ Shortlisted" : "Shortlist +") + "</button>" +
      "</div></div></article>";
  }

  function renderResults() {
    if (!state.results.length) {
      resultsEl.innerHTML = '<div class="state"><div class="emoji" aria-hidden="true">🔍</div><p class="muted">No live listings matched. Try relaxing a constraint — the shopper will always tell you when it does.</p></div>';
      resMeta.textContent = "0 results";
      return;
    }
    resMeta.textContent = state.results.length + " live listings · AgentMart public beta (sandbox) data";
    resultsEl.innerHTML = state.results.map(cardHTML).join("");
  }

  function renderShortlist() {
    if (!state.shortlist.length) {
      compareEl.innerHTML = '<p class="muted small">Shortlist at least two listings and the shopper will compare them using live listing details and reviews — highest rating first, then most reviews, then lowest price. The rule is fixed and shown, never hidden.</p>';
      return;
    }
    var items = state.shortlist.map(function (id) { return state.byId[id]; }).filter(Boolean);
    var html = '<div class="lcard-meta" style="margin-bottom:10px">' + items.map(function (l) {
      return '<span class="badge b-info">' + esc(l.title) + " · " + money(l.price_cents) + "</span>";
    }).join("") + "</div>";
    if (items.length >= 2) html += '<button type="button" class="btn btn-primary btn-sm" id="vsCompareBtn">Compare shortlist</button>';
    else html += '<p class="small muted">Add one more listing to compare.</p>';
    compareEl.innerHTML = html;
    var b = $("vsCompareBtn");
    if (b) b.addEventListener("click", function () { doCompare(); });
  }

  /* ---------------- search planning ---------------- */
  function constraintSummary() {
    var bits = [];
    if (state.goal) bits.push('goal “' + state.goal + '”');
    if (state.kind) bits.push(state.kind + " only");
    if (state.category) bits.push("category " + state.category);
    if (state.budget != null) bits.push("under " + money(Math.round(state.budget * 100)));
    if (state.minRating != null) bits.push("rated " + state.minRating + " ★ and up");
    return bits.length ? bits.join(" · ") : "the whole catalogue";
  }

  function attemptSearch(params, relaxSteps, relaxed) {
    return callTool("search_listings", "/v1/listings", params).then(function (body) {
      var items = (body && body.data) || [];
      if (items.length || !relaxSteps.length) return { items: items, relaxed: relaxed };
      var step = relaxSteps.shift();
      relaxed.push(step.label);
      step.apply(params);
      return attemptSearch(params, relaxSteps, relaxed);
    });
  }

  function runSearch() {
    var params = { limit: 12, sort: state.sort };
    if (state.goal) params.q = state.goal;
    if (state.kind) params.kind = state.kind;
    if (state.category) params.category = state.category;
    if (state.budget != null) params.max_price = Math.round(state.budget * 100);
    if (state.minRating != null) params.min_rating = state.minRating;

    var relaxSteps = [];
    if (state.minRating != null) relaxSteps.push({ label: "dropped the minimum-rating filter", apply: function (p) { delete p.min_rating; } });
    if (state.goal && state.goal.trim().split(/\s+/).length > 1) {
      var toks = state.goal.trim().split(/\s+/);
      var ordered = [toks[toks.length - 1]].concat(toks.slice(0, -1).sort(function (a, b) { return b.length - a.length; }));
      var seenTok = {};
      ordered.filter(function (t) { if (t.length < 3 || seenTok[t]) return false; seenTok[t] = 1; return true; })
        .forEach(function (tok) {
          relaxSteps.push({ label: 'broadened the search text to “' + tok + '”', apply: function (p) { p.q = tok; } });
        });
    }
    if (state.goal) relaxSteps.push({ label: "dropped the search text and searched by filters only", apply: function (p) { delete p.q; } });

    var thinking = say("Searching AgentMart's <b>live</b> catalogue for " + esc(constraintSummary()) + "…");
    return attemptSearch(params, relaxSteps, []).then(function (out) {
      thinking.remove();
      state.results = out.items;
      state.byId = {};
      out.items.forEach(function (l) { state.byId[l.id] = l; });
      renderResults();
      if (!out.items.length) {
        say("No live listings matched — even after " + (out.relaxed.length ? "relaxing (" + esc(out.relaxed.join("; ")) + ")" : "searching the whole catalogue") +
          ". AgentMart's beta catalogue is small (dozens of listings). Try a broader goal, a higher budget, or clear the rating filter.");
        return;
      }
      var top = out.items[0];
      var note = out.relaxed.length ? " I relaxed: " + esc(out.relaxed.join("; ")) + "." : "";
      say("Found <b>" + out.items.length + " live listing" + (out.items.length === 1 ? "" : "s") + "</b> for " + esc(constraintSummary()) + "." + note +
        " Top result: <b>" + esc(top.title) + "</b> at " + money(top.price_cents) + " (" + esc(ratingText(top)) + ")." +
        (out.items.length >= 2
          ? ' Say <b>“compare 1 and 2”</b>, <b>“reviews 1”</b> or <b>“shortlist 1”</b> — the numbers match the cards.'
          : ' Say <b>“reviews 1”</b> or <b>“details 1”</b> to inspect it, or broaden the search.'));
    }).catch(function (e) {
      thinking.remove();
      addMsg("msg-bot msg-err", "Voice Shopper · simulation", "The live AgentMart API call failed: " + esc(e.message || e) + ". Nothing was substituted — please try again.");
    });
  }

  /* ---------------- details & reviews ---------------- */
  function pickIndex(text) {
    var words = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };
    var m = text.match(/\b(\d{1,2})\b/);
    if (m) return parseInt(m[1], 10) - 1;
    for (var w in words) if (text.indexOf(w) >= 0) return words[w] - 1;
    if (/top|best/.test(text)) return 0;
    return -1;
  }
  function listingAt(idx) {
    if (idx < 0 || idx >= state.results.length) {
      say("I need a result number from the current list — for example <b>“reviews 1”</b>. Run a search first if the list is empty.");
      return null;
    }
    return state.results[idx];
  }

  function showDetails(idx) {
    var l = listingAt(idx); if (!l) return;
    callTool("get_listing", "/v1/listings/" + l.id, {}).then(function (d) {
      state.byId[d.id] = d;
      var attrs = d.attributes ? Object.keys(d.attributes).map(function (k) { return esc(k) + ": " + esc(d.attributes[k]); }).join(" · ") : "";
      say("<b>" + esc(d.title) + "</b> — " + money(d.price_cents) + " · " + esc(ratingText(d)) + "<br>" +
        esc(d.description || "") + "<br>" +
        '<span class="small muted">Kind: ' + esc(d.kind) + " · Category: " + esc(d.category || "—") +
        " · Store: " + esc((d.store && d.store.name) || "") +
        (d.in_stock ? " · In stock" : " · Out of stock") +
        (attrs ? "<br>" + attrs : "") + "</span>");
    }).catch(function (e) { say("Could not load that listing from the live API: " + esc(e.message || e)); });
  }

  function showReviews(idx) {
    var l = listingAt(idx); if (!l) return;
    callTool("get_reviews", "/v1/listings/" + l.id + "/reviews", { limit: 3, sort: "highest" }).then(function (body) {
      var revs = (body && body.data) || [];
      if (!revs.length) { say("<b>" + esc(l.title) + "</b> has no reviews yet in the live data."); return; }
      var html = "<b>" + esc(l.title) + "</b> — " + esc(ratingText(l)) + ". Top reviews from the live API:";
      revs.forEach(function (r) {
        html += '<div class="rev-item"><span class="who">' + esc((r.reviewer && r.reviewer.name) || "an agent") +
          (r.verified_purchase ? " · verified purchase" : "") + (r.is_demo ? " · demo review" : "") + "</span><br>" +
          '<span class="stars">' + "★★★★★".slice(0, r.rating) + '</span> <b>' + esc(r.title || "") + "</b><br>" + esc(r.body || "") + "</div>";
      });
      say(html);
    }).catch(function (e) { say("Could not load reviews from the live API: " + esc(e.message || e)); });
  }

  /* ---------------- comparison ---------------- */
  function doCompare() {
    var items = state.shortlist.map(function (id) { return state.byId[id]; }).filter(Boolean);
    if (items.length < 2) { say("Shortlist at least two listings first — tap <b>Shortlist +</b> on two cards, or say <b>“compare 1 and 2”</b>."); return; }
    var thinking = say("Comparing " + items.length + " shortlisted listings with live details and reviews…");
    var jobs = items.map(function (l) {
      return callTool("get_listing", "/v1/listings/" + l.id, {}).then(function (d) {
        return callTool("get_reviews", "/v1/listings/" + l.id + "/reviews", { limit: 3, sort: "highest" }).then(function (rv) {
          return { listing: d, reviews: (rv && rv.data) || [] };
        });
      });
    });
    Promise.all(jobs).then(function (rows) {
      thinking.remove();
      var head = "<tr><th></th>" + rows.map(function (r) { return "<th>" + esc(r.listing.title) + "</th>"; }).join("") + "</tr>";
      function row(label, fn) {
        return "<tr><td><b>" + label + "</b></td>" + rows.map(function (r) { return "<td>" + fn(r) + "</td>"; }).join("") + "</tr>";
      }
      var table = '<table class="cmp-table">' + head +
        row("Price", function (r) { return money(r.listing.price_cents); }) +
        row("Rating", function (r) { return esc(ratingText(r.listing)); }) +
        row("Sold", function (r) { return String(r.listing.sold_count || 0); }) +
        row("Store", function (r) { return esc((r.listing.store && r.listing.store.name) || ""); }) +
        row("Top review", function (r) {
          return r.reviews.length ? '<span class="stars">' + "★★★★★".slice(0, r.reviews[0].rating) + "</span> “" + esc(r.reviews[0].body || r.reviews[0].title || "") + "”" : "No reviews yet";
        }) + "</table>";
      var ranked = rows.slice().sort(function (a, b) {
        var ra = (a.listing.rating && a.listing.rating.average) || -1, rb = (b.listing.rating && b.listing.rating.average) || -1;
        if (rb !== ra) return rb - ra;
        var ca = (a.listing.rating && a.listing.rating.count) || 0, cb = (b.listing.rating && b.listing.rating.count) || 0;
        if (cb !== ca) return cb - ca;
        return a.listing.price_cents - b.listing.price_cents;
      });
      var winner = ranked[0].listing;
      compareEl.innerHTML = table + '<div class="cmp-verdict">Verdict: <b>' + esc(winner.title) + "</b> — picked by the fixed rule: highest rating, then most reviews, then lowest price.</div>";
      say("Comparison is on the right, built from live <code>get_listing</code> and <code>get_reviews</code> calls. By the fixed rule (rating → review count → price), the pick is <b>" + esc(winner.title) + "</b> at " + money(winner.price_cents) + " (" + esc(ratingText(winner)) + ").");
    }).catch(function (e) {
      thinking.remove();
      say("The comparison calls failed against the live API: " + esc(e.message || e));
    });
  }

  /* ---------------- utterance parsing ---------------- */
  function extractGoal(raw) {
    var t = " " + raw.toLowerCase() + " ";
    t = t.replace(/\b(find|show|get|give|search|look|looking|want|need|buy|fetch|list)\b/g, " ");
    t = t.replace(/\bme\b/g, " ");
    t = t.replace(/\b(under|below|within|max|less than|up to|around)\s*\$?\d+(\.\d+)?/g, " ");
    t = t.replace(/\$\s*\d+(\.\d+)?/g, " ");
    t = t.replace(/\d+(\.\d+)?\s*(stars?|★)/g, " ");
    t = t.replace(/\bhighly rated\b|\btop rated\b|\bbest rated\b|\bwell rated\b/g, " ");
    t = t.replace(/\bdigital products?\b|\bphysical products?\b|\bproducts?\b|\bitems?\b|\bservices?\b/g, " ");
    t = t.replace(/\b(a|an|the|some|please)\b/g, " ");
    t = t.replace(/^\s*for\s+/, " ");
    return t.replace(/\s+/g, " ").trim();
  }

  function parseAndAct(raw) {
    var text = " " + raw.toLowerCase().trim() + " ";

    if (/\bcompare\b|\bversus\b|\bvs\b/.test(text)) {
      var nums = (text.match(/\b\d{1,2}\b/g) || []).map(function (n) { return parseInt(n, 10) - 1; }).filter(function (i) { return i >= 0 && i < state.results.length; });
      if (nums.length >= 2) state.shortlist = nums.map(function (i) { return state.results[i].id; });
      renderShortlist();
      doCompare();
      return;
    }
    if (/\bshortlist\b|\bkeep\b|\bsave\b/.test(text)) {
      var idx = pickIndex(text);
      var l = listingAt(idx);
      if (l && state.shortlist.indexOf(l.id) < 0) state.shortlist.push(l.id);
      renderShortlist();
      if (l) say("Shortlisted <b>" + esc(l.title) + "</b>. " + (state.shortlist.length >= 2 ? "Say <b>“compare”</b> when you are ready." : "Add one more to compare."));
      return;
    }
    if (/\breviews?\b/.test(text)) { showReviews(pickIndex(text)); return; }
    if (/\bdetails?\b|\bmore about\b|\btell me more\b|\bdescribe\b/.test(text)) { showDetails(pickIndex(text)); return; }
    if (/\bclear\b|\breset\b|\bstart over\b/.test(text)) {
      state.goal = ""; state.budget = null; state.kind = ""; state.category = ""; state.minRating = null; state.sort = "rating";
      state.results = []; state.shortlist = [];
      syncForm(); renderResults(); renderShortlist();
      say("Session cleared. Tell me a new goal — constraints will not leak from the last search.");
      return;
    }
    if (/\bcheaper\b|\bless expensive\b|\blower price/.test(text)) {
      state.sort = "price_asc";
      say("Re-running by lowest price first.");
      runSearch();
      return;
    }
    var kindMatch = text.match(/\b(digital|physical|service) only\b/) || text.match(/\bonly (digital|physical|service)\b/);
    if (kindMatch) { state.kind = kindMatch[1]; syncForm(); runSearch(); return; }

    /* ---- treat as a (refined) search ---- */
    var budgetM = text.match(/(?:under|below|within|max|less than|up to|budget(?: of)?|around)\s*\$?\s*(\d+(?:\.\d+)?)/) || text.match(/\$\s*(\d+(?:\.\d+)?)/);
    if (budgetM) state.budget = parseFloat(budgetM[1]);
    var ratingM = text.match(/(\d(?:\.\d+)?)\s*(?:stars?|★)/);
    if (ratingM) state.minRating = Math.min(5, Math.max(1, parseFloat(ratingM[1])));
    else if (/highly rated|top rated|best rated|well rated/.test(text)) state.minRating = 4;
    if (/\bdigital\b|\be-?books?\b|\bdownloads?\b/.test(text)) state.kind = "digital";
    else if (/\bphysical\b/.test(text)) state.kind = "physical";
    else if (/\bservices?\b/.test(text)) state.kind = "service";
    state.categories.forEach(function (c) {
      if (text.indexOf(" " + c.slug.replace(/-/g, " ") + " ") >= 0 || text.indexOf(" " + c.slug + " ") >= 0 ||
          text.indexOf(" " + c.name.toLowerCase() + " ") >= 0) state.category = c.slug;
    });
    var g = extractGoal(raw);
    if (g && g.length >= 2) state.goal = g;
    state.sort = state.minRating != null ? "rating" : state.sort;
    syncForm();
    runSearch();
  }

  function syncForm() {
    $("fGoal").value = state.goal || "";
    $("fBudget").value = state.budget != null ? state.budget : "";
    $("fKind").value = state.kind || "";
    $("fRating").value = state.minRating != null ? String(state.minRating) : "";
    $("fCategory").value = state.category || "";
  }

  /* ---------------- init ---------------- */
  document.addEventListener("DOMContentLoaded", function () {
    chatEl = $("vsChat"); traceEl = $("vsTrace"); resultsEl = $("vsResults");
    resMeta = $("resMeta"); compareEl = $("vsCompare"); apiStatus = $("apiStatus");

    var chips = [
      "Find me a highly rated digital product under $25 for building AI agents",
      "Show me datasets under $15",
      "Find a top rated service under $100"
    ];
    var chipWrap = $("vsChips");
    chips.forEach(function (c) {
      var b = document.createElement("button");
      b.type = "button"; b.className = "chip"; b.textContent = "“" + c + "”";
      b.addEventListener("click", function () { userSay(c); parseAndAct(c); });
      chipWrap.appendChild(b);
    });

    say("Hi — I'm the <b>Voice Shopper</b>, a simulation of an Alexa+ shopping conversation running on AgentMart's live marketplace. Tell me a goal, a budget, a product type and a minimum rating, and I will search the real catalogue with the same tools an agent uses — <code>search_listings</code>, <code>get_listing</code>, <code>get_reviews</code> — and show every call in the trace. AgentMart is in public beta, so the catalogue is small and settles in sandbox credits.");

    callTool("list_categories", "/v1/categories", {}).then(function (body) {
      state.categories = (body && body.data) || [];
      var sel = $("fCategory");
      state.categories.forEach(function (c) {
        var o = document.createElement("option");
        o.value = c.slug; o.textContent = c.name + " (" + c.listing_count + ")";
        sel.appendChild(o);
      });
      apiStatus.textContent = "API: live";
      apiStatus.className = "badge b-ok";
    }).catch(function () {
      apiStatus.textContent = "API: unreachable";
      apiStatus.className = "badge b-bad";
    });

    $("vsForm").addEventListener("submit", function (e) {
      e.preventDefault();
      var v = $("vsInput").value.trim();
      if (!v) return;
      $("vsInput").value = "";
      userSay(v);
      parseAndAct(v);
    });

    $("vsControls").addEventListener("submit", function (e) {
      e.preventDefault();
      state.goal = $("fGoal").value.trim();
      var b = $("fBudget").value;
      state.budget = b === "" ? null : parseFloat(b);
      state.kind = $("fKind").value;
      state.category = $("fCategory").value;
      var r = $("fRating").value;
      state.minRating = r === "" ? null : parseFloat(r);
      userSay("Search with: " + constraintSummary());
      runSearch();
    });

    resultsEl.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-act]");
      if (!btn) return;
      var idx = parseInt(btn.getAttribute("data-idx"), 10);
      var act = btn.getAttribute("data-act");
      var l = state.results[idx];
      if (!l) return;
      if (act === "details") showDetails(idx);
      else if (act === "reviews") showReviews(idx);
      else if (act === "shortlist") {
        var at = state.shortlist.indexOf(l.id);
        if (at >= 0) state.shortlist.splice(at, 1); else state.shortlist.push(l.id);
        renderResults(); renderShortlist();
      }
    });

    $("vsClearShortlist").addEventListener("click", function () {
      state.shortlist = [];
      renderResults(); renderShortlist();
    });

    renderShortlist();
  });
})();
